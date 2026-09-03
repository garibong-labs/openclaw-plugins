/**
 * Strict validation of the supported ACP lifecycle report layouts.
 *
 * The validator answers exactly one question: does this payload match the
 * canonical layout for its classified lifecycle family? It never inspects
 * semantics it cannot verify (whether the numbers are true, whether the round
 * is really active) and it never reports payload text back to the caller.
 */

import { hasTrailingWhitespace, toLines } from "./normalize.ts";
import type { LifecycleKind } from "./kinds.ts";
import {
  COMPLETION_LAYOUT,
  COMPLETION_OUTCOME_HEADING_INDEX,
  CORRECTION_START_LAYOUT,
  INTERMEDIATE_DELTA_BULLET_INDEX,
  INTERMEDIATE_ELAPSED_LINE_INDEX,
  INTERMEDIATE_ISSUE_TAIL,
  INTERMEDIATE_LAYOUT,
  INTERMEDIATE_LEGACY_ACTIVITY_LABEL,
  START_LAYOUT,
  compileLayout,
  type CompiledLineSpec,
} from "./layouts.ts";
import { ReasonCodes, type ReasonCode } from "./reason-codes.ts";

export type ValidationResult =
  /**
   * `advisories` carries content-free observations about a report that is
   * nevertheless valid (currently only the transition-window legacy activity
   * label). They never cause a rejection.
   */
  | { ok: true; advisories?: readonly ReasonCode[] }
  | { ok: false; reasonCode: ReasonCode; line?: number };

export type ValidationLimits = {
  /** Character ceiling for the ten-minute cadence report. */
  maxIntermediateChars: number;
  /** Character ceiling for start, correction-start, and completion reports. */
  maxBoundaryReportChars: number;
};

export const DEFAULT_VALIDATION_LIMITS: ValidationLimits = {
  // The intermediate contract caps a rendered report at 1,400 characters.
  maxIntermediateChars: 1400,
  // Boundary reports have no published cap; 2,000 is the single Discord
  // message chunk boundary the skill requires every report to fit inside.
  maxBoundaryReportChars: 2000,
};

const COMPILED = {
  intermediate: compileLayout(INTERMEDIATE_LAYOUT),
  intermediateIssueTail: compileLayout(INTERMEDIATE_ISSUE_TAIL),
  start: compileLayout(START_LAYOUT),
  correctionStart: compileLayout(CORRECTION_START_LAYOUT),
  completion: compileLayout(COMPLETION_LAYOUT),
} as const;

/**
 * Subjects the intermediate contract forbids. ACP must be the grammatical and
 * visual subject of every intermediate value and section.
 */
const INTERMEDIATE_FORBIDDEN_SUBJECTS: readonly RegExp[] = [
  /Eli/u,
  /orchestrator/iu,
  /wrapper/iu,
  /독립 검증/u,
];

/** Progress claims that must not appear before dispatch activation. */
const START_PROGRESS_MARKERS: readonly RegExp[] = [/⏱/u, /🔢/u, /ACP 시간/u];

const DELTA_NONE_BULLET = "- Δ0 · 새로 확인된 ACP 결과 없음";
// Current acp-reporting-v3 emits `Δ<N> · <summary>`.  Accept the historical
// `Δ+<N> <summary>` form only as a bounded migration input; newly built reports
// use the former and are never rewritten here.
const DELTA_INCREMENT_PATTERN = /^- Δ[1-9][0-9]* · \S.*$/u;
const DELTA_INCREMENT_MIGRATION_PATTERN = /^- Δ\+[1-9][0-9]* \S.*$/u;

const TERMINAL_FORBIDDEN_SUBJECTS: readonly RegExp[] = [
  /(?:^|[^\p{L}\p{N}])\/(?:users|home|tmp|var|etc|opt|srv|proc|private)\//iu,
  /(?:^|[^\p{L}\p{N}])~\//u,
  /\b(?:git\s+(?:status|log|diff|show|reflog)|ps\s+(?:aux|-ef|-p)|nohup|disown|setsid)\b/iu,
  /(?:스케줄러|\bscheduler\b|\bcron\b)/iu,
  /(?:프로세스|세션)\s*(?:핸들|목록|조회|확인)/u,
];

function layoutFor(kind: LifecycleKind): readonly CompiledLineSpec[] {
  switch (kind) {
    case "intermediate":
      return COMPILED.intermediate;
    case "start":
      return COMPILED.start;
    case "correction-start":
      return COMPILED.correctionStart;
    case "completion":
      return COMPILED.completion;
  }
}

function limitFor(kind: LifecycleKind, limits: ValidationLimits): number {
  return kind === "intermediate"
    ? limits.maxIntermediateChars
    : limits.maxBoundaryReportChars;
}

function matchLayout(
  lines: readonly string[],
  specs: readonly CompiledLineSpec[],
  offset = 0,
): ValidationResult {
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const line = lines[offset + index];
    if (spec === undefined || line === undefined) {
      return { ok: false, reasonCode: ReasonCodes.LineCountDrift };
    }
    if (!spec.matches(line)) {
      return {
        ok: false,
        reasonCode: spec.code ?? ReasonCodes.LineCountDrift,
        line: offset + index,
      };
    }
  }
  return { ok: true };
}

function validateIntermediateExtras(
  normalized: string,
  lines: readonly string[],
): ValidationResult {
  for (const forbidden of INTERMEDIATE_FORBIDDEN_SUBJECTS) {
    if (forbidden.test(normalized)) {
      return {
        ok: false,
        reasonCode: ReasonCodes.IntermediateForbiddenSubject,
      };
    }
  }
  const deltaBullet = lines[INTERMEDIATE_DELTA_BULLET_INDEX];
  if (
    deltaBullet !== DELTA_NONE_BULLET &&
    !DELTA_INCREMENT_PATTERN.test(deltaBullet ?? "") &&
    !DELTA_INCREMENT_MIGRATION_PATTERN.test(deltaBullet ?? "")
  ) {
    return {
      ok: false,
      reasonCode: ReasonCodes.IntermediateDeltaDrift,
      line: INTERMEDIATE_DELTA_BULLET_INDEX,
    };
  }
  const elapsedLine = lines[INTERMEDIATE_ELAPSED_LINE_INDEX];
  if (
    elapsedLine !== undefined &&
    INTERMEDIATE_LEGACY_ACTIVITY_LABEL.test(elapsedLine)
  ) {
    return {
      ok: true,
      advisories: [ReasonCodes.IntermediateLegacyActivityLabel],
    };
  }
  return { ok: true };
}

function validateCompletion(
  normalized: string,
  lines: readonly string[],
): ValidationResult {
  const structural = validateFixedLayout(lines, COMPILED.completion);
  if (!structural.ok) return structural;
  const expectedOutcome = (lines[0] ?? "").startsWith("🏁") ? "✅ **ACP 완료**" :
    (lines[0] ?? "").startsWith("⛔") ? "⛔ **ACP 취소**" : "❌ **ACP 실패**";
  if (lines[COMPLETION_OUTCOME_HEADING_INDEX] !== expectedOutcome) {
    return { ok: false, reasonCode: ReasonCodes.SectionHeadingDrift };
  }
  for (const forbidden of TERMINAL_FORBIDDEN_SUBJECTS) {
    if (forbidden.test(normalized)) {
      return { ok: false, reasonCode: ReasonCodes.CompletionForbiddenSubject };
    }
  }
  return { ok: true };
}

function validateIntermediate(
  normalized: string,
  lines: readonly string[],
): ValidationResult {
  const base = COMPILED.intermediate;
  const tail = COMPILED.intermediateIssueTail;
  const withIssue = base.length + tail.length;

  if (lines.length !== base.length && lines.length !== withIssue) {
    return { ok: false, reasonCode: ReasonCodes.LineCountDrift };
  }

  const structural = matchLayout(lines, base);
  if (!structural.ok) {
    return structural;
  }

  if (lines.length === withIssue) {
    const issue = matchLayout(lines, tail, base.length);
    if (!issue.ok) {
      return {
        ok: false,
        reasonCode: ReasonCodes.IntermediateIssueSectionDrift,
        ...(issue.line === undefined ? {} : { line: issue.line }),
      };
    }
  }

  return validateIntermediateExtras(normalized, lines);
}

function validateStartFamily(
  normalized: string,
  lines: readonly string[],
  specs: readonly CompiledLineSpec[],
): ValidationResult {
  if (lines.length !== specs.length) {
    return { ok: false, reasonCode: ReasonCodes.LineCountDrift };
  }
  const structural = matchLayout(lines, specs);
  if (!structural.ok) {
    return structural;
  }
  // The title of a correction round legitimately contains `라운드`, so only the
  // elapsed and phase markers are treated as pre-dispatch progress claims.
  const body = lines.slice(1).join("\n");
  for (const marker of START_PROGRESS_MARKERS) {
    if (marker.test(body)) {
      return { ok: false, reasonCode: ReasonCodes.StartProgressClaim };
    }
  }
  void normalized;
  return { ok: true };
}

function validateFixedLayout(
  lines: readonly string[],
  specs: readonly CompiledLineSpec[],
): ValidationResult {
  if (lines.length !== specs.length) {
    return { ok: false, reasonCode: ReasonCodes.LineCountDrift };
  }
  return matchLayout(lines, specs);
}

/**
 * Validate a normalized lifecycle payload against its canonical layout.
 *
 * `normalized` must come from `classifyLifecycleContent`, which already applied
 * line-ending and variation-selector normalization.
 */
export function validateLifecycleReport(params: {
  kind: LifecycleKind;
  normalized: string;
  limits?: ValidationLimits;
}): ValidationResult {
  const limits = params.limits ?? DEFAULT_VALIDATION_LIMITS;
  const { kind, normalized } = params;

  if (normalized.trim().length === 0) {
    return { ok: false, reasonCode: ReasonCodes.Empty };
  }
  if (normalized.length > limitFor(kind, limits)) {
    return { ok: false, reasonCode: ReasonCodes.Oversized };
  }

  const lines = toLines(normalized);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && hasTrailingWhitespace(line)) {
      return {
        ok: false,
        reasonCode: ReasonCodes.TrailingWhitespace,
        line: index,
      };
    }
  }

  switch (kind) {
    case "intermediate":
      return validateIntermediate(normalized, lines);
    case "start":
    case "correction-start":
      return validateStartFamily(normalized, lines, layoutFor(kind));
    case "completion":
      return validateCompletion(normalized, lines);
  }
}
