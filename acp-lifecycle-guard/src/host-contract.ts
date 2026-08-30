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

export type MessageSendingHandler = (
  event: MessageSendingEvent,
  ctx: MessageHookContext,
) => Promise<MessageSendingResult | void> | MessageSendingResult | void;

export type BeforeToolCallHandler = (
  event: BeforeToolCallEvent,
  ctx: ToolHookContext,
) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void;

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
};

/** Mirrors the `OpenClawPluginApi` subset this plugin uses. */
export type GuardHostApi = {
  id: string;
  logger: GuardLogger;
  pluginConfig?: Record<string, unknown>;
  on: GuardHookRegistrar;
};
