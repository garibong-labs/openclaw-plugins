import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONTROLLER_SCHEMA_VERSION = "acp-report-controller.v1";
export const CONTROLLER_TOOL_NAME = "acp_report_controller";
export const MAX_ACTIVE_LEASES = 64;

const SAFE_OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/u;
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_JOB = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DECIMAL_ID = /^[0-9]{1,30}$/u;
const SAFE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAIN_SESSION = /^agent:main:[^\s\u0000-\u001f]{1,480}$/u;

export type LeaseDestination = {
  channel: "discord";
  accountId: string;
  conversationId: string;
};

export type FileAttestation = {
  path: string;
  device: number;
  inode: number;
  size: number;
  modifiedMs: number;
  sha256: string;
};

export type ActiveLease = {
  leaseHash: string;
  ownerAgentId: "main";
  ownerSessionKey: string;
  ownerRunId: string;
  transportFile: FileAttestation;
  processHandle: string;
  jobId: string;
  destination: LeaseDestination;
  reportPumpEntry: FileAttestation;
  hostTransportEntry: FileAttestation;
  snapshotFile?: FileAttestation;
  registeredAt: string;
  cleanupState: "active" | "terminal_acked" | "tracking_lost";
};

type RegistryDocument = {
  schemaVersion: typeof CONTROLLER_SCHEMA_VERSION;
  leases: ActiveLease[];
};

export type RegisterLeaseInput = {
  leaseToken: string;
  ownerSessionKey: string;
  ownerRunId: string;
  transportFile: string;
  processHandle: string;
  jobId: string;
  destination: LeaseDestination;
  reportPumpEntry: string;
  hostTransportEntry: string;
  snapshotFile?: string;
};

function fail(code: string): never {
  const error = new Error(code);
  error.name = "AcpReportControllerError";
  throw error;
}

export function safeControllerCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  return /^acp_lifecycle_guard\.controller\.[a-z0-9_.-]{1,96}$/u.test(value)
    ? value
    : "acp_lifecycle_guard.controller.failed";
}

export function leaseHash(token: unknown): string {
  if (typeof token !== "string" || !SAFE_OPAQUE.test(token)) {
    fail("acp_lifecycle_guard.controller.token_invalid");
  }
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function assertOwnedRegularFile(
  candidate: string,
  options: { privateFile: boolean; basename?: string },
): FileAttestation {
  if (!path.isAbsolute(candidate) || candidate.length > 4096 || candidate.includes("\0")) {
    fail("acp_lifecycle_guard.controller.path_invalid");
  }
  let stat: fs.Stats;
  let real: string;
  try {
    stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("acp_lifecycle_guard.controller.path_unsafe");
    real = fs.realpathSync(candidate);
  } catch (error) {
    if (error instanceof Error && error.name === "AcpReportControllerError") throw error;
    fail("acp_lifecycle_guard.controller.path_unavailable");
  }
  if (real !== path.resolve(candidate) || stat.uid !== process.getuid?.()) {
    fail("acp_lifecycle_guard.controller.path_unsafe");
  }
  if ((stat.mode & 0o022) !== 0 || (options.privateFile && (stat.mode & 0o077) !== 0)) {
    fail("acp_lifecycle_guard.controller.permissions_invalid");
  }
  if (options.basename !== undefined && path.basename(real) !== options.basename) {
    fail("acp_lifecycle_guard.controller.trust_entry_invalid");
  }
  if (stat.size > 4194304) fail("acp_lifecycle_guard.controller.file_too_large");
  return {
    path: real,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(real)).digest("hex"),
  };
}

function sameAttestation(left: FileAttestation, right: FileAttestation): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode &&
    left.size === right.size && left.modifiedMs === right.modifiedMs && left.sha256 === right.sha256;
}

function validateDestination(value: LeaseDestination): LeaseDestination {
  if (value?.channel !== "discord" || !SAFE_ACCOUNT.test(value.accountId) ||
      !DECIMAL_ID.test(value.conversationId)) {
    fail("acp_lifecycle_guard.controller.destination_invalid");
  }
  return { ...value };
}

function validateAttestation(
  value: FileAttestation,
  privateFile: boolean,
  basename?: string,
  requireStable = true,
): void {
  if (!value || typeof value !== "object" || typeof value.path !== "string" ||
      !Number.isSafeInteger(value.device) || value.device < 0 ||
      !Number.isSafeInteger(value.inode) || value.inode < 0 ||
      !Number.isSafeInteger(value.size) || value.size < 0 ||
      !Number.isFinite(value.modifiedMs) || !SHA256.test(value.sha256)) {
    fail("acp_lifecycle_guard.controller.registry_invalid");
  }
  const current = assertOwnedRegularFile(value.path, {
    privateFile, ...(basename === undefined ? {} : { basename }),
  });
  if (requireStable && !sameAttestation(value, current)) {
    fail("acp_lifecycle_guard.controller.trust_changed");
  }
}

function validateEntry(entry: ActiveLease): ActiveLease {
  if (!SHA256.test(entry.leaseHash) || entry.ownerAgentId !== "main" ||
      !MAIN_SESSION.test(entry.ownerSessionKey) || !SAFE_HANDLE.test(entry.ownerRunId) ||
      !SAFE_HANDLE.test(entry.processHandle) || !SAFE_JOB.test(entry.jobId) ||
      !["active", "terminal_acked", "tracking_lost"].includes(entry.cleanupState) ||
      !Number.isFinite(Date.parse(entry.registeredAt))) {
    fail("acp_lifecycle_guard.controller.registry_invalid");
  }
  validateDestination(entry.destination);
  // The transport record is mutable and the skills transport replaces it
  // atomically. Its exact absolute path and private-file boundary remain
  // fixed, while inode, size, timestamp, and digest are expected to evolve.
  validateAttestation(entry.transportFile, true, undefined, false);
  validateAttestation(entry.reportPumpEntry, false, "acp-report-pump.mjs");
  validateAttestation(entry.hostTransportEntry, false, "acp-host-transport.mjs");
  if (entry.snapshotFile !== undefined) validateAttestation(entry.snapshotFile, true);
  if (path.dirname(entry.reportPumpEntry.path) !== path.dirname(entry.hostTransportEntry.path)) {
    fail("acp_lifecycle_guard.controller.registry_invalid");
  }
  return entry;
}

export class LeaseRegistry {
  readonly directory: string;
  readonly file: string;
  private entries = new Map<string, ActiveLease>();

  constructor(stateDir: string) {
    this.directory = path.join(stateDir, "plugins", "acp-lifecycle-guard");
    this.file = path.join(this.directory, "active-leases.json");
    this.load();
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0) {
      fail("acp_lifecycle_guard.controller.registry_permissions");
    }
  }

  private load(): void {
    this.ensureDirectory();
    if (!fs.existsSync(this.file)) return;
    const stat = fs.lstatSync(this.file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 || stat.size > 262144) {
      fail("acp_lifecycle_guard.controller.registry_permissions");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      fail("acp_lifecycle_guard.controller.registry_invalid");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        (parsed as RegistryDocument).schemaVersion !== CONTROLLER_SCHEMA_VERSION ||
        !Array.isArray((parsed as RegistryDocument).leases) ||
        (parsed as RegistryDocument).leases.length > MAX_ACTIVE_LEASES) {
      fail("acp_lifecycle_guard.controller.registry_invalid");
    }
    for (const raw of (parsed as RegistryDocument).leases) {
      const entry = validateEntry(raw);
      if (this.entries.has(entry.leaseHash)) fail("acp_lifecycle_guard.controller.registry_invalid");
      this.entries.set(entry.leaseHash, entry);
    }
  }

  private persist(): void {
    this.ensureDirectory();
    const temporary = path.join(this.directory, `.active-leases.${process.pid}.${crypto.randomUUID()}.tmp`);
    const document: RegistryDocument = {
      schemaVersion: CONTROLLER_SCHEMA_VERSION,
      leases: [...this.entries.values()],
    };
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(document)}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
      const dirFd = fs.openSync(this.directory, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* rename already consumed it */ }
    }
  }

  register(input: RegisterLeaseInput): ActiveLease {
    const hash = leaseHash(input.leaseToken);
    if (!MAIN_SESSION.test(input.ownerSessionKey) || !SAFE_HANDLE.test(input.ownerRunId) ||
        !SAFE_HANDLE.test(input.processHandle) || !SAFE_JOB.test(input.jobId)) {
      fail("acp_lifecycle_guard.controller.identity_invalid");
    }
    if (this.entries.size >= MAX_ACTIVE_LEASES) fail("acp_lifecycle_guard.controller.registry_full");
    const transportFile = assertOwnedRegularFile(input.transportFile, { privateFile: true });
    const reportPumpEntry = assertOwnedRegularFile(input.reportPumpEntry, {
      privateFile: false, basename: "acp-report-pump.mjs",
    });
    const hostTransportEntry = assertOwnedRegularFile(input.hostTransportEntry, {
      privateFile: false, basename: "acp-host-transport.mjs",
    });
    if (path.dirname(reportPumpEntry.path) !== path.dirname(hostTransportEntry.path)) {
      fail("acp_lifecycle_guard.controller.trust_scope_mismatch");
    }
    const snapshotFile = input.snapshotFile === undefined ? undefined :
      assertOwnedRegularFile(input.snapshotFile, { privateFile: true });
    if (this.entries.has(hash) || [...this.entries.values()].some((entry) =>
      entry.jobId === input.jobId || entry.transportFile.path === transportFile.path ||
      (entry.ownerSessionKey === input.ownerSessionKey && entry.ownerRunId === input.ownerRunId))) {
      fail("acp_lifecycle_guard.controller.duplicate");
    }
    const entry: ActiveLease = {
      leaseHash: hash,
      ownerAgentId: "main",
      ownerSessionKey: input.ownerSessionKey,
      ownerRunId: input.ownerRunId,
      transportFile,
      processHandle: input.processHandle,
      jobId: input.jobId,
      destination: validateDestination(input.destination),
      reportPumpEntry,
      hostTransportEntry,
      ...(snapshotFile === undefined ? {} : { snapshotFile }),
      registeredAt: new Date().toISOString(),
      cleanupState: "active",
    };
    this.entries.set(hash, entry);
    try { this.persist(); } catch (error) { this.entries.delete(hash); throw error; }
    return entry;
  }

  getByToken(token: unknown): ActiveLease | undefined {
    return this.entries.get(leaseHash(token));
  }

  getByHash(hash: string): ActiveLease | undefined {
    return this.entries.get(hash);
  }

  activeForOwner(sessionKey: string | undefined, runId: string | undefined): ActiveLease[] {
    if (!sessionKey || !runId) return [];
    return [...this.entries.values()].filter((entry) =>
      entry.ownerSessionKey === sessionKey && entry.ownerRunId === runId);
  }

  setCleanupState(entry: ActiveLease, state: ActiveLease["cleanupState"]): void {
    entry.cleanupState = state;
    this.persist();
  }

  release(entry: ActiveLease): void {
    this.entries.delete(entry.leaseHash);
    try { this.persist(); } catch (error) { this.entries.set(entry.leaseHash, entry); throw error; }
  }

  revalidate(entry: ActiveLease): void {
    const mutableTransport = assertOwnedRegularFile(entry.transportFile.path, { privateFile: true });
    if (mutableTransport.path !== entry.transportFile.path) {
      fail("acp_lifecycle_guard.controller.trust_changed");
    }
    const checks: Array<[FileAttestation, { privateFile: boolean; basename?: string }]> = [
      [entry.reportPumpEntry, { privateFile: false, basename: "acp-report-pump.mjs" }],
      [entry.hostTransportEntry, { privateFile: false, basename: "acp-host-transport.mjs" }],
    ];
    if (entry.snapshotFile !== undefined) checks.push([entry.snapshotFile, { privateFile: true }]);
    for (const [expected, options] of checks) {
      if (!sameAttestation(expected, assertOwnedRegularFile(expected.path, options))) {
        fail("acp_lifecycle_guard.controller.trust_changed");
      }
    }
  }
}

type PendingDelivery = {
  leaseHash: string;
  cronSessionKey: string;
  messageDigest: string;
  report: Record<string, unknown>;
  reportId: string;
  reportKind: "intermediate" | "terminal";
  cadence: number;
  attemptId: string;
  fence: number;
  authorized: boolean;
  expiresAtMs: number;
  outcome: "delivery_missing" | "delivery_uncertain";
};

export type ControllerTickResult =
  | { status: "none_due" }
  | { status: "delivery_pending"; message: string; destination: LeaseDestination }
  | { status: "terminal_acked" | "tracking_lost"; cleanup: "remove_current_job_then_release_lease"; jobId: string }
  | { status: "delivery_missing" | "delivery_uncertain" };

function exactCronJob(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const match = /^(?:agent:main:)?cron:([^:]+)(?::run:[^:]+)?$/u.exec(sessionKey);
  return match?.[1];
}

function parseCanonicalReport(message: string): Record<string, unknown> {
  const lines = message.split("\n");
  const identity = /^(?:\uD83E\uDD16) \*\*ACP\*\*: (Claude Code|Codex) · `([^`]+)`$/u.exec(lines[2] ?? "");
  const target = /^\uD83D\uDCCD \*\*작업\*\*: `([^`]+)` · `([^`]+)`$/u.exec(lines[3] ?? "");
  const titleTime = / · ([0-2][0-9]:[0-5][0-9]) KST\*\*$/u.exec(lines[0] ?? "");
  if (!identity || !target || !titleTime) fail("acp_lifecycle_guard.controller.report_parse_failed");
  const base = {
    agent: identity[1] === "Codex" ? "codex" : "claude",
    model: identity[2], repository: target[1], branch: target[2], timeKst: titleTime[1],
  };
  if ((lines[0] ?? "").startsWith("🔄")) {
    const round = /^\uD83D\uDD22 \*\*라운드\*\*: ([1-9][0-9]*) · ([1-4])\/4 /u.exec(lines[4] ?? "");
    const elapsed = /^\u23F1\uFE0F? \*\*ACP 시간\*\*: 전체 ([0-9]+)분 · 현재 단계 ([0-9]+)분 · 마지막 ACP 활동 ([0-9]+)분 전$/u.exec(lines[5] ?? "");
    const delta = /^- Δ([0-9]+)(?: · (.*))$/u.exec(lines[9] ?? "");
    if (!round || !elapsed || !delta) fail("acp_lifecycle_guard.controller.report_parse_failed");
    return { ...base, roundIndex: Number(round[1]), phaseIndex: Number(round[2]),
      totalMinutes: Number(elapsed[1]), phaseMinutes: Number(elapsed[2]),
      lastAcpActivityMinutesAgo: Number(elapsed[3]), newResultDelta: Number(delta[1]),
      ...(Number(delta[1]) > 0 ? { newResult: delta[2] } : {}),
      executionState: (lines[6] ?? "").replace(/^\uD83D\uDD01 \*\*실행 상태\*\*: /u, ""),
      inProgress: (lines[12] ?? "").slice(2), verification: (lines[15] ?? "").slice(2),
      next: (lines[18] ?? "").slice(2), ...(lines.length === 22 ? { issue: (lines[21] ?? "").slice(2) } : {}) };
  }
  const duration = /^\u23F1\uFE0F? \*\*ACP 소요\*\*: (.+) · 라운드 ([1-9][0-9]*)$/u.exec(lines[4] ?? "");
  const status = (lines[0] ?? "").startsWith("🏁") ? "completed" :
    (lines[0] ?? "").startsWith("⛔") ? "cancelled" : "failed";
  if (!duration || lines.length !== 20) fail("acp_lifecycle_guard.controller.report_parse_failed");
  return { ...base, roundIndex: Number(duration[2]), elapsed: duration[1], status,
    summary: (lines[7] ?? "").slice(2), verification: (lines[10] ?? "").slice(2),
    result: (lines[13] ?? "").slice(2), next: (lines[16] ?? "").slice(2),
    externalAction: (lines[19] ?? "").slice(2) };
}

export class ReportController {
  private pending = new Map<string, PendingDelivery>();
  readonly registry: LeaseRegistry;
  constructor(registry: LeaseRegistry) {
    this.registry = registry;
  }

  callerMatchesCron(entry: ActiveLease, agentId: string | undefined, sessionKey: string | undefined): boolean {
    return agentId === "main" && exactCronJob(sessionKey) === entry.jobId;
  }

  async tick(entry: ActiveLease, sessionKey: string): Promise<ControllerTickResult> {
    this.registry.revalidate(entry);
    if (entry.cleanupState !== "active") {
      return { status: entry.cleanupState, cleanup: "remove_current_job_then_release_lease", jobId: entry.jobId };
    }
    const existing = this.pending.get(entry.leaseHash);
    if (existing !== undefined && Date.now() < existing.expiresAtMs) {
      return { status: existing.outcome };
    }
    if (existing !== undefined) this.pending.delete(entry.leaseHash);
    const transport = await import(`${pathToFileURL(entry.hostTransportEntry.path).href}?attested=${entry.hostTransportEntry.modifiedMs}`) as {
      REPORT_ATTEMPT_TTL_MS?: unknown;
    };
    if (!Number.isSafeInteger(transport.REPORT_ATTEMPT_TTL_MS) ||
        (transport.REPORT_ATTEMPT_TTL_MS as number) < 1000 ||
        (transport.REPORT_ATTEMPT_TTL_MS as number) > 3600000) {
      fail("acp_lifecycle_guard.controller.trust_entry_invalid");
    }
    const claimedAtMs = Date.now();
    const pump = await import(`${pathToFileURL(entry.reportPumpEntry.path).href}?attested=${entry.reportPumpEntry.modifiedMs}`) as {
      runReportPump(input: Record<string, unknown>): Record<string, unknown>;
    };
    const result = pump.runReportPump({
      schemaVersion: "acp-report-pump.v1", transportFile: entry.transportFile.path,
      processHandle: entry.processHandle, jobId: entry.jobId,
      destination: entry.destination.conversationId,
      ...(entry.snapshotFile === undefined ? {} : { snapshotFile: entry.snapshotFile.path }),
      runToken: `controller-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    });
    const status = result.status;
    if (status === "terminal_acked" || status === "tracking_lost") {
      this.registry.setCleanupState(entry, status);
      return { status, cleanup: "remove_current_job_then_release_lease", jobId: entry.jobId };
    }
    if (status === "none_due") return { status };
    if (status !== "delivery_pending" || typeof result.message !== "string" ||
        typeof result.messageDigest !== "string" || !SHA256.test(result.messageDigest) ||
        crypto.createHash("sha256").update(result.message, "utf8").digest("hex") !== result.messageDigest ||
        typeof result.reportId !== "string" || typeof result.attemptId !== "string" ||
        !Number.isSafeInteger(result.fence) || !Number.isSafeInteger(result.cadence) ||
        (result.reportKind !== "intermediate" && result.reportKind !== "terminal")) {
      fail("acp_lifecycle_guard.controller.pump_result_invalid");
    }
    this.pending.set(entry.leaseHash, {
      leaseHash: entry.leaseHash, cronSessionKey: sessionKey,
      messageDigest: result.messageDigest, report: parseCanonicalReport(result.message),
      reportId: result.reportId, reportKind: result.reportKind,
      cadence: result.cadence as number, attemptId: result.attemptId,
      fence: result.fence as number, authorized: false,
      expiresAtMs: claimedAtMs + (transport.REPORT_ATTEMPT_TTL_MS as number),
      outcome: "delivery_uncertain",
    });
    return { status: "delivery_pending", message: result.message, destination: { ...entry.destination } };
  }

  authorizeSending(content: string, context: { sessionKey?: string; channelId: string; accountId?: string; conversationId?: string }):
    "unrelated" | "authorized" | "ambiguous" | "scope_mismatch" {
    const digest = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    const candidates = [...this.pending.values()].filter((candidate) => candidate.messageDigest === digest);
    if (candidates.length === 0) return "unrelated";
    if (candidates.length !== 1) return "ambiguous";
    const matches = candidates.filter((candidate) => {
      const entry = this.registry.getByHash(candidate.leaseHash);
      return entry !== undefined && candidate.cronSessionKey === context.sessionKey &&
        entry.destination.channel === context.channelId && entry.destination.accountId === context.accountId &&
        entry.destination.conversationId === context.conversationId;
    });
    if (matches.length !== 1) return "scope_mismatch";
    matches[0]!.authorized = true;
    return "authorized";
  }

  async acknowledgeSent(event: { content: string; success: boolean; messageId?: string },
    context: { sessionKey?: string; channelId: string; accountId?: string; conversationId?: string }): Promise<"unrelated" | "ignored" | "acked" | "failed"> {
    const digest = crypto.createHash("sha256").update(event.content, "utf8").digest("hex");
    const candidates = [...this.pending.values()].filter((candidate) => candidate.messageDigest === digest && candidate.authorized);
    if (candidates.length !== 1) return candidates.length === 0 ? "unrelated" : "ignored";
    const pending = candidates[0]!;
    const entry = this.registry.getByHash(pending.leaseHash);
    if (!entry || pending.cronSessionKey !== context.sessionKey || entry.destination.channel !== context.channelId ||
        entry.destination.accountId !== context.accountId || entry.destination.conversationId !== context.conversationId) {
      return "ignored";
    }
    if (!event.success) {
      pending.outcome = event.messageId === undefined ? "delivery_missing" : "delivery_uncertain";
      return "ignored";
    }
    if (!event.messageId || !DECIMAL_ID.test(event.messageId)) {
      pending.outcome = "delivery_uncertain";
      return "ignored";
    }
    const deliveredAt = discordSnowflakeInstant(event.messageId);
    if (deliveredAt === undefined) return "ignored";
    try {
      this.registry.revalidate(entry);
      const transport = await import(`${pathToFileURL(entry.hostTransportEntry.path).href}?attested=${entry.hostTransportEntry.modifiedMs}`) as {
        acknowledgeHostTransportReport(input: Record<string, unknown>): unknown;
      };
      transport.acknowledgeHostTransportReport({ transportFile: entry.transportFile.path,
        processHandle: entry.processHandle, reportId: pending.reportId, reportKind: pending.reportKind,
        cadence: pending.cadence, attemptId: pending.attemptId, fence: pending.fence,
        report: pending.report, receipt: { conversationId: entry.destination.conversationId,
          messageId: event.messageId, deliveredAt, deliveryStatus: "delivered", messageDigest: digest } });
      this.pending.delete(entry.leaseHash);
      return "acked";
    } catch {
      return "failed";
    }
  }
}

export function discordSnowflakeInstant(messageId: string): string | undefined {
  if (!DECIMAL_ID.test(messageId)) return undefined;
  try {
    const milliseconds = Number((BigInt(messageId) >> 22n) + 1420070400000n);
    if (!Number.isSafeInteger(milliseconds)) return undefined;
    const value = new Date(milliseconds);
    return Number.isNaN(value.valueOf()) ? undefined : value.toISOString();
  } catch { return undefined; }
}
