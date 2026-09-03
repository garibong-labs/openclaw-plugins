import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyLifecycleContent } from "../src/lifecycle/classify.ts";
import type { LifecycleKind } from "../src/lifecycle/kinds.ts";
import { INTERMEDIATE_DELTA_BULLET_INDEX } from "../src/lifecycle/layouts.ts";
import { stripVariationSelectors } from "../src/lifecycle/normalize.ts";
import {
  ALL_REASON_CODES,
  ReasonCodes,
  isReasonCode,
} from "../src/lifecycle/reason-codes.ts";
import {
  DEFAULT_VALIDATION_LIMITS,
  validateLifecycleReport,
  type ValidationResult,
} from "../src/lifecycle/validate.ts";
import {
  CANONICAL_COMPLETION,
  CANONICAL_COMPLETION_WITH_SECONDS,
  CANONICAL_CORRECTION_START,
  CANONICAL_INTERMEDIATE,
  CANONICAL_INTERMEDIATE_WITH_ISSUE,
  CANONICAL_START,
  INTERMEDIATE_ELAPSED_LINE_INDEX,
  LEGACY_ACTIVITY_INTERMEDIATE,
  ORCHESTRATOR_TERMINAL_COMPLETION,
  RENAMED_COMPLETION_TITLE,
  RENAMED_CORRECTION_START_TITLE,
  RENAMED_INTERMEDIATE_TITLE,
  RENAMED_START_TITLE,
  completionWithDuration,
  insertLine,
  intermediateWithElapsed,
  removeLine,
  replaceLine,
} from "./fixtures.ts";

function validate(report: string): ValidationResult {
  const classification = classifyLifecycleContent(report);
  assert.equal(
    classification.candidate,
    true,
    "fixture must classify as a lifecycle candidate",
  );
  if (!classification.candidate) {
    throw new Error("unreachable");
  }
  return validateLifecycleReport({
    kind: classification.kind,
    normalized: classification.normalized,
  });
}

function expectValid(report: string): void {
  const result = validate(report);
  assert.equal(
    result.ok,
    true,
    `expected valid report, got ${result.ok ? "" : result.reasonCode}`,
  );
}

function expectRejected(report: string, reasonCode: string): void {
  const result = validate(report);
  assert.equal(result.ok, false, "expected report to be rejected");
  if (result.ok) {
    return;
  }
  assert.equal(result.reasonCode, reasonCode);
  assert.equal(isReasonCode(result.reasonCode), true);
}

describe("valid canonical layouts", () => {
  it("accepts the canonical intermediate report", () => {
    expectValid(CANONICAL_INTERMEDIATE);
  });

  it("accepts the canonical intermediate report with the optional issue section", () => {
    expectValid(CANONICAL_INTERMEDIATE_WITH_ISSUE);
  });

  it("accepts an intermediate report using a Δ+N new-result bullet", () => {
    expectValid(
      replaceLine(
        CANONICAL_INTERMEDIATE,
        INTERMEDIATE_DELTA_BULLET_INDEX,
        "- Δ+2 게이트 2건 통과 확인",
      ),
    );
  });

  it("accepts the current v3 Δ<N> middle-report form", () => {
    expectValid(replaceLine(CANONICAL_INTERMEDIATE, INTERMEDIATE_DELTA_BULLET_INDEX,
      "- Δ2 · 게이트 2건 통과 확인"));
  });

  it("accepts the activity age independently of the delta bullet in both directions", () => {
    expectValid(
      intermediateWithElapsed(
        "⏱️ **ACP 시간**: 전체 20분 · 현재 단계 8분 · 마지막 ACP 활동 0분 전",
      ),
    );
    expectValid(
      replaceLine(
        intermediateWithElapsed(
          "⏱️ **ACP 시간**: 전체 200분 · 현재 단계 8분 · 마지막 ACP 활동 180분 전",
        ),
        INTERMEDIATE_DELTA_BULLET_INDEX,
        "- Δ+3 게이트 3건 통과 확인",
      ),
    );
  });

  it("accepts the transition-window legacy activity label with an advisory", () => {
    const result = validate(LEGACY_ACTIVITY_INTERMEDIATE);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.advisories : undefined, [
      ReasonCodes.IntermediateLegacyActivityLabel,
    ]);
  });

  it("reports no advisory for the canonical activity label", () => {
    const result = validate(CANONICAL_INTERMEDIATE);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.advisories : undefined, undefined);
  });

  it("accepts the canonical start report", () => {
    expectValid(CANONICAL_START);
  });

  it("accepts the canonical correction-round start report", () => {
    expectValid(CANONICAL_CORRECTION_START);
  });

  it("accepts the canonical completion report", () => {
    expectValid(CANONICAL_COMPLETION);
  });

  it("accepts the orchestrator terminal builder's exact 20-line contract", () => {
    assert.equal(ORCHESTRATOR_TERMINAL_COMPLETION.split("\n").length, 20);
    expectValid(ORCHESTRATOR_TERMINAL_COMPLETION);
  });

  it("accepts a completion report in the minute-plus-seconds form", () => {
    expectValid(CANONICAL_COMPLETION_WITH_SECONDS);
  });

  it("accepts reports whose emoji omit the variation selector", () => {
    expectValid(stripVariationSelectors(CANONICAL_INTERMEDIATE));
    expectValid(stripVariationSelectors(CANONICAL_COMPLETION));
  });

  it("accepts a report delivered with CRLF endings and a trailing newline", () => {
    expectValid(`${CANONICAL_INTERMEDIATE.replace(/\n/gu, "\r\n")}\r\n`);
  });

  it("accepts canonically equivalent NFD-decomposed Hangul in every family", () => {
    for (const report of [
      CANONICAL_INTERMEDIATE,
      CANONICAL_START,
      CANONICAL_CORRECTION_START,
      CANONICAL_COMPLETION,
    ]) {
      expectValid(report.normalize("NFD"));
    }
  });
});

describe("intermediate drift", () => {
  it("rejects a renamed intermediate title with title drift", () => {
    expectRejected(RENAMED_INTERMEDIATE_TITLE, ReasonCodes.TitleDrift);
  });

  it("rejects title drift", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 0, "🔄 **ACP 중간 보고**"),
      ReasonCodes.TitleDrift,
    );
  });

  it("rejects an invalid clock value in the title", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 0, "🔄 **ACP 중간 보고 · 25:99 KST**"),
      ReasonCodes.TitleDrift,
    );
  });

  it("rejects a leading blank line before the title", () => {
    expectRejected(
      `\n${CANONICAL_INTERMEDIATE}`,
      ReasonCodes.LineCountDrift,
    );
  });

  it("rejects a leading-indented title", () => {
    expectRejected(`  ${CANONICAL_INTERMEDIATE}`, ReasonCodes.TitleDrift);
  });

  it("rejects a missing blank separator line", () => {
    expectRejected(
      removeLine(CANONICAL_INTERMEDIATE, 7),
      ReasonCodes.LineCountDrift,
    );
  });

  it("rejects an extra blank line inside the body", () => {
    expectRejected(
      insertLine(CANONICAL_INTERMEDIATE, 8, ""),
      ReasonCodes.LineCountDrift,
    );
  });

  it("rejects a blank separator replaced by content", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 7, "추가 설명"),
      ReasonCodes.BlankLineDrift,
    );
  });

  it("rejects a missing blank line between metadata and the first section", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 1, "부연 설명"),
      ReasonCodes.BlankLineDrift,
    );
  });

  it("rejects reordered metadata lines", () => {
    const swapped = replaceLine(
      replaceLine(
        CANONICAL_INTERMEDIATE,
        2,
        "📍 **작업**: `example-repo` · `feat/example`",
      ),
      3,
      "🤖 **ACP**: Codex · `example-model-1`",
    );
    expectRejected(swapped, ReasonCodes.MetadataLineDrift);
  });

  it("rejects a model value that is not inline code", () => {
    expectRejected(
      replaceLine(
        CANONICAL_INTERMEDIATE,
        2,
        "🤖 **ACP**: Codex · example-model-1",
      ),
      ReasonCodes.MetadataLineDrift,
    );
  });

  it("rejects harnesses outside the controller's closed Claude Code/Codex set", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 2,
        "🤖 **ACP**: example-harness · `example-model-1`"),
      ReasonCodes.MetadataLineDrift,
    );
  });

  it("rejects the early legacy elapsed-only line", () => {
    expectRejected(
      intermediateWithElapsed("⏱️ **ACP 시간**: 20분"),
      ReasonCodes.IntermediateElapsedDrift,
    );
  });

  it("rejects an elapsed line missing the last-activity segment", () => {
    expectRejected(
      intermediateWithElapsed("⏱️ **ACP 시간**: 전체 20분 · 현재 단계 8분"),
      ReasonCodes.IntermediateElapsedDrift,
    );
  });

  it("rejects an unrecognized activity label", () => {
    expectRejected(
      intermediateWithElapsed(
        "⏱️ **ACP 시간**: 전체 20분 · 현재 단계 8분 · 마지막 활동 2분 전",
      ),
      ReasonCodes.IntermediateElapsedDrift,
    );
  });

  it("rejects a renamed section heading", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 8, "✅ **신규 결과**"),
      ReasonCodes.SectionHeadingDrift,
    );
  });

  it("rejects reordered sections", () => {
    const reordered = replaceLine(
      replaceLine(CANONICAL_INTERMEDIATE, 8, "🛠️ **ACP 진행 중**"),
      11,
      "✅ **새 결과**",
    );
    expectRejected(reordered, ReasonCodes.SectionHeadingDrift);
  });

  it("rejects an extra section appended after the contract ends", () => {
    const extra = [CANONICAL_INTERMEDIATE, "", "📌 **추가**", "- 추가 내용"].join(
      "\n",
    );
    expectRejected(extra, ReasonCodes.IntermediateIssueSectionDrift);
  });

  it("rejects a nested bullet", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 12, "  - 중첩된 항목"),
      ReasonCodes.BulletLineDrift,
    );
  });

  it("rejects more than one bullet per section", () => {
    expectRejected(
      insertLine(CANONICAL_INTERMEDIATE, 13, "- 두 번째 항목"),
      ReasonCodes.LineCountDrift,
    );
  });

  it("rejects a new-result bullet without a delta marker", () => {
    expectRejected(
      replaceLine(
        CANONICAL_INTERMEDIATE,
        INTERMEDIATE_DELTA_BULLET_INDEX,
        "- 새로운 결과 있음",
      ),
      ReasonCodes.IntermediateDeltaDrift,
    );
  });

  it("rejects a v3 positive delta without its canonical separator", () => {
    expectRejected(
      replaceLine(
        CANONICAL_INTERMEDIATE,
        INTERMEDIATE_DELTA_BULLET_INDEX,
        "- Δ2 새 결과",
      ),
      ReasonCodes.IntermediateDeltaDrift,
    );
  });

  it("rejects an altered Δ0 sentence", () => {
    expectRejected(
      replaceLine(
        CANONICAL_INTERMEDIATE,
        INTERMEDIATE_DELTA_BULLET_INDEX,
        "- Δ0 · 새 결과 없음",
      ),
      ReasonCodes.IntermediateDeltaDrift,
    );
  });

  it("rejects a forbidden non-ACP subject", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 18, "- Eli 검토 대기"),
      ReasonCodes.IntermediateForbiddenSubject,
    );
  });

  it("rejects a wrapper liveness claim", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 6, "🔁 **실행 상태**: wrapper 살아있음"),
      ReasonCodes.IntermediateForbiddenSubject,
    );
  });

  it("rejects a Markdown hard-break trailing space", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 12, "- 정책 모듈 구현 3/5  "),
      ReasonCodes.TrailingWhitespace,
    );
  });

  it("rejects an oversized intermediate report", () => {
    const padded = replaceLine(
      CANONICAL_INTERMEDIATE,
      12,
      `- ${"가".repeat(DEFAULT_VALIDATION_LIMITS.maxIntermediateChars)}`,
    );
    expectRejected(padded, ReasonCodes.Oversized);
  });

  it("rejects a malformed optional issue section", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE_WITH_ISSUE, 20, "⚠️ **이슈 사항**"),
      ReasonCodes.IntermediateIssueSectionDrift,
    );
  });

  it("rejects a trailing appended sentence", () => {
    expectRejected(
      [CANONICAL_INTERMEDIATE, "추가 코멘트"].join("\n"),
      ReasonCodes.LineCountDrift,
    );
  });
});

describe("start drift", () => {
  it("rejects renamed start-family titles with title drift", () => {
    expectRejected(RENAMED_START_TITLE, ReasonCodes.TitleDrift);
    expectRejected(RENAMED_CORRECTION_START_TITLE, ReasonCodes.TitleDrift);
  });
  it("rejects an elapsed claim before dispatch activation", () => {
    expectRejected(
      replaceLine(CANONICAL_START, 6, "- 예시 구현 범위 · ACP 시간 5분"),
      ReasonCodes.StartProgressClaim,
    );
  });

  it("rejects a phase marker before dispatch activation", () => {
    expectRejected(
      replaceLine(CANONICAL_START, 6, "- 🔢 2/4 진행"),
      ReasonCodes.StartProgressClaim,
    );
  });

  it("rejects a drifted cadence sentence", () => {
    expectRejected(
      replaceLine(CANONICAL_START, 9, "- 10분마다 보고"),
      ReasonCodes.StartCadenceLineDrift,
    );
  });

  it("rejects a missing external-work section", () => {
    expectRejected(
      removeLine(removeLine(CANONICAL_START, 12), 11),
      ReasonCodes.LineCountDrift,
    );
  });

  it("rejects a correction title without a round number", () => {
    expectRejected(
      replaceLine(
        CANONICAL_CORRECTION_START,
        0,
        "🔁 **ACP 수정 라운드 시작 · 15:00 KST**",
      ),
      ReasonCodes.TitleDrift,
    );
  });
});

describe("completion drift", () => {
  it("rejects a near-canonical renamed title with title drift", () => {
    expectRejected(RENAMED_COMPLETION_TITLE, ReasonCodes.TitleDrift);
  });

  it("rejects a drifted duration line", () => {
    expectRejected(
      replaceLine(CANONICAL_COMPLETION, 4, "⏱️ **ACP 소요**: 42분"),
      ReasonCodes.CompletionDurationDrift,
    );
  });

  it("accepts the v3 structured next-step slot", () => {
    expectValid(replaceLine(CANONICAL_COMPLETION, 16, "- 소유자 검증 시작"));
  });

  for (const [title, heading] of [
    ["⛔ **ACP 취소 보고 · 15:40 KST**", "⛔ **ACP 취소**"],
    ["❌ **ACP 실패 보고 · 15:40 KST**", "❌ **ACP 실패**"],
  ] as const) {
    it(`accepts the canonical v3 terminal ${heading}`, () => {
      expectValid(replaceLine(replaceLine(CANONICAL_COMPLETION, 0, title), 6, heading));
    });
  }

  it("rejects a mismatched v3 terminal title and outcome", () => {
    expectRejected(
      replaceLine(CANONICAL_COMPLETION, 0, "⛔ **ACP 취소 보고 · 15:40 KST**"),
      ReasonCodes.SectionHeadingDrift,
    );
  });

  it("rejects a missing result section", () => {
    expectRejected(
      removeLine(removeLine(CANONICAL_COMPLETION, 13), 12),
      ReasonCodes.LineCountDrift,
    );
  });

  it("rejects an oversized completion report", () => {
    const padded = replaceLine(
      CANONICAL_COMPLETION,
      7,
      `- ${"가".repeat(DEFAULT_VALIDATION_LIMITS.maxBoundaryReportChars)}`,
    );
    expectRejected(padded, ReasonCodes.Oversized);
  });
});

describe("completion duration grammar", () => {
  // Production emits both the minute-only and the minute-plus-seconds form;
  // rejecting the latter cancelled valid completion reports.
  const accepted = ["17분 31초", "42분", "0분", "0분 0초", "7분 09초", "128분 59초", "측정 불가"];

  for (const duration of accepted) {
    it(`accepts \`${duration}\``, () => {
      expectValid(completionWithDuration(duration));
    });
  }

  const rejected = [
    // Seconds are bounded to 0-59.
    "17분 60초",
    "17분 90초",
    "17분 031초",
    // The unit, the separating space, and the segment order are all fixed.
    "17분 31",
    "17분31초",
    "17 분 31초",
    "31초",
    "17분 31초 05초",
    "17분 31분",
    "-17분 31초",
  ];

  for (const duration of rejected) {
    it(`rejects \`${duration}\``, () => {
      expectRejected(
        completionWithDuration(duration),
        ReasonCodes.CompletionDurationDrift,
      );
    });
  }
});

describe("intermediate elapsed grammar", () => {
  const elapsed = (total: string, stage: string, activity: string): string =>
    intermediateWithElapsed(
      `⏱️ **ACP 시간**: 전체 ${total}분 · 현재 단계 ${stage}분 · 마지막 ACP 활동 ${activity}분 전`,
    );

  // Each minute counter is `0` or a positive integer without leading zeros.
  const accepted: ReadonlyArray<[string, string, string]> = [
    ["0", "0", "0"],
    ["20", "8", "2"],
    ["120", "10", "102"],
  ];

  for (const [total, stage, activity] of accepted) {
    it(`accepts 전체 ${total}분 · 현재 단계 ${stage}분 · 마지막 ACP 활동 ${activity}분 전`, () => {
      expectValid(elapsed(total, stage, activity));
    });
  }

  const rejected: ReadonlyArray<[string, string, string]> = [
    ["00", "8", "2"],
    ["007", "8", "2"],
    ["20", "08", "2"],
    ["20", "8", "01"],
  ];

  for (const [total, stage, activity] of rejected) {
    it(`rejects 전체 ${total}분 · 현재 단계 ${stage}분 · 마지막 ACP 활동 ${activity}분 전`, () => {
      expectRejected(
        elapsed(total, stage, activity),
        ReasonCodes.IntermediateElapsedDrift,
      );
    });
  }
});

describe("intermediate layout indices", () => {
  // Regression guard: the exported indices are derived from named specs in
  // the layout, so they must land on the expected canonical fixture lines.
  const lines = CANONICAL_INTERMEDIATE.split("\n");

  it("derives the elapsed line index from the layout structure", () => {
    assert.match(
      lines[INTERMEDIATE_ELAPSED_LINE_INDEX] ?? "",
      /^⏱️ \*\*ACP 시간\*\*: /u,
    );
  });

  it("derives the delta bullet index from the layout structure", () => {
    assert.match(lines[INTERMEDIATE_DELTA_BULLET_INDEX] ?? "", /^- Δ/u);
    assert.equal(lines[INTERMEDIATE_DELTA_BULLET_INDEX - 1], "✅ **새 결과**");
  });
});

describe("reason code hygiene", () => {
  it("exposes only prefixed, content-free reason codes", () => {
    for (const code of ALL_REASON_CODES) {
      assert.match(code, /^acp_lifecycle_guard\.[a-z]+\.[a-z_]+$/u);
    }
  });

  it("has no duplicate reason codes", () => {
    assert.equal(new Set(ALL_REASON_CODES).size, ALL_REASON_CODES.length);
  });

  it("rejects an unknown code string", () => {
    assert.equal(isReasonCode("acp_lifecycle_guard.unknown.code"), false);
  });
});

describe("limits are configurable", () => {
  it("honours a lower intermediate ceiling", () => {
    const classification = classifyLifecycleContent(CANONICAL_INTERMEDIATE);
    assert.equal(classification.candidate, true);
    if (!classification.candidate) {
      return;
    }
    const kind: LifecycleKind = classification.kind;
    const result = validateLifecycleReport({
      kind,
      normalized: classification.normalized,
      limits: { maxIntermediateChars: 200, maxBoundaryReportChars: 2000 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reasonCode, ReasonCodes.Oversized);
  });
});
