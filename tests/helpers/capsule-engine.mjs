// In-memory daemon responses for exercising the real owned-container lifecycle.
export function capsuleEngine(profile, hooks = {}) {
  const image = 'sha256:' + 'a'.repeat(64), id = 'b'.repeat(64);
  const calls = []; let record; const state = { exists: false, running: false, fail: null };
  const runner = async (command, args, environment) => {
    calls.push({ command, args, environment });
    if (state.fail && args.includes(state.fail)) throw new Error('Fixture engine unavailable');
    if (args.includes('info')) { await hooks.info?.(); return { stdout: JSON.stringify({ ID: 'fixture', Name: 'fixture', DockerRootDir: '/var/lib/docker', OSType: 'linux', CgroupVersion: '2', CgroupDriver: 'systemd', CpuCfsPeriod: true, CpuCfsQuota: true, MemoryLimit: true, PidsLimit: true, SecurityOptions: [] }) }; }
    if (args.includes('image')) return { stdout: JSON.stringify([{ Id: image, Os: 'linux', Architecture: 'amd64', Config: { Env: ['IGNORED=never-inherited'], Volumes: {} } }]) };
    if (args.includes('create')) {
      state.exists = true;
      const directory = args.find(a => a.startsWith('--mount=')).match(/src=([^,]+)/)[1];
      record = { Id: id, Name: '/' + args[args.indexOf('--name') + 1], Image: image, Path: profile.python, Args: ['-I', '-S', '-c', args.at(-1)],
        Config: { Labels: Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i + 1].split('=')] : [])), WorkingDir: '/workspace', User: profile.user, Tty: args.includes('--tty'), OpenStdin: args.includes('--interactive'), Env: args.filter(a => a.startsWith('--env=')).flatMap(a => { const s = a.slice(6); return s.includes('=') ? [s] : environment[s] === undefined ? [] : [`${s}=${environment[s]}`]; }) },
        Mounts: [{ Type: 'bind', Source: directory, Destination: '/workspace', RW: !args.find(a => a.startsWith('--mount=')).includes('readonly=true'), Propagation: 'rprivate' }],
        HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'], NetworkMode: args.find(arg => arg.startsWith('--network=')).slice(10), Memory: profile.memoryMb * 1048576, NanoCpus: profile.cpus * 1e9, PidsLimit: profile.pids, CgroupnsMode: 'private', Mounts: [{ BindOptions: { NonRecursive: true } }], Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=256m,mode=1777' }, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' } } };
      await hooks.created?.(directory); return { stdout: id };
    }
    if (args.includes('inspect')) { await hooks.inspect?.(record); return { stdout: JSON.stringify([{ ...record, State: { Running: state.running, Status: state.started ? 'exited' : 'created', ExitCode: state.exitCode ?? 0, OOMKilled: false } }]) }; }
    if (args.includes('ls')) return { stdout: state.exists ? id : '' };
    if (args.includes('stop')) state.running = false;
    if (args.includes('rm')) state.exists = false;
    return { stdout: '' };
  };
  return { calls, state, runner, resolveEndpoint: async p => ({ executable: p.executable, socket: p.endpoint.socket, executableIdentity: 'fixture' }) };
}
