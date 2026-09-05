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
  "A prepared or active ACP lifecycle lease still owns completion. Continue the turn; only the registered report automation may publish and acknowledge reports.";

type Admission = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  owner: boolean;
};

type RunIdentity = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
};

const MAX_OWNER_RUN_ADMISSIONS = 256;

function ownerRunKey(identity: RunIdentity): string | undefined {
  if (identity.agentId !== "main" || typeof identity.sessionKey !== "string" ||
      identity.sessionKey.length === 0 || typeof identity.runId !== "string" ||
      identity.runId.length === 0) {
    return undefined;
  }
  return JSON.stringify([identity.agentId, identity.sessionKey, identity.runId]);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function log(api: Pick<GuardHostApi, "logger">, hook: string, outcome: string, reason: string): void {
  api.logger.warn?.(`[acp-lifecycle-guard] hook=${hook} outcome=${outcome} kind=controller reason=${reason}`);
}

function isOwnerSession(entry: ActiveLease, admission: Admission): boolean {
  return admission.agentId === "main" && admission.owner &&
    admission.sessionKey === entry.ownerSessionKey && typeof admission.runId === "string" && admission.runId.length > 0;
}

const CONTROLLER_OUTPUT_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["status"],
      properties: { status: { const: "prepared" } } },
    { type: "object", additionalProperties: false, required: ["status"],
      properties: { status: { const: "aborted" } } },
    { type: "object", additionalProperties: false, required: ["status"],
      properties: { status: { const: "released" } } },
    { type: "object", additionalProperties: false, required: ["status"],
      properties: { status: { const: "active" } } },
    { type: "object", additionalProperties: false, required: ["status"],
      properties: { status: { enum: ["none_due", "delivery_missing", "delivery_uncertain"] } } },
    { type: "object", additionalProperties: false, required: ["status", "publicationToken"],
      properties: {
        status: { const: "delivery_pending" },
        publicationToken: { type: "string", minLength: 16, maxLength: 128 },
      } },
    { type: "object", additionalProperties: false, required: ["status", "cleanup"],
      properties: {
        status: { enum: ["terminal_acked", "tracking_lost"] },
        cleanup: { const: "remove_current_job_then_release_lease" },
      } },
    { type: "object", additionalProperties: false, required: ["status", "code"],
      properties: { status: { const: "error" }, code: { type: "string" } } },
  ],
} as const;

const LEASE_TOKEN_SCHEMA = { type: "string", minLength: 16, maxLength: 128 } as const;
const SIMPLE_ACTION_SCHEMAS = ["commit_activation", "abort_preactivation", "status", "tick", "release"]
  .map((action) => ({ type: "object", additionalProperties: false,
    required: ["action", "leaseToken"], properties: {
      action: { const: action }, leaseToken: LEASE_TOKEN_SCHEMA,
    } })) as unknown as readonly Record<string, unknown>[];
const CONTROLLER_INPUT_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false,
      required: ["action", "leaseToken", "transportFile", "processHandle", "jobId", "destination",
        "reportPumpEntry", "hostTransportEntry"],
      properties: {
        action: { const: "register" }, leaseToken: LEASE_TOKEN_SCHEMA,
        transportFile: { type: "string" }, processHandle: { type: "string" }, jobId: { type: "string" },
        destination: { type: "object", additionalProperties: false,
          required: ["channel", "accountId", "conversationId"], properties: {
            channel: { const: "discord" }, accountId: { type: "string" }, conversationId: { type: "string" },
          } },
        reportPumpEntry: { type: "string" }, hostTransportEntry: { type: "string" },
        snapshotFile: { type: "string" },
      } },
    ...SIMPLE_ACTION_SCHEMAS,
  ],
} as const;

export type ControllerSurfaces = {
  registry: LeaseRegistry;
  controller: ReportController;
  beforeAgentRun: (event: BeforeAgentRunEvent, ctx: AgentHookContext) => BeforeAgentRunPassDecision;
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
  const ownerRuns = new Set<string>();

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
          owner: ctx.requester?.senderIsOwner === true ||
            (ctx.requester?.senderIsOwner === undefined &&
              ownerRuns.has(ownerRunKey(ctx) ?? "")),
        });
        return;
      }
      if (event.toolName === "message") {
        const prepared = controller.prepareMessageTool(object(event.params), {
          ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
          ...(ctx.sessionKey === undefined ? {} : { sessionKey: ctx.sessionKey }),
        });
        if (prepared.outcome === "authorized") return { params: prepared.params! };
        if (prepared.outcome !== "unrelated") {
          const reason = prepared.outcome === "ambiguous"
            ? ReasonCodes.ControllerDigestAmbiguous
            : ReasonCodes.ControllerScopeMismatch;
          return { block: true, blockReason: reason };
        }
        if (registry.leasesForCron(ctx.agentId, ctx.sessionKey).length > 0) {
          log(api, "trusted_tool_policy", "blocked", ReasonCodes.LeaseEarlyCompletion);
          return { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion };
        }
      }
      const leases = registry.leasesForOwner(ctx.sessionKey, ctx.runId);
      if (leases.length === 0) return;
      // `params` is declared non-optional but is defensively narrowed
      // everywhere else in this plugin; a throwing policy is not a safe way to
      // read one optional flag.
      if (event.toolName === "message" && object(event.params).final === false) return;
      log(api, "trusted_tool_policy", "blocked", ReasonCodes.LeaseEarlyCompletion);
      return { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion };
    },
  });

  api.registerTool((ctx: PluginToolContext) => ({
    name: CONTROLLER_TOOL_NAME,
    label: "ACP report controller",
    hideFromChannelProgress: true,
    description: "Operate one registered ACP report lifecycle lease. Automation ticks need only the opaque lease token.",
    parameters: CONTROLLER_INPUT_SCHEMA,
    outputSchema: CONTROLLER_OUTPUT_SCHEMA,
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
        const simpleAction = ["commit_activation", "abort_preactivation", "status", "tick", "release"]
          .includes(action);
        if (action === "register") {
          if (!exactKeys(params, ["action", "leaseToken", "transportFile", "processHandle", "jobId",
            "destination", "reportPumpEntry", "hostTransportEntry"], ["snapshotFile"])) {
            throw new Error(ReasonCodes.ControllerInputInvalid);
          }
        } else if (simpleAction) {
          if (!exactKeys(params, ["action", "leaseToken"])) {
            throw new Error(ReasonCodes.ControllerInputInvalid);
          }
        } else {
          throw new Error(ReasonCodes.ControllerActionInvalid);
        }
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
          return toolResult({ status: "prepared" });
        }
        if (!entry) throw new Error(ReasonCodes.ControllerLeaseNotFound);
        const cron = controller.callerMatchesCron(entry, admission.agentId, admission.sessionKey);
        const ownerSession = isOwnerSession(entry, admission);
        if (action === "commit_activation") {
          if (!ownerSession) throw new Error(ReasonCodes.ControllerCallerInvalid);
          await registry.commitActivation(entry);
          return toolResult({ status: "active" });
        }
        if (action === "abort_preactivation") {
          if (!ownerSession && !cron) throw new Error(ReasonCodes.ControllerPreactivationAbortDenied);
          await registry.abortPreactivation(entry);
          return toolResult({ status: "aborted" });
        }
        if (action === "status") {
          if (!ownerSession && !cron) throw new Error(ReasonCodes.ControllerCallerInvalid);
          return toolResult(entry.cleanupState === null ? { status: entry.phase } : {
            status: entry.cleanupState, cleanup: "remove_current_job_then_release_lease",
          });
        }
        if (action === "release") {
          if (entry.phase !== "active" || entry.cleanupState === null || (!ownerSession && !cron)) {
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
    beforeAgentRun(event, ctx) {
      const key = ownerRunKey(ctx);
      if (key !== undefined) {
        if (event.senderIsOwner === true) {
          if (!ownerRuns.has(key) && ownerRuns.size >= MAX_OWNER_RUN_ADMISSIONS) {
            const oldest = ownerRuns.values().next().value;
            if (oldest !== undefined) ownerRuns.delete(oldest);
          }
          ownerRuns.add(key);
        } else {
          ownerRuns.delete(key);
        }
      }
      return { outcome: "pass" };
    },
    messageSending(event, ctx) {
      let outcome: ReturnType<ReportController["authorizeSending"]>;
      try {
        outcome = controller.authorizeSending(event.content, ctx);
      } catch (error) {
        const reason = safeControllerCode(error);
        log(api, "message_sending", "cancelled", reason);
        return { cancel: true, cancelReason: reason,
          metadata: { pluginId: "acp-lifecycle-guard", reasonCode: reason } };
      }
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
      const leases = registry.leasesForOwner(ctx.sessionKey ?? event.sessionKey, ctx.runId ?? event.runId);
      if (leases.length === 0) return;
      log(api, "before_agent_finalize", "revise", ReasonCodes.LeaseFinalizeBlocked);
      return { action: "revise", reason: ReasonCodes.LeaseFinalizeBlocked,
        retry: { instruction: FINALIZE_INSTRUCTION,
          idempotencyKey: "acp_lifecycle_guard.active_lease_v1", maxAttempts: 2 } };
    },
    agentEnd(event, ctx) {
      if (registry.leasesForOwner(ctx.sessionKey, ctx.runId ?? event.runId).length > 0) {
        log(api, "agent_end", "violation", ReasonCodes.LeaseAgentEndViolation);
      }
      const runId = ctx.runId ?? event.runId;
      const key = ownerRunKey({
        ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
        ...(ctx.sessionKey === undefined ? {} : { sessionKey: ctx.sessionKey }),
        ...(runId === undefined ? {} : { runId }),
      });
      if (key !== undefined) ownerRuns.delete(key);
    },
  };
}

export { POLICY_ID as CONTROLLER_TRUSTED_TOOL_POLICY_ID };
