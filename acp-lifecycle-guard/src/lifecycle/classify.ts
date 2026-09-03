/**
 * Lifecycle candidate classification.
 *
 * Classification is anchored on the first visible line. That line must begin
 * with a supported family's marker and contain the standalone `ACP` token. An
 * exact canonical family phrase is sufficient. A renamed title must instead
 * express that family's lifecycle intent and have at least two recognizable
 * family body lines later in the payload. Completion failure, cancellation,
 * blocker, tracking-loss, pending, and non-completion titles are excluded even
 * when their payload happens to resemble a lifecycle report.
 *
 * This boundary is deliberate and documented:
 *
 * - Ordinary chat that merely mentions `ACP 중간 보고` is not a candidate, so
 *   discussion, approval evidence, and status answers are never touched.
 * - A payload that drops the marker emoji entirely is not a candidate either.
 *   The guard fails open on classification and fails closed on validation; it
 *   is a malformed-delivery safeguard, not a completeness oracle.
 */

import { normalizeReportText, toLines } from "./normalize.ts";
import type { LifecycleKind } from "./kinds.ts";

type ClassifierRule = {
  kind: LifecycleKind;
  marker: string;
  canonicalPhrase: string;
  nearTitleIntent: RegExp;
  bodyAnchors: readonly RegExp[];
  excludedTitle?: RegExp;
};

const METADATA_ANCHORS: readonly RegExp[] = [
  /^🤖 \*\*ACP\*\*: /u,
  /^📍 \*\*작업\*\*: /u,
];

const CLASSIFIER_RULES: readonly ClassifierRule[] = [
  {
    kind: "intermediate",
    marker: "🔄",
    canonicalPhrase: "ACP 중간 보고",
    nearTitleIntent: /(?:중간|진행)\s*(?:보고|현황|상황)/u,
    bodyAnchors: [
      ...METADATA_ANCHORS,
      /^🔢 \*\*라운드\*\*: /u,
      /^⏱ \*\*ACP 시간\*\*: /u,
      /^✅ \*\*새 결과\*\*$/u,
      /^🛠 \*\*ACP 진행 중\*\*$/u,
    ],
  },
  {
    kind: "start",
    marker: "🚀",
    canonicalPhrase: "ACP 작업 시작",
    nearTitleIntent: /(?:시작|착수)/u,
    bodyAnchors: [
      ...METADATA_ANCHORS,
      /^🎯 \*\*범위\*\*$/u,
      /^🕒 \*\*중간 보고\*\*$/u,
      /^🔒 \*\*외부 작업\*\*$/u,
    ],
  },
  {
    kind: "correction-start",
    marker: "🔁",
    canonicalPhrase: "ACP 수정 라운드",
    nearTitleIntent: /(?:수정|교정).*(?:시작|착수)/u,
    bodyAnchors: [
      ...METADATA_ANCHORS,
      /^🎯 \*\*범위\*\*$/u,
      /^🕒 \*\*중간 보고\*\*$/u,
      /^🔒 \*\*외부 작업\*\*$/u,
    ],
  },
  {
    kind: "completion",
    marker: "🏁",
    canonicalPhrase: "ACP 완료 보고",
    nearTitleIntent:
      /(?:^|[^가-힣A-Za-z0-9_])(?:완료|종료|마무리)(?:$|[^가-힣A-Za-z0-9_])/u,
    excludedTitle:
      /미완료|완료율|(?:완료|종료|마무리)(?:\s*보고)?\s*(?:하지|못|예정)|차단|중단|추적\s*(?:실패|불가|손실)|추적\s*놓침/u,
    bodyAnchors: [
      ...METADATA_ANCHORS,
      /^⏱ \*\*ACP 소요\*\*: /u,
      /^✅ \*\*ACP 완료\*\*$/u,
      /^📦 \*\*결과\*\*$/u,
      /^🔍 \*\*다음\*\*$/u,
    ],
  },
  {
    kind: "completion",
    marker: "⛔",
    canonicalPhrase: "ACP 취소 보고",
    nearTitleIntent: /취소/u,
    bodyAnchors: [...METADATA_ANCHORS, /^\u26D4 \*\*ACP 취소\*\*$/u, /^\uD83D\uDCE6 \*\*결과\*\*$/u],
  },
  {
    kind: "completion",
    marker: "❌",
    canonicalPhrase: "ACP 실패 보고",
    nearTitleIntent: /실패/u,
    bodyAnchors: [...METADATA_ANCHORS, /^\u274C \*\*ACP 실패\*\*$/u, /^\uD83D\uDCE6 \*\*결과\*\*$/u],
  },
];

const ACP_TOKEN_PATTERN = /(?:^|[^A-Za-z0-9_])ACP(?:$|[^A-Za-z0-9_])/u;

export type Classification =
  | { candidate: false }
  | { candidate: true; kind: LifecycleKind; normalized: string };

export function classifyLifecycleContent(content: string): Classification {
  const normalized = normalizeReportText(content);
  const lines = toLines(normalized);
  const headlineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headlineIndex < 0) {
    return { candidate: false };
  }
  const headline = lines[headlineIndex];
  if (headline === undefined) {
    return { candidate: false };
  }
  const probe = headline.trimStart();
  for (const rule of CLASSIFIER_RULES) {
    if (!probe.startsWith(rule.marker) || !ACP_TOKEN_PATTERN.test(probe)) {
      continue;
    }
    if (rule.excludedTitle?.test(probe)) {
      continue;
    }
    if (probe.includes(rule.canonicalPhrase)) {
      return { candidate: true, kind: rule.kind, normalized };
    }
    if (!rule.nearTitleIntent.test(probe)) {
      continue;
    }
    const body = lines.slice(headlineIndex + 1);
    const anchorCount = rule.bodyAnchors.reduce(
      (count, pattern) =>
        count + (body.some((line) => pattern.test(line)) ? 1 : 0),
      0,
    );
    if (anchorCount >= 2) {
      return { candidate: true, kind: rule.kind, normalized };
    }
  }
  return { candidate: false };
}
