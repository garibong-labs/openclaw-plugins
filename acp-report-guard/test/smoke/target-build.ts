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
 * 6. No raw outbound content, command text, or agent id reaches a log line,
 *    the cancel reason, the block reason, or the hook metadata.
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
  ACP_LAUNCH_COMMAND,
  CANONICAL_COMPLETION_WITH_SECONDS,
  ORDINARY_CHAT,
  ORDINARY_COMMAND,
  completionWithDuration,
} from "../fixtures.ts";

const PLUGIN_ID = "acp-report-guard";
const HOOK_NAME = "message_sending";
const TOOL_HOOK_NAME = "before_tool_call";
const UNAUTHORIZED_AGENT_ID = "smoke-helper-agent";
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
  ].flatMap((report) => report.split("\n"));
  lines.push(ACP_LAUNCH_COMMAND, ORDINARY_COMMAND, UNAUTHORIZED_AGENT_ID);
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

    const messageSending = typedHooks.filter(
      (hook) => hook.hookName === HOOK_NAME,
    );
    assert.equal(messageSending.length, 1, `exactly one ${HOOK_NAME} handler`);
    const beforeToolCall = typedHooks.filter(
      (hook) => hook.hookName === TOOL_HOOK_NAME,
    );
    assert.equal(
      beforeToolCall.length,
      1,
      `exactly one ${TOOL_HOOK_NAME} handler`,
    );
    record(`built entry registers ${HOOK_NAME} and ${TOOL_HOOK_NAME}`);

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
    record(
      `installed runner dispatches ${HOOK_NAME} and ${TOOL_HOOK_NAME} to the built plugin`,
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

    const emitted = [
      ...logs.map((entry) => `${entry.level} ${entry.args.map(String).join(" ")}`),
      ...stdout,
      ...stderr,
      malformed.cancelReason ?? "",
      JSON.stringify(malformed.metadata ?? {}),
      helperLaunch.blockReason ?? "",
      contextlessSpawn.blockReason ?? "",
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
