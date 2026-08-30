#!/usr/bin/env node
/**
 * Target-build smoke: `message_sending` cancellation, `before_tool_call`
 * launch blocking, and the owner-checkpoint receipt hooks.
 *
 * The unit suites exercise the pure policy functions. This smoke exercises the
 * *built* plugin through the *installed* OpenClaw hook runner instead, so it
 * proves the parts a pure-function test cannot. It runs in phases, and the
 * long-established guarantees always run first:
 *
 * Phase A - shipped default configuration (`pluginConfig` absent):
 *  1. `dist/index.js` loads against the real `openclaw/plugin-sdk/plugin-entry`
 *     and its `register` puts all six handlers into the registry.
 *  2. A canonical completion report carrying seconds (`17분 31초`) survives the
 *     authoritative guard - the regression this smoke exists for.
 *  3. A malformed lifecycle report is cancelled with the expected reason code.
 *  4. Ordinary chat is returned untouched.
 *  5. A recognized ACP launch from a non-`main` agent is blocked with the
 *     stable reason code, while the same launch from `main` and an ordinary
 *     command pass.
 *  6. The receipt guard ships observing: with no configuration at all, an
 *     eligible checkpoint that reaches finalize without a receipt is logged
 *     (`receipt.missing`) and the finalize proceeds untouched - no revise.
 *
 * Phase B - `ownerCheckpointReceiptMode: "enforce"`:
 *  7. The installed runner dispatches all four receipt hooks: an eligible cron
 *     checkpoint correlates, an exact-target send receipt is accepted (a
 *     failed send and a wrong-target success are not), a missing receipt
 *     yields the bounded enforce-mode revise result, the *installed* finalize
 *     retry accounting turns exhausted revise rounds into plain continuation
 *     (the host fails open there - the guard logs the exhaustion instead of
 *     claiming delivery), cleanup on `agent_end` is deterministic, and
 *     ordinary turns bypass everything.
 *  8. Eligibility is proven behaviorally on both installed cron context
 *     shapes: without `jobId` (the embedded cron runner omits it from the
 *     `before_agent_run` context it assembles - verified by hand on the
 *     pinned build) and with `jobId` (the CLI-runner shape), where the field
 *     is inert. This replaces the earlier bundling-sensitive source probe.
 *  9. A `message_sent` driven through the installed host mappers
 *     (`buildCanonicalSentMessageHookContext` -> `toPluginMessageSentEvent` /
 *     `toPluginMessageContext`, imported from the stable
 *     `openclaw/plugin-sdk/hook-runtime` subpath) confirms a receipt. The
 *     mapped shapes pin what the delivery path actually supplies: no `runId`
 *     on either projection, `sessionKey` only when the send is
 *     session-bound, and a `conversationId` that falls back to the raw `to` -
 *     including a wrapper-prefixed `to`, which the guard's bounded
 *     normalization must still match.
 * 10. A cron prompt carrying a near-miss of the checkpoint marker produces
 *     the content-free `receipt.marker_drift` signal and no tracking.
 *
 * Phase C - composition against synthetic second plugins:
 * 11. `before_agent_run` gate composition: a higher-priority block short-
 *     circuits before this guard runs, and a lower-priority block still wins
 *     over this guard's explicit pass - an earlier or later block is never
 *     un-stuck by the guard passing.
 * 12. Finalize merge and budget contract: when a synthetic plugin's
 *     `finalize` decision wins the installed merge, this guard's revise
 *     request is discarded, its *requested*-rounds counter still advances
 *     (documented conservative under-request), and the installed harness
 *     accounting charges the per-run idempotency-key budget only when a
 *     revise decision actually wins the merge.
 * 13. The installed gate's nullish normalization is pinned with synthetic
 *     probes: a `null` handler result is blocked outright and `undefined`
 *     survives only an incidental merge-layer guard, so this guard's
 *     explicit `{ outcome: "pass" }` is asserted for every scenario.
 * 14. No raw outbound content, prompt text, command text, agent id, or
 *     correlation identifier reaches a log line, the cancel reason, the block
 *     reason, a revise reason, or the hook metadata.
 *
 * It is deliberately non-invasive. It never installs, enables, or activates the
 * plugin, never reads or writes OpenClaw config, and never contacts Gateway.
 * The built `dist` is copied into a private temp directory whose `node_modules`
 * links to the installed OpenClaw package; `OPENCLAW_HOME` is redirected into
 * that same directory so any host-side logging stays disposable. Everything is
 * removed on exit.
 *
 * Run with `npm run smoke:target-build` after `npm run build`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ReasonCodes } from "../../src/lifecycle/reason-codes.ts";
import {
  MAX_RECEIPT_REVISE_ATTEMPTS,
  RECEIPT_REVISE_INSTRUCTION,
} from "../../src/receipt/checkpoint.ts";
import {
  ACP_LAUNCH_COMMAND,
  CANONICAL_COMPLETION_WITH_SECONDS,
  CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT,
  CHECKPOINT_REPORT_TERMINAL_GREEN,
  ORDINARY_CHAT,
  ORDINARY_COMMAND,
  OWNER_CHECKPOINT_PROMPT,
  completionWithDuration,
} from "../fixtures.ts";

const PLUGIN_ID = "acp-lifecycle-guard";
const HOOK_NAME = "message_sending";
const TOOL_HOOK_NAME = "before_tool_call";
const RECEIPT_HOOK_NAMES = [
  "before_agent_run",
  "message_sent",
  "before_agent_finalize",
  "agent_end",
] as const;
const UNAUTHORIZED_AGENT_ID = "smoke-helper-agent";

/** Synthetic correlation values for the receipt scenarios. */
const SMOKE_CHANNEL = "smoke-messenger";
const SMOKE_CONVERSATION = "smoke-conversation-1";
const SMOKE_WRONG_CONVERSATION = "smoke-conversation-2";
const SMOKE_MESSAGE_ID = "smoke-message-1";
const SMOKE_JOB_ID = "smoke-job-1";
const SMOKE_SCENARIOS = [
  "default",
  "happy",
  "wrong",
  "budget",
  "cleanup",
  "jobid",
  "mapper",
  "drift",
  "sticky1",
  "sticky2",
  "override",
  "hostbudget",
] as const;

/**
 * One trusted cron agent-hook context per receipt scenario.
 *
 * The base shape carries no `jobId`, mirroring the installed embedded cron
 * path (`openclaw@2026.7.1-2`), where the cron executor passes
 * `jobId: params.job.id` into `runEmbeddedAgent` but the `hookCtx` the
 * embedded runner assembles for `before_agent_run` omits it (verified by
 * hand on the pinned build). The `jobid` scenario adds the field to mirror
 * the CLI-runner cron shape, proving behaviorally that its presence changes
 * nothing.
 */
function cronRunContext(
  scenario: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    trigger: "cron",
    runId: `smoke-run-${scenario}`,
    sessionKey: `smoke-session-${scenario}`,
    sessionId: `smoke-session-id-${scenario}`,
    channel: SMOKE_CHANNEL,
    channelId: SMOKE_CONVERSATION,
    ...overrides,
  };
}

function finalizeEvent(scenario: string): Record<string, unknown> {
  return {
    runId: `smoke-run-${scenario}`,
    sessionId: `smoke-session-id-${scenario}`,
    sessionKey: `smoke-session-${scenario}`,
    stopHookActive: false,
  };
}
const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** A completion report whose seconds overflow the 0-59 bound. */
const MALFORMED_COMPLETION = completionWithDuration("17분 60초");

const checks: string[] = [];

function record(message: string): void {
  checks.push(message);
  process.stdout.write(`  ok ${message}\n`);
}

/**
 * Locate the installed OpenClaw package without hard-coding a path.
 * `OPENCLAW_SMOKE_PACKAGE_ROOT` overrides the lookup for non-global installs.
 */
function resolveOpenClawRoot(): string {
  const explicit = process.env.OPENCLAW_SMOKE_PACKAGE_ROOT;
  if (explicit !== undefined && explicit.length > 0) {
    return path.resolve(explicit);
  }
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  assert.equal(
    npmRoot.status,
    0,
    "`npm root -g` failed; set OPENCLAW_SMOKE_PACKAGE_ROOT to the installed openclaw package",
  );
  return path.join(npmRoot.stdout.trim(), "openclaw");
}

/**
 * Copy the built plugin into a disposable directory that can resolve
 * `openclaw/*` the way an installed plugin does.
 */
function stageTargetBuild(openclawRoot: string): {
  workspace: string;
  entryUrl: URL;
} {
  const distDir = path.join(PLUGIN_ROOT, "dist");
  assert.ok(
    existsSync(path.join(distDir, "index.js")),
    "dist/index.js is missing; run `npm run build` first",
  );

  const workspace = mkdtempSync(path.join(os.tmpdir(), `${PLUGIN_ID}-smoke-`));
  mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
  symlinkSync(openclawRoot, path.join(workspace, "node_modules", "openclaw"));
  cpSync(distDir, path.join(workspace, "dist"), { recursive: true });
  writeFileSync(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: `${PLUGIN_ID}-smoke`, private: true, type: "module" }, null, 2)}\n`,
  );

  // Keep any host-side logging inside the disposable workspace.
  process.env.OPENCLAW_HOME = path.join(workspace, "openclaw-home");
  mkdirSync(process.env.OPENCLAW_HOME, { recursive: true });

  return {
    workspace,
    entryUrl: pathToFileURL(path.join(workspace, "dist", "index.js")),
  };
}

/**
 * Every fixture line, command string, and identifier that must never appear
 * in a log, reason, or metadata.
 */
function contentNeedles(): readonly string[] {
  const lines = [
    CANONICAL_COMPLETION_WITH_SECONDS,
    MALFORMED_COMPLETION,
    ORDINARY_CHAT,
    OWNER_CHECKPOINT_PROMPT,
    CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT,
    CHECKPOINT_REPORT_TERMINAL_GREEN,
  ].flatMap((report) => report.split("\n"));
  lines.push(
    ACP_LAUNCH_COMMAND,
    ORDINARY_COMMAND,
    UNAUTHORIZED_AGENT_ID,
    SMOKE_CHANNEL,
    SMOKE_CONVERSATION,
    SMOKE_WRONG_CONVERSATION,
    SMOKE_MESSAGE_ID,
    SMOKE_JOB_ID,
  );
  for (const scenario of SMOKE_SCENARIOS) {
    lines.push(
      `smoke-run-${scenario}`,
      `smoke-session-${scenario}`,
      `smoke-session-id-${scenario}`,
    );
  }
  // The checkpoint marker is a public contract constant, but it still has no
  // business inside a log line, reason, or metadata value.
  lines.push("[owner-progress-checkpoint:v1]");
  return [...new Set(lines.filter((line) => line.trim().length > 0))];
}

type LogRecord = { level: string; args: unknown[] };
type TypedHook = Record<string, unknown>;

async function main(): Promise<void> {
  const openclawRoot = resolveOpenClawRoot();
  const openclawVersion = JSON.parse(
    readFileSync(path.join(openclawRoot, "package.json"), "utf8"),
  ).version as string;
  process.stdout.write(
    `openclaw ${openclawVersion} (${HOOK_NAME} + ${TOOL_HOOK_NAME} + receipt-hook runner)\n`,
  );

  const { workspace, entryUrl } = stageTargetBuild(openclawRoot);

  // Resolve the host runtime through the staged workspace so the smoke and the
  // built plugin agree on a single OpenClaw module instance.
  const requireFromWorkspace = createRequire(
    path.join(workspace, "package.json"),
  );
  const pluginRuntime = await import(
    pathToFileURL(
      requireFromWorkspace.resolve("openclaw/plugin-sdk/plugin-runtime"),
    ).href
  );
  // The agent-harness runtime owns the before_agent_finalize retry budget
  // (`normalizeBeforeAgentFinalizeResult`); the smoke drives it directly to
  // prove what the host does with revise decisions and exhausted budgets.
  const agentHarness = await import(
    pathToFileURL(
      requireFromWorkspace.resolve("openclaw/plugin-sdk/agent-harness"),
    ).href
  );
  // The stable SDK subpath exporting the sent-message hook mappers the real
  // delivery paths run (`createMessageSentEmitter` and the telegram sent-hook
  // builder both feed these exact functions).
  const hookRuntime = await import(
    pathToFileURL(
      requireFromWorkspace.resolve("openclaw/plugin-sdk/hook-runtime"),
    ).href
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const allLogs: LogRecord[] = [];
  const extraEmitted: string[] = [];

  try {
    const entry = (await import(entryUrl.href)).default;
    assert.equal(entry.id, PLUGIN_ID, "built entry keeps its plugin id");
    assert.equal(typeof entry.register, "function", "built entry registers");
    record("built dist/index.js loads against the installed plugin SDK");

    // Mirror how the host turns `api.on(...)` into a typed hook registration
    // (openclaw dist `registry`: pluginId, hookName, handler, priority, source).
    const registerPlugin = (
      pluginConfig: Record<string, unknown> | undefined,
    ): { typedHooks: TypedHook[]; logs: LogRecord[] } => {
      const typedHooks: TypedHook[] = [];
      const logs: LogRecord[] = [];
      const logAt =
        (level: string) =>
        (...args: unknown[]): void => {
          logs.push({ level, args });
          allLogs.push({ level, args });
        };
      entry.register({
        id: PLUGIN_ID,
        logger: {
          debug: logAt("debug"),
          info: logAt("info"),
          warn: logAt("warn"),
          error: logAt("error"),
        },
        ...(pluginConfig === undefined ? {} : { pluginConfig }),
        on: (
          hookName: string,
          handler: unknown,
          opts?: { priority?: number },
        ): void => {
          typedHooks.push({
            pluginId: PLUGIN_ID,
            hookName,
            handler,
            priority: opts?.priority,
            source: "smoke:target-build",
          });
        },
      });
      return { typedHooks, logs };
    };

    const initRunner = (typedHooks: TypedHook[], pluginIds: string[]) => {
      pluginRuntime.initializeGlobalHookRunner({
        hooks: [],
        typedHooks,
        plugins: pluginIds.map((id) => ({ id, status: "loaded" })),
      });
      return pluginRuntime.getGlobalHookRunner();
    };

    // Capture everything the host and the plugin emit during dispatch.
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      stdout.push(String(chunk));
      return (realStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      stderr.push(String(chunk));
      return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    const restoreWrites = (): void => {
      process.stdout.write = realStdoutWrite;
      process.stderr.write = realStderrWrite;
    };

    // ================= Phase A: shipped default configuration =============
    const defaultRegistration = registerPlugin(undefined);
    for (const hookName of [HOOK_NAME, TOOL_HOOK_NAME, ...RECEIPT_HOOK_NAMES]) {
      const matching = defaultRegistration.typedHooks.filter(
        (hook) => hook.hookName === hookName,
      );
      assert.equal(matching.length, 1, `exactly one ${hookName} handler`);
    }

    let runner = initRunner(defaultRegistration.typedHooks, [PLUGIN_ID]);
    assert.ok(runner, "global hook runner is available");
    assert.equal(
      pluginRuntime.hasGlobalHooks(HOOK_NAME),
      true,
      `${HOOK_NAME} is visible to the global runner`,
    );
    assert.equal(
      pluginRuntime.hasGlobalHooks(TOOL_HOOK_NAME),
      true,
      `${TOOL_HOOK_NAME} is visible to the global runner`,
    );
    for (const hookName of RECEIPT_HOOK_NAMES) {
      assert.equal(
        pluginRuntime.hasGlobalHooks(hookName),
        true,
        `${hookName} is visible to the global runner`,
      );
    }
    for (const method of [
      "runBeforeToolCall",
      "runBeforeAgentRun",
      "runMessageSent",
      "runBeforeAgentFinalize",
      "runAgentEnd",
    ]) {
      assert.equal(
        typeof runner[method],
        "function",
        `installed OpenClaw hook runner does not expose ${method}; the host hook contract changed - update this smoke and src/host-contract.ts together`,
      );
    }
    assert.equal(
      typeof agentHarness.runAgentHarnessBeforeAgentFinalizeHook,
      "function",
      "installed OpenClaw no longer exposes the harness finalize helper; re-verify the revise retry-budget contract before trusting enforcement",
    );
    for (const mapper of [
      "buildCanonicalSentMessageHookContext",
      "toPluginMessageSentEvent",
      "toPluginMessageContext",
    ]) {
      assert.equal(
        typeof hookRuntime[mapper],
        "function",
        `openclaw/plugin-sdk/hook-runtime no longer exports ${mapper}; the installed message_sent mapper contract moved - re-verify the delivery-path fields by hand`,
      );
    }
    record(
      "built entry registers all six hooks and the installed runner + harness + mapper contracts are present",
    );

    const ctx = { channelId: "smoke-channel" };
    const send = (content: string): Promise<unknown> =>
      runner.runMessageSending({ to: "smoke-target", content }, ctx);
    const callTool = (
      toolName: string,
      params: Record<string, unknown>,
      agentId?: string,
    ): Promise<unknown> =>
      runner.runBeforeToolCall(
        { toolName, params },
        agentId === undefined ? { toolName } : { toolName, agentId },
      );

    const validCompletion = await send(CANONICAL_COMPLETION_WITH_SECONDS);
    const malformed = (await send(MALFORMED_COMPLETION)) as {
      cancel?: boolean;
      cancelReason?: string;
      metadata?: Record<string, unknown>;
    };
    const chat = await send(ORDINARY_CHAT);

    const mainLaunch = await callTool(
      "exec",
      { command: ACP_LAUNCH_COMMAND },
      "main",
    );
    const helperLaunch = (await callTool(
      "exec",
      { command: ACP_LAUNCH_COMMAND },
      UNAUTHORIZED_AGENT_ID,
    )) as { block?: boolean; blockReason?: string };
    const contextlessSpawn = (await callTool("sessions_spawn", {
      runtime: "acp",
      task: "smoke-example",
    })) as { block?: boolean; blockReason?: string };
    const ordinaryCommand = await callTool(
      "exec",
      { command: ORDINARY_COMMAND },
      UNAUTHORIZED_AGENT_ID,
    );

    assert.equal(
      validCompletion,
      undefined,
      "a completion report carrying seconds must not be cancelled",
    );
    record("valid completion with `17분 31초` passes the authoritative guard");

    assert.equal(malformed?.cancel, true, "malformed report must be cancelled");
    assert.equal(
      malformed.cancelReason,
      ReasonCodes.CompletionDurationDrift,
      "cancel reason must be the stable reason code",
    );
    assert.equal(malformed.metadata?.pluginId, PLUGIN_ID);
    assert.equal(
      malformed.metadata?.reasonCode,
      ReasonCodes.CompletionDurationDrift,
    );
    record(
      `malformed lifecycle report cancelled with ${ReasonCodes.CompletionDurationDrift}`,
    );

    assert.equal(chat, undefined, "ordinary chat must pass untouched");
    record("ordinary chat passes untouched");

    assert.equal(
      mainLaunch,
      undefined,
      "an ACP launch from the main agent must not be blocked",
    );
    assert.equal(
      helperLaunch?.block,
      true,
      "an ACP launch from a non-main agent must be blocked",
    );
    assert.ok(
      helperLaunch.blockReason?.startsWith(ReasonCodes.LaunchNonMainAgent),
      "block reason must start with the stable launch reason code",
    );
    assert.equal(
      contextlessSpawn?.block,
      true,
      "an acp-runtime spawn without a context agent id must be blocked",
    );
    assert.equal(
      ordinaryCommand,
      undefined,
      "an ordinary command from a non-main agent must pass untouched",
    );
    record(
      `non-main ACP launches blocked with ${ReasonCodes.LaunchNonMainAgent}; main launch and ordinary command pass`,
    );

    // Shipped-default receipt behavior: observe only, never revise.
    const gatePass = { decision: { outcome: "pass" }, pluginId: PLUGIN_ID };
    const defaultStart = await runner.runBeforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      cronRunContext("default"),
    );
    assert.deepEqual(
      defaultStart,
      gatePass,
      "default-config eligible checkpoint must yield an explicit pass decision",
    );
    const defaultFinalize = await runner.runBeforeAgentFinalize(
      finalizeEvent("default"),
      cronRunContext("default"),
    );
    assert.equal(
      defaultFinalize,
      undefined,
      "with the shipped default config a missing receipt must observe, never revise",
    );
    const defaultMissLogs = defaultRegistration.logs.filter((entry) =>
      entry.args.some(
        (arg) =>
          typeof arg === "string" && arg.includes(ReasonCodes.ReceiptMissing),
      ),
    );
    assert.equal(
      defaultMissLogs.length,
      1,
      "the default-config miss must be logged with receipt.missing",
    );
    await runner.runAgentEnd(
      { runId: "smoke-run-default", messages: [], success: true },
      cronRunContext("default"),
    );
    record(
      "shipped default config (no pluginConfig) observes a missing receipt and finalizes untouched - end-to-end",
    );

    pluginRuntime.resetGlobalHookRunner();

    // ============ Installed-gate nullish normalization probes ==============
    const probeGateDecision = async (
      probeHandler: () => unknown,
    ): Promise<
      { decision?: { outcome?: string; reason?: string } } | undefined
    > => {
      const probeRunner = initRunner(
        [
          {
            pluginId: "smoke-nullish-probe",
            hookName: "before_agent_run",
            handler: probeHandler,
            priority: 0,
            source: "smoke:target-build",
          },
        ],
        ["smoke-nullish-probe"],
      );
      const outcome = await probeRunner.runBeforeAgentRun(
        { prompt: "smoke nullish probe", messages: [] },
        { trigger: "user" },
      );
      pluginRuntime.resetGlobalHookRunner();
      return outcome as
        | { decision?: { outcome?: string; reason?: string } }
        | undefined;
    };
    const nullProbe = await probeGateDecision(() => null);
    assert.equal(
      nullProbe?.decision?.outcome,
      "block",
      "installed runner no longer blocks a null before_agent_run result; re-verify the gate contract before trusting this smoke",
    );
    assert.equal(
      nullProbe?.decision?.reason,
      "before_agent_run returned an invalid decision",
      "installed runner changed its nullish-normalization reason; re-verify the gate contract",
    );
    const undefinedProbe = await probeGateDecision(() => undefined);
    assert.equal(
      undefinedProbe,
      undefined,
      "installed runner started merging undefined before_agent_run results; if this fails, undefined now reaches the nullish normalization and would block - the guard's explicit pass remains the only safe contract either way",
    );
    record(
      "installed gate blocks a synthetic null before_agent_run result (undefined survives only the outer merge guard); explicit pass is the only stable contract",
    );

    // ================= Phase B: enforce receipt mode =======================
    const enforceRegistration = registerPlugin({
      ownerCheckpointReceiptMode: "enforce",
    });
    runner = initRunner(enforceRegistration.typedHooks, [PLUGIN_ID]);

    const startCheckpoint = (
      scenario: string,
      overrides?: Record<string, unknown>,
    ): Promise<unknown> =>
      runner.runBeforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        cronRunContext(scenario, overrides),
      );
    const sendCheckpointReport = (
      scenario: string,
      opts?: { success?: boolean; conversation?: string; messageId?: string },
    ): Promise<unknown> =>
      runner.runMessageSent(
        {
          to: opts?.conversation ?? SMOKE_CONVERSATION,
          content: CHECKPOINT_REPORT_TERMINAL_GREEN,
          success: opts?.success ?? true,
          ...(opts?.messageId === undefined
            ? { messageId: SMOKE_MESSAGE_ID }
            : opts.messageId.length > 0
              ? { messageId: opts.messageId }
              : {}),
        },
        {
          channelId: SMOKE_CHANNEL,
          conversationId: opts?.conversation ?? SMOKE_CONVERSATION,
          sessionKey: `smoke-session-${scenario}`,
        },
      );
    const finalizeCheckpoint = (scenario: string): Promise<unknown> =>
      runner.runBeforeAgentFinalize(
        finalizeEvent(scenario),
        cronRunContext(scenario),
      );
    const endCheckpoint = (scenario: string): Promise<void> =>
      runner.runAgentEnd(
        {
          runId: `smoke-run-${scenario}`,
          messages: [],
          success: true,
        },
        cronRunContext(scenario),
      );

    // Happy path: eligible cron checkpoint, exact-target receipt, untouched
    // finalize, deterministic cleanup. Duplicate receipts must be idempotent.
    const happyStart = await startCheckpoint("happy");
    await sendCheckpointReport("happy", { success: false });
    await sendCheckpointReport("happy");
    await sendCheckpointReport("happy");
    const happyFinalize = await finalizeCheckpoint("happy");
    await endCheckpoint("happy");
    const happyAfterEnd = await finalizeCheckpoint("happy");

    // Wrong-target success must not count; enforce mode revises, and a later
    // exact-target receipt satisfies the guard.
    const wrongStart = await startCheckpoint("wrong");
    await sendCheckpointReport("wrong", {
      conversation: SMOKE_WRONG_CONVERSATION,
    });
    const wrongTargetFinalize = (await finalizeCheckpoint("wrong")) as {
      action?: string;
      reason?: string;
      retry?: {
        instruction?: string;
        idempotencyKey?: string;
        maxAttempts?: number;
      };
    };
    await sendCheckpointReport("wrong");
    const wrongAfterReceipt = await finalizeCheckpoint("wrong");
    await endCheckpoint("wrong");

    // Exhausted revise budget: drive the *installed* harness finalize helper,
    // which owns the host-side retry accounting.
    const budgetStart = await startCheckpoint("budget");
    const budgetDecisions: Array<{ action?: string; reason?: string }> = [];
    for (
      let round = 0;
      round < MAX_RECEIPT_REVISE_ATTEMPTS + 1;
      round += 1
    ) {
      budgetDecisions.push(
        await agentHarness.runAgentHarnessBeforeAgentFinalizeHook({
          event: finalizeEvent("budget"),
          ctx: cronRunContext("budget"),
          hookRunner: runner,
        }),
      );
    }
    await endCheckpoint("budget");

    // CLI-runner cron shape: the same eligible run carrying a jobId. The
    // field must be inert - registered, enforced, and receipt-satisfied
    // exactly like the embedded shape above.
    const jobIdStart = await runner.runBeforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      cronRunContext("jobid", { jobId: SMOKE_JOB_ID }),
    );
    const jobIdMissingFinalize = (await finalizeCheckpoint("jobid")) as {
      action?: string;
    };
    await sendCheckpointReport("jobid");
    const jobIdAfterReceipt = await finalizeCheckpoint("jobid");
    await endCheckpoint("jobid");

    // Host-mapper path: build the message_sent event/context through the
    // installed mappers exactly as `createMessageSentEmitter` does on the
    // delivery path (channelId = channel name, conversationId falling back
    // to the raw `to`, sessionKey from the session-bound send, messageId
    // from the platform result - and no runId anywhere).
    const mapperStart = await startCheckpoint("mapper");
    const wrappedMapperTo = `channel:${SMOKE_CONVERSATION}`;
    const mapperCanonical = hookRuntime.buildCanonicalSentMessageHookContext({
      to: wrappedMapperTo,
      content: CHECKPOINT_REPORT_TERMINAL_GREEN,
      success: true,
      channelId: SMOKE_CHANNEL,
      accountId: undefined,
      conversationId: wrappedMapperTo,
      sessionKey: "smoke-session-mapper",
      messageId: SMOKE_MESSAGE_ID,
    });
    const mapperEvent = hookRuntime.toPluginMessageSentEvent(mapperCanonical);
    const mapperCtx = hookRuntime.toPluginMessageContext(mapperCanonical);
    assert.equal(
      "runId" in mapperEvent,
      false,
      "installed mapper started emitting runId on message_sent events; re-verify the correlation contract",
    );
    assert.equal(
      "runId" in mapperCtx,
      false,
      "installed mapper started emitting runId on message_sent contexts; re-verify the correlation contract",
    );
    assert.equal(mapperCtx.sessionKey, "smoke-session-mapper");
    assert.equal(mapperCtx.channelId, SMOKE_CHANNEL);
    assert.equal(
      mapperCtx.conversationId,
      wrappedMapperTo,
      "installed mapper no longer passes the raw `to` through as conversationId; re-verify destination normalization",
    );
    const fallbackCanonical = hookRuntime.buildCanonicalSentMessageHookContext({
      to: wrappedMapperTo,
      content: CHECKPOINT_REPORT_TERMINAL_GREEN,
      success: true,
      channelId: SMOKE_CHANNEL,
      sessionKey: "smoke-session-mapper",
      messageId: SMOKE_MESSAGE_ID,
    });
    assert.equal(
      hookRuntime.toPluginMessageContext(fallbackCanonical).conversationId,
      wrappedMapperTo,
      "installed canonical builder no longer falls back conversationId -> to; re-verify the delivery contract",
    );
    await runner.runMessageSent(mapperEvent, mapperCtx);
    const mapperFinalize = await finalizeCheckpoint("mapper");
    await endCheckpoint("mapper");

    // Near-miss marker drift on trusted cron provenance: a content-free
    // signal, no tracking, and an explicit pass.
    const driftStart = await runner.runBeforeAgentRun(
      { prompt: CHECKPOINT_PROMPT_MARKER_VERSION_DRIFT, messages: [] },
      cronRunContext("drift"),
    );
    const driftFinalize = await finalizeCheckpoint("drift");

    // Ordinary turns bypass the guard: the marker without cron provenance,
    // and a cron context without correlation fields, are both untouched.
    const ordinaryRunCtx = {
      trigger: "user",
      sessionKey: "smoke-session-cleanup",
    };
    const ordinaryStart = await runner.runBeforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      ordinaryRunCtx,
    );
    const ordinaryFinalize = await runner.runBeforeAgentFinalize(
      finalizeEvent("cleanup"),
      ordinaryRunCtx,
    );
    const { channelId: _omitted, ...uncorrelatable } =
      cronRunContext("cleanup");
    const uncorrelatableStart = await runner.runBeforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      uncorrelatable,
    );
    const uncorrelatableFinalize = await finalizeCheckpoint("cleanup");

    pluginRuntime.resetGlobalHookRunner();

    // Every before_agent_run scenario must come back from the *installed*
    // runner as an explicit pass decision attributed to this plugin. A void
    // or null handler result would surface here as either `undefined` or the
    // gate's invalid-decision block.
    for (const [label, gateResult] of [
      ["eligible (happy)", happyStart],
      ["eligible (wrong-target)", wrongStart],
      ["eligible (budget)", budgetStart],
      ["eligible (jobId present)", jobIdStart],
      ["eligible (mapper)", mapperStart],
      ["near-miss marker drift", driftStart],
      ["ordinary marker-only", ordinaryStart],
      ["uncorrelatable cron", uncorrelatableStart],
    ] as const) {
      assert.deepEqual(
        gateResult,
        gatePass,
        `before_agent_run (${label}) must yield an explicit pass decision from the installed runner`,
      );
    }
    record(
      "every before_agent_run scenario yields an explicit pass decision from the installed runner - no run is blocked by the receipt guard",
    );

    assert.equal(
      happyFinalize,
      undefined,
      "a checkpoint with an exact-target receipt must finalize untouched",
    );
    assert.equal(
      happyAfterEnd,
      undefined,
      "agent_end must clean the entry so later finalizes stay untouched",
    );
    record(
      "eligible checkpoint correlates through the installed runner; failed send then exact-target receipt passes; duplicates are idempotent; agent_end cleans up",
    );

    assert.equal(
      wrongTargetFinalize?.action,
      "revise",
      "a wrong-target success must not count as a receipt in enforce mode",
    );
    assert.equal(wrongTargetFinalize.reason, ReasonCodes.ReceiptMissing);
    assert.equal(
      wrongTargetFinalize.retry?.instruction,
      RECEIPT_REVISE_INSTRUCTION,
      "the revise instruction must be the fixed bounded text",
    );
    assert.equal(
      wrongTargetFinalize.retry?.maxAttempts,
      MAX_RECEIPT_REVISE_ATTEMPTS,
    );
    assert.ok(
      wrongTargetFinalize.retry?.idempotencyKey?.startsWith(
        "acp_lifecycle_guard.",
      ),
      "the revise idempotency key must be the stable prefixed constant",
    );
    assert.equal(
      wrongAfterReceipt,
      undefined,
      "an exact-target receipt after a revise must satisfy the guard",
    );
    const reviseRequestLogs = enforceRegistration.logs.filter((entry) =>
      entry.args.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes(ReasonCodes.ReceiptReviseRequested),
      ),
    );
    assert.ok(
      reviseRequestLogs.length >= 1,
      "each requested revise round must be logged with receipt.revise_requested",
    );
    record(
      `missing receipt yields the bounded revise result (reason ${ReasonCodes.ReceiptMissing}, logged as ${ReasonCodes.ReceiptReviseRequested})`,
    );

    assert.deepEqual(
      budgetDecisions.map((decision) => decision?.action),
      [
        ...Array.from(
          { length: MAX_RECEIPT_REVISE_ATTEMPTS },
          () => "revise",
        ),
        "continue",
      ],
      "the installed finalize retry accounting must allow exactly the bounded revise rounds and then continue",
    );
    // The host fails open after the budget: the run finalizes without a
    // receipt. The guard's warn log is the only trace, so it must exist.
    const exhaustedLogs = enforceRegistration.logs.filter((entry) =>
      entry.args.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes(ReasonCodes.ReceiptReviseExhausted),
      ),
    );
    assert.equal(
      exhaustedLogs.length,
      1,
      "exhausted revise budget must be recorded with the stable reason code",
    );
    record(
      "installed host continues after the bounded revise budget (fail-open) and the guard records the exhaustion loudly",
    );

    assert.equal(
      jobIdMissingFinalize?.action,
      "revise",
      "a jobId-carrying cron checkpoint must be enforced exactly like the embedded shape",
    );
    assert.equal(
      jobIdAfterReceipt,
      undefined,
      "an exact-target receipt must satisfy the jobId-carrying checkpoint",
    );
    record(
      "eligibility is proven behaviorally on both installed cron shapes: without jobId (embedded runner) and with jobId (CLI runner, inert)",
    );

    assert.equal(
      mapperFinalize,
      undefined,
      "a receipt delivered through the installed message_sent mappers must satisfy the guard",
    );
    record(
      "installed sent-message mappers carry no runId, keep sessionKey, and pass the raw (wrapper-prefixed) `to` through - and the guard confirms the receipt on exactly that shape",
    );

    const driftLogs = enforceRegistration.logs.filter((entry) =>
      entry.args.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes(ReasonCodes.ReceiptMarkerDrift),
      ),
    );
    assert.equal(
      driftLogs.length,
      1,
      "a near-miss cron marker must produce exactly one content-free drift signal",
    );
    assert.equal(
      driftFinalize,
      undefined,
      "a near-miss cron prompt must not be tracked",
    );
    record(
      `near-miss cron marker produces ${ReasonCodes.ReceiptMarkerDrift} without tracking or content`,
    );

    assert.equal(
      ordinaryFinalize,
      undefined,
      "an ordinary turn carrying the marker must stay untouched",
    );
    assert.equal(
      uncorrelatableFinalize,
      undefined,
      "a checkpoint without correlation fields must stay untouched",
    );
    record("ordinary and uncorrelatable turns bypass the receipt guard");

    // ================= Phase C: composition probes =========================
    const BLOCKER_ID = "smoke-blocker";
    const blockerHook = (priority: number): TypedHook => ({
      pluginId: BLOCKER_ID,
      hookName: "before_agent_run",
      handler: () => ({ outcome: "block", reason: "smoke synthetic block" }),
      priority,
      source: "smoke:target-build",
    });

    // A higher-priority block short-circuits before this guard runs.
    const stickyEarly = registerPlugin({
      ownerCheckpointReceiptMode: "enforce",
    });
    runner = initRunner(
      [...stickyEarly.typedHooks, blockerHook(10)],
      [PLUGIN_ID, BLOCKER_ID],
    );
    const earlyBlock = (await runner.runBeforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      cronRunContext("sticky1"),
    )) as { decision?: { outcome?: string }; pluginId?: string };
    assert.equal(earlyBlock?.decision?.outcome, "block");
    assert.equal(
      earlyBlock?.pluginId,
      BLOCKER_ID,
      "an earlier higher-priority block must stay attributed to the blocking plugin",
    );
    pluginRuntime.resetGlobalHookRunner();

    // A lower-priority block still wins over this guard's explicit pass.
    const stickyLate = registerPlugin({
      ownerCheckpointReceiptMode: "enforce",
    });
    runner = initRunner(
      [...stickyLate.typedHooks, blockerHook(-10)],
      [PLUGIN_ID, BLOCKER_ID],
    );
    const lateBlock = (await runner.runBeforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      cronRunContext("sticky2"),
    )) as { decision?: { outcome?: string }; pluginId?: string };
    assert.equal(
      lateBlock?.decision?.outcome,
      "block",
      "a later lower-priority block must not be un-stuck by this guard's explicit pass",
    );
    assert.equal(lateBlock?.pluginId, BLOCKER_ID);
    pluginRuntime.resetGlobalHookRunner();
    record(
      "two-handler gate composition: an earlier or later synthetic block stays sticky; this guard's explicit pass never overrides it",
    );

    // Finalize merge: a synthetic plugin's `finalize` decision wins over this
    // guard's revise request; the guard's requested-rounds counter still
    // advances (documented conservative under-request), and the miss is still
    // recorded loudly through the exhausted log.
    const OVERRIDER_ID = "smoke-finalizer";
    let overrideRounds = 0;
    const overrideRegistration = registerPlugin({
      ownerCheckpointReceiptMode: "enforce",
    });
    runner = initRunner(
      [
        ...overrideRegistration.typedHooks,
        {
          pluginId: OVERRIDER_ID,
          hookName: "before_agent_finalize",
          handler: () => {
            overrideRounds += 1;
            return overrideRounds === 1
              ? { action: "finalize", reason: "smoke synthetic finalize" }
              : undefined;
          },
          priority: 10,
          source: "smoke:target-build",
        },
      ],
      [PLUGIN_ID, OVERRIDER_ID],
    );
    await runner.runBeforeAgentRun(
      { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
      cronRunContext("override"),
    );
    const overrideDecisions: Array<{ action?: string }> = [];
    for (
      let round = 0;
      round < MAX_RECEIPT_REVISE_ATTEMPTS + 1;
      round += 1
    ) {
      overrideDecisions.push(
        await agentHarness.runAgentHarnessBeforeAgentFinalizeHook({
          event: finalizeEvent("override"),
          ctx: cronRunContext("override"),
          hookRunner: runner,
        }),
      );
    }
    assert.deepEqual(
      overrideDecisions.map((decision) => decision?.action),
      [
        "finalize",
        ...Array.from(
          { length: MAX_RECEIPT_REVISE_ATTEMPTS - 1 },
          () => "revise",
        ),
        "continue",
      ],
      "when another plugin's finalize wins the merge, this guard's requested round is discarded and it under-requests (never over-revises) afterwards",
    );
    const overrideExhausted = overrideRegistration.logs.filter((entry) =>
      entry.args.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes(ReasonCodes.ReceiptReviseExhausted),
      ),
    );
    assert.equal(
      overrideExhausted.length,
      1,
      "the overridden checkpoint's miss must still surface through the exhausted log",
    );
    await runner.runAgentEnd(
      { runId: "smoke-run-override", messages: [], success: true },
      cronRunContext("override"),
    );
    pluginRuntime.resetGlobalHookRunner();
    record(
      "finalize-merge override: another plugin's finalize wins, the guard under-requests conservatively, and the miss is still logged loudly",
    );

    // Installed budget accounting: the per-(runId, idempotencyKey) charge
    // happens only when a revise decision wins the merge. If the overridden
    // round had been charged, the third call below would already continue.
    let hostBudgetRounds = 0;
    runner = initRunner(
      [
        {
          pluginId: "smoke-budget-finalizer",
          hookName: "before_agent_finalize",
          handler: () => {
            hostBudgetRounds += 1;
            return hostBudgetRounds === 1
              ? { action: "finalize", reason: "smoke synthetic finalize" }
              : undefined;
          },
          priority: 10,
          source: "smoke:target-build",
        },
        {
          pluginId: "smoke-budget-reviser",
          hookName: "before_agent_finalize",
          handler: () => ({
            action: "revise",
            reason: "smoke synthetic revise",
            retry: {
              instruction: "smoke synthetic instruction",
              idempotencyKey: "smoke.synthetic.retry",
              maxAttempts: MAX_RECEIPT_REVISE_ATTEMPTS,
            },
          }),
          priority: 0,
          source: "smoke:target-build",
        },
      ],
      ["smoke-budget-finalizer", "smoke-budget-reviser"],
    );
    const hostBudgetDecisions: Array<{ action?: string }> = [];
    for (
      let round = 0;
      round < MAX_RECEIPT_REVISE_ATTEMPTS + 2;
      round += 1
    ) {
      hostBudgetDecisions.push(
        await agentHarness.runAgentHarnessBeforeAgentFinalizeHook({
          event: finalizeEvent("hostbudget"),
          ctx: cronRunContext("hostbudget"),
          hookRunner: runner,
        }),
      );
    }
    assert.deepEqual(
      hostBudgetDecisions.map((decision) => decision?.action),
      [
        "finalize",
        ...Array.from(
          { length: MAX_RECEIPT_REVISE_ATTEMPTS },
          () => "revise",
        ),
        "continue",
      ],
      "the installed harness accounting must charge the idempotency-key budget only when a revise decision wins the merge",
    );
    pluginRuntime.resetGlobalHookRunner();
    record(
      "installed finalize budget is charged per run and idempotency key only for revise decisions that win the merge - the contract the guard's accounting documents",
    );

    restoreWrites();

    // ================= Privacy sweep ======================================
    extraEmitted.push(
      malformed.cancelReason ?? "",
      JSON.stringify(malformed.metadata ?? {}),
      helperLaunch.blockReason ?? "",
      contextlessSpawn.blockReason ?? "",
      JSON.stringify(wrongTargetFinalize ?? {}),
      JSON.stringify(budgetDecisions),
      JSON.stringify(overrideDecisions),
    );
    const emitted = [
      ...allLogs.map(
        (entry) => `${entry.level} ${entry.args.map(String).join(" ")}`,
      ),
      ...stdout,
      ...stderr,
      ...extraEmitted,
    ].join("\n");
    for (const needle of contentNeedles()) {
      assert.equal(
        emitted.includes(needle),
        false,
        `raw outbound content leaked into a log, reason, or metadata: ${JSON.stringify(needle.slice(0, 24))}`,
      );
    }
    assert.ok(allLogs.length > 0, "the guard logs its decisions");
    record(
      `no raw outbound content in ${allLogs.length} log record(s), stdout, stderr, cancel reason, or metadata`,
    );
  } finally {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    pluginRuntime.resetGlobalHookRunner();
    rmSync(workspace, { recursive: true, force: true });
  }

  process.stdout.write(`\ntarget-build smoke: ${checks.length} checks passed\n`);
}

await main();
