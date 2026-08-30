/**
 * Hook registration.
 *
 * Every handler is thin: it resolves config, delegates to a pure policy
 * module, translates the decision into the host's hook result shape, and emits
 * at most one content-free log line. Raw prompt text and outbound content
 * never reach the logger, a cancel reason, a revise reason or instruction, or
 * hook metadata.
 */

import { resolveGuardConfig, type GuardConfig } from "./config.ts";
import type {
  AgentEndEvent,
  AgentHookContext,
  BeforeAgentFinalizeEvent,
  BeforeAgentFinalizeResult,
  BeforeAgentRunEvent,
  BeforeAgentRunPassDecision,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  GuardHostApi,
  GuardLogger,
  MessageHookContext,
  MessageSendingEvent,
  MessageSendingResult,
  MessageSentEvent,
  ToolHookContext,
} from "./host-contract.ts";
import { evaluateAcpLaunch } from "./policy/launch.ts";
import { evaluateOutboundContent } from "./policy/outbound.ts";
import { evaluateToolCall } from "./policy/tool.ts";
import { ReasonCodes } from "./lifecycle/reason-codes.ts";
import {
  CheckpointReceiptTracker,
  MAX_RECEIPT_REVISE_ATTEMPTS,
  RECEIPT_REVISE_IDEMPOTENCY_KEY,
  RECEIPT_REVISE_INSTRUCTION,
} from "./receipt/checkpoint.ts";

export const PLUGIN_ID = "acp-lifecycle-guard";

/**
 * Run late so ordinary rewriting hooks have already produced final content,
 * and so this guard sees exactly what would be delivered.
 */
export const MESSAGE_SENDING_PRIORITY = -50;
export const BEFORE_TOOL_CALL_PRIORITY = 50;
/**
 * The receipt hooks are pure observers plus one finalize decision; they do
 * not need to run before or after other plugins' handlers.
 */
export const RECEIPT_HOOK_PRIORITY = 0;

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

export type ReceiptHookHandlers = {
  /**
   * Always returns the explicit pass decision: the installed runner's
   * `runBeforeAgentRun` normalizes a nullish handler result to a block
   * (`before_agent_run returned an invalid decision`), so a `void` return is
   * not a safe way to say "not my run" on this host.
   */
  beforeAgentRun: (
    event: BeforeAgentRunEvent,
    ctx?: AgentHookContext,
  ) => BeforeAgentRunPassDecision;
  messageSent: (event: MessageSentEvent, ctx?: MessageHookContext) => void;
  beforeAgentFinalize: (
    event: BeforeAgentFinalizeEvent,
    ctx?: AgentHookContext,
  ) => BeforeAgentFinalizeResult | void;
  agentEnd: (event: AgentEndEvent, ctx?: AgentHookContext) => void;
};

/**
 * Owner-checkpoint delivery-receipt handlers.
 *
 * All four share one bounded in-memory tracker. Every handler is wrapped so a
 * defect in the guard can never block an unrelated run: the host runs
 * `before_agent_run` fail-closed (a throwing handler blocks the request), so
 * these hooks swallow their own failures and fail open. `before_agent_run` is
 * additionally an input gate on the installed host: its runner normalizes a
 * nullish handler result to a block, so the handler returns the explicit
 * `{ outcome: "pass" }` decision on every path - eligible, ordinary, and
 * internal-error alike - and never signals "no opinion" with `void`. Raw
 * prompt text, outbound content, destinations, and identifiers never reach
 * the logger or a hook result; the only guard-authored strings emitted are
 * stable reason codes and the fixed bounded revise instruction.
 */
export function createReceiptHookHandlers(
  api: Pick<GuardHostApi, "logger" | "pluginConfig">,
  tracker: CheckpointReceiptTracker = new CheckpointReceiptTracker(),
  overrideConfig?: GuardConfig,
): ReceiptHookHandlers {
  const resolve = (): GuardConfig =>
    overrideConfig ?? resolveGuardConfig(api.pluginConfig);

  const beforeAgentRun = (
    event: BeforeAgentRunEvent,
    ctx?: AgentHookContext,
  ): BeforeAgentRunPassDecision => {
    try {
      const outcome = tracker.register(event?.prompt, ctx ?? {});
      if (outcome.kind === "registered") {
        logDecision(api.logger, "info", {
          hook: "before_agent_run",
          outcome: "observed",
          kind: "receipt",
          reason: ReasonCodes.ReceiptCheckpointRegistered,
        });
      } else if (
        outcome.kind === "uncorrelatable" ||
        outcome.kind === "ambiguous"
      ) {
        logDecision(api.logger, "info", {
          hook: "before_agent_run",
          outcome: "observed",
          kind: "receipt",
          reason: ReasonCodes.ReceiptUncorrelatable,
        });
      }
    } catch {
      // Fail open: a tracker defect must never block an agent run.
    }
    // Explicit pass on every non-blocking path, including the catch above:
    // the installed runner treats a nullish result as an invalid decision
    // and would block the run.
    return { outcome: "pass" };
  };

  const messageSent = (
    event: MessageSentEvent,
    ctx?: MessageHookContext,
  ): void => {
    try {
      const outcome = tracker.recordSend({
        sessionKey: ctx?.sessionKey ?? event?.sessionKey,
        runId: ctx?.runId ?? event?.runId,
        success: event?.success === true,
        messageId: event?.messageId ?? ctx?.messageId,
        channelId: ctx?.channelId,
        conversationId: ctx?.conversationId ?? event?.to,
      });
      if (outcome.kind === "receipt") {
        logDecision(api.logger, "info", {
          hook: "message_sent",
          outcome: "observed",
          kind: "receipt",
          reason: ReasonCodes.ReceiptConfirmed,
        });
      } else if (outcome.kind === "target_mismatch") {
        logDecision(api.logger, "info", {
          hook: "message_sent",
          outcome: "observed",
          kind: "receipt",
          reason: ReasonCodes.ReceiptTargetMismatch,
        });
      }
    } catch {
      // Fail open.
    }
  };

  const beforeAgentFinalize = (
    event: BeforeAgentFinalizeEvent,
    ctx?: AgentHookContext,
  ): BeforeAgentFinalizeResult | void => {
    try {
      const config = resolve();
      const outcome = tracker.finalize(
        {
          sessionKey: ctx?.sessionKey ?? event?.sessionKey,
          runId: ctx?.runId ?? event?.runId,
        },
        config.ownerCheckpointReceiptMode,
      );
      if (outcome.kind === "unrelated" || outcome.kind === "receipt_confirmed") {
        return;
      }
      if (outcome.kind === "observed_missing") {
        logDecision(api.logger, "info", {
          hook: "before_agent_finalize",
          outcome: "observed",
          kind: "receipt",
          reason: ReasonCodes.ReceiptMissing,
        });
        return;
      }
      if (outcome.kind === "exhausted") {
        // The host's finalize retry accounting turns further revise requests
        // into plain continuation, so the run will finalize without a
        // receipt. Record that loudly; never report it as confirmed.
        logDecision(api.logger, "warn", {
          hook: "before_agent_finalize",
          outcome: "observed",
          kind: "receipt",
          reason: ReasonCodes.ReceiptReviseExhausted,
        });
        return;
      }
      logDecision(api.logger, "warn", {
        hook: "before_agent_finalize",
        outcome: "revise",
        kind: "receipt",
        reason: ReasonCodes.ReceiptMissing,
      });
      return {
        action: "revise",
        reason: ReasonCodes.ReceiptMissing,
        retry: {
          instruction: RECEIPT_REVISE_INSTRUCTION,
          idempotencyKey: RECEIPT_REVISE_IDEMPOTENCY_KEY,
          maxAttempts: MAX_RECEIPT_REVISE_ATTEMPTS,
        },
      };
    } catch {
      // Fail open: finalize proceeds untouched on a guard defect.
      return;
    }
  };

  const agentEnd = (event: AgentEndEvent, ctx?: AgentHookContext): void => {
    try {
      tracker.end({
        sessionKey: ctx?.sessionKey,
        runId: ctx?.runId ?? event?.runId,
      });
    } catch {
      // Fail open.
    }
  };

  return { beforeAgentRun, messageSent, beforeAgentFinalize, agentEnd };
}

export function registerGuard(api: GuardHostApi): void {
  api.on("message_sending", createMessageSendingHandler(api), {
    priority: MESSAGE_SENDING_PRIORITY,
  });
  api.on("before_tool_call", createBeforeToolCallHandler(api), {
    priority: BEFORE_TOOL_CALL_PRIORITY,
  });
  const receipt = createReceiptHookHandlers(api);
  api.on("before_agent_run", receipt.beforeAgentRun, {
    priority: RECEIPT_HOOK_PRIORITY,
  });
  api.on("message_sent", receipt.messageSent, {
    priority: RECEIPT_HOOK_PRIORITY,
  });
  api.on("before_agent_finalize", receipt.beforeAgentFinalize, {
    priority: RECEIPT_HOOK_PRIORITY,
  });
  api.on("agent_end", receipt.agentEnd, { priority: RECEIPT_HOOK_PRIORITY });
}
