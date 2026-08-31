import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyLifecycleContent } from "../src/lifecycle/classify.ts";
import {
  APPROVAL_EVIDENCE,
  CANONICAL_COMPLETION,
  CANONICAL_CORRECTION_START,
  CANONICAL_INTERMEDIATE,
  CANONICAL_START,
  ORDINARY_CHAT,
  RENAMED_COMPLETION_TITLE,
  RENAMED_CORRECTION_START_TITLE,
  RENAMED_INTERMEDIATE_TITLE,
  RENAMED_START_TITLE,
  replaceLine,
} from "./fixtures.ts";

describe("classifyLifecycleContent", () => {
  it("classifies each supported lifecycle family", () => {
    const cases: ReadonlyArray<[string, string]> = [
      [CANONICAL_INTERMEDIATE, "intermediate"],
      [CANONICAL_START, "start"],
      [CANONICAL_CORRECTION_START, "correction-start"],
      [CANONICAL_COMPLETION, "completion"],
    ];
    for (const [report, expected] of cases) {
      const result = classifyLifecycleContent(report);
      assert.equal(result.candidate, true);
      assert.equal(result.candidate && result.kind, expected);
    }
  });

  it("classifies a drifted report so the validator can reject it", () => {
    const drifted = CANONICAL_INTERMEDIATE.replace(
      "🔄 **ACP 중간 보고 · 14:20 KST**",
      "🔄 ACP 중간 보고",
    );
    const result = classifyLifecycleContent(drifted);
    assert.equal(result.candidate, true);
    assert.equal(result.candidate && result.kind, "intermediate");
  });

  it("classifies near-canonical renamed titles in every family", () => {
    const cases: ReadonlyArray<[string, string]> = [
      [RENAMED_INTERMEDIATE_TITLE, "intermediate"],
      [RENAMED_START_TITLE, "start"],
      [RENAMED_CORRECTION_START_TITLE, "correction-start"],
      [RENAMED_COMPLETION_TITLE, "completion"],
      [
        replaceLine(
          CANONICAL_COMPLETION,
          0,
          "🏁 **ACP example-harness 실행 종료 · 15:40 KST**",
        ),
        "completion",
      ],
      [
        replaceLine(
          CANONICAL_COMPLETION,
          0,
          "🏁 **ACP example-harness 작업 마무리 · 15:40 KST**",
        ),
        "completion",
      ],
    ];
    for (const [report, expected] of cases) {
      const result = classifyLifecycleContent(report);
      assert.equal(result.candidate, true);
      assert.equal(result.candidate && result.kind, expected);
    }
  });

  it("does not classify ordinary ACP discussion", () => {
    assert.equal(classifyLifecycleContent(ORDINARY_CHAT).candidate, false);
  });

  it("does not classify approval evidence that mentions a report name", () => {
    assert.equal(classifyLifecycleContent(APPROVAL_EVIDENCE).candidate, false);
  });

  it("does not classify empty or whitespace-only content", () => {
    assert.equal(classifyLifecycleContent("").candidate, false);
    assert.equal(classifyLifecycleContent("   \n\n  ").candidate, false);
  });

  it("does not classify a quoted mention of a lifecycle title", () => {
    const quoted = `아래 형식을 참고하세요.\n\n🔄 **ACP 중간 보고 · 14:20 KST**`;
    assert.equal(classifyLifecycleContent(quoted).candidate, false);
  });

  it("classifies through CRLF line endings and a trailing newline", () => {
    const transported = `${CANONICAL_INTERMEDIATE.replace(/\n/gu, "\r\n")}\r\n`;
    const result = classifyLifecycleContent(transported);
    assert.equal(result.candidate, true);
    assert.equal(result.candidate && result.kind, "intermediate");
  });

  it("does not classify a fenced template quotation (documented boundary)", () => {
    const fenced = ["```markdown", "🔄 **ACP 중간 보고 · 14:20 KST**", "```"].join(
      "\n",
    );
    assert.equal(classifyLifecycleContent(fenced).candidate, false);
  });

  it("does not classify a quoted or fenced near-canonical completion title", () => {
    const headline = "🏁 **ACP example-harness 라운드 7 완료**";
    const quoted = ["예시 제목을 검토합니다.", "", headline].join("\n");
    const fenced = ["```markdown", headline, "```"].join("\n");
    assert.equal(classifyLifecycleContent(quoted).candidate, false);
    assert.equal(classifyLifecycleContent(fenced).candidate, false);
  });

  it("does not classify unrelated marker chat even with near-title tokens", () => {
    const unrelated = [
      "🏁 예시 작업을 완료했습니다.",
      "🏁 ACP 상태를 논의합니다.",
      "🏁 **ACPX 완료 보고**",
      [
        "🏁 ACP 예시 작업 완료",
        "🤖 ACP 담당자와 결과를 논의하는 일반 채팅입니다.",
        "📍 작업 위치는 아직 정하지 않았습니다.",
      ].join("\n"),
      "🔄 ACP 진행 현황이 궁금합니다.",
      "🚀 ACP 작업을 시작할까요?",
      "🔁 ACP 수정 작업을 시작할까요?",
    ];
    for (const message of unrelated) {
      assert.equal(classifyLifecycleContent(message).candidate, false);
    }
  });

  it("does not classify completion negatives or operator terminal reports", () => {
    const titles = [
      "🏁 **ACP 작업 미완료 · 15:40 KST**",
      "🏁 **ACP 작업을 완료하지 못했습니다**",
      "🏁 **ACP 완료율 80% · 15:40 KST**",
      "🏁 **ACP 완료 예정 · 15:40 KST**",
      "🏁 **ACP 완료 보고 예정 · 15:40 KST**",
      "🏁 **ACP 실행 실패 · 15:40 KST**",
      "🏁 **ACP 실행 취소 · 15:40 KST**",
      "🏁 **ACP 운영자 차단 · 15:40 KST**",
      "🏁 **ACP 추적 손실 · 15:40 KST**",
    ];
    for (const title of titles) {
      const report = replaceLine(CANONICAL_COMPLETION, 0, title);
      assert.equal(classifyLifecycleContent(report).candidate, false, title);
    }
  });

  it("normalizes NFD-decomposed Hangul before classifying every family", () => {
    for (const report of [
      CANONICAL_INTERMEDIATE,
      CANONICAL_START,
      CANONICAL_CORRECTION_START,
      CANONICAL_COMPLETION,
    ]) {
      const result = classifyLifecycleContent(report.normalize("NFD"));
      assert.equal(result.candidate, true);
      assert.equal(
        result.candidate && result.normalized,
        report.normalize("NFC").replace(/\uFE0F/gu, ""),
      );
    }
  });

  it("classifies a leading-indented title so indentation drift is caught", () => {
    const indented = `  ${CANONICAL_INTERMEDIATE}`;
    const result = classifyLifecycleContent(indented);
    assert.equal(result.candidate, true);
  });
});
