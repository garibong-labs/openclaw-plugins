/**
 * Bounded record of the agent runs the host itself proved to be direct-owner
 * turns at `before_agent_run`.
 *
 * Pure policy state: no host access, no I/O, no logging. The hook wiring in
 * `surfaces.ts` decides when to admit or revoke and how to report an
 * eviction. Owner authority is never inferred here; the host's
 * `senderIsOwner` verdict is only remembered for the exact session and run it
 * was proven for, so a requester-less bridged tool call later in that run can
 * be bound back to it.
 */

export const MAX_OWNER_RUN_ADMISSIONS = 256;

/**
 * Session keys embed the agent id (`agent:main:...`), so the pair is the
 * complete run identity. The `agentId === "main"` gate belongs to the
 * admission decision, not to the key: revocation must succeed on whatever run
 * identity the host still provides at `agent_end`.
 */
export function ownerRunKey(sessionKey: unknown, runId: unknown): string | undefined {
  if (typeof sessionKey !== "string" || sessionKey.length === 0 ||
      typeof runId !== "string" || runId.length === 0) {
    return undefined;
  }
  return JSON.stringify([sessionKey, runId]);
}

/**
 * An explicit host requester verdict wins in both directions. Only an absent
 * verdict defers to the remembered run admission; any non-boolean value fails
 * closed.
 */
export function resolveOwnerAuthority(explicit: unknown, admitted: boolean): boolean {
  return explicit === undefined ? admitted : explicit === true;
}

export class OwnerRunAdmissions {
  private readonly keys = new Set<string>();

  /**
   * Remembers a host-proven owner run. Re-admitting a tracked run is a no-op.
   * Returns true when the bounded cap displaced the oldest admission so the
   * caller can report it: bounded-state pressure must never be silent.
   */
  admit(sessionKey: unknown, runId: unknown): boolean {
    const key = ownerRunKey(sessionKey, runId);
    if (key === undefined || this.keys.has(key)) return false;
    let evicted = false;
    if (this.keys.size >= MAX_OWNER_RUN_ADMISSIONS) {
      this.keys.delete(this.keys.values().next().value as string);
      evicted = true;
    }
    this.keys.add(key);
    return evicted;
  }

  revoke(sessionKey: unknown, runId: unknown): void {
    const key = ownerRunKey(sessionKey, runId);
    if (key !== undefined) this.keys.delete(key);
  }

  has(sessionKey: unknown, runId: unknown): boolean {
    const key = ownerRunKey(sessionKey, runId);
    return key !== undefined && this.keys.has(key);
  }

  get size(): number {
    return this.keys.size;
  }
}
