/**
 * Hook registration.
 *
 * Both handlers are thin: they resolve config, delegate to a pure policy
 * module, translate the decision into the host's hook result shape, and emit a
 * single content-free log line. Raw outbound content never reaches the logger,
 * the cancel reason, or the hook metadata.
 */

import { resolveGuardConfig, type GuardConfig } from "./config.ts";
import type {
  BeforeToolCallEvent,
  BeforeToolCallResult,
  GuardHostApi,
  GuardLogger,
  MessageHookContext,
  MessageSendingEvent,
  MessageSendingResult,
  ToolHookContext,
} from "./host-contract.ts";
import { evaluateAcpLaunch } from "./policy/launch.ts";
import { evaluateOutboundContent } from "./policy/outbound.ts";
import { evaluateToolCall } from "./policy/tool.ts";

export const PLUGIN_ID = "acp-lifecycle-guard";

/**
 * Run late so ordinary rewriting hooks have already produced final content,
 * and so this guard sees exactly what would be delivered.
 */
export const MESSAGE_SENDING_PRIORITY = -50;
export const BEFORE_TOOL_CALL_PRIORITY = 50;

function logDecision(
  logger: GuardLogger,
  level: "warn" | "info",
  fields: { hook: string; outcome: string; kind?: string; reason: string },
): void {
  const parts = [
    `[${PLUGIN_ID}]`,
    `hook=${fields.hook}`,
    `outcome=${fields.outcome}`,
    ...(fields.kind === undefined ? [] : [`kind=${fields.kind}`]),
    `reason=${fields.reason}`,
  ];
  const emit = level === "warn" ? logger.warn : logger.info;
  emit?.(parts.join(" "));
}

export function createMessageSendingHandler(
  api: Pick<GuardHostApi, "logger" | "pluginConfig">,
  overrideConfig?: GuardConfig,
): (
  event: MessageSendingEvent,
  ctx?: MessageHookContext,
) => MessageSendingResult | void {
  return (event: MessageSendingEvent): MessageSendingResult | void => {
    const config = overrideConfig ?? resolveGuardConfig(api.pluginConfig);
    const content = typeof event.content === "string" ? event.content : "";
    const decision = evaluateOutboundContent(content, config);

    if (decision.action === "pass") {
      return;
    }

    if (decision.action === "observe") {
      logDecision(api.logger, "info", {
        hook: "message_sending",
        outcome: "observed",
        kind: decision.kind,
        reason: decision.reasonCode,
      });
      return;
    }

    logDecision(api.logger, "warn", {
      hook: "message_sending",
      outcome: "cancelled",
      kind: decision.kind,
      reason: decision.reasonCode,
    });

    return {
      cancel: true,
      cancelReason: decision.reasonCode,
      metadata: {
        pluginId: PLUGIN_ID,
        lifecycleKind: decision.kind,
        reasonCode: decision.reasonCode,
      },
    };
  };
}

export function createBeforeToolCallHandler(
  api: Pick<GuardHostApi, "logger" | "pluginConfig">,
  overrideConfig?: GuardConfig,
): (
  event: BeforeToolCallEvent,
  ctx?: ToolHookContext,
) => BeforeToolCallResult | void {
  return (
    event: BeforeToolCallEvent,
    ctx?: ToolHookContext,
  ): BeforeToolCallResult | void => {
    const config = overrideConfig ?? resolveGuardConfig(api.pluginConfig);
    const params =
      event.params !== null && typeof event.params === "object"
        ? event.params
        : {};

    const launchDecision = evaluateAcpLaunch(
      { toolName: event.toolName, params },
      { agentId: ctx?.agentId },
      config,
    );

    if (launchDecision.action === "block") {
      logDecision(api.logger, "warn", {
        hook: "before_tool_call",
        outcome: "blocked",
        kind: "launch",
        reason: launchDecision.reasonCode,
      });
      return {
        block: true,
        blockReason: `${launchDecision.reasonCode}: ACP launch routes may only be invoked by the main OpenClaw agent.`,
      };
    }

    if (launchDecision.action === "observe") {
      logDecision(api.logger, "info", {
        hook: "before_tool_call",
        outcome: "observed",
        kind: "launch",
        reason: launchDecision.reasonCode,
      });
    }

    const decision = evaluateToolCall(
      { toolName: event.toolName, params },
      config,
    );

    if (decision.action === "pass") {
      return;
    }

    if (decision.action === "observe") {
      logDecision(api.logger, "info", {
        hook: "before_tool_call",
        outcome: "observed",
        kind: "intermediate",
        reason: decision.reasonCode,
      });
      return;
    }

    logDecision(api.logger, "warn", {
      hook: "before_tool_call",
      outcome: "blocked",
      kind: "intermediate",
      reason: decision.reasonCode,
    });

    return {
      block: true,
      blockReason: `${decision.reasonCode}: direct ACP intermediate report publication is not allowed; the disabled watchdog announce path is the only intermediate publisher.`,
    };
  };
}

export function registerGuard(api: GuardHostApi): void {
  api.on("message_sending", createMessageSendingHandler(api), {
    priority: MESSAGE_SENDING_PRIORITY,
  });
  api.on("before_tool_call", createBeforeToolCallHandler(api), {
    priority: BEFORE_TOOL_CALL_PRIORITY,
  });
}
