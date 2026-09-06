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
 * ephemeral session id is the only accepted alias across two concrete keys.
 */

export const MAX_OWNER_RUN_ADMISSIONS = 256;

export type RunProjection = {
  sessionKey?: unknown;
  sessionId?: unknown;
  runId?: unknown;
};

export type NormalizedRunProjection = {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
};

export type OwnerRunAdmission = {
  sessionKey: string;
  runId: string;
  sessionId?: string;
};

export type SessionProjectionRelation = "same" | "partial" | "different";

/** Normalize optional host identifiers once; empty strings are absent. */
export function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeRunProjection(projection: RunProjection): NormalizedRunProjection {
  const sessionKey = optionalNonEmptyString(projection.sessionKey);
  const sessionId = optionalNonEmptyString(projection.sessionId);
  const runId = optionalNonEmptyString(projection.runId);
  return {
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(runId === undefined ? {} : { runId }),
  };
}

/** A host session key must agree with the separately supplied agent identity. */
export function isAgentSessionKey(sessionKey: unknown, agentId: unknown): boolean {
  const session = optionalNonEmptyString(sessionKey);
  const agent = optionalNonEmptyString(agentId);
  return session !== undefined && agent !== undefined && session.startsWith(`agent:${agent}:`);
}

/**
 * Compare the two host session projections once for every authorization and
 * cleanup caller. Aliasing requires two concrete keys plus the same non-empty
 * session id. Two absent ids fall back to exact key equality. A one-sided id
 * is `partial`: authorization rejects it, while exact-key revocation may use
 * it to fail safe by deleting authority.
 */
export function sessionProjectionRelation(left: RunProjection,
  right: RunProjection): SessionProjectionRelation {
  const a = normalizeRunProjection(left);
  const b = normalizeRunProjection(right);
  if (a.sessionKey === undefined || b.sessionKey === undefined) return "different";
  if (a.sessionId === undefined && b.sessionId === undefined) {
    return a.sessionKey === b.sessionKey ? "same" : "different";
  }
  if (a.sessionId === undefined || b.sessionId === undefined) {
    return a.sessionKey === b.sessionKey ? "partial" : "different";
  }
  return a.sessionId === b.sessionId ? "same" : "different";
}

export function sameRunProjection(left: RunProjection, right: RunProjection): boolean {
  const a = normalizeRunProjection(left);
  const b = normalizeRunProjection(right);
  return a.runId !== undefined && a.runId === b.runId &&
    sessionProjectionRelation(a, b) === "same";
}

/** Revocation also accepts a one-sided id when the concrete key is exact. */
export function revokesRunProjection(left: RunProjection, right: RunProjection): boolean {
  const a = normalizeRunProjection(left);
  const b = normalizeRunProjection(right);
  if (a.runId !== b.runId) return false;
  const relation = sessionProjectionRelation(a, b);
  return relation === "same" || relation === "partial";
}

/**
 * Session keys embed the agent id (`agent:main:...`), so the pair is the
 * complete canonical run identity. The `agentId === "main"` gate belongs to
 * the admission decision; this helper also rejects malformed empty values.
 */
export function ownerRunKey(sessionKey: unknown, runId: unknown): string | undefined {
  const session = optionalNonEmptyString(sessionKey);
  const run = optionalNonEmptyString(runId);
  return session === undefined || run === undefined ? undefined : JSON.stringify([session, run]);
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
  /** One canonical entry per host run; the map key deliberately omits sessionId. */
  private readonly entries = new Map<string, OwnerRunAdmission>();

  /**
   * Remembers a host-proven owner run. Re-admitting a tracked run is a no-op;
   * an exact id-less entry is upgraded when the host later supplies its
   * ephemeral session id. Returns true only when the bounded cap displaced the
   * oldest admission so the caller can report it.
   */
  admit(sessionKey: unknown, runId: unknown, sessionId?: unknown): boolean {
    const projection = normalizeRunProjection({ sessionKey, sessionId, runId });
    const key = ownerRunKey(projection.sessionKey, projection.runId);
    if (key === undefined || !isAgentSessionKey(projection.sessionKey, "main")) return false;
    const admission: OwnerRunAdmission = {
      sessionKey: projection.sessionKey!,
      runId: projection.runId!,
      ...(projection.sessionId === undefined ? {} : { sessionId: projection.sessionId }),
    };
    const exact = this.entries.get(key);
    if (exact) {
      if (exact.sessionId === undefined && admission.sessionId !== undefined) {
        this.entries.set(key, admission);
      } else if (exact.sessionId !== undefined && admission.sessionId !== undefined &&
          exact.sessionId !== admission.sessionId) {
        // Two different ephemeral sessions claiming one exact host run are
        // contradictory. Delete the old grant and admit neither.
        this.entries.delete(key);
      }
      return false;
    }
    // Host run ids are unique. A conflicting projection for an already known
    // run is not another grant, even when its session evidence is malformed.
    if ([...this.entries.values()].some((entry) => entry.runId === admission.runId)) return false;
    let evicted = false;
    if (this.entries.size >= MAX_OWNER_RUN_ADMISSIONS) {
      this.entries.delete(this.entries.keys().next().value as string);
      evicted = true;
    }
    this.entries.set(key, admission);
    return evicted;
  }

  revoke(sessionKey: unknown, runId: unknown, sessionId?: unknown): void {
    const candidate = normalizeRunProjection({ sessionKey, sessionId, runId });
    if (!isAgentSessionKey(candidate.sessionKey, "main")) return;
    for (const [key, admission] of this.entries) {
      if (revokesRunProjection(admission, candidate)) this.entries.delete(key);
    }
  }

  resolve(sessionKey: unknown, runId: unknown, sessionId?: unknown): OwnerRunAdmission | undefined {
    const candidate = normalizeRunProjection({ sessionKey, sessionId, runId });
    if (!isAgentSessionKey(candidate.sessionKey, "main")) return undefined;
    return [...this.entries.values()].find((entry) => sameRunProjection(entry, candidate));
  }

  /** Test/readability convenience over `resolve`; production callers use the admission itself. */
  has(sessionKey: unknown, runId: unknown, sessionId?: unknown): boolean {
    return this.resolve(sessionKey, runId, sessionId) !== undefined;
  }

  get size(): number {
    return this.entries.size;
  }
}
