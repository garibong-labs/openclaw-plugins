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

/**
 * Exact synthetic 20-line terminal shape emitted by the approved
 * acp-discord-orchestrator completion builder. This fixture is copied as a
 * public contract example; the guard does not depend on the skills repository.
 */
export const ORCHESTRATOR_TERMINAL_COMPLETION = [
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

export const CANONICAL_COMPLETION = ORCHESTRATOR_TERMINAL_COMPLETION;

/** Synthetic near-canonical completion whose renamed title must not bypass. */
export const RENAMED_COMPLETION_TITLE = replaceLine(
  CANONICAL_COMPLETION,
  0,
  "🏁 **ACP Codex 라운드 7 완료**",
);

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

/** Synthetic shell command that invokes a canonical ACP launch entrypoint. */
export const ACP_LAUNCH_COMMAND =
  "node ./example-tools/acp-host-transport-cli.mjs --example-flag";

/** Synthetic shell command with no relation to ACP launch entrypoints. */
export const ORDINARY_COMMAND = "npm run check";

/**
 * Synthetic owner progress checkpoint prompt. The first line is the public
 * marker contract; everything after it is invented.
 */
export const OWNER_CHECKPOINT_PROMPT = [
  "[owner-progress-checkpoint:v1]",
  "",
  "예시 진행 점검: 현재 작업 상태를 정리해 원래 대화로 보고하세요.",
].join("\n");

/** Marker text pasted mid-conversation by an ordinary (untrusted) turn. */
export const MARKER_IN_ORDINARY_TEXT = OWNER_CHECKPOINT_PROMPT;

/** Prompt whose marker is present but not on the first line. */
export const CHECKPOINT_PROMPT_MARKER_NOT_FIRST = [
  "예시 서문",
  "[owner-progress-checkpoint:v1]",
].join("\n");

/** Prompt carrying a near-miss of the marker (version drift on line one). */
export const CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT = [
  "[owner-progress-checkpoint:v2]",
  "",
  "예시 점검 프롬프트 본문.",
].join("\n");

/**
 * Synthetic checkpoint result reports. The receipt guard is deliberately
 * content-blind, so one fixture per reported state proves that terminal
 * green, terminal failure, blocked, and active/pending reports all count the
 * same once the send itself succeeds to the exact destination.
 */
export const CHECKPOINT_REPORT_TERMINAL_GREEN =
  "✅ 예시 점검 보고: 작업 완료, 검증 통과.";
export const CHECKPOINT_REPORT_TERMINAL_FAILURE =
  "❌ 예시 점검 보고: 작업 실패, 오류 1건.";
export const CHECKPOINT_REPORT_BLOCKED =
  "⛔ 예시 점검 보고: 승인 대기로 차단됨.";
export const CHECKPOINT_REPORT_ACTIVE =
  "🔄 예시 점검 보고: 작업 진행 중, 절반 완료.";

/**
 * Trusted scheduler hook context for an eligible synthetic checkpoint run.
 *
 * Deliberately carries no `jobId`: this mirrors the authoritative installed
 * shape (`openclaw@2026.7.1-2` embedded cron path), where the executor passes
 * `jobId` into `runEmbeddedAgent` but the `before_agent_run` hook context
 * assembled inside the embedded runner omits it. Eligibility must therefore
 * hold without a job id.
 */
export const CHECKPOINT_RUN_CONTEXT = {
  trigger: "cron",
  runId: "example-run-1",
  sessionKey: "example-session-key-1",
  channel: "example-messenger",
  channelId: "example-conversation-1",
} as const;

/**
 * The same eligible run as seen on the CLI-runner cron path, which does
 * expose `jobId`. Presence of the optional field must not change any outcome.
 */
export const CHECKPOINT_RUN_CONTEXT_WITH_JOB_ID = {
  ...CHECKPOINT_RUN_CONTEXT,
  jobId: "example-cron-job-1",
} as const;

/** The exact-destination delivery context the run above must publish to. */
export const CHECKPOINT_SEND_CONTEXT = {
  channelId: "example-messenger",
  conversationId: "example-conversation-1",
  sessionKey: "example-session-key-1",
} as const;

/** A successful delivery somewhere other than the original conversation. */
export const WRONG_TARGET_SEND_CONTEXT = {
  channelId: "example-messenger",
  conversationId: "example-conversation-2",
  sessionKey: "example-session-key-1",
} as const;
