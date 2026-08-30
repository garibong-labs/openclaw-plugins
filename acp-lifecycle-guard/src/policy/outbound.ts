/**
 * `message_sending` policy - the authoritative final outbound safeguard.
 *
 * Pure function: content in, decision out. No I/O, no logging, no host access.
 */

import type { GuardConfig } from "../config.ts";
import { classifyLifecycleContent } from "../lifecycle/classify.ts";
import type { LifecycleKind } from "../lifecycle/kinds.ts";
import type { ReasonCode } from "../lifecycle/reason-codes.ts";
import { validateLifecycleReport } from "../lifecycle/validate.ts";

export type OutboundDecision =
  /** Not a lifecycle candidate, or a candidate that matches its contract. */
  | { action: "pass"; kind?: LifecycleKind }
  /** Malformed candidate; delivery must be cancelled. */
  | { action: "cancel"; kind: LifecycleKind; reasonCode: ReasonCode }
  /** Malformed candidate detected while enforcement is disabled. */
  | { action: "observe"; kind: LifecycleKind; reasonCode: ReasonCode };

export function evaluateOutboundContent(
  content: string,
  config: GuardConfig,
): OutboundDecision {
  const classification = classifyLifecycleContent(content);
  if (!classification.candidate) {
    return { action: "pass" };
  }

  const result = validateLifecycleReport({
    kind: classification.kind,
    normalized: classification.normalized,
    limits: config.limits,
  });

  if (result.ok) {
    return { action: "pass", kind: classification.kind };
  }

  return {
    action: config.enforce ? "cancel" : "observe",
    kind: classification.kind,
    reasonCode: result.reasonCode,
  };
}
