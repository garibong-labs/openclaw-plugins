import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyLifecycleContent } from "../src/lifecycle/classify.ts";
import type { LifecycleKind } from "../src/lifecycle/kinds.ts";
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
  completionWithDuration,
  insertLine,
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
      replaceLine(CANONICAL_INTERMEDIATE, 9, "- Δ+2 게이트 2건 통과 확인"),
    );
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
});

describe("intermediate drift", () => {
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
      "🤖 **ACP**: example-harness · `example-model-1`",
    );
    expectRejected(swapped, ReasonCodes.MetadataLineDrift);
  });

  it("rejects a model value that is not inline code", () => {
    expectRejected(
      replaceLine(
        CANONICAL_INTERMEDIATE,
        2,
        "🤖 **ACP**: example-harness · example-model-1",
      ),
      ReasonCodes.MetadataLineDrift,
    );
  });

  it("rejects the early legacy elapsed-only line", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 5, "⏱️ **ACP 시간**: 20분"),
      ReasonCodes.IntermediateElapsedDrift,
    );
  });

  it("rejects an elapsed line missing the last-change segment", () => {
    expectRejected(
      replaceLine(
        CANONICAL_INTERMEDIATE,
        5,
        "⏱️ **ACP 시간**: 전체 20분 · 현재 단계 8분",
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
      replaceLine(CANONICAL_INTERMEDIATE, 9, "- 새로운 결과 있음"),
      ReasonCodes.IntermediateDeltaDrift,
    );
  });

  it("rejects an altered Δ0 sentence", () => {
    expectRejected(
      replaceLine(CANONICAL_INTERMEDIATE, 9, "- Δ0 · 새 결과 없음"),
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
  it("rejects a drifted duration line", () => {
    expectRejected(
      replaceLine(CANONICAL_COMPLETION, 4, "⏱️ **ACP 소요**: 42분"),
      ReasonCodes.CompletionDurationDrift,
    );
  });

  it("rejects a drifted next-step sentence", () => {
    expectRejected(
      replaceLine(CANONICAL_COMPLETION, 16, "- 검증 시작"),
      ReasonCodes.CompletionNextLineDrift,
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
  const accepted = ["17분 31초", "42분", "0분", "0분 0초", "7분 09초", "128분 59초"];

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

describe("reason code hygiene", () => {
  it("exposes only prefixed, content-free reason codes", () => {
    for (const code of ALL_REASON_CODES) {
      assert.match(code, /^acp_report_guard\.[a-z]+\.[a-z_]+$/u);
    }
  });

  it("has no duplicate reason codes", () => {
    assert.equal(new Set(ALL_REASON_CODES).size, ALL_REASON_CODES.length);
  });

  it("rejects an unknown code string", () => {
    assert.equal(isReasonCode("acp_report_guard.unknown.code"), false);
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
