/**
 * `before_tool_call` policy - defense in depth, not the enforcement boundary.
 *
 * The disabled watchdog announce path is the only normal publisher of ACP
 * intermediate cadence reports. A direct `message` tool call that carries an
 * intermediate report therefore bypasses the intended publisher and is blocked
 * regardless of whether the layout happens to be well formed.
 *
 * Everything else is left alone on purpose: ordinary ACP discussion, approval
 * evidence, status answers, start reports, correction-round start reports,
 * completion reports, and unrelated messages all pass through. Outbound
 * layout enforcement belongs to `message_sending`.
 */

import type { GuardConfig } from "../config.ts";
import { classifyLifecycleContent } from "../lifecycle/classify.ts";
import { ReasonCodes, type ReasonCode } from "../lifecycle/reason-codes.ts";

/** Core messaging tool name (`openclaw` message tool). */
export const GUARDED_TOOL_NAMES: readonly string[] = ["message"];

/** Message tool actions that publish visible content to a channel. */
export const PUBLISHING_ACTIONS: readonly string[] = ["send", "broadcast"];

/** Message tool parameters that can carry a rendered report body. */
const TEXT_PARAM_KEYS: readonly string[] = ["message", "caption"];

export type ToolDecision =
  | { action: "pass" }
  | { action: "block"; reasonCode: ReasonCode }
  | { action: "observe"; reasonCode: ReasonCode };

function readAction(params: Record<string, unknown>): string | undefined {
  const action = params.action;
  return typeof action === "string" ? action : undefined;
}

function collectTexts(params: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const key of TEXT_PARAM_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      texts.push(value);
    }
  }
  return texts;
}

function isPublishingCall(params: Record<string, unknown>): boolean {
  const action = readAction(params);
  if (action === undefined) {
    // The message tool requires an action; an omitted action with body text is
    // still treated as a send so a malformed envelope cannot slip past.
    return collectTexts(params).length > 0;
  }
  return PUBLISHING_ACTIONS.includes(action);
}

export function evaluateToolCall(
  event: { toolName: string; params: Record<string, unknown> },
  config: GuardConfig,
): ToolDecision {
  if (!GUARDED_TOOL_NAMES.includes(event.toolName)) {
    return { action: "pass" };
  }
  if (!isPublishingCall(event.params)) {
    return { action: "pass" };
  }

  const carriesIntermediate = collectTexts(event.params).some((text) => {
    const classification = classifyLifecycleContent(text);
    return classification.candidate && classification.kind === "intermediate";
  });

  if (!carriesIntermediate) {
    return { action: "pass" };
  }

  if (!config.enforce || !config.blockDirectIntermediateToolCalls) {
    return { action: "observe", reasonCode: ReasonCodes.ToolDirectIntermediate };
  }

  return { action: "block", reasonCode: ReasonCodes.ToolDirectIntermediate };
}
