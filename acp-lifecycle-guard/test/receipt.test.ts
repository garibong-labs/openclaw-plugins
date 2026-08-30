import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_GUARD_CONFIG, resolveGuardConfig } from "../src/config.ts";
import type { GuardConfig } from "../src/config.ts";
import type { GuardHostApi } from "../src/host-contract.ts";
import { ReasonCodes } from "../src/lifecycle/reason-codes.ts";
import {
  CHECKPOINT_TTL_MS,
  CheckpointReceiptTracker,
  MAX_RECEIPT_REVISE_ATTEMPTS,
  MAX_TRACKED_CHECKPOINTS,
  OWNER_CHECKPOINT_MARKER,
  RECEIPT_REVISE_IDEMPOTENCY_KEY,
  RECEIPT_REVISE_INSTRUCTION,
  normalizeConversationTarget,
  promptCarriesCheckpointMarker,
  promptNearCheckpointMarker,
} from "../src/receipt/checkpoint.ts";
import { PLUGIN_ID, createReceiptHookHandlers } from "../src/register.ts";
import {
  CHECKPOINT_PROMPT_MARKER_NOT_FIRST,
  CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT,
  CHECKPOINT_REPORT_ACTIVE,
  CHECKPOINT_REPORT_BLOCKED,
  CHECKPOINT_REPORT_TERMINAL_FAILURE,
  CHECKPOINT_REPORT_TERMINAL_GREEN,
  CHECKPOINT_RUN_CONTEXT,
  CHECKPOINT_RUN_CONTEXT_WITH_JOB_ID,
  CHECKPOINT_SEND_CONTEXT,
  OWNER_CHECKPOINT_PROMPT,
  WRONG_TARGET_SEND_CONTEXT,
} from "./fixtures.ts";

const ENFORCE_RECEIPT_CONFIG: GuardConfig = {
  ...DEFAULT_GUARD_CONFIG,
  ownerCheckpointReceiptMode: "enforce",
};

type LoggedCall = { level: string; args: unknown[] };

function createFakeApi(pluginConfig?: Record<string, unknown>): {
  api: Pick<GuardHostApi, "logger" | "pluginConfig">;
  logs: LoggedCall[];
} {
  const logs: LoggedCall[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push({ level, args });
    };
  return {
    api: {
      logger: {
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      },
      ...(pluginConfig === undefined ? {} : { pluginConfig }),
    },
    logs,
  };
}

function flatten(logs: LoggedCall[]): string {
  return logs
    .map((entry) =>
      entry.args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "),
    )
    .join("\n");
}

function successfulSend(
  target: { channelId: string; conversationId: string; sessionKey: string },
  messageId = "example-message-1",
): Parameters<CheckpointReceiptTracker["recordSend"]>[0] {
  return { ...target, success: true, messageId };
}

const FINALIZE_KEY = {
  sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
  runId: CHECKPOINT_RUN_CONTEXT.runId,
} as const;

describe("checkpoint marker recognition", () => {
  it("accepts the exact first-line marker", () => {
    assert.equal(promptCarriesCheckpointMarker(OWNER_CHECKPOINT_PROMPT), true);
    assert.equal(promptCarriesCheckpointMarker(OWNER_CHECKPOINT_MARKER), true);
    assert.equal(
      promptCarriesCheckpointMarker(`${OWNER_CHECKPOINT_MARKER}\r\nbody`),
      true,
    );
  });

  it("rejects anything that is not the exact first line", () => {
    assert.equal(
      promptCarriesCheckpointMarker(CHECKPOINT_PROMPT_MARKER_NOT_FIRST),
      false,
    );
    assert.equal(
      promptCarriesCheckpointMarker(` ${OWNER_CHECKPOINT_MARKER}`),
      false,
    );
    assert.equal(
      promptCarriesCheckpointMarker(`${OWNER_CHECKPOINT_MARKER} extra`),
      false,
    );
    assert.equal(promptCarriesCheckpointMarker(undefined), false);
    assert.equal(promptCarriesCheckpointMarker(42), false);
  });

  it("recognizes near-miss marker drift without treating carriers as drift", () => {
    for (const nearMiss of [
      CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT,
      CHECKPOINT_PROMPT_MARKER_NOT_FIRST,
      ` ${OWNER_CHECKPOINT_MARKER}`,
      `${OWNER_CHECKPOINT_MARKER} extra`,
    ]) {
      assert.equal(promptNearCheckpointMarker(nearMiss), true);
    }
    // Exact carriers and unrelated prompts are not drift.
    assert.equal(promptNearCheckpointMarker(OWNER_CHECKPOINT_PROMPT), false);
    assert.equal(promptNearCheckpointMarker("예시 일반 크론 프롬프트"), false);
    assert.equal(promptNearCheckpointMarker(undefined), false);
  });
});

describe("conversation target normalization", () => {
  it("strips known target prefixes and the channel's own prefix", () => {
    for (const prefixed of [
      "channel:example-conversation-1",
      "dm:example-conversation-1",
      "example-messenger:example-conversation-1",
      "example-conversation-1",
    ]) {
      assert.equal(
        normalizeConversationTarget(prefixed, "example-messenger"),
        "example-conversation-1",
      );
    }
  });

  it("strips repeated wrappers so both comparison sides land on one shape", () => {
    // The host strips one wrapper per site, and the two sides of a
    // destination comparison pass through it a different number of times;
    // bounded repeated stripping makes the comparison symmetric.
    for (const wrapped of [
      "channel:dm:example-conversation-1",
      "example-messenger:channel:example-conversation-1",
      "thread:group:chat:example-conversation-1",
    ]) {
      assert.equal(
        normalizeConversationTarget(wrapped, "example-messenger"),
        "example-conversation-1",
      );
    }
  });

  it("compares prefixes case-insensitively but preserves id case", () => {
    assert.equal(
      normalizeConversationTarget("Channel:Example-Conversation-1", "example-messenger"),
      "Example-Conversation-1",
    );
    assert.equal(
      normalizeConversationTarget("EXAMPLE-MESSENGER:example-conversation-1", "example-messenger"),
      "example-conversation-1",
    );
  });

  it("preserves unknown prefixes and empty suffixes", () => {
    assert.equal(
      normalizeConversationTarget("other:example-conversation-1", "example-messenger"),
      "other:example-conversation-1",
    );
    assert.equal(
      normalizeConversationTarget("channel:", "example-messenger"),
      "channel:",
    );
  });
});

describe("tracker eligibility", () => {
  it("registers only when provenance and marker coincide", () => {
    const tracker = new CheckpointReceiptTracker();
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT).kind,
      "registered",
    );
    assert.equal(tracker.size, 1);
  });

  it("registers the installed embedded shape, which carries no jobId", () => {
    // The authoritative installed before_agent_run context on the embedded
    // cron path omits jobId, so eligibility must hold without it - and the
    // resulting entry must be fully receipt-enforced, not just tracked.
    const tracker = new CheckpointReceiptTracker();
    assert.equal("jobId" in CHECKPOINT_RUN_CONTEXT, false);
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT).kind,
      "registered",
    );
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "revise");
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "receipt",
    );
    assert.equal(
      tracker.finalize(FINALIZE_KEY, "enforce").kind,
      "receipt_confirmed",
    );
  });

  it("treats a present jobId as inert (CLI-runner cron shape)", () => {
    const tracker = new CheckpointReceiptTracker();
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT_WITH_JOB_ID)
        .kind,
      "registered",
    );
    assert.equal(tracker.size, 1);
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "revise");
  });

  it("ignores the marker from an unrelated non-cron turn", () => {
    const tracker = new CheckpointReceiptTracker();
    for (const ctx of [
      { ...CHECKPOINT_RUN_CONTEXT, trigger: undefined },
      { ...CHECKPOINT_RUN_CONTEXT, trigger: "user" },
      { ...CHECKPOINT_RUN_CONTEXT, trigger: "manual" },
      // A jobId without cron provenance never opts a run in either.
      { ...CHECKPOINT_RUN_CONTEXT_WITH_JOB_ID, trigger: "user" },
    ]) {
      assert.equal(
        tracker.register(OWNER_CHECKPOINT_PROMPT, ctx).kind,
        "not_eligible",
      );
    }
    assert.equal(tracker.size, 0);
  });

  it("ignores cron runs without the marker", () => {
    const tracker = new CheckpointReceiptTracker();
    assert.equal(
      tracker.register("예시 일반 크론 프롬프트", CHECKPOINT_RUN_CONTEXT).kind,
      "not_eligible",
    );
    // A cron prompt whose marker slipped off the first line is not tracked
    // either, but surfaces as the content-free drift signal.
    assert.equal(
      tracker.register(CHECKPOINT_PROMPT_MARKER_NOT_FIRST, CHECKPOINT_RUN_CONTEXT)
        .kind,
      "marker_drift",
    );
    assert.equal(tracker.size, 0);
  });

  it("declines runs with missing correlation fields", () => {
    const tracker = new CheckpointReceiptTracker();
    for (const missing of ["sessionKey", "channel", "channelId"] as const) {
      const ctx = { ...CHECKPOINT_RUN_CONTEXT, [missing]: undefined };
      assert.equal(
        tracker.register(OWNER_CHECKPOINT_PROMPT, ctx).kind,
        "uncorrelatable",
      );
    }
    assert.equal(tracker.size, 0);
  });

  it("signals near-miss marker drift only for trusted cron provenance", () => {
    const tracker = new CheckpointReceiptTracker();
    for (const nearMiss of [
      CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT,
      CHECKPOINT_PROMPT_MARKER_NOT_FIRST,
    ]) {
      assert.equal(
        tracker.register(nearMiss, CHECKPOINT_RUN_CONTEXT).kind,
        "marker_drift",
      );
    }
    // Untrusted provenance never produces the drift signal, and exact
    // unrelated cron prompts stay silent.
    assert.equal(
      tracker.register(CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT, {
        ...CHECKPOINT_RUN_CONTEXT,
        trigger: "user",
      }).kind,
      "not_eligible",
    );
    assert.equal(
      tracker.register("예시 일반 크론 프롬프트", CHECKPOINT_RUN_CONTEXT).kind,
      "not_eligible",
    );
    assert.equal(tracker.size, 0);
  });

  it("drops tracking when a second run makes the session key ambiguous", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    const outcome = tracker.register(OWNER_CHECKPOINT_PROMPT, {
      ...CHECKPOINT_RUN_CONTEXT,
      runId: "example-run-2",
    });
    assert.equal(outcome.kind, "ambiguous");
    assert.equal(tracker.size, 0);
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "unrelated");
  });

  it("treats registrations that cannot prove the same run as ambiguous", () => {
    // Two run-id-less registrations are indistinguishable runs.
    const withoutRunId = { ...CHECKPOINT_RUN_CONTEXT, runId: undefined };
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, withoutRunId);
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, withoutRunId).kind,
      "ambiguous",
    );
    assert.equal(tracker.size, 0);

    // A run-id-less registration over a tracked run with an id, and the
    // reverse, are equally unprovable.
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, withoutRunId).kind,
      "ambiguous",
    );
    assert.equal(tracker.size, 0);
    tracker.register(OWNER_CHECKPOINT_PROMPT, withoutRunId);
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT).kind,
      "ambiguous",
    );
    assert.equal(tracker.size, 0);
  });

  it("keeps receipt state across a provable same-run re-registration", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "revise");
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "receipt",
    );

    // Same run id registers again (e.g. another gate pass in one run).
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT).kind,
      "registered",
    );
    assert.equal(tracker.size, 1);
    // The confirmed receipt survived - no false missing-receipt revise.
    assert.equal(
      tracker.finalize(FINALIZE_KEY, "enforce").kind,
      "receipt_confirmed",
    );

    // A pending checkpoint still revises after re-registration; there is no
    // local budget to reset (the host's per-run accounting is authoritative).
    const pendingTracker = new CheckpointReceiptTracker();
    pendingTracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.deepEqual(pendingTracker.finalize(FINALIZE_KEY, "enforce"), {
      kind: "revise",
    });
    pendingTracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.deepEqual(pendingTracker.finalize(FINALIZE_KEY, "enforce"), {
      kind: "revise",
    });
  });
});

describe("tracker receipts", () => {
  const REPORTS = [
    CHECKPOINT_REPORT_TERMINAL_GREEN,
    CHECKPOINT_REPORT_TERMINAL_FAILURE,
    CHECKPOINT_REPORT_BLOCKED,
    CHECKPOINT_REPORT_ACTIVE,
  ];

  it("accepts an exact-destination receipt regardless of reported state", () => {
    for (const report of REPORTS) {
      const tracker = new CheckpointReceiptTracker();
      tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
      assert.ok(report.length > 0);
      assert.equal(
        tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
        "receipt",
      );
      assert.equal(
        tracker.finalize(FINALIZE_KEY, "enforce").kind,
        "receipt_confirmed",
      );
    }
  });

  it("passes after a failed send followed by an exact-target success", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.recordSend({
        ...CHECKPOINT_SEND_CONTEXT,
        success: false,
      }).kind,
      "not_a_receipt",
    );
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "receipt",
    );
    assert.equal(
      tracker.finalize(FINALIZE_KEY, "enforce").kind,
      "receipt_confirmed",
    );
  });

  it("does not count success to the wrong target", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.recordSend(successfulSend(WRONG_TARGET_SEND_CONTEXT)).kind,
      "target_mismatch",
    );
    assert.equal(
      tracker.recordSend(
        successfulSend({
          ...CHECKPOINT_SEND_CONTEXT,
          channelId: "example-other-messenger",
        }),
      ).kind,
      "target_mismatch",
    );
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "revise");
  });

  it("accepts a prefixed form of the exact destination", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.recordSend(
        successfulSend({
          ...CHECKPOINT_SEND_CONTEXT,
          conversationId: "channel:example-conversation-1",
        }),
      ).kind,
      "receipt",
    );
  });

  it("matches asymmetrically wrapped forms of one destination", () => {
    // Registration side: the host already stripped one wrapper, one remains.
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, {
      ...CHECKPOINT_RUN_CONTEXT,
      channelId: "dm:example-conversation-1",
    });
    // Send side: the raw outbound target still carries both wrappers.
    assert.equal(
      tracker.recordSend(
        successfulSend({
          ...CHECKPOINT_SEND_CONTEXT,
          conversationId: "channel:dm:example-conversation-1",
        }),
      ).kind,
      "receipt",
    );
  });

  it("keeps conversation ids case-sensitive after wrapper stripping", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.recordSend(
        successfulSend({
          ...CHECKPOINT_SEND_CONTEXT,
          conversationId: "channel:EXAMPLE-CONVERSATION-1",
        }),
      ).kind,
      "target_mismatch",
    );
  });

  it("reports missing destination metadata as unverifiable, not mismatch", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    for (const overrides of [
      { channelId: undefined },
      { conversationId: undefined },
      { channelId: "   ", conversationId: undefined },
    ]) {
      assert.equal(
        tracker.recordSend({
          ...successfulSend(CHECKPOINT_SEND_CONTEXT),
          ...overrides,
        }).kind,
        "unverifiable_target",
      );
    }
    // An unverifiable send never confirms the receipt.
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "revise");
  });

  it("requires a non-empty message id", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    for (const messageId of [undefined, "", "   "]) {
      assert.equal(
        tracker.recordSend({
          ...CHECKPOINT_SEND_CONTEXT,
          success: true,
          ...(messageId === undefined ? {} : { messageId }),
        }).kind,
        "not_a_receipt",
      );
    }
  });

  it("treats duplicate matching receipt events idempotently", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "receipt",
    );
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "duplicate_receipt",
    );
    assert.equal(
      tracker.finalize(FINALIZE_KEY, "enforce").kind,
      "receipt_confirmed",
    );
  });

  it("ignores sends from other sessions and mismatched run ids", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.recordSend(
        successfulSend({
          ...CHECKPOINT_SEND_CONTEXT,
          sessionKey: "example-session-key-9",
        }),
      ).kind,
      "unrelated",
    );
    assert.equal(
      tracker.recordSend({
        ...successfulSend(CHECKPOINT_SEND_CONTEXT),
        runId: "example-run-9",
      }).kind,
      "unrelated",
    );
  });
});

describe("tracker finalize decisions", () => {
  it("observes a missing receipt without revising", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.deepEqual(tracker.finalize(FINALIZE_KEY, "observe"), {
      kind: "observed_missing",
    });
    // Observe mode never revises, no matter how many rounds pass.
    assert.deepEqual(tracker.finalize(FINALIZE_KEY, "observe"), {
      kind: "observed_missing",
    });
  });

  it("keeps requesting the idempotent revise without local budget accounting", () => {
    // The installed host merges finalize results across plugins without
    // acknowledging which decision won, so a local requested-rounds budget
    // would be consumed by other plugins' winning decisions. The guard
    // therefore requests the same bounded revise on every receipt-less
    // round and relies on the host's winning-decision accounting (charged
    // only when this guard's revise wins the merge) to bound applied
    // rounds - there is no plugin-authored exhausted state.
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    for (let round = 0; round < MAX_RECEIPT_REVISE_ATTEMPTS + 2; round += 1) {
      assert.deepEqual(tracker.finalize(FINALIZE_KEY, "enforce"), {
        kind: "revise",
      });
    }
  });

  it("stays out of unrelated finalizations", () => {
    const tracker = new CheckpointReceiptTracker();
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "unrelated");
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.finalize({ sessionKey: "example-session-key-9" }, "enforce").kind,
      "unrelated",
    );
    assert.equal(
      tracker.finalize(
        { sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey, runId: "example-run-9" },
        "enforce",
      ).kind,
      "unrelated",
    );
  });
});

describe("tracker cleanup and bounds", () => {
  it("cleans on agent end only with proven run identity", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    // A proven-different run id changes nothing.
    assert.deepEqual(
      tracker.end({
        sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
        runId: "example-run-9",
      }),
      { kind: "unrelated" },
    );
    assert.equal(tracker.size, 1);
    // Both ids present and equal is the only deleting shape.
    assert.deepEqual(tracker.end(FINALIZE_KEY), { kind: "cleaned" });
    assert.equal(tracker.size, 0);
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "unrelated");
  });

  it("never lets an unprovable run disarm a tracked checkpoint on end", () => {
    // Tracked run carries an id; an end without one cannot prove identity.
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.deepEqual(
      tracker.end({ sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey }),
      { kind: "retained_unproven" },
    );
    assert.equal(tracker.size, 1);
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "revise");

    // Tracked run has no id: neither an id-carrying end nor an id-less end
    // can prove identity - matching absence is NOT proof of the same run.
    const idlessTracker = new CheckpointReceiptTracker();
    idlessTracker.register(OWNER_CHECKPOINT_PROMPT, {
      ...CHECKPOINT_RUN_CONTEXT,
      runId: undefined,
    });
    assert.deepEqual(
      idlessTracker.end({
        sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
        runId: "example-run-9",
      }),
      { kind: "retained_unproven" },
    );
    assert.equal(idlessTracker.size, 1);
    assert.deepEqual(
      idlessTracker.end({ sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey }),
      { kind: "retained_unproven" },
    );
    assert.equal(idlessTracker.size, 1);
  });

  it("keeps guarding an id-less checkpoint through an unrelated id-less end", () => {
    // The concrete interleaving: id-less checkpoint A is tracked, an
    // unrelated id-less run B ends on the same session key, and A must
    // remain guarded - its receipt still confirms and its finalize still
    // enforces.
    const idlessKey = { sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey };
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, {
      ...CHECKPOINT_RUN_CONTEXT,
      runId: undefined,
    });
    assert.deepEqual(tracker.end(idlessKey), { kind: "retained_unproven" });
    assert.equal(tracker.finalize(idlessKey, "enforce").kind, "revise");
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "receipt",
    );
    assert.equal(
      tracker.finalize(idlessKey, "enforce").kind,
      "receipt_confirmed",
    );
  });

  it("resolves an id-less checkpoint's own end through observable displacement", () => {
    // An id-less checkpoint's own terminal cleanup cannot be proven either,
    // so the entry stays as an end-observed terminal candidate. The next
    // registration then displaces it as an observable eviction instead of
    // an ambiguity drop - consecutive id-less checkpoints stay guarded.
    const withoutRunId = { ...CHECKPOINT_RUN_CONTEXT, runId: undefined };
    const idlessKey = { sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey };
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, withoutRunId);
    assert.deepEqual(tracker.end(idlessKey), { kind: "retained_unproven" });
    assert.equal(tracker.size, 1);
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, withoutRunId).kind,
      "registered",
    );
    assert.equal(tracker.size, 1);
    assert.equal(tracker.takeEvictions(), 1);
    assert.equal(tracker.finalize(idlessKey, "enforce").kind, "revise");
  });

  it("clears the end-observed mark when the tracked run proves it is live", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "receipt",
    );
    // An unprovable end marks the entry, but the tracked run then proves it
    // is still live by re-registering with its own id: idempotent, state
    // kept, no eviction.
    tracker.end({ sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey });
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT).kind,
      "registered",
    );
    assert.equal(tracker.takeEvictions(), 0);
    assert.equal(
      tracker.finalize(FINALIZE_KEY, "enforce").kind,
      "receipt_confirmed",
    );
    // With the mark cleared, the entry is live again: an unprovable second
    // registration is back to the ambiguity rule, not displacement.
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, {
        ...CHECKPOINT_RUN_CONTEXT,
        runId: "example-run-2",
      }).kind,
      "ambiguous",
    );
  });

  it("keeps guarding through interleaved unrelated ends", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    // Another run on the same session key ends first (id-less and
    // wrong-id shapes); the tracked checkpoint must survive both.
    tracker.end({ sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey });
    tracker.end({
      sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
      runId: "example-run-9",
    });
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "receipt",
    );
    assert.equal(
      tracker.finalize(FINALIZE_KEY, "enforce").kind,
      "receipt_confirmed",
    );
    tracker.end(FINALIZE_KEY);
    assert.equal(tracker.size, 0);
  });

  it("turns TTL-old pending entries into explicit stale tombstones", () => {
    let clock = 1_000;
    const tracker = new CheckpointReceiptTracker(() => clock);
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    clock += CHECKPOINT_TTL_MS - 1;
    assert.equal(tracker.finalize(FINALIZE_KEY, "observe").kind, "observed_missing");
    clock += 1;
    // Past the TTL the miss stays observable and enforcement is disarmed -
    // never a silent `unrelated`, never a revise on stale correlation.
    assert.equal(tracker.finalize(FINALIZE_KEY, "observe").kind, "stale_missing");
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "stale_missing");
    assert.equal(tracker.size, 1);
    // A provable end still cleans the tombstone.
    tracker.end(FINALIZE_KEY);
    assert.equal(tracker.size, 0);
  });

  it("still accepts a late exact-target receipt on a long-active run", () => {
    let clock = 1_000;
    const tracker = new CheckpointReceiptTracker(() => clock);
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    clock += CHECKPOINT_TTL_MS + 1;
    assert.equal(
      tracker.recordSend(successfulSend(CHECKPOINT_SEND_CONTEXT)).kind,
      "receipt",
    );
    assert.equal(
      tracker.finalize(FINALIZE_KEY, "enforce").kind,
      "receipt_confirmed",
    );
  });

  it("lets a new registration displace a stale tombstone as an observable eviction", () => {
    let clock = 1_000;
    const tracker = new CheckpointReceiptTracker(() => clock);
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    clock += CHECKPOINT_TTL_MS + 1;
    assert.equal(
      tracker.register(OWNER_CHECKPOINT_PROMPT, {
        ...CHECKPOINT_RUN_CONTEXT,
        runId: "example-run-2",
      }).kind,
      "registered",
    );
    assert.equal(tracker.size, 1);
    assert.equal(tracker.takeEvictions(), 1);
    assert.equal(tracker.takeEvictions(), 0);
    assert.equal(
      tracker.finalize(
        { sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey, runId: "example-run-2" },
        "enforce",
      ).kind,
      "revise",
    );
  });

  it("caps tracked checkpoints by evicting stale entries first, then the oldest", () => {
    const tracker = new CheckpointReceiptTracker();
    for (let index = 0; index <= MAX_TRACKED_CHECKPOINTS; index += 1) {
      tracker.register(OWNER_CHECKPOINT_PROMPT, {
        ...CHECKPOINT_RUN_CONTEXT,
        sessionKey: `example-session-key-${index}`,
        runId: `example-run-${index}`,
      });
    }
    assert.equal(tracker.size, MAX_TRACKED_CHECKPOINTS);
    assert.equal(tracker.takeEvictions(), 1);
    assert.equal(
      tracker.finalize(
        { sessionKey: "example-session-key-0", runId: "example-run-0" },
        "enforce",
      ).kind,
      "unrelated",
    );

    // With a stale tombstone present, capacity pressure evicts it before
    // any fresh pending entry.
    let clock = 1_000;
    const staleFirst = new CheckpointReceiptTracker(() => clock);
    staleFirst.register(OWNER_CHECKPOINT_PROMPT, {
      ...CHECKPOINT_RUN_CONTEXT,
      sessionKey: "example-session-key-stale",
      runId: "example-run-stale",
    });
    clock += CHECKPOINT_TTL_MS + 1;
    for (let index = 1; index <= MAX_TRACKED_CHECKPOINTS; index += 1) {
      staleFirst.register(OWNER_CHECKPOINT_PROMPT, {
        ...CHECKPOINT_RUN_CONTEXT,
        sessionKey: `example-session-key-${index}`,
        runId: `example-run-${index}`,
      });
    }
    assert.equal(staleFirst.size, MAX_TRACKED_CHECKPOINTS);
    assert.equal(staleFirst.takeEvictions(), 1);
    assert.equal(
      staleFirst.finalize(
        { sessionKey: "example-session-key-stale", runId: "example-run-stale" },
        "enforce",
      ).kind,
      "unrelated",
    );
    // The oldest fresh entry survived because the tombstone went first.
    assert.equal(
      staleFirst.finalize(
        { sessionKey: "example-session-key-1", runId: "example-run-1" },
        "enforce",
      ).kind,
      "revise",
    );

    // An end-observed terminal candidate is evicted before any fresh
    // pending entry (after stale tombstones).
    const endFirst = new CheckpointReceiptTracker();
    endFirst.register(OWNER_CHECKPOINT_PROMPT, {
      ...CHECKPOINT_RUN_CONTEXT,
      sessionKey: "example-session-key-ended",
      runId: "example-run-ended",
    });
    endFirst.end({ sessionKey: "example-session-key-ended" });
    for (let index = 1; index <= MAX_TRACKED_CHECKPOINTS; index += 1) {
      endFirst.register(OWNER_CHECKPOINT_PROMPT, {
        ...CHECKPOINT_RUN_CONTEXT,
        sessionKey: `example-session-key-${index}`,
        runId: `example-run-${index}`,
      });
    }
    assert.equal(endFirst.size, MAX_TRACKED_CHECKPOINTS);
    assert.equal(endFirst.takeEvictions(), 1);
    assert.equal(
      endFirst.finalize(
        { sessionKey: "example-session-key-ended", runId: "example-run-ended" },
        "enforce",
      ).kind,
      "unrelated",
    );
    // The oldest fresh entry survived because the candidate went first.
    assert.equal(
      endFirst.finalize(
        { sessionKey: "example-session-key-1", runId: "example-run-1" },
        "enforce",
      ).kind,
      "revise",
    );
  });
});

describe("receipt hook handlers", () => {
  it("defaults to observe mode independently of the legacy enforce toggle", () => {
    assert.equal(
      resolveGuardConfig(undefined).ownerCheckpointReceiptMode,
      "observe",
    );
    assert.equal(
      resolveGuardConfig({ enforce: true }).ownerCheckpointReceiptMode,
      "observe",
    );
    assert.equal(
      resolveGuardConfig({ ownerCheckpointReceiptMode: "invalid" })
        .ownerCheckpointReceiptMode,
      "observe",
    );
    assert.equal(
      resolveGuardConfig({ ownerCheckpointReceiptMode: "enforce" })
        .ownerCheckpointReceiptMode,
      "enforce",
    );
  });

  it("passes a happy-path checkpoint end to end", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        CHECKPOINT_RUN_CONTEXT,
      ),
      { outcome: "pass" },
      "an eligible checkpoint must be tracked and explicitly passed",
    );
    handlers.messageSent(
      {
        to: CHECKPOINT_SEND_CONTEXT.conversationId,
        content: CHECKPOINT_REPORT_TERMINAL_GREEN,
        success: true,
        messageId: "example-message-1",
      },
      CHECKPOINT_SEND_CONTEXT,
    );
    assert.equal(
      handlers.beforeAgentFinalize(
        {
          sessionId: "example-session-id-1",
          sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
          runId: CHECKPOINT_RUN_CONTEXT.runId,
          stopHookActive: false,
        },
        CHECKPOINT_RUN_CONTEXT,
      ),
      undefined,
    );
    handlers.agentEnd(
      { runId: CHECKPOINT_RUN_CONTEXT.runId, messages: [], success: true },
      CHECKPOINT_RUN_CONTEXT,
    );
    const flattened = flatten(logs);
    assert.match(flattened, new RegExp(ReasonCodes.ReceiptCheckpointRegistered));
    assert.match(flattened, new RegExp(ReasonCodes.ReceiptConfirmed));
  });

  it("observes a missing receipt without revising in observe mode", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        CHECKPOINT_RUN_CONTEXT,
      ),
      { outcome: "pass" },
    );
    const result = handlers.beforeAgentFinalize(
      {
        sessionId: "example-session-id-1",
        sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
        stopHookActive: false,
      },
      CHECKPOINT_RUN_CONTEXT,
    );
    assert.equal(result, undefined);
    assert.match(flatten(logs), new RegExp(ReasonCodes.ReceiptMissing));
  });

  it("logs a content-free drift signal for a near-miss cron marker", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT, messages: [] },
        CHECKPOINT_RUN_CONTEXT,
      ),
      { outcome: "pass" },
    );
    const flattened = flatten(logs);
    assert.match(flattened, new RegExp(ReasonCodes.ReceiptMarkerDrift));
    for (const line of CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT.split("\n")) {
      if (line.trim().length > 0) {
        assert.equal(flattened.includes(line), false);
      }
    }
    // No tracking happened: finalize stays untouched.
    assert.equal(
      handlers.beforeAgentFinalize(
        {
          sessionId: "example-session-id-1",
          sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
          stopHookActive: false,
        },
        CHECKPOINT_RUN_CONTEXT,
      ),
      undefined,
    );

    // The same near-miss without cron provenance stays completely silent.
    const { api: quietApi, logs: quietLogs } = createFakeApi();
    const quietHandlers = createReceiptHookHandlers(
      quietApi,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    quietHandlers.beforeAgentRun(
      { prompt: CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT, messages: [] },
      { trigger: "user", sessionKey: "example-session-key-1" },
    );
    assert.equal(quietLogs.length, 0);
  });

  it("logs an unverifiable destination distinctly from a mismatch", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    handlers.beforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      CHECKPOINT_RUN_CONTEXT,
    );
    // The host mappers always set ctx.channelId/ctx.conversationId; a
    // context stripped of both models an unverifiable delivery report.
    handlers.messageSent(
      {
        to: "",
        content: CHECKPOINT_REPORT_TERMINAL_GREEN,
        success: true,
        messageId: "example-message-1",
      },
      {
        channelId: "",
        sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
      },
    );
    const flattened = flatten(logs);
    assert.match(flattened, new RegExp(ReasonCodes.ReceiptTargetUnverifiable));
    assert.equal(
      flattened.includes(ReasonCodes.ReceiptTargetMismatch),
      false,
    );
  });

  it("logs a stale pending checkpoint explicitly at finalize", () => {
    let clock = 1_000;
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(() => clock),
      ENFORCE_RECEIPT_CONFIG,
    );
    handlers.beforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      CHECKPOINT_RUN_CONTEXT,
    );
    clock += CHECKPOINT_TTL_MS + 1;
    const result = handlers.beforeAgentFinalize(
      {
        sessionId: "example-session-id-1",
        sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
        runId: CHECKPOINT_RUN_CONTEXT.runId,
        stopHookActive: false,
      },
      CHECKPOINT_RUN_CONTEXT,
    );
    // Disarmed (no revise) but never silent.
    assert.equal(result, undefined);
    assert.match(flatten(logs), new RegExp(ReasonCodes.ReceiptStaleMissing));
  });

  it("logs bounded-state evictions instead of dropping entries silently", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    for (let index = 0; index <= MAX_TRACKED_CHECKPOINTS; index += 1) {
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        {
          ...CHECKPOINT_RUN_CONTEXT,
          sessionKey: `example-session-key-${index}`,
          runId: `example-run-${index}`,
        },
      );
    }
    const evictionLines = flatten(logs)
      .split("\n")
      .filter((line) => line.includes(ReasonCodes.ReceiptEvicted));
    assert.equal(evictionLines.length, 1);
  });

  it("logs an unprovable agent end and keeps the checkpoint guarded", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    const { runId: _omittedRunId, ...idlessRunContext } =
      CHECKPOINT_RUN_CONTEXT;
    handlers.beforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      idlessRunContext,
    );
    // An unrelated id-less run ends on the same session key: the retention
    // is surfaced content-free, and the checkpoint still enforces.
    handlers.agentEnd(
      { messages: [], success: true },
      { trigger: "cron", sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey },
    );
    assert.match(flatten(logs), new RegExp(ReasonCodes.ReceiptEndUnproven));
    assert.equal(
      handlers.beforeAgentFinalize(
        {
          sessionId: "example-session-id-1",
          sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
          stopHookActive: false,
        },
        { trigger: "cron", sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey },
      )?.action,
      "revise",
    );
    // A proven end (both ids equal) stays silent - no unproven signal.
    const { api: cleanApi, logs: cleanLogs } = createFakeApi();
    const cleanHandlers = createReceiptHookHandlers(
      cleanApi,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    cleanHandlers.beforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      CHECKPOINT_RUN_CONTEXT,
    );
    cleanHandlers.agentEnd(
      { runId: CHECKPOINT_RUN_CONTEXT.runId, messages: [], success: true },
      CHECKPOINT_RUN_CONTEXT,
    );
    assert.equal(
      flatten(cleanLogs).includes(ReasonCodes.ReceiptEndUnproven),
      false,
    );
  });

  it("returns a bounded revise result in enforce mode", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        CHECKPOINT_RUN_CONTEXT,
      ),
      { outcome: "pass" },
    );
    const finalizeEvent = {
      sessionId: "example-session-id-1",
      sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
      runId: CHECKPOINT_RUN_CONTEXT.runId,
      stopHookActive: false,
    };
    const result = handlers.beforeAgentFinalize(
      finalizeEvent,
      CHECKPOINT_RUN_CONTEXT,
    );
    assert.deepEqual(result, {
      action: "revise",
      reason: ReasonCodes.ReceiptMissing,
      retry: {
        instruction: RECEIPT_REVISE_INSTRUCTION,
        idempotencyKey: RECEIPT_REVISE_IDEMPOTENCY_KEY,
        maxAttempts: MAX_RECEIPT_REVISE_ATTEMPTS,
      },
    });
    // Each requested round is logged with the documented revise reason code.
    const reviseLines = flatten(logs)
      .split("\n")
      .filter((line) => line.includes(ReasonCodes.ReceiptReviseRequested));
    assert.equal(reviseLines.length, 1);
    // The guard keeps no local budget: it requests the same idempotent
    // revise on every receipt-less round and never authors a false
    // exhausted signal - the installed host's winning-decision accounting
    // is the only bound on applied rounds.
    for (let round = 0; round < MAX_RECEIPT_REVISE_ATTEMPTS + 1; round += 1) {
      assert.equal(
        handlers.beforeAgentFinalize(finalizeEvent, CHECKPOINT_RUN_CONTEXT)
          ?.action,
        "revise",
      );
    }
    assert.equal(
      flatten(logs)
        .split("\n")
        .filter((line) => line.includes(ReasonCodes.ReceiptReviseRequested))
        .length,
      MAX_RECEIPT_REVISE_ATTEMPTS + 2,
    );
    assert.equal(flatten(logs).includes("revise_exhausted"), false);
  });

  it("leaves an ordinary turn completely untouched", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        { trigger: "user", sessionKey: "example-session-key-1" },
      ),
      { outcome: "pass" },
      "an ordinary marker-only turn must be explicitly passed, not voided",
    );
    handlers.messageSent(
      {
        to: "example-conversation-1",
        content: "예시 일반 답변",
        success: true,
        messageId: "example-message-1",
      },
      CHECKPOINT_SEND_CONTEXT,
    );
    assert.equal(
      handlers.beforeAgentFinalize(
        {
          sessionId: "example-session-id-1",
          sessionKey: "example-session-key-1",
          stopHookActive: false,
        },
        { trigger: "user", sessionKey: "example-session-key-1" },
      ),
      undefined,
    );
    assert.equal(logs.length, 0);
  });

  it("returns an explicit pass even when the tracker itself is defective", () => {
    // The host runs before_agent_run fail-closed: a null result is blocked
    // outright and undefined is skipped only by an incidental merge-layer
    // guard, so the internal-error path must still produce the explicit pass
    // decision - fail open means pass, not void.
    const throwingTracker = new (class extends CheckpointReceiptTracker {
      override register(): never {
        throw new Error("synthetic tracker defect");
      }
    })();
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      throwingTracker,
      ENFORCE_RECEIPT_CONFIG,
    );
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        CHECKPOINT_RUN_CONTEXT,
      ),
      { outcome: "pass" },
    );
    assert.equal(logs.length, 0);
  });

  it("never emits raw prompt text, content, destinations, or identifiers", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    const SECRET = "ZZ-UNIQUE-RECEIPT-MARKER-4821";
    const taintedCtx = {
      trigger: "cron",
      jobId: `job-${SECRET}`,
      runId: `run-${SECRET}`,
      sessionKey: `session-${SECRET}`,
      channel: `messenger-${SECRET}`,
      channelId: `conversation-${SECRET}`,
    };
    const runDecision = handlers.beforeAgentRun(
      {
        prompt: `${OWNER_CHECKPOINT_MARKER}\n비밀 프롬프트 ${SECRET}`,
        messages: [],
      },
      taintedCtx,
    );
    assert.deepEqual(runDecision, { outcome: "pass" });
    handlers.messageSent(
      {
        to: `other-${SECRET}`,
        content: `비밀 본문 ${SECRET}`,
        success: true,
        messageId: `message-${SECRET}`,
      },
      {
        channelId: `messenger-${SECRET}`,
        conversationId: `other-${SECRET}`,
        sessionKey: `session-${SECRET}`,
      },
    );
    const result = handlers.beforeAgentFinalize(
      {
        sessionId: `session-id-${SECRET}`,
        sessionKey: `session-${SECRET}`,
        runId: `run-${SECRET}`,
        stopHookActive: false,
      },
      taintedCtx,
    );
    assert.equal(result?.action, "revise");

    const emitted = [
      flatten(logs),
      JSON.stringify(runDecision),
      JSON.stringify(result ?? {}),
    ].join("\n");
    assert.equal(emitted.includes(SECRET), false);
    assert.ok(logs.length >= 2);
    for (const line of flatten(logs).split("\n")) {
      assert.match(
        line,
        /^\[acp-lifecycle-guard\] hook=[a-z_]+ outcome=[a-z]+ kind=receipt reason=acp_lifecycle_guard\.receipt\.[a-z_]+$/u,
      );
    }
  });

  it("logs the missing or ambiguous correlation cases as uncorrelatable", () => {
    const { api, logs } = createFakeApi();
    const handlers = createReceiptHookHandlers(
      api,
      new CheckpointReceiptTracker(),
      ENFORCE_RECEIPT_CONFIG,
    );
    const { channelId: _omitted, ...withoutConversation } =
      CHECKPOINT_RUN_CONTEXT;
    // Uncorrelatable, registered, and ambiguous runs alike must yield the
    // explicit pass decision.
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        withoutConversation,
      ),
      { outcome: "pass" },
    );
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        CHECKPOINT_RUN_CONTEXT,
      ),
      { outcome: "pass" },
    );
    assert.deepEqual(
      handlers.beforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        { ...CHECKPOINT_RUN_CONTEXT, runId: "example-run-2" },
      ),
      { outcome: "pass" },
    );
    const flattened = flatten(logs);
    const uncorrelatable = flattened
      .split("\n")
      .filter((line) => line.includes(ReasonCodes.ReceiptUncorrelatable));
    assert.equal(uncorrelatable.length, 2);
    // Neither ambiguous run is guarded afterwards.
    assert.equal(
      handlers.beforeAgentFinalize(
        {
          sessionId: "example-session-id-1",
          sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey,
          stopHookActive: false,
        },
        CHECKPOINT_RUN_CONTEXT,
      ),
      undefined,
    );
  });

  it("keeps the fixed revise instruction free of identifiers and unbounded text", () => {
    assert.ok(RECEIPT_REVISE_INSTRUCTION.length < 240);
    assert.equal(/example|session|run-|job-|:\/\//u.test(RECEIPT_REVISE_INSTRUCTION), false);
    assert.match(RECEIPT_REVISE_IDEMPOTENCY_KEY, /^acp_lifecycle_guard\./u);
    assert.equal(PLUGIN_ID, "acp-lifecycle-guard");
  });
});
