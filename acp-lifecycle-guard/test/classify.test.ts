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

  it("classifies a near-canonical completion title for strict validation", () => {
    const result = classifyLifecycleContent(RENAMED_COMPLETION_TITLE);
    assert.equal(result.candidate, true);
    assert.equal(result.candidate && result.kind, "completion");
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
    const headline = "🏁 **ACP Codex 라운드 7 완료**";
    const quoted = ["예시 제목을 검토합니다.", "", headline].join("\n");
    const fenced = ["```markdown", headline, "```"].join("\n");
    assert.equal(classifyLifecycleContent(quoted).candidate, false);
    assert.equal(classifyLifecycleContent(fenced).candidate, false);
  });

  it("does not classify unrelated finish-marker chat", () => {
    const unrelated = [
      "🏁 예시 작업을 완료했습니다.",
      "🏁 ACP 상태를 논의합니다.",
      "🏁 **ACPX 완료 보고**",
    ];
    for (const message of unrelated) {
      assert.equal(classifyLifecycleContent(message).candidate, false);
    }
  });

  it("classifies a leading-indented title so indentation drift is caught", () => {
    const indented = `  ${CANONICAL_INTERMEDIATE}`;
    const result = classifyLifecycleContent(indented);
    assert.equal(result.candidate, true);
  });
});
