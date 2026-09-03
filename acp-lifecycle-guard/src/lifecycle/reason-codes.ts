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

  /** Elapsed line is not the canonical total / current-stage / last-ACP-activity form. */
  IntermediateElapsedDrift: `${REASON_CODE_PREFIX}.intermediate.elapsed_drift`,
  /**
   * Valid intermediate report using the transition-window legacy activity
   * label (`마지막 변화`). Advisory only: the report passes, and this code is
   * never a cancel reason. Remove together with the legacy alternative in the
   * elapsed-line pattern once every reporting host emits the revised label.
   */
  IntermediateLegacyActivityLabel: `${REASON_CODE_PREFIX}.intermediate.legacy_activity_label`,
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
  /** Completion report contains a recognized operational subject. */
  CompletionForbiddenSubject: `${REASON_CODE_PREFIX}.completion.forbidden_subject`,

  /** Direct message-tool publication of an ACP intermediate report. */
  ToolDirectIntermediate: `${REASON_CODE_PREFIX}.tool.direct_intermediate_blocked`,

  /** Recognized ACP launch route invoked by an agent other than `main`. */
  LaunchNonMainAgent: `${REASON_CODE_PREFIX}.launch.non_main_agent`,

  /** Eligible owner checkpoint registered for delivery-receipt tracking. */
  ReceiptCheckpointRegistered: `${REASON_CODE_PREFIX}.receipt.checkpoint_registered`,
  /** Marker plus provenance matched, but correlation fields were missing or ambiguous. */
  ReceiptUncorrelatable: `${REASON_CODE_PREFIX}.receipt.uncorrelatable`,
  /** Trusted cron prompt carries a near-miss of the checkpoint marker. */
  ReceiptMarkerDrift: `${REASON_CODE_PREFIX}.receipt.marker_drift`,
  /** Exact-destination successful send receipt confirmed. */
  ReceiptConfirmed: `${REASON_CODE_PREFIX}.receipt.confirmed`,
  /** Successful send from an eligible checkpoint run to a different destination. */
  ReceiptTargetMismatch: `${REASON_CODE_PREFIX}.receipt.target_mismatch`,
  /** Correlated successful send whose destination metadata cannot be verified. */
  ReceiptTargetUnverifiable: `${REASON_CODE_PREFIX}.receipt.target_unverifiable`,
  /** Eligible checkpoint reached finalize without a publication receipt. */
  ReceiptMissing: `${REASON_CODE_PREFIX}.receipt.missing`,
  /** Tracked checkpoint outlived the TTL and reached finalize with no receipt. */
  ReceiptStaleMissing: `${REASON_CODE_PREFIX}.receipt.stale_missing`,
  /** Bounded-state pressure removed tracked checkpoint entries. */
  ReceiptEvicted: `${REASON_CODE_PREFIX}.receipt.evicted`,
  /** Enforce mode requested a bounded finalize revise round. */
  ReceiptReviseRequested: `${REASON_CODE_PREFIX}.receipt.revise_requested`,
  /**
   * An agent end on a tracked session key could not prove run identity; the
   * entry is retained as a bounded end-observed terminal candidate.
   */
  ReceiptEndUnproven: `${REASON_CODE_PREFIX}.receipt.end_unproven`,

  ControllerCallerInvalid: `${REASON_CODE_PREFIX}.controller.caller_invalid`,
  ControllerLeaseNotFound: `${REASON_CODE_PREFIX}.controller.lease_not_found`,
  ControllerReleaseDenied: `${REASON_CODE_PREFIX}.controller.release_denied`,
  ControllerPreactivationAbortDenied: `${REASON_CODE_PREFIX}.controller.preactivation_abort_denied`,
  ControllerActionInvalid: `${REASON_CODE_PREFIX}.controller.action_invalid`,
  ControllerInputInvalid: `${REASON_CODE_PREFIX}.controller.input_invalid`,
  ControllerDigestAmbiguous: `${REASON_CODE_PREFIX}.controller.digest_ambiguous`,
  ControllerScopeMismatch: `${REASON_CODE_PREFIX}.controller.scope_mismatch`,
  ControllerAckFailed: `${REASON_CODE_PREFIX}.controller.ack_failed`,
  LeaseEarlyCompletion: `${REASON_CODE_PREFIX}.controller.early_completion_blocked`,
  LeaseFinalizeBlocked: `${REASON_CODE_PREFIX}.controller.finalize_blocked`,
  LeaseAgentEndViolation: `${REASON_CODE_PREFIX}.controller.agent_end_violation`,
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
