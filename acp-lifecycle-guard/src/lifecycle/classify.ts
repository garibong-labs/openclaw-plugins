/**
 * Lifecycle candidate classification.
 *
 * Classification is anchored on the first visible line only: a payload is an
 * ACP lifecycle candidate when that line begins with the lifecycle marker emoji
 * **and** carries the lifecycle phrase for one supported family.
 *
 * This boundary is deliberate and documented:
 *
 * - Ordinary chat that merely mentions `ACP 중간 보고` is not a candidate, so
 *   discussion, approval evidence, and status answers are never touched.
 * - A payload that drops the marker emoji entirely is not a candidate either.
 *   The guard fails open on classification and fails closed on validation; it
 *   is a malformed-delivery safeguard, not a completeness oracle.
 */

import { firstNonEmptyLine, normalizeReportText } from "./normalize.ts";
import type { LifecycleKind } from "./kinds.ts";

type ClassifierRule = {
  kind: LifecycleKind;
  marker: string;
  phrase: string;
};

const CLASSIFIER_RULES: readonly ClassifierRule[] = [
  { kind: "intermediate", marker: "🔄", phrase: "ACP 중간 보고" },
  { kind: "start", marker: "🚀", phrase: "ACP 작업 시작" },
  { kind: "correction-start", marker: "🔁", phrase: "ACP 수정 라운드" },
  { kind: "completion", marker: "🏁", phrase: "ACP 완료 보고" },
];

export type Classification =
  | { candidate: false }
  | { candidate: true; kind: LifecycleKind; normalized: string };

export function classifyLifecycleContent(content: string): Classification {
  const normalized = normalizeReportText(content);
  const headline = firstNonEmptyLine(normalized);
  if (headline === undefined) {
    return { candidate: false };
  }
  const probe = headline.trimStart();
  for (const rule of CLASSIFIER_RULES) {
    if (probe.startsWith(rule.marker) && probe.includes(rule.phrase)) {
      return { candidate: true, kind: rule.kind, normalized };
    }
  }
  return { candidate: false };
}
