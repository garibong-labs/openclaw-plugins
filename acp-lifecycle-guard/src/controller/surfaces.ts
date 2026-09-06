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
  ToolHookContext,
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
import {
  isAgentSessionKey,
  normalizeRunProjection,
  optionalNonEmptyString,
  OwnerRunAdmissions,
  ownerRunKey,
  resolveOwnerAuthority,
  revokesRunProjection,
  sessionProjectionRelation,
  type NormalizedRunProjection,
} from "./owner-runs.ts";

const POLICY_ID = "acp-report-controller-lifecycle-v1";
const FINALIZE_INSTRUCTION =
  "A prepared or active ACP lifecycle lease still owns completion. Continue the turn; only the registered report automation may publish and acknowledge reports.";

type Admission = {
  agentId?: string;
  /** Session key carried by the trusted tool-policy invocation. */
  executionSessionKey?: string;
  /** Canonical owner session key used by lifecycle and durable lease guards. */
  ownerSessionKey?: string;
  sessionId?: string;
  runId?: string;
  owner: boolean;
};

type MainOwnerAdmission = Admission & { ownerSessionKey: string; runId: string };

/** Tool-call admissions are keyed by host tool-call id and consumed by `execute`. */
const MAX_TOOL_CALL_ADMISSIONS = 256;

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

/** The one main-owner-run predicate every owner-only controller action shares. */
function isMainOwnerRun(admission: Admission): admission is MainOwnerAdmission {
  return admission.owner && admission.agentId === "main" &&
    isAgentSessionKey(admission.ownerSessionKey, "main") &&
    ownerRunKey(admission.ownerSessionKey, admission.runId) !== undefined;
}

function isOwnerSession(entry: ActiveLease, admission: Admission): boolean {
  return isMainOwnerRun(admission) && admission.ownerSessionKey === entry.ownerSessionKey;
}

/** Bind policy admission to the same host session despite canonical/runtime key projection. */
function matchesExecutionSession(admission: Admission, ctx: PluginToolContext): boolean {
  const agentId = optionalNonEmptyString(ctx.agentId);
  if (agentId === undefined || agentId !== admission.agentId ||
      !isAgentSessionKey(admission.executionSessionKey, agentId) ||
      !isAgentSessionKey(ctx.sessionKey, agentId)) return false;
  return sessionProjectionRelation({
    sessionKey: admission.executionSessionKey,
    sessionId: admission.sessionId,
  }, ctx) === "same";
}

/** Destructive cleanup accepts either exact session projection for the exact run. */
function admissionEnded(admission: Admission, ctx: AgentHookContext, runId: unknown): boolean {
  if (!isAgentSessionKey(ctx.sessionKey, admission.agentId)) return false;
  const ended = { sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, runId };
  return [admission.executionSessionKey, admission.ownerSessionKey].some((sessionKey) =>
    revokesRunProjection({ sessionKey, sessionId: admission.sessionId, runId: admission.runId }, ended));
}

/**
 * Explicit requester authority may establish a canonical owner key only when
 * the trusted key is in that requester's channel namespace. A projected key
 * needs a `before_agent_run` admission to recover the canonical key.
 */
function directOwnerSessionKey(ctx: ToolHookContext, run: NormalizedRunProjection): string | undefined {
  const channel = optionalNonEmptyString(ctx.requester?.channel);
  if (ctx.agentId !== "main" || ctx.requester?.senderIsOwner !== true ||
      channel === undefined || run.sessionKey === undefined || run.runId === undefined) return undefined;
  return run.sessionKey.startsWith(`agent:main:${channel}:`) ? run.sessionKey : undefined;
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
  const ownerRuns = new OwnerRunAdmissions();

  api.registerTrustedToolPolicy({
    id: POLICY_ID,
    description: "Bind the ACP report controller and lifecycle completion tools to trusted run context.",
    matcher: [CONTROLLER_TOOL_NAME, "sessions_yield", "message"],
    evaluate(event: BeforeToolCallEvent, ctx): BeforeToolCallResult | void {
      const agentId = optionalNonEmptyString(ctx.agentId);
      const run = normalizeRunProjection(ctx);
      const ownerRun = agentId === "main"
        ? ownerRuns.resolve(run.sessionKey, run.runId, run.sessionId)
        : undefined;
      if (event.toolName === CONTROLLER_TOOL_NAME) {
        if (!event.toolCallId) return { block: true, blockReason: ReasonCodes.ControllerCallerInvalid };
        if (admissions.size >= MAX_TOOL_CALL_ADMISSIONS) {
          admissions.delete(admissions.keys().next().value as string);
        }
        const directOwner = directOwnerSessionKey(ctx, run);
        const ownerSessionKey = ownerRun?.sessionKey ?? directOwner;
        admissions.set(event.toolCallId, {
          ...(agentId === undefined ? {} : { agentId }),
          ...(run.sessionKey === undefined ? {} : { executionSessionKey: run.sessionKey }),
          ...(ownerSessionKey === undefined ? {} : { ownerSessionKey }),
          ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
          ...(run.runId === undefined ? {} : { runId: run.runId }),
          owner: resolveOwnerAuthority(ctx.requester?.senderIsOwner,
            ownerRun !== undefined),
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
      const leases = registry.leasesForOwner(ownerRun?.sessionKey ?? run.sessionKey, run.runId);
      // A projected key with missing or mismatched alias proof must not turn a
      // known owner run into an early-completion bypass. Run ids are host-owned
      // and exact; this fallback only blocks, never grants controller access.
      const completionLeases = leases.length > 0 ? leases : registry.leasesForOwnerRun(run.runId);
      if (completionLeases.length === 0) return;
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
        if (!matchesExecutionSession(admission, ctx) ||
            admission.owner && ctx.senderIsOwner !== undefined && ctx.senderIsOwner !== true) {
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
          if (!isMainOwnerRun(admission)) throw new Error(ReasonCodes.ControllerCallerInvalid);
          const destination = object(params.destination) as LeaseDestination;
          const previousOwnerRunId = registry.getByToken(params.leaseToken)?.ownerRunId;
          const lease = registry.register({ leaseToken: string(params.leaseToken), ownerSessionKey: admission.ownerSessionKey,
            ownerRunId: admission.runId, transportFile: string(params.transportFile),
            processHandle: string(params.processHandle), jobId: string(params.jobId), destination,
            reportPumpEntry: string(params.reportPumpEntry), hostTransportEntry: string(params.hostTransportEntry),
            ...(params.snapshotFile === undefined ? {} : { snapshotFile: string(params.snapshotFile) }) });
          if (previousOwnerRunId !== undefined && previousOwnerRunId !== lease.ownerRunId) {
            // A durable authority change for a run other than the caller's is
            // never silent; the line carries only the stable reason code.
            log(api, CONTROLLER_TOOL_NAME, "transferred", ReasonCodes.ControllerFenceTransferred);
          }
          return toolResult({ status: "prepared" });
        }
        if (!entry) throw new Error(ReasonCodes.ControllerLeaseNotFound);
        const cron = controller.callerMatchesCron(entry, admission.agentId, admission.executionSessionKey);
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
          if (!cron || !admission.executionSessionKey) throw new Error(ReasonCodes.ControllerCallerInvalid);
          return toolResult(await controller.tick(entry, admission.executionSessionKey));
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
      // The host runs this gate fail-closed: a throwing handler blocks the run.
      // Owner admission is optional authority and must never cost a turn, so
      // both inputs are read defensively and every path returns the explicit
      // pass decision (see the receipt handler in register.ts).
      try {
        const run = object(ctx);
        if (run.agentId === "main") {
          if (object(event).senderIsOwner === true) {
            if (ownerRuns.admit(run.sessionKey, run.runId, run.sessionId)) {
              log(api, "before_agent_run", "evicted", ReasonCodes.ControllerOwnerRunEvicted);
            }
          } else {
            ownerRuns.revoke(run.sessionKey, run.runId, run.sessionId);
          }
        }
      } catch {
        // Fail open on admission bookkeeping only; the run proceeds.
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
      const sessionKey = optionalNonEmptyString(ctx.sessionKey) ?? optionalNonEmptyString(event.sessionKey);
      const runId = optionalNonEmptyString(ctx.runId) ?? optionalNonEmptyString(event.runId);
      const leases = registry.leasesForOwner(sessionKey, runId);
      if (leases.length === 0) return;
      log(api, "before_agent_finalize", "revise", ReasonCodes.LeaseFinalizeBlocked);
      return { action: "revise", reason: ReasonCodes.LeaseFinalizeBlocked,
        retry: { instruction: FINALIZE_INSTRUCTION,
          idempotencyKey: "acp_lifecycle_guard.active_lease_v1", maxAttempts: 2 } };
    },
    agentEnd(event, ctx) {
      const runId = optionalNonEmptyString(ctx.runId) ?? optionalNonEmptyString(event.runId);
      // Authority must not outlive its run: revoke the owner admission first,
      // then drop tool admissions the run computed but never executed, so a
      // controller call still in flight at agent_end fails closed.
      ownerRuns.revoke(ctx.sessionKey, runId, ctx.sessionId);
      for (const [toolCallId, admission] of admissions) {
        if (admissionEnded(admission, ctx, runId)) {
          admissions.delete(toolCallId);
        }
      }
      if (registry.leasesForOwner(ctx.sessionKey, runId).length > 0) {
        log(api, "agent_end", "violation", ReasonCodes.LeaseAgentEndViolation);
      }
    },
  };
}

export { POLICY_ID as CONTROLLER_TRUSTED_TOOL_POLICY_ID };
