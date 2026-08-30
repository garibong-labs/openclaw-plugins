/**
 * Owner-checkpoint delivery-receipt policy - pure state and decisions.
 *
 * Incident class: a scheduler-created owner progress checkpoint runs with
 * `delivery.mode=none` and is expected to publish its result through an
 * explicit messaging-tool send. When the run completes without ever calling
 * the messaging tool, no payload enters `message_sending`, so the existing
 * outbound guard sees nothing. The work is done, the result report is absent,
 * and nothing records the omission.
 *
 * This module closes that gap with a narrow completeness check:
 *
 * - `before_agent_run` registers an *eligible* checkpoint only when trusted
 *   scheduler provenance (hook context `trigger === "cron"`) coincides with
 *   the exact first-line marker in the checkpoint prompt. The marker alone is
 *   never authority; the provenance alone never opts a run in. Eligibility
 *   deliberately does not require a cron `jobId`: the installed embedded cron
 *   runner (`openclaw@2026.7.1-2`) receives `jobId` in `runEmbeddedAgent`
 *   but omits it from the `before_agent_run` hook context it assembles, so a
 *   `jobId` requirement would misclassify every real embedded checkpoint as
 *   ineligible. Only the CLI-runner path exposes `jobId` here; it is treated
 *   as an optional field that is never read for decisions and never logged.
 *   The target-build smoke proves eligibility behaviorally on both shapes
 *   (with and without `jobId`).
 * - `message_sent` counts a publication receipt only for a successful send
 *   with a message id whose correlation and destination match the eligible
 *   run exactly. The destination is derived from the trusted hook context at
 *   registration time, never from prompt text. A send whose destination
 *   metadata is absent is reported as *unverifiable*, distinct from a
 *   verified mismatch.
 * - `before_agent_finalize` decides: pass with a receipt, observe or revise
 *   without one.
 * - `agent_end` cleans up deterministically when the ending run's identity
 *   provably agrees with the tracked one; a size cap and TTL tombstones
 *   bound the state of abandoned runs without silently disarming pending
 *   checkpoints.
 *
 * ## Correlation rule (single source of truth)
 *
 * Every transition correlates through the same rule: the session key selects
 * the entry (the host guarantees `sessionKey` equality between the agent-run
 * hooks and outbound delivery hooks, while `runId` is *never* populated on
 * the installed outbound `message_sent` path - `createMessageSentEmitter`
 * and the telegram sent-hook builder both build the canonical context
 * without one), and run ids act as a consistency check:
 *
 * - *contradiction* (both sides carry a run id and they differ) always means
 *   "not the tracked run";
 * - the destructive `end` transition additionally requires *exact agreement*
 *   (`entry.runId === correlation.runId`, where both-absent counts as
 *   agreement because the pinned host builds both hook contexts from the
 *   same run params) - a run that cannot prove it is the tracked one can
 *   never silently disarm a pending checkpoint;
 * - two live registrations on one session key that cannot prove they are the
 *   same run (either run id absent, or ids differing) are indistinguishable
 *   at `message_sent` time, so tracking is dropped for both (fail open)
 *   rather than guessed at. A re-registration that proves the same run id is
 *   idempotent and preserves receipt and revise state.
 *
 * Everything here is pure and host-free: no I/O, no logging, no clock access
 * except through the injected `now`. Correlation identifiers live only in
 * this in-memory state; they are never part of a decision's outward shape.
 */

/**
 * Exact first-line marker of an owner progress checkpoint prompt. The marker
 * is a public contract constant, not content.
 */
export const OWNER_CHECKPOINT_MARKER = "[owner-progress-checkpoint:v1]";

/**
 * Stable stem shared by every versioned form of the marker. Used only to
 * recognize *near-miss* marker drift on trusted cron provenance (for a
 * content-free drift signal); never used as authority.
 */
export const OWNER_CHECKPOINT_MARKER_STEM = "[owner-progress-checkpoint";

/** Hook-context trigger value that identifies trusted scheduler provenance. */
export const TRUSTED_SCHEDULER_TRIGGER = "cron";

/** Upper bound on simultaneously tracked checkpoints (stale evicted first). */
export const MAX_TRACKED_CHECKPOINTS = 64;

/**
 * Age after which a pending checkpoint entry becomes a *stale tombstone*: it
 * stops arming enforcement (finalize reports it explicitly instead of
 * revising) but stays observable until the run ends, a new registration
 * replaces it, or the size cap evicts it. Stale entries are never silently
 * dropped by the clock alone.
 */
export const CHECKPOINT_TTL_MS = 6 * 60 * 60 * 1000;

/** Bounded number of finalize revise rounds *requested* per checkpoint. */
export const MAX_RECEIPT_REVISE_ATTEMPTS = 2;

/** Stable idempotency key for the finalize revise retry budget. */
export const RECEIPT_REVISE_IDEMPOTENCY_KEY =
  "acp_lifecycle_guard.receipt.owner_checkpoint_v1";

/**
 * Fixed, bounded revise instruction. It must stay free of identifiers,
 * prompt text, and destination values: the host echoes it into the model's
 * revise turn and may log it.
 */
export const RECEIPT_REVISE_INSTRUCTION =
  "Owner progress checkpoint incomplete: publish the checkpoint result now " +
  "with exactly one messaging-tool send to the conversation this run was " +
  "started for, then finish.";

/**
 * Conversation-target prefixes the host strips when normalizing conversation
 * ids. Mirrors the `TARGET_PREFIXES` set in the installed host's
 * hook-agent-context builder (`stripConversationPrefix`,
 * `openclaw@2026.7.1-2`) exactly; the host additionally strips the
 * channel/provider's own name as a prefix, which `normalizeConversationTarget`
 * also does.
 */
const TARGET_PREFIXES: readonly string[] = [
  "channel",
  "chat",
  "direct",
  "dm",
  "group",
  "thread",
  "user",
];

/**
 * Bound on repeated prefix stripping. The host strips a single wrapper per
 * site, but the two sides of a destination comparison pass through the
 * host's normalization a different number of times (the agent-hook context
 * id is host-stripped once; the outbound `to` is not stripped at all), so
 * this module strips *repeatedly* on both sides until no known wrapper
 * remains, making the comparison symmetric. The bound keeps it total.
 */
const MAX_TARGET_PREFIX_STRIPS = 8;

export type ReceiptMode = "observe" | "enforce";

/** Correlation fields captured for one eligible checkpoint. */
type CheckpointEntry = {
  /** Run id when the registering context carried one. */
  runId?: string;
  /** Normalized channel (provider) name of the original owner conversation. */
  channel: string;
  /** Normalized conversation target id of the original owner conversation. */
  conversation: string;
  /** True once an exact-destination successful send has been observed. */
  receiptConfirmed: boolean;
  /** Finalize revise rounds already *requested* for this checkpoint. */
  reviseAttempts: number;
  /** Registration time from the injected clock, for TTL staleness. */
  registeredAtMs: number;
  /** True once the TTL has passed: disarmed for enforcement, kept observable. */
  stale: boolean;
};

export type RegisterOutcome =
  /** Not an owner checkpoint (or not trusted provenance); leave untouched. */
  | { kind: "not_eligible" }
  /**
   * Trusted cron provenance whose prompt carries a *near-miss* of the marker
   * (the stable stem without the exact first-line form). Not tracked, but
   * worth a content-free drift signal so a contract version skew is not
   * silent.
   */
  | { kind: "marker_drift" }
  /** Marker and provenance match but a required correlation field is absent. */
  | { kind: "uncorrelatable" }
  /**
   * A live pending run already claims this session key and the two
   * registrations cannot prove they are the same run. Both are dropped.
   */
  | { kind: "ambiguous" }
  | { kind: "registered" };

export type SendOutcome =
  /** No tracked checkpoint matches this send; nothing to do. */
  | { kind: "unrelated" }
  /** Failed send, or a send the host reported without a message id. */
  | { kind: "not_a_receipt" }
  /**
   * Successful correlated send whose destination metadata is missing, so the
   * destination cannot be verified either way. Distinct from a verified
   * mismatch; never counts as a receipt.
   */
  | { kind: "unverifiable_target" }
  /** Successful send, but verifiably not to the original owner conversation. */
  | { kind: "target_mismatch" }
  /** First exact-destination successful receipt. */
  | { kind: "receipt" }
  /** Receipt was already confirmed; duplicate events are idempotent. */
  | { kind: "duplicate_receipt" };

export type FinalizeOutcome =
  /** No tracked checkpoint for this run; the guard stays out of the way. */
  | { kind: "unrelated" }
  /** Receipt confirmed; finalization proceeds untouched. */
  | { kind: "receipt_confirmed" }
  /** Observe mode: record the miss, never revise. */
  | { kind: "observed_missing" }
  /**
   * The tracked entry outlived the TTL without a receipt. Enforcement is
   * disarmed (a run this old must not be revised on stale correlation), but
   * the miss is reported explicitly instead of silently becoming
   * `unrelated`.
   */
  | { kind: "stale_missing" }
  /** Enforce mode: request one bounded revise round. */
  | { kind: "revise"; attempt: number }
  /**
   * Enforce mode with the bounded revise budget spent. The host's own
   * finalize retry accounting turns further revise requests into `continue`
   * (`normalizeBeforeAgentFinalizeResult` in the installed build), so the
   * run will finalize without a receipt; this outcome exists so the miss is
   * loudly recorded rather than silently described as delivered.
   */
  | { kind: "exhausted" };

/** Subset of the agent hook context this policy reads. */
export type CheckpointRunContext = {
  trigger?: string | undefined;
  /**
   * Declared by the host's `PluginHookAgentContext` but populated
   * inconsistently: the CLI-runner cron path exposes it, while the installed
   * embedded cron runner omits it from the `before_agent_run` context.
   * Accepted for shape compatibility only - never required for eligibility,
   * never read for decisions, never logged.
   */
  jobId?: string | undefined;
  runId?: string | undefined;
  sessionKey?: string | undefined;
  /** Channel/provider name of the originating conversation. */
  channel?: string | undefined;
  /** Conversation target id of the originating conversation. */
  channelId?: string | undefined;
};

/** Subset of the message_sent event/context this policy reads. */
export type CheckpointSendObservation = {
  sessionKey?: string | undefined;
  runId?: string | undefined;
  success: boolean;
  messageId?: string | undefined;
  /** Channel/provider name the payload was delivered on. */
  channelId?: string | undefined;
  /** Conversation the payload was delivered to. */
  conversationId?: string | undefined;
};

/** Correlation key shared by every lookup (see the module header). */
export type CheckpointCorrelation = {
  sessionKey?: string | undefined;
  runId?: string | undefined;
};

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * True when the prompt's first line is exactly the checkpoint marker. The
 * comparison tolerates a trailing carriage return from transport newline
 * normalization and nothing else: leading whitespace, prefixes, or a marker
 * that appears later in the prompt do not match.
 */
export function promptCarriesCheckpointMarker(prompt: unknown): boolean {
  if (typeof prompt !== "string") {
    return false;
  }
  const newlineIndex = prompt.indexOf("\n");
  const firstLine = newlineIndex === -1 ? prompt : prompt.slice(0, newlineIndex);
  return firstLine.replace(/\r$/u, "") === OWNER_CHECKPOINT_MARKER;
}

/**
 * True when the prompt carries the marker stem anywhere but is not an exact
 * marker carrier: a versioned variant, a decorated marker, or a marker that
 * slipped off the first line. Only consulted for trusted cron provenance,
 * and only to emit a stable content-free drift signal - never for
 * eligibility.
 */
export function promptNearCheckpointMarker(prompt: unknown): boolean {
  if (typeof prompt !== "string") {
    return false;
  }
  return (
    prompt.toLowerCase().includes(OWNER_CHECKPOINT_MARKER_STEM) &&
    !promptCarriesCheckpointMarker(prompt)
  );
}

/**
 * Strip known conversation-target wrappers (`channel:`, `dm:`, ... or the
 * channel's own name) the way the host does before exposing conversation ids
 * to agent hooks. The host strips one wrapper per site; because the two
 * sides of a destination comparison pass through the host a different number
 * of times, this strips *repeatedly* (bounded) so both sides land on the
 * same shape. Prefixes compare case-insensitively (host `normalizeKey`);
 * the remaining id keeps its case, because conversation ids are
 * case-sensitive on some channels. Unknown prefixes are preserved: this is
 * bounded normalization, not parsing.
 */
export function normalizeConversationTarget(
  value: string,
  channel: string,
): string {
  const channelKey = channel.trim().toLowerCase();
  let current = value;
  for (let round = 0; round < MAX_TARGET_PREFIX_STRIPS; round += 1) {
    const separatorIndex = current.indexOf(":");
    if (separatorIndex === -1) {
      return current;
    }
    const prefix = current.slice(0, separatorIndex).trim().toLowerCase();
    const suffix = current.slice(separatorIndex + 1).trim();
    if (suffix.length === 0) {
      return current;
    }
    if (!TARGET_PREFIXES.includes(prefix) && prefix !== channelKey) {
      return current;
    }
    current = suffix;
  }
  return current;
}

/** True when both sides carry a run id and the two ids differ. */
function runIdsContradict(
  entryRunId: string | undefined,
  correlationRunId: string | undefined,
): boolean {
  return (
    entryRunId !== undefined &&
    correlationRunId !== undefined &&
    entryRunId !== correlationRunId
  );
}

/**
 * Bounded in-memory correlation state for eligible owner checkpoints.
 *
 * Keys are session keys; see the module header for the shared correlation
 * rule and for why `runId` is only ever a consistency check.
 */
export class CheckpointReceiptTracker {
  private readonly entries = new Map<string, CheckpointEntry>();
  private readonly now: () => number;
  private evictions = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Number of entries removed by bounded-state pressure (size cap, or a
   * stale tombstone displaced by a new registration) since the last call.
   * Returned-and-reset so the hook layer can surface every removal as a
   * stable content-free log signal instead of letting bounded state disarm
   * checkpoints silently.
   */
  takeEvictions(): number {
    const count = this.evictions;
    this.evictions = 0;
    return count;
  }

  /**
   * Mark entries older than the TTL stale. Runs before every state
   * transition. Deliberately never deletes: a stale entry stops arming
   * enforcement but stays observable until `end`, replacement, or cap
   * eviction removes it.
   */
  private prune(): void {
    const cutoff = this.now() - CHECKPOINT_TTL_MS;
    for (const entry of this.entries.values()) {
      if (entry.registeredAtMs <= cutoff) {
        entry.stale = true;
      }
    }
  }

  /**
   * Shared non-destructive lookup: session key selects the entry; a run-id
   * contradiction rejects it. Used by `recordSend` and `finalize` so the
   * correlation rule cannot diverge between transitions.
   */
  private lookup(
    correlation: CheckpointCorrelation,
  ): { sessionKey: string; entry: CheckpointEntry } | undefined {
    const sessionKey = nonBlank(correlation.sessionKey);
    if (sessionKey === undefined) {
      return undefined;
    }
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) {
      return undefined;
    }
    if (runIdsContradict(entry.runId, nonBlank(correlation.runId))) {
      return undefined;
    }
    return { sessionKey, entry };
  }

  /** Evict entries beyond the size cap: stale tombstones first, then oldest. */
  private enforceCap(): void {
    while (this.entries.size > MAX_TRACKED_CHECKPOINTS) {
      let victim: string | undefined;
      for (const [key, entry] of this.entries) {
        if (entry.stale) {
          victim = key;
          break;
        }
        victim ??= key;
      }
      if (victim === undefined) {
        break;
      }
      this.entries.delete(victim);
      this.evictions += 1;
    }
  }

  /**
   * Evaluate one `before_agent_run` and track the run when it is an eligible
   * owner checkpoint. Eligibility requires *both* trusted scheduler
   * provenance (`trigger === "cron"`) and the exact first-line marker; a run
   * carrying only one of the two is not eligible and stays untouched, except
   * that a cron prompt carrying a *near-miss* of the marker yields the
   * content-free `marker_drift` signal. A cron `jobId` is deliberately not
   * required (the installed embedded cron runner omits it from this hook's
   * context; see the module header). A marker-and-provenance run whose
   * context lacks the session key or destination fields cannot be correlated
   * and also stays untouched.
   *
   * Re-registration semantics: a registration that proves the same run id as
   * the live tracked entry is idempotent (receipt and revise state are
   * preserved); one that cannot prove it drops tracking for the session key
   * entirely (fail open). A stale tombstone never blocks a new registration;
   * displacing one counts as an eviction so it stays observable.
   */
  register(prompt: unknown, ctx: CheckpointRunContext): RegisterOutcome {
    this.prune();
    if (
      nonBlank(ctx.trigger) !== TRUSTED_SCHEDULER_TRIGGER ||
      !promptCarriesCheckpointMarker(prompt)
    ) {
      if (
        nonBlank(ctx.trigger) === TRUSTED_SCHEDULER_TRIGGER &&
        promptNearCheckpointMarker(prompt)
      ) {
        return { kind: "marker_drift" };
      }
      return { kind: "not_eligible" };
    }

    const sessionKey = nonBlank(ctx.sessionKey);
    const channel = nonBlank(ctx.channel);
    const conversation = nonBlank(ctx.channelId);
    if (
      sessionKey === undefined ||
      channel === undefined ||
      conversation === undefined
    ) {
      return { kind: "uncorrelatable" };
    }

    const runId = nonBlank(ctx.runId);
    const existing = this.entries.get(sessionKey);
    if (existing !== undefined && !existing.stale) {
      if (runId !== undefined && existing.runId === runId) {
        // Provably the same run re-registering: idempotent, keep state.
        return { kind: "registered" };
      }
      // Two live registrations on one session key that cannot prove they are
      // the same run cannot be told apart at message_sent time (outbound
      // hooks correlate by session key only), so neither is guarded: drop
      // the pending entry and track nothing.
      this.entries.delete(sessionKey);
      return { kind: "ambiguous" };
    }
    if (existing !== undefined) {
      // A stale tombstone is disarmed state; replacing it is an eviction.
      this.entries.delete(sessionKey);
      this.evictions += 1;
    }

    this.entries.set(sessionKey, {
      ...(runId === undefined ? {} : { runId }),
      channel: channel.toLowerCase(),
      conversation: normalizeConversationTarget(conversation, channel),
      receiptConfirmed: false,
      reviseAttempts: 0,
      registeredAtMs: this.now(),
      stale: false,
    });
    this.enforceCap();
    return { kind: "registered" };
  }

  /**
   * Evaluate one `message_sent`. A receipt requires a tracked checkpoint
   * whose correlation matches (shared lookup rule), a successful send, a
   * non-empty message id, and an exact destination match against the
   * conversation captured from trusted context at registration. A correlated
   * successful send without destination metadata is unverifiable, not a
   * mismatch. Duplicate matching events are idempotent. A late receipt on a
   * stale entry still counts: better a truthful late confirmation than a
   * false missing-receipt signal.
   */
  recordSend(observation: CheckpointSendObservation): SendOutcome {
    this.prune();
    const found = this.lookup(observation);
    if (found === undefined) {
      return { kind: "unrelated" };
    }
    const { entry } = found;

    if (
      observation.success !== true ||
      nonBlank(observation.messageId) === undefined
    ) {
      return { kind: "not_a_receipt" };
    }

    const channel = nonBlank(observation.channelId);
    const conversation = nonBlank(observation.conversationId);
    if (channel === undefined || conversation === undefined) {
      return { kind: "unverifiable_target" };
    }
    if (
      channel.toLowerCase() !== entry.channel ||
      normalizeConversationTarget(conversation, channel) !== entry.conversation
    ) {
      return { kind: "target_mismatch" };
    }

    if (entry.receiptConfirmed) {
      return { kind: "duplicate_receipt" };
    }
    entry.receiptConfirmed = true;
    return { kind: "receipt" };
  }

  /**
   * Evaluate one `before_agent_finalize` for the given mode.
   *
   * Revise rounds are bounded per checkpoint, and the counter counts
   * *requested* rounds. The installed host merges finalize results across
   * plugins (`mergeBeforeAgentFinalize`: another plugin's `finalize` wins
   * over this guard's `revise`) and acknowledges nothing back to handlers,
   * so a requested round is not always an applied one. The host's own retry
   * accounting (`normalizeBeforeAgentFinalizeResult`, keyed by run id and
   * this guard's idempotency key, charged only when a revise decision wins
   * the merge) is the authoritative bound on *applied* rounds. When another
   * plugin's decision wins, this guard under-requests rather than
   * over-revises - it degrades toward finalizing without a receipt, which is
   * this repository's fail-open direction, and the miss is still recorded
   * loudly through the `exhausted` outcome. The target-build smoke pins both
   * sides of this contract.
   */
  finalize(
    correlation: CheckpointCorrelation,
    mode: ReceiptMode,
  ): FinalizeOutcome {
    this.prune();
    const found = this.lookup(correlation);
    if (found === undefined) {
      return { kind: "unrelated" };
    }
    const { entry } = found;
    if (entry.receiptConfirmed) {
      return { kind: "receipt_confirmed" };
    }
    if (entry.stale) {
      // Disarmed by the TTL, but explicitly observable - never silent.
      return { kind: "stale_missing" };
    }
    if (mode !== "enforce") {
      return { kind: "observed_missing" };
    }
    if (entry.reviseAttempts >= MAX_RECEIPT_REVISE_ATTEMPTS) {
      return { kind: "exhausted" };
    }
    entry.reviseAttempts += 1;
    return { kind: "revise", attempt: entry.reviseAttempts };
  }

  /**
   * Deterministic cleanup on `agent_end` and other terminal paths. The entry
   * is removed only when the ending run's identity *exactly agrees* with the
   * tracked one: both run ids present and equal, or both absent (the pinned
   * host derives both hook contexts from the same run params, so matching
   * absence is the same-run shape). A run that carries a different id - or
   * that cannot prove identity because exactly one side carries an id -
   * never disarms a pending checkpoint; such entries stay bounded by the
   * TTL tombstone and the size cap instead.
   */
  end(correlation: CheckpointCorrelation): void {
    this.prune();
    const sessionKey = nonBlank(correlation.sessionKey);
    if (sessionKey === undefined) {
      return;
    }
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) {
      return;
    }
    if (entry.runId !== nonBlank(correlation.runId)) {
      return;
    }
    this.entries.delete(sessionKey);
  }
}
