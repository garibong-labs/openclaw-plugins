import type {
  AgentEndEvent,
  AgentHookContext,
  BeforeAgentFinalizeEvent,
  BeforeAgentFinalizeResult,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  GuardHostApi,
  MessageHookContext,
  MessageSendingEvent,
  MessageSendingResult,
  MessageSentEvent,
  PluginToolContext,
} from "../host-contract.ts";
import { ReasonCodes } from "../lifecycle/reason-codes.ts";
import {
  CONTROLLER_TOOL_NAME,
  LeaseRegistry,
  ReportController,
  safeControllerCode,
  type ActiveLease,
  type LeaseDestination,
} from "./registry.ts";

const POLICY_ID = "acp-report-controller-lifecycle-v1";
const FINALIZE_INSTRUCTION =
  "An active ACP lifecycle lease still owns completion. Continue the turn; only the registered report automation may publish and acknowledge reports.";

type Admission = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  owner: boolean;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function log(api: Pick<GuardHostApi, "logger">, hook: string, outcome: string, reason: string): void {
  api.logger.warn?.(`[acp-lifecycle-guard] hook=${hook} outcome=${outcome} kind=controller reason=${reason}`);
}

function isOwner(entry: ActiveLease, admission: Admission): boolean {
  return admission.agentId === "main" && admission.owner &&
    admission.sessionKey === entry.ownerSessionKey && admission.runId === entry.ownerRunId;
}

export type ControllerSurfaces = {
  registry: LeaseRegistry;
  controller: ReportController;
  messageSending: (event: MessageSendingEvent, ctx: MessageHookContext) => MessageSendingResult | void;
  messageSent: (event: MessageSentEvent, ctx: MessageHookContext) => Promise<void>;
  beforeAgentFinalize: (event: BeforeAgentFinalizeEvent, ctx: AgentHookContext) => BeforeAgentFinalizeResult | void;
  agentEnd: (event: AgentEndEvent, ctx: AgentHookContext) => void;
};

export function createControllerSurfaces(api: GuardHostApi): ControllerSurfaces {
  const stateDir = api.runtime.state.resolveStateDir();
  const registry = new LeaseRegistry(stateDir);
  const controller = new ReportController(registry);
  const admissions = new Map<string, Admission>();

  api.registerTrustedToolPolicy({
    id: POLICY_ID,
    description: "Bind the ACP report controller and lifecycle completion tools to trusted run context.",
    matcher: [CONTROLLER_TOOL_NAME, "sessions_yield", "message"],
    evaluate(event: BeforeToolCallEvent, ctx): BeforeToolCallResult | void {
      if (event.toolName === CONTROLLER_TOOL_NAME) {
        if (!event.toolCallId) return { block: true, blockReason: ReasonCodes.ControllerCallerInvalid };
        if (admissions.size >= 256) admissions.delete(admissions.keys().next().value as string);
        admissions.set(event.toolCallId, {
          ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
          ...(ctx.sessionKey === undefined ? {} : { sessionKey: ctx.sessionKey }),
          ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
          owner: ctx.requester?.senderIsOwner === true,
        });
        return;
      }
      const active = registry.activeForOwner(ctx.sessionKey, ctx.runId);
      if (active.length === 0) return;
      if (event.toolName === "message" && event.params.final === false) return;
      log(api, "trusted_tool_policy", "blocked", ReasonCodes.LeaseEarlyCompletion);
      return { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion };
    },
  });

  api.registerTool((ctx: PluginToolContext) => ({
    name: CONTROLLER_TOOL_NAME,
    label: "ACP report controller",
    hideFromChannelProgress: true,
    description: "Operate one registered ACP report lifecycle lease. Automation ticks need only the opaque lease token.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "leaseToken"],
      properties: {
        action: { type: "string", enum: ["register", "status", "tick", "release"] },
        leaseToken: { type: "string", minLength: 16, maxLength: 128 },
        transportFile: { type: "string" }, processHandle: { type: "string" },
        jobId: { type: "string" }, destination: { type: "object" },
        reportPumpEntry: { type: "string" }, hostTransportEntry: { type: "string" },
        snapshotFile: { type: "string" },
      },
    },
    async execute(toolCallId: string, raw: unknown): Promise<Record<string, unknown>> {
      const admission = admissions.get(toolCallId);
      admissions.delete(toolCallId);
      if (!admission) return toolResult({ status: "error", code: ReasonCodes.ControllerCallerInvalid });
      const params = object(raw);
      try {
        if (ctx.agentId !== admission.agentId || ctx.sessionKey !== admission.sessionKey) {
          throw new Error(ReasonCodes.ControllerCallerInvalid);
        }
        const action = string(params.action);
        const entry = action === "register" ? undefined : registry.getByToken(params.leaseToken);
        if (action === "register") {
          if (admission.agentId !== "main" || !admission.owner || !admission.sessionKey || !admission.runId ||
              ctx.agentId !== admission.agentId || ctx.sessionKey !== admission.sessionKey) {
            throw new Error(ReasonCodes.ControllerCallerInvalid);
          }
          const destination = object(params.destination) as LeaseDestination;
          registry.register({ leaseToken: string(params.leaseToken), ownerSessionKey: admission.sessionKey,
            ownerRunId: admission.runId, transportFile: string(params.transportFile),
            processHandle: string(params.processHandle), jobId: string(params.jobId), destination,
            reportPumpEntry: string(params.reportPumpEntry), hostTransportEntry: string(params.hostTransportEntry),
            ...(params.snapshotFile === undefined ? {} : { snapshotFile: string(params.snapshotFile) }) });
          return toolResult({ status: "registered" });
        }
        if (!entry) throw new Error(ReasonCodes.ControllerLeaseNotFound);
        const cron = controller.callerMatchesCron(entry, admission.agentId, admission.sessionKey);
        const owner = isOwner(entry, admission);
        if (action === "status") {
          if (!owner && !cron) throw new Error(ReasonCodes.ControllerCallerInvalid);
          return toolResult({ status: entry.cleanupState });
        }
        if (action === "release") {
          if (!owner && !(cron && entry.cleanupState !== "active")) {
            throw new Error(ReasonCodes.ControllerReleaseDenied);
          }
          registry.release(entry);
          return toolResult({ status: "released" });
        }
        if (action === "tick") {
          if (!cron || !admission.sessionKey) throw new Error(ReasonCodes.ControllerCallerInvalid);
          return toolResult(await controller.tick(entry, admission.sessionKey));
        }
        throw new Error(ReasonCodes.ControllerActionInvalid);
      } catch (error) {
        const code = safeControllerCode(error);
        log(api, CONTROLLER_TOOL_NAME, "failed", code);
        return toolResult({ status: "error", code });
      }
    },
  }), { name: CONTROLLER_TOOL_NAME, optional: false });

  return {
    registry,
    controller,
    messageSending(event, ctx) {
      const outcome = controller.authorizeSending(event.content, ctx);
      if (outcome === "unrelated" || outcome === "authorized") return;
      const reason = outcome === "ambiguous" ? ReasonCodes.ControllerDigestAmbiguous : ReasonCodes.ControllerScopeMismatch;
      log(api, "message_sending", "cancelled", reason);
      return { cancel: true, cancelReason: reason,
        metadata: { pluginId: "acp-lifecycle-guard", reasonCode: reason } };
    },
    async messageSent(event, ctx) {
      const outcome = await controller.acknowledgeSent(event, ctx);
      if (outcome === "failed") log(api, "message_sent", "retained", ReasonCodes.ControllerAckFailed);
    },
    beforeAgentFinalize(event, ctx) {
      const active = registry.activeForOwner(ctx.sessionKey ?? event.sessionKey, ctx.runId ?? event.runId);
      if (active.length === 0) return;
      log(api, "before_agent_finalize", "revise", ReasonCodes.LeaseFinalizeBlocked);
      return { action: "revise", reason: ReasonCodes.LeaseFinalizeBlocked,
        retry: { instruction: FINALIZE_INSTRUCTION,
          idempotencyKey: "acp_lifecycle_guard.active_lease_v1", maxAttempts: 2 } };
    },
    agentEnd(event, ctx) {
      if (registry.activeForOwner(ctx.sessionKey, ctx.runId ?? event.runId).length > 0) {
        log(api, "agent_end", "violation", ReasonCodes.LeaseAgentEndViolation);
      }
    },
  };
}

export { POLICY_ID as CONTROLLER_TRUSTED_TOOL_POLICY_ID };
