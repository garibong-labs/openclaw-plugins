/**
 * Synthetic lifecycle report fixtures.
 *
 * Every value here is invented for tests. No real channel, message, user,
 * session, cron, process, repository, branch, or model identifier appears in
 * this repository.
 */

export const CANONICAL_INTERMEDIATE = [
  "🔄 **ACP 중간 보고 · 14:20 KST**",
  "",
  "🤖 **ACP**: example-harness · `example-model-1`",
  "📍 **작업**: `example-repo` · `feat/example`",
  "🔢 **라운드**: 1 · 2/4 구현",
  "⏱️ **ACP 시간**: 전체 20분 · 현재 단계 8분 · 마지막 변화 2분 전",
  "🔁 **실행 상태**: ACP 프롬프트 실행 중",
  "",
  "✅ **새 결과**",
  "- Δ0 · 새로 확인된 ACP 결과 없음",
  "",
  "🛠️ **ACP 진행 중**",
  "- 정책 모듈 구현 3/5",
  "",
  "🧪 **ACP 자체 검증**",
  "- 아직 실행 전",
  "",
  "⏭️ **ACP 다음**",
  "- 남은 게이트 2개 · 검증 실행",
].join("\n");

export const CANONICAL_INTERMEDIATE_WITH_ISSUE = [
  CANONICAL_INTERMEDIATE,
  "",
  "⚠️ **이슈**",
  "- 예시 차단 요인 1건",
].join("\n");

export const CANONICAL_START = [
  "🚀 **ACP 작업 시작 · 14:00 KST**",
  "",
  "🤖 **ACP**: example-harness · `example-model-1`",
  "📍 **작업**: `example-repo` · `feat/example`",
  "",
  "🎯 **범위**",
  "- 예시 구현 범위",
  "",
  "🕒 **중간 보고**",
  "- ACP 실행 10분 이상일 때만 시작",
  "",
  "🔒 **외부 작업**",
  "- 없음",
].join("\n");

export const CANONICAL_CORRECTION_START = CANONICAL_START.replace(
  "🚀 **ACP 작업 시작 · 14:00 KST**",
  "🔁 **ACP 수정 라운드 2 시작 · 15:00 KST**",
);

export const CANONICAL_COMPLETION = [
  "🏁 **ACP 완료 보고 · 15:40 KST**",
  "",
  "🤖 **ACP**: example-harness · `example-model-1`",
  "📍 **작업**: `example-repo` · `feat/example`",
  "⏱️ **ACP 소요**: 42분 · 라운드 1",
  "",
  "✅ **ACP 완료**",
  "- 예시 구현 완료",
  "",
  "🧪 **ACP 자체 검증**",
  "- 테스트 24/24 통과",
  "",
  "📦 **결과**",
  "- 커밋 1개 · 변경 파일 9개",
  "",
  "🔍 **다음**",
  "- Eli 독립 검증 시작",
  "",
  "🔒 **외부 작업**",
  "- 없음",
].join("\n");

export const ORDINARY_CHAT =
  "ACP 중간 보고 주기는 10분입니다. 지금은 시작 보고만 보냈습니다.";

export const APPROVAL_EVIDENCE = [
  "승인 근거를 정리했습니다.",
  "- ACP 완료 보고 이후 독립 검증을 시작합니다.",
].join("\n");

/** Replace one line, keeping every other line untouched. */
export function replaceLine(
  report: string,
  index: number,
  replacement: string,
): string {
  const lines = report.split("\n");
  lines[index] = replacement;
  return lines.join("\n");
}

/** Remove one line so the surrounding structure shifts. */
export function removeLine(report: string, index: number): string {
  const lines = report.split("\n");
  lines.splice(index, 1);
  return lines.join("\n");
}

/** Insert one line at `index`. */
export function insertLine(
  report: string,
  index: number,
  inserted: string,
): string {
  const lines = report.split("\n");
  lines.splice(index, 0, inserted);
  return lines.join("\n");
}

/** Index of the `⏱ **ACP 소요**` line inside a completion report. */
export const COMPLETION_DURATION_LINE_INDEX = 4;

/** Completion report whose elapsed duration uses `duration` verbatim. */
export function completionWithDuration(duration: string): string {
  return replaceLine(
    CANONICAL_COMPLETION,
    COMPLETION_DURATION_LINE_INDEX,
    `⏱️ **ACP 소요**: ${duration} · 라운드 1`,
  );
}

/** Completion report in the minute-plus-seconds form production emits. */
export const CANONICAL_COMPLETION_WITH_SECONDS =
  completionWithDuration("17분 31초");
