import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_GUARD_CONFIG, resolveGuardConfig } from "../src/config.ts";
import { ReasonCodes } from "../src/lifecycle/reason-codes.ts";
import { evaluateOutboundContent } from "../src/policy/outbound.ts";
import { evaluateToolCall } from "../src/policy/tool.ts";
import {
  ACTIVITY_LABEL_CHAT,
  APPROVAL_EVIDENCE,
  CANONICAL_COMPLETION,
  CANONICAL_COMPLETION_WITH_SECONDS,
  CANONICAL_CORRECTION_START,
  CANONICAL_INTERMEDIATE,
  CANONICAL_START,
  LEGACY_ACTIVITY_INTERMEDIATE,
  ORDINARY_CHAT,
  ORCHESTRATOR_TERMINAL_COMPLETION,
  RENAMED_COMPLETION_TITLE,
  RENAMED_CORRECTION_START_TITLE,
  RENAMED_INTERMEDIATE_TITLE,
  RENAMED_START_TITLE,
  completionWithDuration,
  intermediateWithElapsed,
  replaceLine,
} from "./fixtures.ts";

const MALFORMED_INTERMEDIATE = intermediateWithElapsed("⏱️ **ACP 시간**: 20분");

describe("evaluateOutboundContent", () => {
  it("passes ordinary chat", () => {
    assert.deepEqual(evaluateOutboundContent(ORDINARY_CHAT, DEFAULT_GUARD_CONFIG), {
      action: "pass",
    });
  });

  it("passes approval evidence", () => {
    assert.deepEqual(
      evaluateOutboundContent(APPROVAL_EVIDENCE, DEFAULT_GUARD_CONFIG),
      { action: "pass" },
    );
  });

  it("passes ordinary chat that mentions both activity labels untouched", () => {
    assert.deepEqual(
      evaluateOutboundContent(ACTIVITY_LABEL_CHAT, DEFAULT_GUARD_CONFIG),
      { action: "pass" },
    );
  });

  it("passes a legacy-activity-label report with the transition advisory", () => {
    assert.deepEqual(
      evaluateOutboundContent(LEGACY_ACTIVITY_INTERMEDIATE, DEFAULT_GUARD_CONFIG),
      {
        action: "pass",
        kind: "intermediate",
        advisories: [ReasonCodes.IntermediateLegacyActivityLabel],
      },
    );
  });

  it("passes every canonical lifecycle report", () => {
    for (const report of [
      CANONICAL_START,
      CANONICAL_CORRECTION_START,
      CANONICAL_INTERMEDIATE,
      CANONICAL_COMPLETION,
      CANONICAL_COMPLETION_WITH_SECONDS,
    ]) {
      const decision = evaluateOutboundContent(report, DEFAULT_GUARD_CONFIG);
      assert.equal(decision.action, "pass");
    }
  });

  it("passes the orchestrator terminal builder's exact 20-line completion", () => {
    assert.equal(ORCHESTRATOR_TERMINAL_COMPLETION.split("\n").length, 20);
    assert.deepEqual(
      evaluateOutboundContent(
        ORCHESTRATOR_TERMINAL_COMPLETION,
        DEFAULT_GUARD_CONFIG,
      ),
      { action: "pass", kind: "completion" },
    );
  });

  it("cancels a near-canonical renamed title in every family", () => {
    const cases = [
      [RENAMED_INTERMEDIATE_TITLE, "intermediate"],
      [RENAMED_START_TITLE, "start"],
      [RENAMED_CORRECTION_START_TITLE, "correction-start"],
      [RENAMED_COMPLETION_TITLE, "completion"],
    ] as const;
    for (const [report, kind] of cases) {
      assert.deepEqual(
        evaluateOutboundContent(report, DEFAULT_GUARD_CONFIG),
        {
          action: "cancel",
          kind,
          reasonCode: ReasonCodes.TitleDrift,
        },
      );
    }
  });

  it("cancels a completion report whose seconds exceed 59", () => {
    const decision = evaluateOutboundContent(
      completionWithDuration("17분 60초"),
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, {
      action: "cancel",
      kind: "completion",
      reasonCode: ReasonCodes.CompletionDurationDrift,
    });
  });

  it("cancels a malformed intermediate report", () => {
    const decision = evaluateOutboundContent(
      MALFORMED_INTERMEDIATE,
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, {
      action: "cancel",
      kind: "intermediate",
      reasonCode: ReasonCodes.IntermediateElapsedDrift,
    });
  });

  it("cancels a malformed completion report", () => {
    const decision = evaluateOutboundContent(
      replaceLine(CANONICAL_COMPLETION, 15, "🔎 **후속**"),
      DEFAULT_GUARD_CONFIG,
    );
    assert.equal(decision.action, "cancel");
    assert.equal(decision.action === "cancel" && decision.kind, "completion");
  });

  it("observes instead of cancelling when enforcement is off", () => {
    const decision = evaluateOutboundContent(MALFORMED_INTERMEDIATE, {
      ...DEFAULT_GUARD_CONFIG,
      enforce: false,
    });
    assert.equal(decision.action, "observe");
  });

  it("cancels a malformed canonical-v3 terminal failure report", () => {
    const failure = [
      "❌ ACP 실패 보고 · 16:00 KST",
      "",
      "- 예시 실패 사유",
    ].join("\n");
    assert.equal(evaluateOutboundContent(failure, DEFAULT_GUARD_CONFIG).action, "cancel");
  });

  it("passes lifecycle-shaped terminal failure and pending reports untouched", () => {
    for (const title of [
      "🏁 **ACP 작업 미완료 · 16:00 KST**",
      "🏁 **ACP 작업을 완료하지 못했습니다**",
      "🏁 **ACP 완료율 80% · 16:00 KST**",
      "🏁 **ACP 완료 예정 · 16:00 KST**",
      "🏁 **ACP 완료 보고 예정 · 16:00 KST**",
      "🏁 **ACP 실행 실패 · 16:00 KST**",
      "🏁 **ACP 실행 취소 · 16:00 KST**",
      "🏁 **ACP 운영자 차단 · 16:00 KST**",
      "🏁 **ACP 추적 손실 · 16:00 KST**",
      "⛔ **ACP 취소 예정 · 16:00 KST**",
      "❌ **ACP 실패 예정 · 16:00 KST**",
    ]) {
      const report = replaceLine(CANONICAL_COMPLETION, 0, title);
      assert.deepEqual(
        evaluateOutboundContent(report, DEFAULT_GUARD_CONFIG),
        { action: "pass" },
      );
    }
  });
});

describe("evaluateToolCall", () => {
  it("ignores tools other than the message tool", () => {
    const decision = evaluateToolCall(
      { toolName: "exec", params: { command: "echo hi" } },
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, { action: "pass" });
  });

  it("blocks a direct intermediate report send", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "send", message: CANONICAL_INTERMEDIATE },
      },
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, {
      action: "block",
      reasonCode: ReasonCodes.ToolDirectIntermediate,
    });
  });

  it("blocks a direct intermediate report broadcast", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "broadcast", message: CANONICAL_INTERMEDIATE },
      },
      DEFAULT_GUARD_CONFIG,
    );
    assert.equal(decision.action, "block");
  });

  it("blocks an intermediate report carried in a caption", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "send", caption: CANONICAL_INTERMEDIATE },
      },
      DEFAULT_GUARD_CONFIG,
    );
    assert.equal(decision.action, "block");
  });

  it("blocks a send whose action is omitted", () => {
    const decision = evaluateToolCall(
      { toolName: "message", params: { message: CANONICAL_INTERMEDIATE } },
      DEFAULT_GUARD_CONFIG,
    );
    assert.equal(decision.action, "block");
  });

  it("does not block start reports", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "send", message: CANONICAL_START },
      },
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, { action: "pass" });
  });

  it("does not block correction-round start reports", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "send", message: CANONICAL_CORRECTION_START },
      },
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, { action: "pass" });
  });

  it("does not block completion reports", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "send", message: CANONICAL_COMPLETION },
      },
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, { action: "pass" });
  });

  it("does not block ordinary ACP discussion", () => {
    const decision = evaluateToolCall(
      { toolName: "message", params: { action: "send", message: ORDINARY_CHAT } },
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, { action: "pass" });
  });

  it("does not block approval evidence", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "send", message: APPROVAL_EVIDENCE },
      },
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, { action: "pass" });
  });

  it("does not block non-publishing message actions", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "read", message: CANONICAL_INTERMEDIATE },
      },
      DEFAULT_GUARD_CONFIG,
    );
    assert.deepEqual(decision, { action: "pass" });
  });

  it("observes when the direct-tool guard is disabled", () => {
    const decision = evaluateToolCall(
      {
        toolName: "message",
        params: { action: "send", message: CANONICAL_INTERMEDIATE },
      },
      { ...DEFAULT_GUARD_CONFIG, blockDirectIntermediateToolCalls: false },
    );
    assert.equal(decision.action, "observe");
  });
});

describe("resolveGuardConfig", () => {
  it("returns defaults for missing or invalid config", () => {
    assert.deepEqual(resolveGuardConfig(undefined), DEFAULT_GUARD_CONFIG);
    assert.deepEqual(resolveGuardConfig(null), DEFAULT_GUARD_CONFIG);
    assert.deepEqual(resolveGuardConfig("nope"), DEFAULT_GUARD_CONFIG);
  });

  it("reads supported overrides", () => {
    const resolved = resolveGuardConfig({
      enforce: false,
      blockDirectIntermediateToolCalls: false,
      blockNonMainAcpLaunches: false,
      ownerCheckpointReceiptMode: "enforce",
      maxIntermediateChars: 900,
      maxBoundaryReportChars: 1800,
    });
    assert.deepEqual(resolved, {
      enforce: false,
      blockDirectIntermediateToolCalls: false,
      blockNonMainAcpLaunches: false,
      ownerCheckpointReceiptMode: "enforce",
      limits: { maxIntermediateChars: 900, maxBoundaryReportChars: 1800 },
    });
  });

  it("ignores out-of-range and non-integer limits", () => {
    const resolved = resolveGuardConfig({
      maxIntermediateChars: 10,
      maxBoundaryReportChars: 12.5,
    });
    assert.deepEqual(resolved.limits, DEFAULT_GUARD_CONFIG.limits);
  });
});
