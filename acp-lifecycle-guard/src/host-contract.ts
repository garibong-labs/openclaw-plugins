/**
 * Local mirror of the OpenClaw plugin-host surface this plugin consumes.
 *
 * These types are a hand-narrowed subset of the installed OpenClaw plugin SDK
 * (`openclaw@2026.7.1-2`, `dist/hook-types-*.d.ts` and `dist/types-*.d.ts`).
 * They exist so the guard's pure policy modules and their unit tests can be
 * typechecked and executed without installing the full `openclaw` package,
 * which is declared as a peer dependency instead.
 *
 * Keep every field name and optionality identical to the host contract. If the
 * host contract changes, update this file and `src/types/openclaw-plugin-sdk.d.ts`
 * together.
 */

/** Mirrors `PluginLogger` (only the levels this plugin uses). */
export type GuardLogger = {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

/** Mirrors `PluginHookMessageSendingEvent`. */
export type MessageSendingEvent = {
  to: string;
  content: string;
  replyToId?: string | number;
  threadId?: string | number;
  metadata?: Record<string, unknown>;
};

/** Mirrors `PluginHookMessageSendingResult`. */
export type MessageSendingResult = {
  content?: string;
  cancel?: boolean;
  cancelReason?: string;
  metadata?: Record<string, unknown>;
};

/** Mirrors `PluginHookMessageContext` (correlation fields only). */
export type MessageHookContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
};

/** Mirrors `PluginHookBeforeToolCallEvent`. */
export type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  toolKind?: string;
  toolInputKind?: string;
  runId?: string;
  toolCallId?: string;
  derivedPaths?: readonly string[];
};

/** Mirrors `PluginHookBeforeToolCallResult` (only the fields this plugin returns). */
export type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

/** Mirrors `PluginHookToolContext` (correlation fields only). */
export type ToolHookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
  channelId?: string;
};

/** Mirrors `PluginHookAgentContext` (the fields this plugin reads). */
export type AgentHookContext = {
  runId?: string;
  /**
   * Declared by the host type, but populated inconsistently at runtime on
   * `openclaw@2026.7.1-2`: the CLI-runner cron path includes it, while the
   * embedded cron runner passes `jobId` into `runEmbeddedAgent` and then
   * omits it from the `before_agent_run` hook context it assembles. Never
   * rely on it for eligibility or correlation.
   */
  jobId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  trigger?: string;
  /** Channel/plugin id for channel-originated runs, e.g. a messenger name. */
  channel?: string;
  messageProvider?: string;
  /** Conversation target id for channel-originated runs. */
  channelId?: string;
  /** Mirrors `channelId` for compatibility. */
  chatId?: string;
  senderId?: string;
};

/** Mirrors `PluginHookBeforeAgentRunEvent`. */
export type BeforeAgentRunEvent = {
  prompt: string;
  messages: unknown[];
  systemPrompt?: string;
  accountId?: string;
  channelId?: string;
  senderId?: string;
  senderIsOwner?: boolean;
};

/** Mirrors the host's `InputGateDecision`. */
export type InputGateDecision =
  | { outcome: "pass" }
  | {
      outcome: "block";
      reason: string;
      message?: string;
      category?: string;
      metadata?: Record<string, unknown>;
    };

/**
 * The explicit pass decision - the only result this guard's
 * `before_agent_run` handler ever returns (see `BeforeAgentRunResult`).
 */
export type BeforeAgentRunPassDecision = Extract<
  InputGateDecision,
  { outcome: "pass" }
>;

/**
 * Mirrors `PluginHookBeforeAgentRunResult` (`InputGateDecision | void`).
 *
 * The exported host type allows `void`, but runtime behavior is authoritative
 * for the pinned build: `runBeforeAgentRun` merges handler results with
 * `mergeNullResults: true` and its merge normalizes a `null` result to
 * `{ outcome: "block", reason: "before_agent_run returned an invalid
 * decision" }`. On `openclaw@2026.7.1-2` a `null` result blocks the run
 * outright, and an `undefined` result avoids that only through an incidental
 * `!== undefined` guard in the generic `runModifyingHook` layer - not through
 * the gate's own normalization. A handler that relies on `void` is therefore
 * one host refactor away from blocking every run it observes. This guard
 * never relies on it: every non-blocking path returns the explicit
 * `BeforeAgentRunPassDecision`.
 */
export type BeforeAgentRunResult = InputGateDecision | void;

/** Mirrors `PluginHookMessageSentEvent` (correlation fields only). */
export type MessageSentEvent = {
  to: string;
  content: string;
  success: boolean;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  error?: string;
};

/** Mirrors `PluginHookBeforeAgentFinalizeEvent` (the fields this plugin reads). */
export type BeforeAgentFinalizeEvent = {
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  turnId?: string;
  stopHookActive: boolean;
  lastAssistantMessage?: string;
  messages?: unknown[];
};

/** Mirrors `PluginHookBeforeAgentFinalizeResult`. */
export type BeforeAgentFinalizeResult = {
  action?: "continue" | "revise" | "finalize";
  reason?: string;
  retry?: {
    instruction: string;
    idempotencyKey?: string;
    maxAttempts?: number;
  };
};

/** Mirrors `PluginHookAgentEndEvent`. */
export type AgentEndEvent = {
  runId?: string;
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

export type MessageSendingHandler = (
  event: MessageSendingEvent,
  ctx: MessageHookContext,
) => Promise<MessageSendingResult | void> | MessageSendingResult | void;

export type BeforeToolCallHandler = (
  event: BeforeToolCallEvent,
  ctx: ToolHookContext,
) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;

export type BeforeAgentRunHandler = (
  event: BeforeAgentRunEvent,
  ctx: AgentHookContext,
) => Promise<BeforeAgentRunResult> | BeforeAgentRunResult;

export type MessageSentHandler = (
  event: MessageSentEvent,
  ctx: MessageHookContext,
) => Promise<void> | void;

export type BeforeAgentFinalizeHandler = (
  event: BeforeAgentFinalizeEvent,
  ctx: AgentHookContext,
) => Promise<BeforeAgentFinalizeResult | void> | BeforeAgentFinalizeResult | void;

export type AgentEndHandler = (
  event: AgentEndEvent,
  ctx: AgentHookContext,
) => Promise<void> | void;

/** Mirrors the `opts` bag accepted by `api.on(...)`. */
export type GuardHookOptions = {
  priority?: number;
  timeoutMs?: number;
};

/** Mirrors the `api.on(...)` overloads this plugin registers. */
export type GuardHookRegistrar = {
  (
    hookName: "message_sending",
    handler: MessageSendingHandler,
    opts?: GuardHookOptions,
  ): void;
  (
    hookName: "before_tool_call",
    handler: BeforeToolCallHandler,
    opts?: GuardHookOptions,
  ): void;
  (
    hookName: "before_agent_run",
    handler: BeforeAgentRunHandler,
    opts?: GuardHookOptions,
  ): void;
  (
    hookName: "message_sent",
    handler: MessageSentHandler,
    opts?: GuardHookOptions,
  ): void;
  (
    hookName: "before_agent_finalize",
    handler: BeforeAgentFinalizeHandler,
    opts?: GuardHookOptions,
  ): void;
  (
    hookName: "agent_end",
    handler: AgentEndHandler,
    opts?: GuardHookOptions,
  ): void;
};

/** Mirrors the `OpenClawPluginApi` subset this plugin uses. */
export type GuardHostApi = {
  id: string;
  logger: GuardLogger;
  pluginConfig?: Record<string, unknown>;
  on: GuardHookRegistrar;
};
