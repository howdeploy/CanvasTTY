import {
  CompanionError,
  type CompanionGrant,
} from "../../../shared/companion.ts";

/** Grants come from desktop pairing, never from a remote request body. */
export class SessionAccess {
  private readonly grants = new Map<string, CompanionGrant>();
  private revision = 0;

  share(grant: Omit<CompanionGrant, "revision">): CompanionGrant {
    if (
      !grant.deviceId ||
      grant.deviceId.length > 128 ||
      grant.sessionIds.length > 64
    ) {
      throw new CompanionError("invalid-request");
    }
    const next = {
      ...grant,
      sessionIds: [...new Set(grant.sessionIds)],
      revision: ++this.revision,
    };
    this.grants.set(grant.deviceId, next);
    return structuredClone(next);
  }

  get(deviceId: string): CompanionGrant {
    const grant = this.grants.get(deviceId);
    if (!grant) throw new CompanionError("not-paired");
    return structuredClone(grant);
  }

  assertCurrent(grant: CompanionGrant): void {
    if (this.get(grant.deviceId).revision !== grant.revision)
      throw new CompanionError("not-permitted");
  }

  assertSession(grant: CompanionGrant, sessionId: string): void {
    this.assertCurrent(grant);
    if (!grant.sessionIds.includes(sessionId))
      throw new CompanionError("not-shared");
  }

  revoke(deviceId: string): void {
    this.grants.delete(deviceId);
  }

  includeCreatedSession(grant: CompanionGrant, sessionId: string): void {
    this.assertCurrent(grant);
    this.share({ ...grant, sessionIds: [...grant.sessionIds, sessionId] });
  }
}
