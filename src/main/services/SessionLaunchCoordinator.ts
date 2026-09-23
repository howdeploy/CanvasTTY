import { assertDelegationRoute } from '../../shared/delegationLaunch.ts';
import type { AgentStartup } from "./AgentStartup.ts";
import { DATA_CLASS_RANK, remotePathForHost } from "../../shared/contracts.ts";
import type { IsolatedWorktree } from "./WorktreeService.ts";
import type { ContainerExecutionService } from "./ContainerExecutionService.ts";
import { randomUUID } from "node:crypto";
import { realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { AppSettings, ExecutionWorkspaceSummary, SessionMetadata } from '../../shared/contracts.ts';
import { assertIsolationRequest } from '../../shared/isolation.ts';
import type { PreparedProviderAccountLaunch, ProviderAccountLaunchCoordinator } from './ProviderAccountLaunchService.ts';
import type { WorktreeService } from './WorktreeService.ts';
import type { HostPlacementService } from './HostPlacement.ts';
import type { CapsuleLaunchService } from './CapsuleLaunchService.ts';
import type { TaskCapsule } from './TaskCapsuleService.ts';

/** Composes workspace and host preparation around the account adapter; sessions and budgets remain in TerminalManager. */
export class SessionLaunchCoordinator implements ProviderAccountLaunchCoordinator {
  readonly handlesTerminals = true;
  private readonly containers?: ContainerExecutionService;
  private readonly capsules?: CapsuleLaunchService;
  private readonly accounts: ProviderAccountLaunchCoordinator;
  private readonly worktrees: WorktreeService;
  private readonly settings: () => Pick<AppSettings, 'remoteHosts' | 'providerAccounts' | 'requiresSandboxProfiles'>;
  private readonly placement: Pick<HostPlacementService, 'place' | 'checkShell'>;
  constructor(accounts: ProviderAccountLaunchCoordinator, worktrees: WorktreeService,
    settings: () => Pick<AppSettings, 'remoteHosts' | 'providerAccounts' | 'requiresSandboxProfiles'>, placement: Pick<HostPlacementService, 'place' | 'checkShell'>, containers?: ContainerExecutionService, capsules?: CapsuleLaunchService) {
    this.accounts = accounts; this.worktrees = worktrees; this.settings = settings; this.placement = placement; this.containers = containers; this.capsules = capsules;
  }
  async prepare(metadata: SessionMetadata, resumePrevious: boolean, control?: { isCurrent(): boolean; assertRoute?(): void; onStartupDisclosure?(): void; startup?: AgentStartup }): Promise<PreparedProviderAccountLaunch> {
    const initialSettings = this.settings();
    assertDelegationRoute(metadata, initialSettings.providerAccounts.find(a => a.id === metadata.accountId));
    const host = metadata.hostId === undefined ? undefined : initialSettings.remoteHosts.find(item => item.id === metadata.hostId);
    const hostIdentity = JSON.stringify(host);
    const capsuleId = metadata.isolation?.mode === 'container' ? metadata.isolation.capsuleId : undefined;
    const checkCapsule = (): void => {
      if (!capsuleId) return;
      if (!this.capsules || metadata.hostId !== undefined || metadata.transport === 'acp' || metadata.provider === 'terminal') throw new Error('Capsules require a supported local API container agent.');
      if (metadata.execution?.workspaceId && metadata.execution.workspaceId !== capsuleId) throw new Error('Saved capsule workspace identity changed.');
      if (!metadata.dataClass || DATA_CLASS_RANK[this.capsules.classify(metadata)] > DATA_CLASS_RANK[metadata.dataClass]) throw new Error('Capsule data policy changed before launch.');
    };
    const active = (snapshot = metadata.hostId === undefined ? initialSettings : this.settings()): void => {
      if (control && !control.isCurrent()) throw new Error('Launch cancelled.');
      control?.assertRoute?.();
      if (JSON.stringify(snapshot.remoteHosts.find(item => item.id === metadata.hostId)) !== hostIdentity) throw new Error('Remote host changed during launch preparation.');
      checkCapsule();
    };
    assertIsolationRequest(metadata.isolation); active();
    const mode = metadata.isolation?.mode ?? 'direct';
    if (mode === 'container') {
      if (!this.containers || metadata.isolation?.mode !== 'container') throw new Error('Container execution service is unavailable.');
      const profile = this.containers.profile(metadata.isolation.profileId);
      if (profile.hostId !== (metadata.hostId ?? 'local')) throw new Error('Container profile belongs to another execution host.');
      if (metadata.provider !== 'terminal' && initialSettings.providerAccounts.find(a => a.id === metadata.accountId)?.binding?.kind !== 'api-profile') throw new Error('Container agents require a supported API account; native OAuth home recipes are unavailable.');
      if (!profile.commands[metadata.provider]) throw new Error('Selected image profile has no supported command for this provider.');
      if (metadata.provider !== 'terminal' && profile.network !== 'bridge') throw new Error('Cloud API container launch requires an explicitly selected bridge network profile.');
      if (metadata.provider !== 'terminal' && resumePrevious) throw new Error('Container API configuration is ephemeral. Start a fresh session in its retained workspace.');
    }
    if (mode === 'worktree' && metadata.hostId !== undefined) throw new Error('Worktree isolation is supported only on the local computer.');
    if (mode === 'direct' && initialSettings.requiresSandboxProfiles?.includes(metadata.profile)) throw new Error('This launch profile requires a worktree or container.');
    let remoteWorkspace: string | undefined;
    if (metadata.hostId !== undefined) {
      if (!host) throw new Error('Selected remote host is no longer configured.');
      const account = initialSettings.providerAccounts.find(item => item.id === metadata.accountId);
      if (account?.binding?.kind === 'api-profile' && mode !== 'container') throw new Error('Remote API accounts require a container and a credential provisioned on their fixed server.');
      // Shells have no provider endpoint or installation, but share bounded resource and capacity checks.
      if (metadata.provider === 'terminal' || mode === 'container') {
        if (mode === 'container') { remoteWorkspace = remotePathForHost(host, metadata.cwd) ?? undefined; if (!remoteWorkspace) throw new Error('Container source workspace is not mapped on the selected host.'); }
        await this.placement.checkShell(host, metadata.id); active();
      }
      else {
        const decision = await this.placement.place([host], { provider: metadata.provider, localWorkspace: metadata.cwd, dataClass: metadata.dataClass, eligibleHostIds: [host.id], excludeSessionId: metadata.id });
        active();
        if (decision.kind === 'remote') remoteWorkspace = decision.remoteWorkspace;
        if (decision.kind !== 'remote' || decision.host.id !== host.id) throw new Error(`Remote launch preflight failed: ${decision.kind === 'local' ? decision.reason : 'selected host changed'}.`);
      }
    }
    const leaseId = randomUUID();
    let workspaceId: string | undefined;
    let remoteOwnedWorkspace: (IsolatedWorktree & { executionCwd: string }) | undefined;
    let capsule: TaskCapsule | undefined;
    let capsuleDigest: string | undefined;
    let started = false;
    let exited = false;
    let accountLaunch: PreparedProviderAccountLaunch | undefined;
    let containerLaunch: Awaited<ReturnType<ContainerExecutionService['prepare']>> | undefined;
    let execution: ExecutionWorkspaceSummary = { mode, sourceCwd: metadata.cwd, executionCwd: metadata.hostId === undefined ? metadata.cwd : remoteWorkspace, filesystemRestricted: false, state: 'ready' };
    try {
      active();
      if (capsuleId) {
        capsule = await this.capsules!.verify(capsuleId); active();
        if (await this.containers!.blocksWorkspace(capsuleId)) throw new Error('A previous container still owns this capsule. Confirm cleanup first.');
        capsuleDigest = await this.capsules!.storage.reserve(capsuleId, leaseId);
        workspaceId = capsuleId; active();
      }
      // Reject a stale account, incompatible protocol/model or missing remote
      // credential reference before creating an owned checkout on its server.
      if (mode === 'container' && metadata.provider !== 'terminal') {
        accountLaunch = await this.accounts.prepare(metadata, resumePrevious, { isCurrent: () => !control || control.isCurrent(), assertRoute: () => active(), target: 'container' });
        active(); accountLaunch.assertCurrent(metadata);
      }
      if (capsule) {
        execution = { ...execution, workspaceId, executionCwd: '/workspace', hostWorkspace: capsule.directory, containerProfileId: metadata.isolation?.mode === 'container' ? metadata.isolation.profileId : undefined, filesystemRestricted: true };
        await this.capsules!.verifyLaunch(capsule.id, leaseId, capsuleDigest!); active();
      } else if (mode === 'container' && metadata.hostId !== undefined) {
        const profile = this.containers!.profile(metadata.isolation!.mode === 'container' ? metadata.isolation!.profileId : '');
        remoteOwnedWorkspace = await this.containers!.remoteWorkspace(profile, remoteWorkspace!, metadata.execution?.workspaceId, leaseId);
        workspaceId = remoteOwnedWorkspace.id;
        execution = { ...execution, workspaceId, executionCwd: remoteOwnedWorkspace.executionCwd, hostWorkspace: remoteOwnedWorkspace.directory, baseCommit: remoteOwnedWorkspace.commit, containerProfileId: profile.id, filesystemRestricted: true };
      } else if (mode === 'worktree' || mode === 'container') {
        const workspace = metadata.execution?.workspaceId
          ? await this.worktrees.reuse(metadata.execution.workspaceId, metadata.cwd)
          : await this.worktrees.create({ sourceDirectory: metadata.cwd, ref: metadata.isolation?.mode === 'worktree' ? metadata.isolation.ref : undefined, sessionId: metadata.id, leaseId });
        workspaceId = workspace.id;
        if (metadata.execution?.workspaceId) await this.worktrees.reserve(workspaceId, leaseId);
        active();
        const sourceCwd = await realpath(metadata.cwd);
        const executionCwd = join(workspace.directory, relative(workspace.sourceDirectory, sourceCwd));
        if (await realpath(executionCwd) !== executionCwd || !(await stat(executionCwd)).isDirectory()) throw new Error('The selected source subdirectory is absent or a symlink at the worktree base. Choose a committed directory.');
        execution = { ...execution, workspaceId, executionCwd: mode === 'container' ? join('/workspace', relative(workspace.directory, executionCwd)) : executionCwd, baseCommit: workspace.commit, ...(mode === 'container' ? { hostWorkspace: workspace.directory, containerProfileId: metadata.isolation?.mode === 'container' ? metadata.isolation.profileId : undefined, filesystemRestricted: true } : {}) };
      } else if (metadata.execution?.workspaceId) throw new Error('A retained workspace cannot silently switch to direct execution.');
      active();
      accountLaunch ??= metadata.provider === 'terminal'
        ? { args: [], environment: {}, unsetEnvironment: [], skipBridges: false, bindingDigest: '', assertCurrent() {}, async cleanup() {} }
        : await this.accounts.prepare(metadata, resumePrevious, { isCurrent: () => !control || control.isCurrent(), assertRoute: () => active(), ...(mode === 'container' ? { target: 'container' } : {}) });
      active();
      if (mode === 'container') {
        const workspace = capsule ? { kind: capsule.kind === 'advisory-review' ? 'advisory-review' as const : 'capsule' as const, id: capsule.id, directory: capsule.directory, sourceDirectory: capsule.sourceDirectory } : remoteOwnedWorkspace ?? await this.worktrees.reuse(workspaceId!, metadata.cwd);
        containerLaunch = await this.containers!.prepare(metadata, workspace, { ...accountLaunch, startup: control?.startup, onStartupDisclosure: control?.onStartupDisclosure }, () => { active(); accountLaunch!.assertCurrent(metadata); }, leaseId, execution.executionCwd, capsule ? marker => this.capsules!.verifyLaunch(capsuleId!, leaseId, capsuleDigest!, marker) : undefined);
      }
      if (capsule) await this.capsules!.storage.setRunning(capsule.id, leaseId);
      else if (workspaceId && !remoteOwnedWorkspace) await this.worktrees.setRunning(workspaceId, leaseId);
      active();
      const preparedAccount = accountLaunch;
      let cleanupTask: Promise<void> | undefined;
      const cleanup = (): Promise<void> => cleanupTask ??= (async () => {
        await containerLaunch?.cleanup();
        await preparedAccount.cleanup();
        if (capsule) await this.capsules!.storage.confirmContainerStopped(capsule.id, leaseId);
        else if (workspaceId && !remoteOwnedWorkspace) await this.worktrees.retain(workspaceId, !!containerLaunch || !started || exited, leaseId);
      })().catch(error => { cleanupTask = undefined; throw error; });
      return { ...preparedAccount, ...containerLaunch, execution, startup: control?.startup,
        ...(containerLaunch ? { skipBridges: true, integrationNote: capsule?.kind === 'advisory-review' ? 'Advisory review receives only a read-only Review.patch and Task.md plus filtered context. The original project is not mounted; source apply and delegation are unavailable.' : capsule ? 'Container receives only the selected files and Task.md. Output is retained for review; host bridges are unavailable.' : 'Container uses its image CLI and full detached workspace. Host runtime/browser bridges are unavailable. Linked-worktree Git metadata is outside the mount.' } : {}),
        assertCurrent: current => {
          const liveSettings = this.settings();
          active(liveSettings); preparedAccount.assertCurrent(current); containerLaunch?.assertCurrent(current);
          if (JSON.stringify(current.isolation) !== JSON.stringify(metadata.isolation)) throw new Error('Isolation request changed during launch preparation.');
          if (mode === 'direct' && liveSettings.requiresSandboxProfiles?.includes(current.profile)) throw new Error('This launch profile now requires a worktree or container.');
        },
        processStarted: () => { started = true; },
        processExited: async () => { exited = true; if (containerLaunch) await cleanup(); else if (workspaceId && !remoteOwnedWorkspace) await this.worktrees.retain(workspaceId, true, leaseId); },
        cleanup
      };
    } catch (error) {
      let stopped = true;
      await containerLaunch?.cleanup().catch(() => { stopped = false; });
      await accountLaunch?.cleanup().catch(() => undefined);
      if (remoteOwnedWorkspace) await this.containers!.releaseRemoteWorkspace(remoteOwnedWorkspace.id, leaseId).catch(() => undefined);
      if (workspaceId && mode === 'container' && await this.containers!.blocksWorkspace(workspaceId).catch(() => true)) stopped = false;
      if (capsule && workspaceId) {
        if (stopped) await this.capsules!.storage.confirmContainerStopped(workspaceId, leaseId).catch(() => undefined);
        else await this.capsules!.storage.retainUncertain(workspaceId, leaseId).catch(() => undefined);
      } else if (workspaceId && !remoteOwnedWorkspace) {
        if (!stopped) await this.worktrees.setRunning(workspaceId, leaseId).catch(() => undefined);
        await this.worktrees.retain(workspaceId, stopped, leaseId).catch(() => undefined);
      }
      throw error;
    }
  }
}
