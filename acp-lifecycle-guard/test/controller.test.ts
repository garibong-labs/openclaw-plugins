import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createControllerSurfaces } from "../src/controller/surfaces.ts";
import {
  LeaseRegistry,
  MAX_PREPARED_LEASES_PER_OWNER,
  ReportController,
  assertPosixControllerPlatform,
  discordSnowflakeInstant,
  type ActiveLease,
} from "../src/controller/registry.ts";
import type {
  BeforeToolCallEvent,
  BeforeToolCallResult,
  GuardHostApi,
  PluginToolContext,
  ToolHookContext,
} from "../src/host-contract.ts";
import { ReasonCodes } from "../src/lifecycle/reason-codes.ts";
import { CANONICAL_INTERMEDIATE, replaceLine } from "./fixtures.ts";

const automationTemplatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../templates/report-controller-automation.json");
const automationTemplate = JSON.parse(fs.readFileSync(automationTemplatePath, "utf8")) as
  { payload: { script: string } };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...values: Array<(...args: unknown[]) => Promise<unknown>>) =>
    Promise<unknown>;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__acpControllerPumpStatus;
  delete (globalThis as Record<string, unknown>).__acpControllerAck;
  delete (globalThis as Record<string, unknown>).__acpControllerActivation;
  delete (globalThis as Record<string, unknown>).__acpControllerAbort;
  delete (globalThis as Record<string, unknown>).__acpControllerActivationInput;
  delete (globalThis as Record<string, unknown>).__acpControllerAbortInput;
  delete (globalThis as Record<string, unknown>).__acpControllerExactReport;
});

function canonicalPumpReport(): Record<string, unknown> {
  return {
    agent: "codex", model: "example-model-1", roundIndex: 1,
    repository: "example-repo", branch: "feat/example", timeKst: "14:20",
    phaseIndex: 2, totalMinutes: 20, phaseMinutes: 8, lastAcpActivityMinutesAgo: 2,
    newResultDelta: 1, newResult: "예시 결과 확인", executionState: "ACP 프롬프트 실행 중",
    inProgress: "정책 모듈 구현 3/5", verification: "아직 실행 전",
    next: "남은 게이트 2개 · 검증 실행",
  };
}

function writePumpModule(pump: string, message: string, report = canonicalPumpReport()): void {
  fs.writeFileSync(pump, [
    "import crypto from 'node:crypto';",
    `const message = ${JSON.stringify(message)};`,
    `const report = Object.freeze(${JSON.stringify(report)});`,
    "globalThis.__acpControllerExactReport = report;",
    "export function runReportPump() {",
    " const status = globalThis.__acpControllerPumpStatus ?? 'delivery_pending';",
    " if (status !== 'delivery_pending') return { status };",
    " return { status, message, messageDigest: crypto.createHash('sha256').update(message).digest('hex'),",
    "  reportId: 'report-example', attemptId: 'attempt-example', fence: 1, cadence: 1, reportKind: 'intermediate', report };",
    "}",
  ].join("\n"), { mode: 0o644 });
}

function fixture(): {
  root: string;
  state: string;
  transport: string;
  pump: string;
  host: string;
  message: string;
} {
  // `os.tmpdir()` traverses a symlinked ancestor on macOS (`/var` ->
  // `/private/var`), and the registry stores and compares canonical paths,
  // so the fixture root must be canonical before anything is attested.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-test-")));
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
  writePumpModule(pump, message);
  const host = path.join(root, "acp-host-transport.mjs");
  fs.writeFileSync(host, [
    "export const REPORT_ATTEMPT_TTL_MS = 300000;",
    "export function confirmHostTransportActivation(input) {",
    " globalThis.__acpControllerActivationInput = input;",
    " const state = globalThis.__acpControllerActivation ?? 'confirmed'; if (state === 'throw') throw new Error('unproven');",
    " return { schemaVersion: 'acp-host-controller-lease.v1', type: state === 'mismatch' ? 'host_transport_preactivation_aborted' : 'host_transport_activation_confirmed', processHandle: input.processHandle };",
    "}",
    "export function abortHostTransportPreactivation(input) {",
    " globalThis.__acpControllerAbortInput = input;",
    " const state = globalThis.__acpControllerAbort ?? 'preactivation_exit'; if (state !== 'preactivation_exit') throw new Error('denied');",
    " return { schemaVersion: 'acp-host-controller-lease.v1', type: 'host_transport_preactivation_aborted', processHandle: input.processHandle };",
    "}",
    "export function acknowledgeHostTransportReport(input) { if (globalThis.__acpControllerAck === 'throw') throw new Error('stale'); globalThis.__acpControllerAck = input; }",
  ].join("\n"), { mode: 0o644 });
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

async function activate(registry: LeaseRegistry, entry: ActiveLease): Promise<ActiveLease> {
  await registry.commitActivation(entry);
  return entry;
}

async function preparePublication(
  controller: ReportController,
  entry: ActiveLease,
  sessionKey: string,
): Promise<Record<string, unknown>> {
  const result = await controller.tick(entry, sessionKey);
  assert.equal(result.status, "delivery_pending");
  assert.ok("publicationToken" in result);
  const prepared = controller.prepareMessageTool({
    action: "send",
    message: result.publicationToken,
    final: false,
  }, { agentId: "main", sessionKey });
  assert.equal(prepared.outcome, "authorized");
  return prepared.params!;
}

describe("owner-private persistent lease registry", () => {
  it("registers and durably reloads only a prepared lease", () => {
    const f = fixture();
    const first = new LeaseRegistry(f.state);
    register(first, f);
    assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
    const reloaded = new LeaseRegistry(f.state);
    assert.equal(reloaded.getByToken("lease-token-example-00000001")?.jobId, "job-example-1");
    assert.equal(reloaded.getByToken("lease-token-example-00000001")?.phase, "prepared");
    assert.equal(reloaded.getByToken("lease-token-example-00000001")?.cleanupState, null);
  });

  it("recovers an exact persisted registration replay without another lease or capacity use", () => {
    const f = fixture();
    const firstRegistry = new LeaseRegistry(f.state);
    const first = register(firstRegistry, f);
    const persistedBeforeReplay = fs.readFileSync(firstRegistry.file, "utf8");

    // A new registry instance models a caller losing the first successful
    // response and retrying only after the durable write has completed.
    const recoveredRegistry = new LeaseRegistry(f.state);
    const recovered = register(recoveredRegistry, f);
    assert.deepEqual(recovered, first);
    assert.equal(fs.readFileSync(recoveredRegistry.file, "utf8"), persistedBeforeReplay);

    const recoveredFromFreshRun = register(recoveredRegistry, f, {
      ownerRunId: "owner-run-example-recovery",
    });
    assert.equal(recoveredFromFreshRun.ownerRunId, "owner-run-example-recovery");
    assert.equal(recoveredRegistry.leasesForOwner("agent:main:discord:example-owner",
      "owner-run-example-1").length, 0);
    assert.equal(recoveredRegistry.leasesForOwner("agent:main:discord:example-owner",
      "owner-run-example-recovery").length, 1);
    const persistedAfterRecovery = fs.readFileSync(recoveredRegistry.file, "utf8");
    assert.notEqual(persistedAfterRecovery, persistedBeforeReplay);
    const document = JSON.parse(persistedAfterRecovery) as {
      leases: Array<{ ownerRunId: string }> };
    assert.equal(document.leases.length, 1);
    assert.equal(document.leases[0]?.ownerRunId, "owner-run-example-recovery");

    const alternate = fixture();
    for (const overrides of [
      { leaseToken: "lease-token-example-00000002" },
      { processHandle: "process-example-mismatch" },
      { jobId: "job-example-mismatch" },
      { ownerSessionKey: "agent:main:discord:example-owner-mismatch" },
      { transportFile: alternate.transport },
      { destination: { channel: "discord" as const, accountId: "account-mismatch", conversationId: "2" } },
    ]) {
      assert.throws(() => register(recoveredRegistry, f, overrides), /controller\.duplicate/u);
    }
  });

  it("rejects mismatched duplicates, symlinks, and insecure private files", () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    register(registry, f);
    assert.throws(() => register(registry, f, { jobId: "job-example-mismatch" }), /controller\.duplicate/u);

    const second = fixture();
    fs.chmodSync(second.transport, 0o644);
    assert.throws(() => register(new LeaseRegistry(second.state), second), /permissions_invalid/u);
    fs.chmodSync(second.transport, 0o600);
    const link = path.join(second.root, "linked-transport.json");
    fs.symlinkSync(second.transport, link);
    assert.throws(() => register(new LeaseRegistry(second.state), second, { transportFile: link }), /path_unsafe/u);

    const ancestor = path.join(second.root, "linked-ancestor");
    fs.symlinkSync(second.root, ancestor);
    assert.throws(() => register(new LeaseRegistry(second.state), second, {
      leaseToken: "lease-token-example-00000002",
      ownerRunId: "owner-run-example-2",
      jobId: "job-example-2",
      transportFile: path.join(ancestor, path.basename(second.transport)),
    }), /path_unsafe/u);
  });

  it("declares the direct controller POSIX-only instead of weakening uid checks", () => {
    assert.doesNotThrow(() => assertPosixControllerPlatform(process.getuid));
    assert.throws(() => assertPosixControllerPlatform(undefined), /controller\.posix_required/u);
  });

  it("reloads unrelated leases without touching a missing stale transport", () => {
    const stale = fixture();
    const live = fixture();
    const first = new LeaseRegistry(stale.state);
    register(first, stale);
    const liveEntry = register(first, live, {
      leaseToken: "lease-token-example-00000002",
      ownerSessionKey: "agent:main:discord:example-owner-2",
      ownerRunId: "owner-run-example-2",
      jobId: "job-example-2",
    });
    fs.unlinkSync(stale.transport);
    const reloaded = new LeaseRegistry(stale.state);
    assert.ok(reloaded.getByToken("lease-token-example-00000001"));
    assert.doesNotThrow(() => reloaded.revalidate(reloaded.getByHash(liveEntry.leaseHash)!));
    assert.throws(() => reloaded.revalidate(reloaded.getByToken("lease-token-example-00000001")!),
      /path_unavailable/u);
    const added = fixture();
    assert.doesNotThrow(() => register(reloaded, added, {
      leaseToken: "lease-token-example-00000003",
      ownerSessionKey: "agent:main:discord:example-owner-3",
      ownerRunId: "owner-run-example-3",
      processHandle: "process-example-3",
      jobId: "job-example-3",
    }));
  });

  it("bounds repeated prepared failures per owner until evidence-based recovery", () => {
    const first = fixture();
    const registry = new LeaseRegistry(first.state);
    for (let index = 0; index < MAX_PREPARED_LEASES_PER_OWNER; index += 1) {
      const current = index === 0 ? first : fixture();
      register(registry, current, {
        leaseToken: `lease-token-example-${String(index + 1).padStart(8, "0")}`,
        ownerRunId: `owner-run-example-${index + 1}`,
        processHandle: `process-example-${index + 1}`,
        jobId: `job-example-${index + 1}`,
      });
    }
    assert.doesNotThrow(() => register(registry, first),
      "an exact replay must recover even when the owner is at capacity");
    const persisted = JSON.parse(fs.readFileSync(registry.file, "utf8")) as { leases: unknown[] };
    assert.equal(persisted.leases.length, MAX_PREPARED_LEASES_PER_OWNER);
    const overflow = fixture();
    assert.throws(() => register(registry, overflow, {
      leaseToken: "lease-token-example-00000099",
      ownerRunId: "owner-run-example-99",
      processHandle: "process-example-99",
      jobId: "job-example-99",
    }), /prepared_recovery_required/u);
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

  for (const cleanupState of ["terminal_acked", "tracking_lost"] as const) {
    it(`durably releases ${cleanupState} after the transport artifact disappears`, async () => {
      const f = fixture();
      const registry = new LeaseRegistry(f.state);
      const entry = register(registry, f);
      await activate(registry, entry);
      registry.setCleanupState(entry, cleanupState);
      fs.unlinkSync(f.transport);
      assert.doesNotThrow(() => registry.release(entry));
      assert.equal(registry.getByToken("lease-token-example-00000001"), undefined);
      assert.equal(new LeaseRegistry(f.state).getByToken("lease-token-example-00000001"), undefined);
    });
  }

  it("revalidates exact transport proof before aborting and deleting a prepared lease", async () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    fs.unlinkSync(f.transport);
    await assert.rejects(registry.abortPreactivation(entry), /controller\.path_unavailable/u);
    assert.equal(registry.getByToken("lease-token-example-00000001"), entry);
    assert.equal(new LeaseRegistry(f.state).getByToken("lease-token-example-00000001")?.phase, "prepared");
  });
});

describe("controller caller and delivery binding", () => {
  it("denies automation ticks while the durable lease is only prepared", async () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    await assert.rejects(
      new ReportController(registry).tick(entry, "agent:main:cron:job-example-1:run:tick-1"),
      /controller\.lease_prepared/u,
    );
    assert.equal(entry.phase, "prepared");
  });

  it("binds ticks to the exact main cron job session", () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    const controller = new ReportController(registry);
    assert.equal(controller.callerMatchesCron(entry, "main", "agent:main:cron:job-example-1:run:tick-1"), true);
    assert.equal(controller.callerMatchesCron(entry, "helper", "agent:main:cron:job-example-1:run:tick-1"), false);
    assert.equal(controller.callerMatchesCron(entry, "main", "agent:main:cron:job-example-2:run:tick-1"), false);
  });

  for (const [label, mutate] of [
    ["CRLF plus a trailing newline", (message: string) => `${message.replaceAll("\n", "\r\n")}\r\n`],
    ["NFD-equivalent text", (message: string) => message.normalize("NFD")],
    ["the legacy activity label", (message: string) => message.replace("마지막 ACP 활동", "마지막 변화")],
    ["the legacy positive-delta grammar", (message: string) => message.replace("- Δ1 · ", "- Δ+1 ")],
  ] as const) {
    it(`fails closed before publication for pump output using ${label}`, async () => {
      const f = fixture();
      writePumpModule(f.pump, mutate(f.message));
      const registry = new LeaseRegistry(f.state);
      const entry = register(registry, f);
      await activate(registry, entry);
      const controller = new ReportController(registry);
      await assert.rejects(
        controller.tick(entry, "agent:main:cron:job-example-1:run:tick-1"),
        /controller\.pump_report_noncanonical/u,
      );
      const internals = controller as unknown as { pending: Map<string, unknown> };
      assert.equal(internals.pending.size, 0);
    });
  }

  it("fails closed before publication when the pump report is not an exact bounded shape", async () => {
    const f = fixture();
    writePumpModule(f.pump, f.message, { ...canonicalPumpReport(), unexpected: "synthetic" });
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    await activate(registry, entry);
    const controller = new ReportController(registry);
    await assert.rejects(
      controller.tick(entry, "agent:main:cron:job-example-1:run:tick-1"),
      /controller\.pump_report_invalid/u,
    );
    const internals = controller as unknown as { pending: Map<string, unknown> };
    assert.equal(internals.pending.size, 0);
  });

  it("authorizes one exact digest/session/job/destination/account candidate and rejects ambiguity", async () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    await activate(registry, entry);
    const controller = new ReportController(registry);
    const sessionKey = "agent:main:cron:job-example-1:run:tick-1";
    const adjusted = await preparePublication(controller, entry, sessionKey);
    assert.deepEqual(adjusted, { action: "send", channel: "discord",
      target: entry.destination.conversationId, accountId: entry.destination.accountId,
      message: f.message, final: false });
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
    await activate(registry, secondEntry);
    const copy = { ...internals.pending.values().next().value, leaseHash: secondEntry.leaseHash };
    internals.pending.set(secondEntry.leaseHash, copy);
    assert.equal(controller.authorizeSending(f.message, { sessionKey, channelId: "discord",
      accountId: entry.destination.accountId, conversationId: entry.destination.conversationId }), "ambiguous");
  });

  it("authorizes equal report digests independently after filtering exact scope", async () => {
    const first = fixture();
    const second = fixture();
    const registry = new LeaseRegistry(first.state);
    const firstEntry = register(registry, first);
    const secondEntry = register(registry, second, {
      leaseToken: "lease-token-example-00000002",
      ownerSessionKey: "agent:main:discord:example-owner-2",
      ownerRunId: "owner-run-example-2",
      processHandle: "process-example-2",
      jobId: "job-example-2",
      destination: { channel: "discord", accountId: "account-example-2", conversationId: "2" },
    });
    await activate(registry, firstEntry);
    await activate(registry, secondEntry);
    const controller = new ReportController(registry);
    const firstSession = "agent:main:cron:job-example-1:run:tick-1";
    const secondSession = "agent:main:cron:job-example-2:run:tick-1";
    await preparePublication(controller, firstEntry, firstSession);
    await preparePublication(controller, secondEntry, secondSession);
    assert.equal(controller.authorizeSending(first.message, {
      sessionKey: firstSession, channelId: "discord", accountId: "account-example",
      conversationId: "1",
    }), "authorized");
    assert.equal(controller.authorizeSending(second.message, {
      sessionKey: secondSession, channelId: "discord", accountId: "account-example-2",
      conversationId: "2",
    }), "authorized");
  });

  it("acknowledges with the exact pump report without reconstructing minute fields", async () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    await activate(registry, entry);
    const controller = new ReportController(registry);
    const sessionKey = "agent:main:cron:job-example-1:run:tick-1";
    await preparePublication(controller, entry, sessionKey);
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
    assert.strictEqual(ack.report,
      (globalThis as Record<string, unknown>).__acpControllerExactReport,
      "the production tick/send/ack path must retain the pump's exact structured report");
    assert.deepEqual(ack.report, {
      agent: "codex", model: "example-model-1", roundIndex: 1,
      repository: "example-repo", branch: "feat/example", timeKst: "14:20",
      phaseIndex: 2, totalMinutes: 20, phaseMinutes: 8, lastAcpActivityMinutesAgo: 2,
      newResultDelta: 1, newResult: "예시 결과 확인", executionState: "ACP 프롬프트 실행 중",
      inProgress: "정책 모듈 구현 3/5", verification: "아직 실행 전",
      next: "남은 게이트 2개 · 검증 실행",
    });
    assert.equal((ack.receipt as Record<string, unknown>).messageId, messageId);
    assert.equal((ack.receipt as Record<string, unknown>).deliveredAt, new Date(instant).toISOString());
  });

  it("keeps missing and uncertain delivery distinct, then retries after the attempt fence expires", async () => {
    const f = fixture();
    const registry = new LeaseRegistry(f.state);
    const entry = register(registry, f);
    await activate(registry, entry);
    const controller = new ReportController(registry);
    const sessionKey = "agent:main:cron:job-example-1:run:tick-1";
    await preparePublication(controller, entry, sessionKey);
    const context = { sessionKey, channelId: "discord", accountId: entry.destination.accountId,
      conversationId: entry.destination.conversationId };
    controller.authorizeSending(f.message, context);
    assert.equal(await controller.acknowledgeSent({ content: f.message, success: false }, context), "ignored");
    assert.deepEqual(await controller.tick(entry, sessionKey), { status: "delivery_missing" });
    const internals = controller as unknown as { pending: Map<string, { expiresAtMs: number }> };
    internals.pending.get(entry.leaseHash)!.expiresAtMs = 0;
    await preparePublication(controller, entry, sessionKey);
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
      await activate(registry, entry);
      (globalThis as Record<string, unknown>).__acpControllerPumpStatus = terminal;
      const result = await new ReportController(registry).tick(entry,
        "agent:main:cron:job-example-1:run:tick-1");
      assert.deepEqual(result, { status: terminal, cleanup: "remove_current_job_then_release_lease" });
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

  it("survives two lost registration responses and delayed shipped-template ticks before exact replay", async () => {
    const f = fixture();
    const logs: string[] = [];
    let policy: { evaluate: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown } | undefined;
    let toolFactory: ((ctx: Record<string, unknown>) => {
      execute: (id: string, params: unknown) => Promise<Record<string, unknown>> }) | undefined;
    const api = {
      id: "acp-lifecycle-guard", logger: { warn: (line: unknown) => logs.push(String(line)) },
      runtime: { state: { resolveStateDir: () => f.state } }, on: () => {},
      registerTool: (value: unknown) => { toolFactory = value as typeof toolFactory; },
      registerTrustedToolPolicy: (value: unknown) => { policy = value as typeof policy; },
    } as unknown as GuardHostApi;
    const surfaces = createControllerSurfaces(api);
    const owner = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:discord:example-owner", runId: "owner-run-example-1",
      requester: { senderIsOwner: true } };
    const registration = {
      action: "register", leaseToken: "lease-token-example-00000001", transportFile: f.transport,
      processHandle: "process-example-1", jobId: "job-example-1",
      destination: { channel: "discord", accountId: "account-example", conversationId: "1" },
      reportPumpEntry: f.pump, hostTransportEntry: f.host,
    };
    const invoke = async (id: string, params: Record<string, unknown>) => {
      policy!.evaluate({ toolName: "acp_report_controller", toolCallId: id, params }, owner);
      return toolFactory!(owner).execute(id, params);
    };

    const schedulerCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    let jobPresent = true;
    const cron = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:cron:job-example-1:run:tick-recovery" };
    let tickIndex = 0;
    const runAutomation = new AsyncFunction("acp_report_controller", "message", "automations",
      automationTemplate.payload.script
        .replace('"LEASE_TOKEN"', JSON.stringify(registration.leaseToken))
        .replace('"JOB_ID"', JSON.stringify(registration.jobId)));
    const delayedTick = async () => {
      const controller = async (params: unknown) => {
        const bounded = params as Record<string, unknown>;
        schedulerCalls.push({ tool: "acp_report_controller", params: structuredClone(bounded) });
        const id = `delayed-tick-${tickIndex += 1}`;
        policy!.evaluate({ toolName: "acp_report_controller", toolCallId: id, params: bounded }, cron);
        const response = await toolFactory!(cron).execute(id, bounded);
        return response.details;
      };
      const result = await runAutomation(
        controller,
        async (params: unknown) => {
          schedulerCalls.push({ tool: "message", params: structuredClone(params as Record<string, unknown>) });
          return { ok: true };
        },
        async (params: unknown) => {
          schedulerCalls.push({ tool: "automations", params: structuredClone(params as Record<string, unknown>) });
          jobPresent = false;
          return { removed: true };
        },
      );
      assert.deepEqual(result, {});
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
    };

    // Both successful responses are intentionally discarded to model the
    // consumer retaining registration_pending after byte-identical calls.
    await invoke("register-response-lost-first", registration);
    await delayedTick();
    await invoke("register-response-lost-second", structuredClone(registration));
    await delayedTick();
    await delayedTick();
    assert.deepEqual(schedulerCalls, [
      { tool: "acp_report_controller", params: {
        action: "tick", leaseToken: registration.leaseToken,
      } },
      { tool: "acp_report_controller", params: {
        action: "tick", leaseToken: registration.leaseToken,
      } },
      { tool: "acp_report_controller", params: {
        action: "tick", leaseToken: registration.leaseToken,
      } },
    ]);
    assert.equal(jobPresent, true);
    assert.equal(surfaces.registry.getByToken(registration.leaseToken)?.phase, "prepared");
    assert.equal(new LeaseRegistry(f.state).getByToken(registration.leaseToken)?.phase, "prepared");

    const recovered = await invoke("register-exact-replay", structuredClone(registration));
    assert.deepEqual(recovered.details, { status: "prepared" });
    const nonOwner = { ...owner, runId: "owner-run-example-2", requester: { senderIsOwner: false } };
    policy!.evaluate({ toolName: "acp_report_controller", toolCallId: "register-non-owner-replay",
      params: registration }, nonOwner);
    const denied = await toolFactory!(nonOwner).execute("register-non-owner-replay", registration);
    assert.equal((denied.details as Record<string, unknown>).code, ReasonCodes.ControllerCallerInvalid);
    const serialized = JSON.stringify(recovered);
    for (const privateValue of [registration.leaseToken, registration.transportFile,
      owner.sessionKey, owner.runId, registration.processHandle, registration.jobId]) {
      assert.equal(serialized.includes(String(privateValue)), false);
      assert.equal(logs.some((line) => line.includes(String(privateValue))), false);
    }
    const document = JSON.parse(fs.readFileSync(surfaces.registry.file, "utf8")) as { leases: unknown[] };
    assert.equal(document.leases.length, 1);
    assert.equal(surfaces.beforeAgentFinalize({ sessionId: "example", stopHookActive: false }, owner)?.action,
      "revise");

    assert.deepEqual((await invoke("commit-recovered", {
      action: "commit_activation", leaseToken: registration.leaseToken,
    })).details, { status: "active" });
    assert.deepEqual((globalThis as Record<string, unknown>).__acpControllerActivationInput,
      { transportFile: f.transport, processHandle: registration.processHandle });
    const entry = surfaces.registry.getByToken(registration.leaseToken)!;
    surfaces.registry.setCleanupState(entry, "terminal_acked");
    assert.deepEqual((await invoke("release-recovered", {
      action: "release", leaseToken: registration.leaseToken,
    })).details, { status: "released" });
    assert.equal(surfaces.beforeAgentFinalize({ sessionId: "example", stopHookActive: false }, owner), undefined);
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
    const entry = register(surfaces.registry, f);
    await activate(surfaces.registry, entry);
    const cronCtx = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:cron:job-example-1:run:tick-1" };
    policy!.evaluate({ toolName: "acp_report_controller", toolCallId: "tick-example",
      params: { action: "tick" } }, cronCtx);
    const tickResult = await toolFactory!(cronCtx).execute("tick-example", {
      action: "tick", leaseToken: "lease-token-example-00000001",
    });
    assert.equal((tickResult.details as Record<string, unknown>).status, "delivery_pending");
    assert.deepEqual(Object.keys(tickResult.details as Record<string, unknown>).sort(),
      ["publicationToken", "status"]);
    const serializedTick = JSON.stringify(tickResult);
    assert.equal(serializedTick.includes(f.message), false);
    assert.equal(serializedTick.includes(entry.destination.accountId), false);
    const publicationToken = String((tickResult.details as Record<string, unknown>).publicationToken);
    const injected = policy!.evaluate({ toolName: "message", params: {
      action: "send", message: publicationToken, final: false,
    } }, { ...cronCtx, toolName: "message" }) as { params?: Record<string, unknown> };
    assert.equal(injected.params?.message, f.message);
    assert.equal(injected.params?.target, entry.destination.conversationId);
    assert.deepEqual(policy!.evaluate({ toolName: "message", params: {
      action: "send", message: publicationToken, final: false,
    } }, { ...cronCtx, toolName: "message" }),
    { block: true, blockReason: ReasonCodes.ControllerScopeMismatch });
    assert.deepEqual(policy!.evaluate({ toolName: "message", params: {
      action: "send", message: f.message, final: false,
    } }, { ...cronCtx, toolName: "message" }),
    { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion });
    assert.equal(surfaces.messageSending({ to: entry.destination.conversationId,
      content: f.message }, { channelId: "discord", accountId: entry.destination.accountId,
      conversationId: entry.destination.conversationId, sessionKey: cronCtx.sessionKey }), undefined);
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
    assert.ok(logs.every((line) => !line.includes(f.message)));
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
    await activate(surfaces.registry, entry);
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
      cleanup: "remove_current_job_then_release_lease" });
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

  for (const cleanupState of ["terminal_acked", "tracking_lost"] as const) {
    it(`allows authenticated ${cleanupState} release after transport disappearance`, async () => {
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
      const entry = register(surfaces.registry, f);
      await activate(surfaces.registry, entry);
      surfaces.registry.setCleanupState(entry, cleanupState);
      fs.unlinkSync(f.transport);
      const owner = { toolName: "acp_report_controller", agentId: "main",
        sessionKey: "agent:main:discord:example-owner", runId: "owner-run-example-2",
        requester: { senderIsOwner: true } };
      policy!.evaluate({ toolName: "acp_report_controller", toolCallId: `release-${cleanupState}`,
        params: { action: "release" } }, owner);
      const released = await toolFactory!(owner).execute(`release-${cleanupState}`,
        { action: "release", leaseToken: "lease-token-example-00000001" });
      assert.deepEqual(released.details, { status: "released" });
      assert.equal(surfaces.registry.getByToken("lease-token-example-00000001"), undefined);
    });
  }

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
    const entry = register(surfaces.registry, f);
    await activate(surfaces.registry, entry);
    const owner = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:discord:example-owner", runId: "owner-run-example-1",
      requester: { senderIsOwner: true } };
    fs.unlinkSync(f.transport);
    policy!.evaluate({ toolName: "acp_report_controller", toolCallId: "active-release", params: {} }, owner);
    const result = await toolFactory!(owner).execute("active-release",
      { action: "release", leaseToken: "lease-token-example-00000001" });
    assert.equal((result.details as Record<string, unknown>).code, ReasonCodes.ControllerReleaseDenied);
    assert.ok(surfaces.registry.getByToken("lease-token-example-00000001"));
  });

  it("commits activation only from attested evidence and is retryable from a fresh same-session owner run", async () => {
    const f = fixture();
    let policy: { evaluate: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown } | undefined;
    let toolFactory: ((ctx: Record<string, unknown>) => { outputSchema?: unknown;
      execute: (id: string, params: unknown) => Promise<Record<string, unknown>> }) | undefined;
    const logs: string[] = [];
    const api = {
      id: "acp-lifecycle-guard", logger: { warn: (line: unknown) => logs.push(String(line)) },
      runtime: { state: { resolveStateDir: () => f.state } }, on: () => {},
      registerTool: (value: unknown) => { toolFactory = value as typeof toolFactory; },
      registerTrustedToolPolicy: (value: unknown) => { policy = value as typeof policy; },
    } as unknown as GuardHostApi;
    const surfaces = createControllerSurfaces(api);
    const originalOwner = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:discord:example-owner", runId: "owner-run-example-1",
      requester: { senderIsOwner: true } };
    const invoke = async (id: string, ctx: Record<string, unknown>, params: Record<string, unknown>) => {
      policy!.evaluate({ toolName: "acp_report_controller", toolCallId: id, params }, ctx);
      return toolFactory!(ctx).execute(id, params);
    };
    const registered = await invoke("register-prepared", originalOwner, {
      action: "register", leaseToken: "lease-token-example-00000001", transportFile: f.transport,
      processHandle: "process-example-1", jobId: "job-example-1",
      destination: { channel: "discord", accountId: "account-example", conversationId: "1" },
      reportPumpEntry: f.pump, hostTransportEntry: f.host,
    });
    assert.deepEqual(registered.details, { status: "prepared" });
    assert.ok(toolFactory!(originalOwner).outputSchema);
    assert.deepEqual(policy!.evaluate({ toolName: "sessions_yield", params: {} }, originalOwner),
      { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion });
    assert.deepEqual(policy!.evaluate({ toolName: "message", params: { final: true } }, originalOwner),
      { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion });
    const widened = await invoke("commit-widened", originalOwner, {
      action: "commit_activation", leaseToken: "lease-token-example-00000001", activated: true,
    });
    assert.equal((widened.details as Record<string, unknown>).code, ReasonCodes.ControllerInputInvalid);
    assert.equal(surfaces.registry.getByToken("lease-token-example-00000001")?.phase, "prepared");

    (globalThis as Record<string, unknown>).__acpControllerActivation = "throw";
    const unproven = await invoke("commit-unproven", originalOwner, {
      action: "commit_activation", leaseToken: "lease-token-example-00000001",
    });
    assert.equal((unproven.details as Record<string, unknown>).code,
      "acp_lifecycle_guard.controller.activation_not_confirmed");
    assert.equal(surfaces.registry.getByToken("lease-token-example-00000001")?.phase, "prepared");
    (globalThis as Record<string, unknown>).__acpControllerActivation = "mismatch";
    const drifted = await invoke("commit-drifted", originalOwner, {
      action: "commit_activation", leaseToken: "lease-token-example-00000001",
    });
    assert.equal((drifted.details as Record<string, unknown>).code,
      "acp_lifecycle_guard.controller.activation_evidence_invalid");

    const wrongSession = await invoke("commit-wrong-session", { ...originalOwner,
      sessionKey: "agent:main:discord:example-other", runId: "owner-run-example-2" }, {
      action: "commit_activation", leaseToken: "lease-token-example-00000001",
    });
    assert.equal((wrongSession.details as Record<string, unknown>).code, ReasonCodes.ControllerCallerInvalid);
    (globalThis as Record<string, unknown>).__acpControllerActivation = "confirmed";
    const persistInternals = surfaces.registry as unknown as { persist: () => void };
    const realPersist = persistInternals.persist.bind(surfaces.registry);
    persistInternals.persist = () => { throw new Error("synthetic persistence failure"); };
    const unpersisted = await invoke("commit-unpersisted", originalOwner, {
      action: "commit_activation", leaseToken: "lease-token-example-00000001",
    });
    persistInternals.persist = realPersist;
    assert.equal((unpersisted.details as Record<string, unknown>).code,
      "acp_lifecycle_guard.controller.failed");
    assert.equal(surfaces.registry.getByToken("lease-token-example-00000001")?.phase, "prepared");
    assert.equal(new LeaseRegistry(f.state).getByToken("lease-token-example-00000001")?.phase, "prepared");
    const freshOwner = { ...originalOwner, runId: "owner-run-example-2" };
    const committed = await invoke("commit-retry", freshOwner, {
      action: "commit_activation", leaseToken: "lease-token-example-00000001",
    });
    assert.deepEqual(committed.details, { status: "active" });
    assert.deepEqual((globalThis as Record<string, unknown>).__acpControllerActivationInput,
      { transportFile: f.transport, processHandle: "process-example-1" });
    assert.equal(surfaces.registry.getByToken("lease-token-example-00000001")?.phase, "active");
    const idempotent = await invoke("commit-idempotent", freshOwner, {
      action: "commit_activation", leaseToken: "lease-token-example-00000001",
    });
    assert.deepEqual(idempotent.details, { status: "active" });
    const abortActive = await invoke("abort-active", freshOwner, {
      action: "abort_preactivation", leaseToken: "lease-token-example-00000001",
    });
    assert.equal((abortActive.details as Record<string, unknown>).code,
      ReasonCodes.ControllerPreactivationAbortDenied);
    assert.ok(logs.every((line) => !line.includes("example-owner") && !line.includes("lease-token")));
  });

  it("aborts only a prepared transport with authoritative no-mutation evidence", async () => {
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
    const entry = register(surfaces.registry, f);
    const owner = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:discord:example-owner", runId: "owner-run-example-2",
      requester: { senderIsOwner: true } };
    const invokeAbort = async (id: string, ctx: Record<string, unknown> = owner) => {
      policy!.evaluate({ toolName: "acp_report_controller", toolCallId: id,
        params: { action: "abort_preactivation" } }, ctx);
      return toolFactory!(ctx).execute(id, {
        action: "abort_preactivation", leaseToken: "lease-token-example-00000001",
      });
    };
    const crossAgent = await invokeAbort("abort-cross-agent", { ...owner, agentId: "helper" });
    assert.equal((crossAgent.details as Record<string, unknown>).code,
      ReasonCodes.ControllerPreactivationAbortDenied);
    for (const evidence of ["activation_confirmed", "started", "activity", "terminal_intent", "uncertain"]) {
      (globalThis as Record<string, unknown>).__acpControllerAbort = evidence;
      const denied = await invokeAbort(`abort-after-${evidence}`);
      assert.equal((denied.details as Record<string, unknown>).code,
        ReasonCodes.ControllerPreactivationAbortDenied);
      assert.equal(entry.phase, "prepared");
    }
    (globalThis as Record<string, unknown>).__acpControllerAbort = "preactivation_exit";
    const exactCron = { toolName: "acp_report_controller", agentId: "main",
      sessionKey: "agent:main:cron:job-example-1:run:tick-recovery" };
    const aborted = await invokeAbort("abort-safe", exactCron);
    assert.deepEqual(aborted.details, { status: "aborted" });
    assert.deepEqual((globalThis as Record<string, unknown>).__acpControllerAbortInput,
      { transportFile: f.transport, processHandle: "process-example-1" });
    assert.equal(surfaces.registry.getByToken("lease-token-example-00000001"), undefined);
  });
});


describe("host-proven controller owner-run admission", () => {
  it("bridges the direct-owner run into tool hooks and recovers an exact registration from a fresh run", async () => {
    const f = fixture();
    let policy: { evaluate: (event: BeforeToolCallEvent, ctx: ToolHookContext) => BeforeToolCallResult | void } |
      undefined;
    let toolFactory: ((ctx: PluginToolContext) => {
      execute: (id: string, params: unknown) => Promise<Record<string, unknown>> }) | undefined;
    const api = {
      id: "acp-lifecycle-guard",
      logger: {},
      runtime: { state: { resolveStateDir: () => f.state } },
      on: () => {},
      registerTool: (value: unknown) => { toolFactory = value as typeof toolFactory; },
      registerTrustedToolPolicy: (value: unknown) => { policy = value as typeof policy; },
    } as unknown as GuardHostApi;
    const surfaces = createControllerSurfaces(api);
    const sessionKey = "agent:main:discord:example-owner";
    const registration = {
      action: "register",
      leaseToken: "lease-token-example-00000001",
      transportFile: f.transport,
      processHandle: "process-example-1",
      jobId: "job-example-1",
      destination: { channel: "discord", accountId: "account-example", conversationId: "1" },
      reportPumpEntry: f.pump,
      hostTransportEntry: f.host,
    };
    const invoke = async (id: string, runId: string, params: Record<string, unknown>,
      senderIsOwner?: boolean) => {
      const context: ToolHookContext = {
        toolName: "acp_report_controller",
        toolCallId: id,
        agentId: "main",
        sessionKey,
        runId,
        ...(senderIsOwner === undefined ? {} : { requester: { senderIsOwner } }),
      };
      policy!.evaluate({ toolName: "acp_report_controller", toolCallId: id, params }, context);
      return toolFactory!({ agentId: "main", sessionKey }).execute(id, params);
    };

    surfaces.beforeAgentRun(
      { prompt: "owner request", messages: [], senderIsOwner: true },
      { agentId: "main", sessionKey, runId: "owner-run-example-1" },
    );
    assert.deepEqual((await invoke("explicit-non-owner", "owner-run-example-1", registration, false)).details,
      { status: "error", code: ReasonCodes.ControllerCallerInvalid });
    assert.deepEqual((await invoke("register-1", "owner-run-example-1", registration)).details,
      { status: "prepared" });

    assert.deepEqual((await invoke("unadmitted-run", "owner-run-example-untrusted", registration)).details,
      { status: "error", code: ReasonCodes.ControllerCallerInvalid });

    surfaces.beforeAgentRun(
      { prompt: "fresh owner recovery", messages: [], senderIsOwner: true },
      { agentId: "main", sessionKey, runId: "owner-run-example-2" },
    );
    assert.deepEqual((await invoke("register-fresh-run", "owner-run-example-2", registration)).details,
      { status: "prepared" });
    assert.equal(surfaces.registry.getByToken(registration.leaseToken)?.ownerRunId,
      "owner-run-example-2", "recovery must transfer the lifecycle fence to the fresh owner run");
    assert.equal(surfaces.beforeAgentFinalize({ sessionId: "example", stopHookActive: false }, {
      agentId: "main", sessionKey, runId: "owner-run-example-2",
    })?.action, "revise");
    const yieldDecision = policy!.evaluate({
      toolName: "sessions_yield", toolCallId: "fresh-owner-yield", params: {},
    }, {
      toolName: "sessions_yield", toolCallId: "fresh-owner-yield", agentId: "main",
      sessionKey, runId: "owner-run-example-2",
    });
    assert.deepEqual(yieldDecision,
      { block: true, blockReason: ReasonCodes.LeaseEarlyCompletion });

    surfaces.agentEnd(
      { runId: "owner-run-example-2", messages: [], success: true },
      { agentId: "main", sessionKey, runId: "owner-run-example-2" },
    );
    assert.deepEqual((await invoke("revoked-run", "owner-run-example-2", {
      action: "status", leaseToken: registration.leaseToken,
    })).details, { status: "error", code: ReasonCodes.ControllerCallerInvalid });
  });
});
