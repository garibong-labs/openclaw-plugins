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
} from "../src/receipt/checkpoint.ts";
import { PLUGIN_ID, createReceiptHookHandlers } from "../src/register.ts";
import {
  CHECKPOINT_PROMPT_MARKER_NOT_FIRST,
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

  it("preserves unknown prefixes", () => {
    assert.equal(
      normalizeConversationTarget("other:example-conversation-1", "example-messenger"),
      "other:example-conversation-1",
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
    assert.equal(
      tracker.register(CHECKPOINT_PROMPT_MARKER_NOT_FIRST, CHECKPOINT_RUN_CONTEXT)
        .kind,
      "not_eligible",
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
    // Observe mode never consumes revise budget.
    assert.deepEqual(tracker.finalize(FINALIZE_KEY, "observe"), {
      kind: "observed_missing",
    });
  });

  it("bounds enforce-mode revise rounds and then reports exhaustion", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    for (let attempt = 1; attempt <= MAX_RECEIPT_REVISE_ATTEMPTS; attempt += 1) {
      assert.deepEqual(tracker.finalize(FINALIZE_KEY, "enforce"), {
        kind: "revise",
        attempt,
      });
    }
    assert.deepEqual(tracker.finalize(FINALIZE_KEY, "enforce"), {
      kind: "exhausted",
    });
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
  it("cleans deterministically on agent end", () => {
    const tracker = new CheckpointReceiptTracker();
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    tracker.end({ sessionKey: CHECKPOINT_RUN_CONTEXT.sessionKey, runId: "example-run-9" });
    assert.equal(tracker.size, 1);
    tracker.end(FINALIZE_KEY);
    assert.equal(tracker.size, 0);
    assert.equal(tracker.finalize(FINALIZE_KEY, "enforce").kind, "unrelated");
  });

  it("prunes abandoned entries after the TTL", () => {
    let clock = 1_000;
    const tracker = new CheckpointReceiptTracker(() => clock);
    tracker.register(OWNER_CHECKPOINT_PROMPT, CHECKPOINT_RUN_CONTEXT);
    clock += CHECKPOINT_TTL_MS - 1;
    assert.equal(tracker.finalize(FINALIZE_KEY, "observe").kind, "observed_missing");
    clock += 1;
    assert.equal(tracker.finalize(FINALIZE_KEY, "observe").kind, "unrelated");
    assert.equal(tracker.size, 0);
  });

  it("caps tracked checkpoints by evicting the oldest", () => {
    const tracker = new CheckpointReceiptTracker();
    for (let index = 0; index <= MAX_TRACKED_CHECKPOINTS; index += 1) {
      tracker.register(OWNER_CHECKPOINT_PROMPT, {
        ...CHECKPOINT_RUN_CONTEXT,
        sessionKey: `example-session-key-${index}`,
        runId: `example-run-${index}`,
      });
    }
    assert.equal(tracker.size, MAX_TRACKED_CHECKPOINTS);
    assert.equal(
      tracker.finalize(
        { sessionKey: "example-session-key-0", runId: "example-run-0" },
        "enforce",
      ).kind,
      "unrelated",
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

  it("returns a bounded revise result in enforce mode", () => {
    const { api } = createFakeApi();
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
    // Second revise round is still within the bound; the third is not.
    assert.equal(
      handlers.beforeAgentFinalize(finalizeEvent, CHECKPOINT_RUN_CONTEXT)
        ?.action,
      "revise",
    );
    assert.equal(
      handlers.beforeAgentFinalize(finalizeEvent, CHECKPOINT_RUN_CONTEXT),
      undefined,
    );
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
