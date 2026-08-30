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
 *   scheduler provenance (hook context `trigger === "cron"` plus a cron job
 *   id) coincides with the exact first-line marker in the checkpoint prompt.
 *   The marker alone is never authority; the provenance alone never opts a
 *   run in.
 * - `message_sent` counts a publication receipt only for a successful send
 *   with a message id whose correlation and destination match the eligible
 *   run exactly. The destination is derived from the trusted hook context at
 *   registration time, never from prompt text.
 * - `before_agent_finalize` decides: pass with a receipt, observe or revise
 *   without one.
 * - `agent_end` cleans up deterministically; a size cap and TTL bound the
 *   state of abandoned runs.
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

/** Hook-context trigger value that identifies trusted scheduler provenance. */
export const TRUSTED_SCHEDULER_TRIGGER = "cron";

/** Upper bound on simultaneously tracked checkpoints (oldest evicted first). */
export const MAX_TRACKED_CHECKPOINTS = 64;

/** Age after which an abandoned checkpoint entry is pruned. */
export const CHECKPOINT_TTL_MS = 6 * 60 * 60 * 1000;

/** Bounded number of finalize revise rounds requested per checkpoint. */
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
 * ids (mirrors `TARGET_PREFIXES` in the host's hook-agent-context builder).
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
  /** Finalize revise rounds already requested for this checkpoint. */
  reviseAttempts: number;
  /** Registration time from the injected clock, for TTL pruning. */
  registeredAtMs: number;
};

export type RegisterOutcome =
  /** Not an owner checkpoint (or not trusted provenance); leave untouched. */
  | { kind: "not_eligible" }
  /** Marker and provenance match but a required correlation field is absent. */
  | { kind: "uncorrelatable" }
  /** A different pending run already claims this session key. */
  | { kind: "ambiguous" }
  | { kind: "registered" };

export type SendOutcome =
  /** No tracked checkpoint matches this send; nothing to do. */
  | { kind: "unrelated" }
  /** Failed send, or a send the host reported without a message id. */
  | { kind: "not_a_receipt" }
  /** Successful send, but not to the original owner conversation. */
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

/** Correlation key shared by the finalize and end transitions. */
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
 * Strip one known conversation-target prefix (`channel:`, `dm:`, ... or the
 * channel's own name) the way the host does before exposing conversation ids
 * to agent hooks, so both sides of a destination comparison use the same
 * shape. Unknown prefixes are preserved: this is bounded normalization, not
 * parsing.
 */
export function normalizeConversationTarget(
  value: string,
  channel: string,
): string {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) {
    return value;
  }
  const prefix = value.slice(0, separatorIndex).trim().toLowerCase();
  const suffix = value.slice(separatorIndex + 1).trim();
  if (suffix.length === 0) {
    return value;
  }
  if (TARGET_PREFIXES.includes(prefix) || prefix === channel.toLowerCase()) {
    return suffix;
  }
  return value;
}

/**
 * Bounded in-memory correlation state for eligible owner checkpoints.
 *
 * Keys are session keys: the host guarantees `sessionKey` equality between
 * the agent-run hooks and outbound delivery hooks, while `runId` is not yet
 * plumbed through the outbound path (see `PluginHookMessageContext` in the
 * installed build). `runId` is therefore used only as a consistency check
 * when both sides carry one.
 */
export class CheckpointReceiptTracker {
  private readonly entries = new Map<string, CheckpointEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drop entries older than the TTL. Runs before every state transition. */
  private prune(): void {
    const cutoff = this.now() - CHECKPOINT_TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.registeredAtMs <= cutoff) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Evaluate one `before_agent_run` and track the run when it is an eligible
   * owner checkpoint. Eligibility requires *both* trusted scheduler
   * provenance (`trigger === "cron"` plus a job id) and the exact first-line
   * marker; a run carrying only one of the two is not eligible and stays
   * untouched. A marker-and-provenance run whose context lacks the session
   * key or destination fields cannot be correlated and also stays untouched.
   */
  register(prompt: unknown, ctx: CheckpointRunContext): RegisterOutcome {
    this.prune();
    if (
      nonBlank(ctx.trigger) !== TRUSTED_SCHEDULER_TRIGGER ||
      nonBlank(ctx.jobId) === undefined ||
      !promptCarriesCheckpointMarker(prompt)
    ) {
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
    if (existing !== undefined && existing.runId !== runId) {
      // Two distinct pending runs on one session key cannot be told apart at
      // message_sent time (outbound hooks correlate by session key only), so
      // neither is guarded: drop the pending entry and track nothing.
      this.entries.delete(sessionKey);
      return { kind: "ambiguous" };
    }

    this.entries.delete(sessionKey);
    this.entries.set(sessionKey, {
      ...(runId === undefined ? {} : { runId }),
      channel: channel.toLowerCase(),
      conversation: normalizeConversationTarget(conversation, channel),
      receiptConfirmed: false,
      reviseAttempts: 0,
      registeredAtMs: this.now(),
    });
    while (this.entries.size > MAX_TRACKED_CHECKPOINTS) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
    return { kind: "registered" };
  }

  /**
   * Evaluate one `message_sent`. A receipt requires a tracked checkpoint
   * whose session key matches, a successful send, a non-empty message id, a
   * consistent run id when both sides carry one, and an exact destination
   * match against the conversation captured from trusted context at
   * registration. Duplicate matching events are idempotent.
   */
  recordSend(observation: CheckpointSendObservation): SendOutcome {
    this.prune();
    const sessionKey = nonBlank(observation.sessionKey);
    const entry =
      sessionKey === undefined ? undefined : this.entries.get(sessionKey);
    if (entry === undefined) {
      return { kind: "unrelated" };
    }

    const runId = nonBlank(observation.runId);
    if (
      runId !== undefined &&
      entry.runId !== undefined &&
      runId !== entry.runId
    ) {
      return { kind: "unrelated" };
    }

    if (
      observation.success !== true ||
      nonBlank(observation.messageId) === undefined
    ) {
      return { kind: "not_a_receipt" };
    }

    const channel = nonBlank(observation.channelId);
    const conversation = nonBlank(observation.conversationId);
    if (
      channel === undefined ||
      conversation === undefined ||
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
   * Evaluate one `before_agent_finalize` for the given mode. Revise rounds
   * are bounded per checkpoint; the counter survives across finalize calls
   * for the same run and is cleaned with the entry.
   */
  finalize(
    correlation: CheckpointCorrelation,
    mode: ReceiptMode,
  ): FinalizeOutcome {
    this.prune();
    const sessionKey = nonBlank(correlation.sessionKey);
    const entry =
      sessionKey === undefined ? undefined : this.entries.get(sessionKey);
    if (entry === undefined) {
      return { kind: "unrelated" };
    }
    const runId = nonBlank(correlation.runId);
    if (
      runId !== undefined &&
      entry.runId !== undefined &&
      runId !== entry.runId
    ) {
      return { kind: "unrelated" };
    }
    if (entry.receiptConfirmed) {
      return { kind: "receipt_confirmed" };
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
   * is removed only when the ending run is the tracked one: a different
   * run id ending on the same session key leaves the pending checkpoint in
   * place (it is bounded by the TTL and size cap regardless).
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
    const runId = nonBlank(correlation.runId);
    if (
      runId !== undefined &&
      entry.runId !== undefined &&
      runId !== entry.runId
    ) {
      return;
    }
    this.entries.delete(sessionKey);
  }
}
