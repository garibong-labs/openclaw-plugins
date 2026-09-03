import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createControllerSurfaces } from "../src/controller/surfaces.ts";
import {
  LeaseRegistry,
  ReportController,
  discordSnowflakeInstant,
  type ActiveLease,
} from "../src/controller/registry.ts";
import type { GuardHostApi } from "../src/host-contract.ts";
import { ReasonCodes } from "../src/lifecycle/reason-codes.ts";
import { CANONICAL_INTERMEDIATE, replaceLine } from "./fixtures.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__acpControllerPumpStatus;
  delete (globalThis as Record<string, unknown>).__acpControllerAck;
});

function fixture(): {
  root: string;
  state: string;
  transport: string;
  pump: string;
  host: string;
  message: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-test-"));
  roots.push(root);
  const state = path.join(root, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const transport = path.join(root, "transport.json");
  fs.writeFileSync(transport, "{}\n", { mode: 0o600 });
  const message = replaceLine(
    replaceLine(CANONICAL_INTERMEDIATE, 2, "🤖 **ACP**: Codex · `example-model-1`"),
    9,
    "- Δ1 · 예시 결과 확인",
  );
  const pump = path.join(root, "acp-report-pump.mjs");
  fs.writeFileSync(pump, [
    "import crypto from 'node:crypto';",
    `const message = ${JSON.stringify(message)};`,
    "export function runReportPump() {",
    " const status = globalThis.__acpControllerPumpStatus ?? 'delivery_pending';",
    " if (status !== 'delivery_pending') return { status };",
    " return { status, message, messageDigest: crypto.createHash('sha256').update(message).digest('hex'),",
    "  reportId: 'report-example', attemptId: 'attempt-example', fence: 1, cadence: 1, reportKind: 'intermediate' };",
    "}",
  ].join("\n"), { mode: 0o644 });
  const host = path.join(root, "acp-host-transport.mjs");
  fs.writeFileSync(host,
    "export const REPORT_ATTEMPT_TTL_MS = 300000; export function acknowledgeHostTransportReport(input) { if (globalThis.__acpControllerAck === 'throw') throw new Error('stale'); globalThis.__acpControllerAck = input; }\n",
    { mode: 0o644 });
  return { root, state, transport, pump, host, message };
}

function register(registry: LeaseRegistry, f: ReturnType<typeof fixture>, overrides: Partial<Parameters<LeaseRegistry["register"]>[0]> = {}): ActiveLease {
  return registry.register({
    leaseToken: "lease-token-example-00000001",
    ownerSessionKey: "agent:main:discord:example-owner",
    ownerRunId: "owner-run-example-1",
    transportFile: f.transport,
    processHandle: "process-example-1",
    jobId: "job-example-1",
    destination: { channel: "discord", accountId: "account-example", conversationId: "1" },
    reportPumpEntry: f.pump,
    hostTransportEntry: f.host,
    ...overrides,
  });
}

describe("owner-private persistent lease registry", () => {
  it("persists atomically with owner-only modes and reloads the active lease", () => {
    const f = fixture();
    const first = new LeaseRegistry(f.state);
    register(first, f);
    assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
    const reloaded = new LeaseRegistry(f.state);
    assert.equal(reloaded.getByToken("lease-token-example-00000001")?.jobId, "job-example-1");
  });

  it("rejects duplicates, symlinks, and insecure private files", () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    register(registry, f);
    assert.throws(() => register(registry, f), /controller\.duplicate/u);

    const second = fixture();
    fs.chmodSync(second.transport, 0o644);
    assert.throws(() => register(new LeaseRegistry(second.state), second), /permissions_invalid/u);
    fs.chmodSync(second.transport, 0o600);
    const link = path.join(second.root, "linked-transport.json");
    fs.symlinkSync(second.transport, link);
    assert.throws(() => register(new LeaseRegistry(second.state), second, { transportFile: link }), /path_unsafe/u);
  });

  it("detects content changes to an attested executable even when size and mtime are preserved", () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    const before = fs.statSync(f.pump);
    const original = fs.readFileSync(f.pump, "utf8");
    fs.writeFileSync(f.pump, original.replace("delivery_pending", "delivery_pendinx"), { mode: 0o644 });
    fs.utimesSync(f.pump, before.atime, before.mtime);
    assert.throws(() => registry.revalidate(entry), /trust_changed/u);
  });
});

describe("controller caller and delivery binding", () => {
  it("binds ticks to the exact main cron job session", () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    const controller = new ReportController(registry);
    assert.equal(controller.callerMatchesCron(entry, "main", "agent:main:cron:job-example-1:run:tick-1"), true);
    assert.equal(controller.callerMatchesCron(entry, "helper", "agent:main:cron:job-example-1:run:tick-1"), false);
    assert.equal(controller.callerMatchesCron(entry, "main", "agent:main:cron:job-example-2:run:tick-1"), false);
  });

  it("authorizes one exact digest/session/job/destination/account candidate and rejects ambiguity", async () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    const controller = new ReportController(registry);
    const sessionKey = "agent:main:cron:job-example-1:run:tick-1";
    assert.deepEqual(await controller.tick(entry, sessionKey), { status: "delivery_pending", message: f.message,
      destination: entry.destination });
    assert.equal(controller.authorizeSending(f.message, { sessionKey, channelId: "discord",
      accountId: "wrong-account", conversationId: entry.destination.conversationId }), "scope_mismatch");
    assert.equal(controller.authorizeSending(f.message, { sessionKey, channelId: "discord",
      accountId: entry.destination.accountId, conversationId: entry.destination.conversationId }), "authorized");

    const internals = controller as unknown as { pending: Map<string, Record<string, unknown>> };
    const second = fixture();
    const secondEntry = register(registry, second, {
      leaseToken: "lease-token-example-00000002", ownerSessionKey: "agent:main:discord:example-owner-2",
      ownerRunId: "owner-run-example-2", jobId: "job-example-2",
      destination: entry.destination,
    });
    const copy = { ...internals.pending.values().next().value, leaseHash: secondEntry.leaseHash };
    internals.pending.set(secondEntry.leaseHash, copy);
    assert.equal(controller.authorizeSending(f.message, { sessionKey, channelId: "discord",
      accountId: entry.destination.accountId, conversationId: entry.destination.conversationId }), "ambiguous");
  });

  it("acknowledges one successful logical multipart send with its canonical message id", async () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    const controller = new ReportController(registry);
    const sessionKey = "agent:main:cron:job-example-1:run:tick-1";
    await controller.tick(entry, sessionKey);
    const context = { sessionKey, channelId: "discord", accountId: entry.destination.accountId,
      conversationId: entry.destination.conversationId };
    assert.equal(controller.authorizeSending(f.message, context), "authorized");
    const replacement = path.join(f.root, "replacement-transport.json");
    fs.writeFileSync(replacement, "{\"updated\":true}\n", { mode: 0o600 });
    fs.renameSync(replacement, f.transport);
    const instant = Date.now() - 1000;
    const messageId = (BigInt(instant - 1420070400000) << 22n).toString();
    assert.equal(await controller.acknowledgeSent({ content: f.message, success: true, messageId }, context), "acked");
    const ack = (globalThis as Record<string, unknown>).__acpControllerAck as Record<string, unknown>;
    assert.equal((ack.receipt as Record<string, unknown>).messageId, messageId);
    assert.equal((ack.receipt as Record<string, unknown>).deliveredAt, new Date(instant).toISOString());
  });

  it("keeps missing and uncertain delivery distinct, then retries after the attempt fence expires", async () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    const controller = new ReportController(registry);
    const sessionKey = "agent:main:cron:job-example-1:run:tick-1";
    await controller.tick(entry, sessionKey);
    const context = { sessionKey, channelId: "discord", accountId: entry.destination.accountId,
      conversationId: entry.destination.conversationId };
    controller.authorizeSending(f.message, context);
    assert.equal(await controller.acknowledgeSent({ content: f.message, success: false }, context), "ignored");
    assert.deepEqual(await controller.tick(entry, sessionKey), { status: "delivery_missing" });
    const internals = controller as unknown as { pending: Map<string, { expiresAtMs: number }> };
    internals.pending.get(entry.leaseHash)!.expiresAtMs = 0;
    assert.deepEqual(await controller.tick(entry, sessionKey), { status: "delivery_pending", message: f.message,
      destination: entry.destination });
    controller.authorizeSending(f.message, context);
    (globalThis as Record<string, unknown>).__acpControllerAck = "throw";
    const messageId = (BigInt(Date.now() - 1420070400000) << 22n).toString();
    assert.equal(await controller.acknowledgeSent({ content: f.message, success: true, messageId }, context), "failed");
    assert.ok(registry.getByToken("lease-token-example-00000001"));
    assert.deepEqual(await controller.tick(entry, sessionKey), { status: "delivery_uncertain" });
  });

  for (const terminal of ["terminal_acked", "tracking_lost"] as const) {
    it(`returns deterministic self-cleanup for ${terminal}`, async () => {
      const f = fixture();
      const registry = new LeaseRegistry(f.state);
      const entry = register(registry, f);
      (globalThis as Record<string, unknown>).__acpControllerPumpStatus = terminal;
      const result = await new ReportController(registry).tick(entry,
        "agent:main:cron:job-example-1:run:tick-1");
      assert.deepEqual(result, { status: terminal, cleanup: "remove_current_job_then_release_lease",
        jobId: "job-example-1" });
      assert.equal(registry.getByToken("lease-token-example-00000001")?.cleanupState, terminal);
    });
  }
});

describe("receipt time and lifecycle enforcement", () => {
  it("derives the Discord delivery instant from a snowflake", () => {
    const instant = Date.UTC(2026, 7, 31, 10, 0, 5);
    const snowflake = (BigInt(instant - 1420070400000) << 22n).toString();
    assert.equal(discordSnowflakeInstant(snowflake), new Date(instant).toISOString());
    assert.equal(discordSnowflakeInstant("not-an-id"), undefined);
  });

  it("blocks cross-agent controller calls, final/yield, revises finalize, and logs agent_end content-free", async () => {
    const f = fixture();
    let policy: { evaluate: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown } | undefined;
    let toolFactory: ((ctx: Record<string, unknown>) => { execute: (id: string, params: unknown) => Promise<Record<string, unknown>> }) | undefined;
    const logs: string[] = [];
    const api = {
      id: "acp-lifecycle-guard", logger: { warn: (line: unknown) => logs.push(String(line)) },
      runtime: { state: { resolveStateDir: () => f.state } }, on: () => {},
      registerTool: (value: unknown) => { toolFactory = value as typeof toolFactory; },
      registerTrustedToolPolicy: (value: unknown) => { policy = value as typeof policy; },
    } as unknown as GuardHostApi;
    const surfaces = createControllerSurfaces(api);
    register(surfaces.registry, f);
    policy!.evaluate({ toolName: "acp_report_controller", toolCallId: "call-example", params: { action: "status" } },
      { toolName: "acp_report_controller", agentId: "helper", sessionKey: "agent:helper:example", runId: "helper-run" });
    const tool = toolFactory!({ agentId: "helper", sessionKey: "agent:helper:example" });
    const denied = await tool.execute("call-example", { action: "status", leaseToken: "lease-token-example-00000001" });
    assert.equal((denied.details as Record<string, unknown>).code, ReasonCodes.ControllerCallerInvalid);
    const ctx = { toolName: "message", agentId: "main", sessionKey: "agent:main:discord:example-owner",
      runId: "owner-run-example-1" };
    assert.deepEqual(policy!.evaluate({ toolName: "sessions_yield", params: {} }, ctx),
      { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion });
    assert.deepEqual(policy!.evaluate({ toolName: "message", params: { final: true } }, ctx),
      { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion });
    assert.equal(policy!.evaluate({ toolName: "message", params: { final: false } }, ctx), undefined);
    assert.equal(policy!.evaluate({ toolName: "sessions_yield", params: {} }, { ...ctx, runId: "other-run" }), undefined);
    const finalize = surfaces.beforeAgentFinalize({ sessionId: "example", stopHookActive: false }, ctx);
    assert.equal(finalize?.action, "revise");
    surfaces.agentEnd({ messages: [], success: true }, ctx);
    assert.ok(logs.some((line) => line.includes(ReasonCodes.LeaseAgentEndViolation)));
    assert.ok(logs.every((line) => !line.includes("example-owner") && !line.includes("owner-run")));
  });

  it("allows terminal recovery only to a fresh authenticated run in the same owner session", async () => {
    const f = fixture();
    const logs: string[] = [];
    let policy: { evaluate: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown } | undefined;
    let toolFactory: ((ctx: Record<string, unknown>) => { outputSchema?: unknown;
      execute: (id: string, params: unknown) => Promise<Record<string, unknown>> }) | undefined;
    const api = {
      id: "acp-lifecycle-guard", logger: { warn: (line: unknown) => logs.push(String(line)) },
      runtime: { state: { resolveStateDir: () => f.state } }, on: () => {},
      registerTool: (value: unknown) => { toolFactory = value as typeof toolFactory; },
      registerTrustedToolPolicy: (value: unknown) => { policy = value as typeof policy; },
    } as unknown as GuardHostApi;
    const surfaces = createControllerSurfaces(api);
    const entry = register(surfaces.registry, f);
    surfaces.registry.setCleanupState(entry, "terminal_acked");

    const invoke = async (id: string, ctx: Record<string, unknown>, action: "status" | "tick" | "release") => {
      policy!.evaluate({ toolName: "acp_report_controller", toolCallId: id, params: { action } }, ctx);
      return toolFactory!(ctx).execute(id, { action, leaseToken: "lease-token-example-00000001" });
    };
    const freshOwner = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:discord:example-owner", runId: "owner-run-example-2",
      requester: { senderIsOwner: true } };
    const status = await invoke("fresh-status", freshOwner, "status");
    assert.deepEqual(status.details, { status: "terminal_acked",
      cleanup: "remove_current_job_then_release_lease", jobId: "job-example-1" });
    assert.ok(toolFactory!(freshOwner).outputSchema, "the controller must declare its structured output contract");

    const wrongSession = await invoke("wrong-session", { ...freshOwner,
      sessionKey: "agent:main:discord:example-other" }, "status");
    assert.equal((wrongSession.details as Record<string, unknown>).code, ReasonCodes.ControllerCallerInvalid);
    const wrongSessionRelease = await invoke("wrong-session-release", { ...freshOwner,
      sessionKey: "agent:main:discord:example-other" }, "release");
    assert.equal((wrongSessionRelease.details as Record<string, unknown>).code, ReasonCodes.ControllerReleaseDenied);
    const wrongAgent = await invoke("wrong-agent", { ...freshOwner, agentId: "helper" }, "status");
    assert.equal((wrongAgent.details as Record<string, unknown>).code, ReasonCodes.ControllerCallerInvalid);
    const wrongAgentRelease = await invoke("wrong-agent-release", { ...freshOwner, agentId: "helper" }, "release");
    assert.equal((wrongAgentRelease.details as Record<string, unknown>).code, ReasonCodes.ControllerReleaseDenied);
    const unauthenticated = await invoke("unauthenticated", { ...freshOwner,
      requester: { senderIsOwner: false } }, "status");
    assert.equal((unauthenticated.details as Record<string, unknown>).code, ReasonCodes.ControllerCallerInvalid);
    const freshTick = await invoke("fresh-tick", freshOwner, "tick");
    assert.equal((freshTick.details as Record<string, unknown>).code, ReasonCodes.ControllerCallerInvalid);
    assert.ok(logs.some((line) => line.includes(ReasonCodes.ControllerCallerInvalid)));
    assert.ok(logs.some((line) => line.includes(ReasonCodes.ControllerReleaseDenied)));
    assert.ok(logs.every((line) => !line.includes("example-owner") &&
      !line.includes("owner-run") && !line.includes("lease-token")));

    const released = await invoke("fresh-release", freshOwner, "release");
    assert.deepEqual(released.details, { status: "released" });
    assert.equal(surfaces.registry.getByToken("lease-token-example-00000001"), undefined);
  });

  it("explicitly denies manual release while a lease is active, including the original owner run", async () => {
    const f = fixture();
    let policy: { evaluate: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown } | undefined;
    let toolFactory: ((ctx: Record<string, unknown>) => {
      execute: (id: string, params: unknown) => Promise<Record<string, unknown>> }) | undefined;
    const api = {
      id: "acp-lifecycle-guard", logger: { warn: () => {} },
      runtime: { state: { resolveStateDir: () => f.state } }, on: () => {},
      registerTool: (value: unknown) => { toolFactory = value as typeof toolFactory; },
      registerTrustedToolPolicy: (value: unknown) => { policy = value as typeof policy; },
    } as unknown as GuardHostApi;
    const surfaces = createControllerSurfaces(api);
    register(surfaces.registry, f);
    const owner = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:discord:example-owner", runId: "owner-run-example-1",
      requester: { senderIsOwner: true } };
    policy!.evaluate({ toolName: "acp_report_controller", toolCallId: "active-release", params: {} }, owner);
    const result = await toolFactory!(owner).execute("active-release",
      { action: "release", leaseToken: "lease-token-example-00000001" });
    assert.equal((result.details as Record<string, unknown>).code, ReasonCodes.ControllerReleaseDenied);
    assert.ok(surfaces.registry.getByToken("lease-token-example-00000001"));
  });
});
