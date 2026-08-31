/**
 * Canonical line layouts for the supported ACP lifecycle families.
 *
 * Every layout below is transcribed from the live `acp-progress-reporting`
 * skill. Line order, blank separators, metadata order, section names, and the
 * one-bullet-per-section rule are all part of the contract, so they are encoded
 * positionally rather than as a loose set of "required markers".
 *
 * Emoji variation selectors are stripped from both the specs and the payload
 * before comparison (see `normalize.ts`).
 */

import { stripVariationSelectors } from "./normalize.ts";
import { ReasonCodes, type ReasonCode } from "./reason-codes.ts";

export type LineSpec =
  | { kind: "blank" }
  | { kind: "literal"; text: string; code: ReasonCode }
  | { kind: "pattern"; source: string; code: ReasonCode };

export type CompiledLineSpec = {
  code: ReasonCode | null;
  matches: (line: string) => boolean;
};

const TIME_SUFFIX = "([01][0-9]|2[0-3]):[0-5][0-9] KST";

/**
 * Completion elapsed duration: `<n>분`, optionally followed by `<s>초`.
 *
 * Both forms are canonical - a completion report emits the minute-only form
 * for a whole-minute run and the minute-plus-seconds form otherwise
 * (`17분 31초`). Seconds are bounded to 0-59 so an unnormalized value such as
 * `17분 90초` stays duration drift, as does a missing unit, a missing
 * separating space, or a repeated segment.
 */
const COMPLETION_DURATION_SOURCE = "[0-9]+분(?: [0-5]?[0-9]초)?";

/** Exactly one top-level bullet with visible text; nested bullets are drift. */
const BULLET_SOURCE = "^- \\S.*$";

const bullet = (): LineSpec => ({
  kind: "pattern",
  source: BULLET_SOURCE,
  code: ReasonCodes.BulletLineDrift,
});

const blank = (): LineSpec => ({ kind: "blank" });

const heading = (text: string): LineSpec => ({
  kind: "literal",
  text,
  code: ReasonCodes.SectionHeadingDrift,
});

/** `🤖 **ACP**: <harness> · `<exact-model>`` */
const ACP_HARNESS_LINE: LineSpec = {
  kind: "pattern",
  source: "^🤖 \\*\\*ACP\\*\\*: \\S.* · `[^`]+`$",
  code: ReasonCodes.MetadataLineDrift,
};

/** `📍 **작업**: `<repository basename>` · `<branch>`` */
const ACP_TARGET_LINE: LineSpec = {
  kind: "pattern",
  source: "^📍 \\*\\*작업\\*\\*: `[^`]+` · `[^`]+`$",
  code: ReasonCodes.MetadataLineDrift,
};

export const INTERMEDIATE_LAYOUT: readonly LineSpec[] = [
  {
    kind: "pattern",
    source: `^🔄 \\*\\*ACP 중간 보고 · ${TIME_SUFFIX}\\*\\*$`,
    code: ReasonCodes.TitleDrift,
  },
  blank(),
  ACP_HARNESS_LINE,
  ACP_TARGET_LINE,
  {
    kind: "pattern",
    source: "^🔢 \\*\\*라운드\\*\\*: [1-9][0-9]* · [1-4]/4 \\S.*$",
    code: ReasonCodes.MetadataLineDrift,
  },
  {
    // Rejects the early legacy elapsed-only line such as `⏱ **ACP 시간**: 12분`
    // and the legacy `마지막 변화` activity label. The activity-age segment is
    // shape-only: it carries no relation to the `새 결과` delta bullet.
    kind: "pattern",
    source:
      "^⏱ \\*\\*ACP 시간\\*\\*: 전체 [0-9]+분 · 현재 단계 [0-9]+분 · 마지막 ACP 활동 [0-9]+분 전$",
    code: ReasonCodes.IntermediateElapsedDrift,
  },
  {
    kind: "pattern",
    source: "^🔁 \\*\\*실행 상태\\*\\*: \\S.*$",
    code: ReasonCodes.MetadataLineDrift,
  },
  blank(),
  heading("✅ **새 결과**"),
  bullet(),
  blank(),
  heading("🛠 **ACP 진행 중**"),
  bullet(),
  blank(),
  heading("🧪 **ACP 자체 검증**"),
  bullet(),
  blank(),
  heading("⏭ **ACP 다음**"),
  bullet(),
];

/** Optional issue block, permitted only as the exact trailing section. */
export const INTERMEDIATE_ISSUE_TAIL: readonly LineSpec[] = [
  blank(),
  heading("⚠ **이슈**"),
  bullet(),
];

/** Index of the `새 결과` bullet inside `INTERMEDIATE_LAYOUT`. */
export const INTERMEDIATE_DELTA_BULLET_INDEX = 9;

const START_BODY: readonly LineSpec[] = [
  blank(),
  ACP_HARNESS_LINE,
  ACP_TARGET_LINE,
  blank(),
  heading("🎯 **범위**"),
  bullet(),
  blank(),
  heading("🕒 **중간 보고**"),
  {
    kind: "literal",
    text: "- ACP 실행 10분 이상일 때만 시작",
    code: ReasonCodes.StartCadenceLineDrift,
  },
  blank(),
  heading("🔒 **외부 작업**"),
  bullet(),
];

export const START_LAYOUT: readonly LineSpec[] = [
  {
    kind: "pattern",
    source: `^🚀 \\*\\*ACP 작업 시작 · ${TIME_SUFFIX}\\*\\*$`,
    code: ReasonCodes.TitleDrift,
  },
  ...START_BODY,
];

export const CORRECTION_START_LAYOUT: readonly LineSpec[] = [
  {
    kind: "pattern",
    source: `^🔁 \\*\\*ACP 수정 라운드 [1-9][0-9]* 시작 · ${TIME_SUFFIX}\\*\\*$`,
    code: ReasonCodes.TitleDrift,
  },
  ...START_BODY,
];

export const COMPLETION_LAYOUT: readonly LineSpec[] = [
  {
    kind: "pattern",
    source: `^🏁 \\*\\*ACP 완료 보고 · ${TIME_SUFFIX}\\*\\*$`,
    code: ReasonCodes.TitleDrift,
  },
  blank(),
  ACP_HARNESS_LINE,
  ACP_TARGET_LINE,
  {
    kind: "pattern",
    source: `^⏱ \\*\\*ACP 소요\\*\\*: ${COMPLETION_DURATION_SOURCE} · 라운드 [1-9][0-9]*$`,
    code: ReasonCodes.CompletionDurationDrift,
  },
  blank(),
  heading("✅ **ACP 완료**"),
  bullet(),
  blank(),
  heading("🧪 **ACP 자체 검증**"),
  bullet(),
  blank(),
  heading("📦 **결과**"),
  bullet(),
  blank(),
  heading("🔍 **다음**"),
  {
    kind: "literal",
    text: "- Eli 독립 검증 시작",
    code: ReasonCodes.CompletionNextLineDrift,
  },
  blank(),
  heading("🔒 **외부 작업**"),
  bullet(),
];

export function compileLineSpec(spec: LineSpec): CompiledLineSpec {
  if (spec.kind === "blank") {
    return {
      code: ReasonCodes.BlankLineDrift,
      matches: (line) => line.length === 0,
    };
  }
  if (spec.kind === "literal") {
    const expected = stripVariationSelectors(spec.text);
    return { code: spec.code, matches: (line) => line === expected };
  }
  const pattern = new RegExp(stripVariationSelectors(spec.source), "u");
  return { code: spec.code, matches: (line) => pattern.test(line) };
}

export function compileLayout(
  layout: readonly LineSpec[],
): readonly CompiledLineSpec[] {
  return layout.map(compileLineSpec);
}
