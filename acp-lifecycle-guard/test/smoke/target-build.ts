#!/usr/bin/env node
/**
 * Target-build smoke: `message_sending` cancellation and `before_tool_call`
 * launch blocking.
 *
 * The unit suites exercise the pure policy functions. This smoke exercises the
 * *built* plugin through the *installed* OpenClaw hook runner instead, so it
 * proves the parts a pure-function test cannot:
 *
 * 1. `dist/index.js` loads against the real `openclaw/plugin-sdk/plugin-entry`
 *    and its `register` puts `message_sending` and `before_tool_call` handlers
 *    into the registry.
 * 2. A canonical completion report carrying seconds (`17분 31초`) survives the
 *    authoritative guard - the regression this smoke exists for.
 * 3. A malformed lifecycle report is cancelled with the expected reason code.
 * 4. Ordinary chat is returned untouched.
 * 5. The installed runner dispatches `before_tool_call`: a recognized ACP
 *    launch from a non-`main` agent is blocked with the stable reason code,
 *    while the same launch from `main` and an ordinary command pass. The
 *    smoke fails clearly if the installed runner no longer exposes the
 *    expected `before_tool_call` dispatch contract.
 * 6. The installed runner dispatches the owner-checkpoint receipt hooks
 *    (`before_agent_run`, `message_sent`, `before_agent_finalize`,
 *    `agent_end`): an eligible cron checkpoint correlates, an exact-target
 *    send receipt is accepted (a failed send and a wrong-target success are
 *    not), a missing receipt yields the bounded enforce-mode revise result,
 *    the *installed* finalize retry accounting turns exhausted revise rounds
 *    into plain continuation (proving the host fails open there - the guard
 *    logs the exhaustion instead of claiming delivery), cleanup on
 *    `agent_end` is deterministic, and ordinary turns bypass everything.
 * 7. `before_agent_run` is an input gate on this host: `runBeforeAgentRun`
 *    normalizes a nullish handler result to a block (`before_agent_run
 *    returned an invalid decision`). A synthetic probe pins that behavior on
 *    the installed build, and every receipt scenario - eligible, ordinary
 *    marker-only, and uncorrelatable - is asserted to produce an explicit
 *    pass decision from the installed runner, so a regression back to a
 *    `void` return cannot escape this smoke again.
 * 8. No raw outbound content, prompt text, command text, agent id, or
 *    correlation identifier reaches a log line, the cancel reason, the block
 *    reason, a revise reason, or the hook metadata.
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
const SMOKE_JOB_ID = "smoke-cron-job-1";
const SMOKE_MESSAGE_ID = "smoke-message-1";

/** One trusted cron agent-hook context per receipt scenario. */
function cronRunContext(scenario: string): Record<string, unknown> {
  return {
    trigger: "cron",
    jobId: SMOKE_JOB_ID,
    runId: `smoke-run-${scenario}`,
    sessionKey: `smoke-session-${scenario}`,
    sessionId: `smoke-session-id-${scenario}`,
    channel: SMOKE_CHANNEL,
    channelId: SMOKE_CONVERSATION,
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
 * Every fixture line, command string, and agent id that must never appear in a
 * log, reason, or metadata.
 */
function contentNeedles(): readonly string[] {
  const lines = [
    CANONICAL_COMPLETION_WITH_SECONDS,
    MALFORMED_COMPLETION,
    ORDINARY_CHAT,
    OWNER_CHECKPOINT_PROMPT,
    CHECKPOINT_REPORT_TERMINAL_GREEN,
  ].flatMap((report) => report.split("\n"));
  lines.push(
    ACP_LAUNCH_COMMAND,
    ORDINARY_COMMAND,
    UNAUTHORIZED_AGENT_ID,
    SMOKE_CHANNEL,
    SMOKE_CONVERSATION,
    SMOKE_WRONG_CONVERSATION,
    SMOKE_JOB_ID,
    SMOKE_MESSAGE_ID,
  );
  for (const scenario of ["happy", "revise", "budget", "wrong", "cleanup"]) {
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

async function main(): Promise<void> {
  const openclawRoot = resolveOpenClawRoot();
  const openclawVersion = JSON.parse(
    readFileSync(path.join(openclawRoot, "package.json"), "utf8"),
  ).version as string;
  process.stdout.write(
    `openclaw ${openclawVersion} (${HOOK_NAME} + ${TOOL_HOOK_NAME} runner)\n`,
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
  // prove what the host does once bounded revise rounds are exhausted.
  const agentHarness = await import(
    pathToFileURL(
      requireFromWorkspace.resolve("openclaw/plugin-sdk/agent-harness"),
    ).href
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  try {
    const entry = (await import(entryUrl.href)).default;
    assert.equal(entry.id, PLUGIN_ID, "built entry keeps its plugin id");
    assert.equal(typeof entry.register, "function", "built entry registers");
    record("built dist/index.js loads against the installed plugin SDK");

    // Mirror how the host turns `api.on(...)` into a typed hook registration
    // (openclaw dist `registry`: pluginId, hookName, handler, priority, source).
    const typedHooks: Array<Record<string, unknown>> = [];
    const logs: Array<{ level: string; args: unknown[] }> = [];
    const logAt =
      (level: string) =>
      (...args: unknown[]): void => {
        logs.push({ level, args });
      };
    entry.register({
      id: PLUGIN_ID,
      logger: {
        debug: logAt("debug"),
        info: logAt("info"),
        warn: logAt("warn"),
        error: logAt("error"),
      },
      // Enforce receipt mode so the smoke can prove the revise contract; the
      // shipped default stays observe-only.
      pluginConfig: { ownerCheckpointReceiptMode: "enforce" },
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

    for (const hookName of [HOOK_NAME, TOOL_HOOK_NAME, ...RECEIPT_HOOK_NAMES]) {
      const matching = typedHooks.filter((hook) => hook.hookName === hookName);
      assert.equal(matching.length, 1, `exactly one ${hookName} handler`);
    }
    record(
      `built entry registers ${HOOK_NAME}, ${TOOL_HOOK_NAME}, and the four receipt hooks`,
    );

    // Pin the installed gate's nullish normalization with synthetic handlers
    // before wiring the real plugin: the exported host type still allows
    // `void`, but on this build a `null` result is normalized into a block
    // and only an incidental `!== undefined` guard in the generic hook-merge
    // layer keeps `undefined` from doing the same. The explicit-pass
    // assertions below rest on this observed behavior, not on the type.
    const probeGateDecision = async (
      probeHandler: () => unknown,
    ): Promise<
      { decision?: { outcome?: string; reason?: string } } | undefined
    > => {
      pluginRuntime.initializeGlobalHookRunner({
        hooks: [],
        typedHooks: [
          {
            pluginId: "smoke-nullish-probe",
            hookName: "before_agent_run",
            handler: probeHandler,
            priority: 0,
            source: "smoke:target-build",
          },
        ],
        plugins: [{ id: "smoke-nullish-probe", status: "loaded" }],
      });
      const probeRunner = pluginRuntime.getGlobalHookRunner();
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

    pluginRuntime.initializeGlobalHookRunner({
      hooks: [],
      typedHooks,
      plugins: [{ id: PLUGIN_ID, status: "loaded" }],
    });
    const runner = pluginRuntime.getGlobalHookRunner();
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
    assert.equal(
      typeof runner.runBeforeToolCall,
      "function",
      `installed OpenClaw hook runner does not expose runBeforeToolCall; the host ${TOOL_HOOK_NAME} contract changed - update this smoke and src/host-contract.ts together`,
    );
    for (const hookName of RECEIPT_HOOK_NAMES) {
      assert.equal(
        pluginRuntime.hasGlobalHooks(hookName),
        true,
        `${hookName} is visible to the global runner`,
      );
    }
    for (const method of [
      "runBeforeAgentRun",
      "runMessageSent",
      "runBeforeAgentFinalize",
      "runAgentEnd",
    ]) {
      assert.equal(
        typeof runner[method],
        "function",
        `installed OpenClaw hook runner does not expose ${method}; the host receipt-hook contract changed - update this smoke and src/host-contract.ts together`,
      );
    }
    assert.equal(
      typeof agentHarness.runAgentHarnessBeforeAgentFinalizeHook,
      "function",
      "installed OpenClaw no longer exposes the harness finalize helper; re-verify the revise retry-budget contract before trusting enforcement",
    );
    record(
      `installed runner dispatches ${HOOK_NAME}, ${TOOL_HOOK_NAME}, and the receipt hooks to the built plugin`,
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

    // Capture everything the host and the plugin emit during dispatch.
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      stdout.push(String(chunk));
      return (realStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      stderr.push(String(chunk));
      return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

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

    // --- Owner-checkpoint receipt scenarios -------------------------------
    const startCheckpoint = (scenario: string): Promise<unknown> =>
      runner.runBeforeAgentRun(
        { prompt: OWNER_CHECKPOINT_PROMPT, messages: [] },
        cronRunContext(scenario),
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

    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;

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
    record("ACP launch from agent `main` passes through the installed runner");

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
    record(
      `non-main ACP launches blocked with ${ReasonCodes.LaunchNonMainAgent}`,
    );

    assert.equal(
      ordinaryCommand,
      undefined,
      "an ordinary command from a non-main agent must pass untouched",
    );
    record("ordinary command from a non-main agent passes untouched");

    // Every before_agent_run scenario must come back from the *installed*
    // runner as an explicit pass decision attributed to this plugin. A void
    // or null handler result would surface here as either `undefined` or the
    // gate's invalid-decision block.
    const gatePass = { decision: { outcome: "pass" }, pluginId: PLUGIN_ID };
    for (const [label, gateResult] of [
      ["eligible (happy)", happyStart],
      ["eligible (wrong-target)", wrongStart],
      ["eligible (budget)", budgetStart],
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
    record(
      `missing receipt yields the bounded revise result with ${ReasonCodes.ReceiptMissing}`,
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
    const exhaustedLogs = logs.filter((entry) =>
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

    const emitted = [
      ...logs.map((entry) => `${entry.level} ${entry.args.map(String).join(" ")}`),
      ...stdout,
      ...stderr,
      malformed.cancelReason ?? "",
      JSON.stringify(malformed.metadata ?? {}),
      helperLaunch.blockReason ?? "",
      contextlessSpawn.blockReason ?? "",
      JSON.stringify(wrongTargetFinalize ?? {}),
      JSON.stringify(budgetDecisions),
    ].join("\n");
    for (const needle of contentNeedles()) {
      assert.equal(
        emitted.includes(needle),
        false,
        `raw outbound content leaked into a log, reason, or metadata: ${JSON.stringify(needle.slice(0, 24))}`,
      );
    }
    assert.ok(logs.length > 0, "the guard logs its cancellation decision");
    record(
      `no raw outbound content in ${logs.length} log record(s), stdout, stderr, cancel reason, or metadata`,
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
