/**
 * Stable, content-free reason codes.
 *
 * These are the only guard-authored strings that may reach a log line, a hook
 * `cancelReason`, or hook metadata. They must never embed message text, channel
 * identifiers, session keys, or any other runtime value.
 */

export const REASON_CODE_PREFIX = "acp_lifecycle_guard";

export const ReasonCodes = {
  /** Report exceeds the configured character ceiling for its lifecycle kind. */
  Oversized: `${REASON_CODE_PREFIX}.common.oversized`,
  /** Report body is empty after normalization. */
  Empty: `${REASON_CODE_PREFIX}.common.empty`,
  /** A line carries trailing whitespace (including Markdown hard-break spaces). */
  TrailingWhitespace: `${REASON_CODE_PREFIX}.common.trailing_whitespace`,
  /** Line count does not match the canonical layout for the lifecycle kind. */
  LineCountDrift: `${REASON_CODE_PREFIX}.common.line_count_drift`,
  /** Title line does not match the canonical title. */
  TitleDrift: `${REASON_CODE_PREFIX}.common.title_drift`,
  /** A required blank separator line is missing or an extra blank line exists. */
  BlankLineDrift: `${REASON_CODE_PREFIX}.common.blank_line_drift`,
  /** A metadata line is missing, reordered, or shaped differently. */
  MetadataLineDrift: `${REASON_CODE_PREFIX}.common.metadata_line_drift`,
  /** A section heading is missing, renamed, reordered, or duplicated. */
  SectionHeadingDrift: `${REASON_CODE_PREFIX}.common.section_heading_drift`,
  /** A section bullet is missing, nested, or not a single top-level bullet. */
  BulletLineDrift: `${REASON_CODE_PREFIX}.common.bullet_line_drift`,

  /** Elapsed line is not the canonical total / current-stage / last-change form. */
  IntermediateElapsedDrift: `${REASON_CODE_PREFIX}.intermediate.elapsed_drift`,
  /** New-result bullet does not use the canonical `Δ0` or `Δ+N` marker. */
  IntermediateDeltaDrift: `${REASON_CODE_PREFIX}.intermediate.delta_drift`,
  /** Report uses a subject the intermediate contract forbids. */
  IntermediateForbiddenSubject: `${REASON_CODE_PREFIX}.intermediate.forbidden_subject`,
  /** Optional issue section is present but malformed, or trailing content follows it. */
  IntermediateIssueSectionDrift: `${REASON_CODE_PREFIX}.intermediate.issue_section_drift`,

  /** Start report claims phase or elapsed progress before dispatch activation. */
  StartProgressClaim: `${REASON_CODE_PREFIX}.start.progress_claim`,
  /** Start report cadence bullet is not the canonical sentence. */
  StartCadenceLineDrift: `${REASON_CODE_PREFIX}.start.cadence_line_drift`,

  /** Completion report duration line is not the canonical form. */
  CompletionDurationDrift: `${REASON_CODE_PREFIX}.completion.duration_drift`,
  /** Completion report next-step bullet is not the canonical sentence. */
  CompletionNextLineDrift: `${REASON_CODE_PREFIX}.completion.next_line_drift`,

  /** Direct message-tool publication of an ACP intermediate report. */
  ToolDirectIntermediate: `${REASON_CODE_PREFIX}.tool.direct_intermediate_blocked`,

  /** Recognized ACP launch route invoked by an agent other than `main`. */
  LaunchNonMainAgent: `${REASON_CODE_PREFIX}.launch.non_main_agent`,
} as const;

export type ReasonCode = (typeof ReasonCodes)[keyof typeof ReasonCodes];

/** Every reason code the guard is allowed to emit. */
export const ALL_REASON_CODES: readonly ReasonCode[] = Object.freeze(
  Object.values(ReasonCodes),
);

/** Guard against accidentally emitting an unlisted or content-bearing string. */
export function isReasonCode(value: string): value is ReasonCode {
  return (ALL_REASON_CODES as readonly string[]).includes(value);
}
