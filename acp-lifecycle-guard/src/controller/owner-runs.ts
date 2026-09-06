/**
 * Bounded record of the agent runs the host itself proved to be direct-owner
 * turns at `before_agent_run`.
 *
 * Pure policy state: no host access, no I/O, no logging. The hook wiring in
 * `surfaces.ts` decides when to admit or revoke and how to report an
 * eviction. Owner authority is never inferred here; the host's
 * `senderIsOwner` verdict is only remembered for the exact session and run it
 * was proven for, so a requester-less bridged tool call later in that run can
 * be bound back to it. OpenClaw may expose the canonical run session key to an
 * agent hook and a sandbox/runtime session key to its tool surface; the shared
 * ephemeral session id is the only accepted alias across that split.
 */

export const MAX_OWNER_RUN_ADMISSIONS = 256;

export type OwnerRunAdmission = {
  sessionKey: string;
  runId: string;
  sessionId?: string;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Session keys embed the agent id (`agent:main:...`), so the pair is the
 * complete run identity. The `agentId === "main"` gate belongs to the
 * admission decision, not to the key: revocation must succeed on whatever run
 * identity the host still provides at `agent_end`.
 */
export function ownerRunKey(sessionKey: unknown, runId: unknown): string | undefined {
  const session = nonEmptyString(sessionKey);
  const run = nonEmptyString(runId);
  return session === undefined || run === undefined ? undefined : JSON.stringify([session, run]);
}

function ownerRunAdmissionKey(admission: OwnerRunAdmission): string {
  return JSON.stringify([admission.sessionKey, admission.sessionId ?? null, admission.runId]);
}

/**
 * Authorizes aliases only when both sides carry the same ephemeral session id.
 * If either side omits that id, the canonical session key must match exactly.
 */
function matchesOwnerRun(admission: OwnerRunAdmission, sessionKey: unknown,
  runId: unknown, sessionId: unknown): boolean {
  const run = nonEmptyString(runId);
  if (run === undefined || admission.runId !== run) return false;
  const candidateSessionId = nonEmptyString(sessionId);
  if (admission.sessionId !== undefined || candidateSessionId !== undefined) {
    return admission.sessionId !== undefined && candidateSessionId !== undefined &&
      admission.sessionId === candidateSessionId;
  }
  return admission.sessionKey === nonEmptyString(sessionKey);
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
  private readonly entries = new Map<string, OwnerRunAdmission>();

  /**
   * Remembers a host-proven owner run. Re-admitting a tracked run is a no-op.
   * Returns true when the bounded cap displaced the oldest admission so the
   * caller can report it: bounded-state pressure must never be silent.
   */
  admit(sessionKey: unknown, runId: unknown, sessionId?: unknown): boolean {
    const key = ownerRunKey(sessionKey, runId);
    if (key === undefined) return false;
    const ephemeralSession = nonEmptyString(sessionId);
    const admission: OwnerRunAdmission = {
      sessionKey: nonEmptyString(sessionKey)!,
      runId: nonEmptyString(runId)!,
      ...(ephemeralSession === undefined ? {} : { sessionId: ephemeralSession }),
    };
    if ([...this.entries.values()].some((entry) => matchesOwnerRun(entry,
      admission.sessionKey, admission.runId, admission.sessionId))) return false;
    let evicted = false;
    if (this.entries.size >= MAX_OWNER_RUN_ADMISSIONS) {
      this.entries.delete(this.entries.keys().next().value as string);
      evicted = true;
    }
    this.entries.set(ownerRunAdmissionKey(admission), admission);
    return evicted;
  }

  revoke(sessionKey: unknown, runId: unknown, sessionId?: unknown): void {
    const session = nonEmptyString(sessionKey);
    const run = nonEmptyString(runId);
    const ephemeralSession = nonEmptyString(sessionId);
    if (run === undefined) return;
    for (const [key, admission] of this.entries) {
      if (admission.runId === run &&
          (admission.sessionKey === session ||
            admission.sessionId !== undefined && admission.sessionId === ephemeralSession)) {
        this.entries.delete(key);
      }
    }
  }

  resolve(sessionKey: unknown, runId: unknown, sessionId?: unknown): OwnerRunAdmission | undefined {
    const matches = [...this.entries.values()].filter((entry) =>
      matchesOwnerRun(entry, sessionKey, runId, sessionId));
    return matches.length === 1 ? matches[0] : undefined;
  }

  has(sessionKey: unknown, runId: unknown, sessionId?: unknown): boolean {
    return this.resolve(sessionKey, runId, sessionId) !== undefined;
  }

  get size(): number {
    return this.entries.size;
  }
}
