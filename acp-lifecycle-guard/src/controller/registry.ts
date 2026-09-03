import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONTROLLER_SCHEMA_VERSION = "acp-report-controller.v2";
const LEGACY_CONTROLLER_SCHEMA_VERSION = "acp-report-controller.v1";
export const CONTROLLER_TOOL_NAME = "acp_report_controller";
export const MAX_ACTIVE_LEASES = 64;
export const MAX_PREPARED_LEASES_PER_OWNER = 4;

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

export type ControllerLease = {
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
  phase: "prepared" | "active";
  cleanupState: null | "terminal_acked" | "tracking_lost";
};

/** @deprecated Kept as a source-compatible alias for controller consumers. */
export type ActiveLease = ControllerLease;

type RegistryDocument = {
  schemaVersion: typeof CONTROLLER_SCHEMA_VERSION | typeof LEGACY_CONTROLLER_SCHEMA_VERSION;
  leases: unknown[];
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

/**
 * Every ownership, symlink, permission, basename, and size check for one
 * attested path, without reading its contents.
 *
 * `assertOwnedRegularFile` layers the content digest on top. Callers that only
 * need the *identity* of a deliberately mutable file (the transport record)
 * use this directly, so a 4 MiB read plus SHA-256 is not paid again on every
 * tick and every `message_sent`.
 */
export function assertPosixControllerPlatform(
  getuid: NodeJS.Process["getuid"] | undefined,
): void {
  if (typeof getuid !== "function") {
    fail("acp_lifecycle_guard.controller.posix_required");
  }
}

function statOwnedRegularFile(
  candidate: string,
  options: { privateFile: boolean; basename?: string },
): { real: string; stat: fs.Stats } {
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
  assertPosixControllerPlatform(process.getuid);
  if (real !== path.resolve(candidate) || stat.uid !== process.getuid!()) {
    fail("acp_lifecycle_guard.controller.path_unsafe");
  }
  if ((stat.mode & 0o022) !== 0 || (options.privateFile && (stat.mode & 0o077) !== 0)) {
    fail("acp_lifecycle_guard.controller.permissions_invalid");
  }
  if (options.basename !== undefined && path.basename(real) !== options.basename) {
    fail("acp_lifecycle_guard.controller.trust_entry_invalid");
  }
  if (stat.size > 4194304) fail("acp_lifecycle_guard.controller.file_too_large");
  return { real, stat };
}

function assertOwnedRegularFile(
  candidate: string,
  options: { privateFile: boolean; basename?: string },
): FileAttestation {
  const { real, stat } = statOwnedRegularFile(candidate, options);
  return {
    path: real,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(real)).digest("hex"),
  };
}

/**
 * Import an attested skills entry.
 *
 * The cache-busting key must be the *content digest* on every call site: the
 * ES module registry keys on the full URL, so mixing digests and timestamps
 * would instantiate the same trusted module twice in one process and split any
 * state it keeps between activation and acknowledgement.
 */
function importAttested(entry: FileAttestation): Promise<Record<string, unknown>> {
  return import(`${pathToFileURL(entry.path).href}?attested=${entry.sha256}`) as
    Promise<Record<string, unknown>>;
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

function validateAttestationShape(
  value: FileAttestation,
): void {
  if (!value || typeof value !== "object" || typeof value.path !== "string" ||
      !Number.isSafeInteger(value.device) || value.device < 0 ||
      !Number.isSafeInteger(value.inode) || value.inode < 0 ||
      !Number.isSafeInteger(value.size) || value.size < 0 ||
      !Number.isFinite(value.modifiedMs) || !SHA256.test(value.sha256)) {
    fail("acp_lifecycle_guard.controller.registry_invalid");
  }
}

function validateAttestation(
  value: FileAttestation,
  privateFile: boolean,
  basename?: string,
  requireStable = true,
): void {
  validateAttestationShape(value);
  const options = { privateFile, ...(basename === undefined ? {} : { basename }) };
  if (!requireStable) {
    // Identity-only check: hashing a deliberately mutable record would only
    // produce a digest this branch immediately discards.
    statOwnedRegularFile(value.path, options);
    return;
  }
  if (!sameAttestation(value, assertOwnedRegularFile(value.path, options))) {
    fail("acp_lifecycle_guard.controller.trust_changed");
  }
}

function validateEntryShape(entry: ControllerLease): ControllerLease {
  if (!SHA256.test(entry.leaseHash) || entry.ownerAgentId !== "main" ||
      !MAIN_SESSION.test(entry.ownerSessionKey) || !SAFE_HANDLE.test(entry.ownerRunId) ||
      !SAFE_HANDLE.test(entry.processHandle) || !SAFE_JOB.test(entry.jobId) ||
      !["prepared", "active"].includes(entry.phase) ||
      ![null, "terminal_acked", "tracking_lost"].includes(entry.cleanupState) ||
      (entry.phase === "prepared" && entry.cleanupState !== null) ||
      !Number.isFinite(Date.parse(entry.registeredAt))) {
    fail("acp_lifecycle_guard.controller.registry_invalid");
  }
  validateDestination(entry.destination);
  validateAttestationShape(entry.transportFile);
  validateAttestationShape(entry.reportPumpEntry);
  validateAttestationShape(entry.hostTransportEntry);
  if (entry.snapshotFile !== undefined) validateAttestationShape(entry.snapshotFile);
  if (path.dirname(entry.reportPumpEntry.path) !== path.dirname(entry.hostTransportEntry.path)) {
    fail("acp_lifecycle_guard.controller.registry_invalid");
  }
  return entry;
}

function validateEntry(entry: ControllerLease): ControllerLease {
  validateEntryShape(entry);
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
  private entries = new Map<string, ControllerLease>();

  constructor(stateDir: string) {
    assertPosixControllerPlatform(process.getuid);
    this.directory = path.join(stateDir, "plugins", "acp-lifecycle-guard");
    this.file = path.join(this.directory, "active-leases.json");
    this.load();
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid!() ||
        (stat.mode & 0o077) !== 0) {
      fail("acp_lifecycle_guard.controller.registry_permissions");
    }
  }

  private load(): void {
    this.ensureDirectory();
    if (!fs.existsSync(this.file)) return;
    const stat = fs.lstatSync(this.file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid!() ||
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
        ![CONTROLLER_SCHEMA_VERSION, LEGACY_CONTROLLER_SCHEMA_VERSION].includes(
          (parsed as RegistryDocument).schemaVersion,
        ) ||
        !Array.isArray((parsed as RegistryDocument).leases) ||
        (parsed as RegistryDocument).leases.length > MAX_ACTIVE_LEASES) {
      fail("acp_lifecycle_guard.controller.registry_invalid");
    }
    for (const raw of (parsed as RegistryDocument).leases) {
      const legacy = (parsed as RegistryDocument).schemaVersion === LEGACY_CONTROLLER_SCHEMA_VERSION;
      const candidate = legacy && raw && typeof raw === "object" &&
        (raw as { cleanupState?: unknown }).cleanupState !== undefined
        ? { ...(raw as Record<string, unknown>), phase: "active",
            cleanupState: (raw as { cleanupState: unknown }).cleanupState === "active"
              ? null : (raw as { cleanupState: unknown }).cleanupState }
        : raw;
      // Startup validates only the bounded persisted shape. Path identity,
      // ownership, permissions, and content attestations are deliberately
      // deferred to the exact action that would import, mutate, publish, or
      // acknowledge. A single moved stale transport therefore cannot disable
      // unrelated registrations or trigger a startup hashing storm.
      const entry = validateEntryShape(candidate as ControllerLease);
      if (this.entries.has(entry.leaseHash)) fail("acp_lifecycle_guard.controller.registry_invalid");
      this.entries.set(entry.leaseHash, entry);
    }
  }

  private persist(): void {
    this.ensureDirectory();
    const temporary = path.join(this.directory, `.active-leases.${process.pid}.${crypto.randomUUID()}.tmp`);
    const document: RegistryDocument = {
      schemaVersion: CONTROLLER_SCHEMA_VERSION,
      // Keep the durable recovery queue oldest-first. Timestamps never delete
      // entries; they only make explicit evidence-based prepared recovery and
      // capacity diagnosis deterministic across restarts.
      leases: [...this.entries.values()].sort((left, right) =>
        Date.parse(left.registeredAt) - Date.parse(right.registeredAt)),
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

  register(input: RegisterLeaseInput): ControllerLease {
    const hash = leaseHash(input.leaseToken);
    if (!MAIN_SESSION.test(input.ownerSessionKey) || !SAFE_HANDLE.test(input.ownerRunId) ||
        !SAFE_HANDLE.test(input.processHandle) || !SAFE_JOB.test(input.jobId)) {
      fail("acp_lifecycle_guard.controller.identity_invalid");
    }
    const preparedForOwner = [...this.entries.values()]
      .filter((entry) => entry.phase === "prepared" && entry.ownerSessionKey === input.ownerSessionKey)
      .sort((left, right) => Date.parse(left.registeredAt) - Date.parse(right.registeredAt));
    if (preparedForOwner.length >= MAX_PREPARED_LEASES_PER_OWNER) {
      // Never delete by age alone: the oldest timestamp only makes the cap
      // deterministic. Recovery still requires abortPreactivation's attested
      // transport proof under exact owner/job authority.
      fail("acp_lifecycle_guard.controller.prepared_recovery_required");
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
    const entry: ControllerLease = {
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
      phase: "prepared",
      cleanupState: null,
    };
    this.entries.set(hash, entry);
    try { this.persist(); } catch (error) { this.entries.delete(hash); throw error; }
    return entry;
  }

  getByToken(token: unknown): ControllerLease | undefined {
    return this.entries.get(leaseHash(token));
  }

  getByHash(hash: string): ControllerLease | undefined {
    return this.entries.get(hash);
  }

  leasesForOwner(sessionKey: string | undefined, runId: string | undefined): ControllerLease[] {
    if (!sessionKey || !runId) return [];
    return [...this.entries.values()].filter((entry) =>
      entry.ownerSessionKey === sessionKey && entry.ownerRunId === runId);
  }

  leasesForCron(agentId: string | undefined, sessionKey: string | undefined): ControllerLease[] {
    const jobId = exactCronJob(sessionKey);
    if (agentId !== "main" || jobId === undefined) return [];
    return [...this.entries.values()].filter((entry) => entry.jobId === jobId);
  }

  setCleanupState(entry: ControllerLease, state: Exclude<ControllerLease["cleanupState"], null>): void {
    if (entry.phase !== "active") fail("acp_lifecycle_guard.controller.phase_invalid");
    this.revalidate(entry);
    const previous = entry.cleanupState;
    entry.cleanupState = state;
    // Every mutating path rolls the in-memory entry back on a failed write, so
    // a durable read after a persistence failure never disagrees with memory.
    try { this.persist(); } catch (error) { entry.cleanupState = previous; throw error; }
  }

  async commitActivation(entry: ControllerLease): Promise<void> {
    if (entry.phase === "active") return;
    this.revalidate(entry);
    const transport = await importAttested(entry.hostTransportEntry) as
      { confirmHostTransportActivation?: (input: Record<string, unknown>) => unknown };
    if (typeof transport.confirmHostTransportActivation !== "function") {
      fail("acp_lifecycle_guard.controller.activation_contract_invalid");
    }
    let evidence: unknown;
    try {
      evidence = await transport.confirmHostTransportActivation({
        transportFile: entry.transportFile.path,
        processHandle: entry.processHandle,
      });
    } catch {
      fail("acp_lifecycle_guard.controller.activation_not_confirmed");
    }
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
        Object.keys(evidence).sort().join(",") !== "processHandle,schemaVersion,type" ||
        (evidence as Record<string, unknown>).schemaVersion !== "acp-host-controller-lease.v1" ||
        (evidence as Record<string, unknown>).type !== "host_transport_activation_confirmed" ||
        (evidence as Record<string, unknown>).processHandle !== entry.processHandle) {
      fail("acp_lifecycle_guard.controller.activation_evidence_invalid");
    }
    entry.phase = "active";
    try { this.persist(); } catch (error) { entry.phase = "prepared"; throw error; }
  }

  async abortPreactivation(entry: ControllerLease): Promise<void> {
    if (entry.phase !== "prepared" || entry.cleanupState !== null) {
      fail("acp_lifecycle_guard.controller.preactivation_abort_denied");
    }
    this.revalidate(entry);
    const transport = await importAttested(entry.hostTransportEntry) as
      { abortHostTransportPreactivation?: (input: Record<string, unknown>) => unknown };
    if (typeof transport.abortHostTransportPreactivation !== "function") {
      fail("acp_lifecycle_guard.controller.preactivation_contract_invalid");
    }
    let evidence: unknown;
    try {
      evidence = await transport.abortHostTransportPreactivation({
        transportFile: entry.transportFile.path,
        processHandle: entry.processHandle,
      });
    } catch {
      fail("acp_lifecycle_guard.controller.preactivation_abort_denied");
    }
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
        Object.keys(evidence).sort().join(",") !== "processHandle,schemaVersion,type" ||
        (evidence as Record<string, unknown>).schemaVersion !== "acp-host-controller-lease.v1" ||
        (evidence as Record<string, unknown>).type !== "host_transport_preactivation_aborted" ||
        (evidence as Record<string, unknown>).processHandle !== entry.processHandle) {
      fail("acp_lifecycle_guard.controller.preactivation_evidence_invalid");
    }
    this.release(entry);
  }

  release(entry: ControllerLease): void {
    this.entries.delete(entry.leaseHash);
    try { this.persist(); } catch (error) { this.entries.set(entry.leaseHash, entry); throw error; }
  }

  revalidate(entry: ControllerLease): void {
    // The transport record is mutable by contract, so only its identity is
    // rechecked here; digesting it would be discarded work on a hot path.
    const mutableTransport = statOwnedRegularFile(entry.transportFile.path, { privateFile: true });
    if (mutableTransport.real !== entry.transportFile.path) {
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
  publicationTokenHash: string;
  message: string;
  report: Record<string, unknown>;
  reportId: string;
  reportKind: "intermediate" | "terminal";
  cadence: number;
  attemptId: string;
  fence: number;
  injected: boolean;
  authorized: boolean;
  expiresAtMs: number;
  outcome: "delivery_missing" | "delivery_uncertain";
};

export type ControllerTickResult =
  | { status: "none_due" }
  | { status: "delivery_pending"; publicationToken: string }
  | { status: "terminal_acked" | "tracking_lost"; cleanup: "remove_current_job_then_release_lease" }
  | { status: "delivery_missing" | "delivery_uncertain" };

function exactCronJob(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const match = /^(?:agent:main:)?cron:([^:]+)(?::run:[^:]+)?$/u.exec(sessionKey);
  return match?.[1];
}

function pendingScopeMatches(
  pending: PendingDelivery,
  entry: ControllerLease,
  context: { sessionKey?: string; channelId: string; accountId?: string; conversationId?: string },
): boolean {
  return pending.cronSessionKey === context.sessionKey &&
    entry.destination.channel === context.channelId &&
    entry.destination.accountId === context.accountId &&
    entry.destination.conversationId === context.conversationId;
}

function parseCanonicalReport(message: string): Record<string, unknown> {
  // The general lifecycle guard intentionally accepts transport normalization.
  // Controller traffic is narrower: the attested pump is a canonical builder
  // and the transport reconstructs those bytes before checking receipt digest.
  if (message !== message.normalize("NFC") || message.includes("\r") || message.endsWith("\n")) {
    fail("acp_lifecycle_guard.controller.pump_report_noncanonical");
  }
  const lines = message.split("\n");
  const identity = /^(?:\uD83E\uDD16) \*\*ACP\*\*: (Claude Code|Codex) · `([^`]+)`$/u.exec(lines[2] ?? "");
  const target = /^\uD83D\uDCCD \*\*작업\*\*: `([^`]+)` · `([^`]+)`$/u.exec(lines[3] ?? "");
  const titleTime = / · ([0-2][0-9]:[0-5][0-9]) KST\*\*$/u.exec(lines[0] ?? "");
  if (!identity || !target || !titleTime) {
    fail("acp_lifecycle_guard.controller.pump_report_noncanonical");
  }
  const base = {
    agent: identity[1] === "Codex" ? "codex" : "claude",
    model: identity[2], repository: target[1], branch: target[2], timeKst: titleTime[1],
  };
  if ((lines[0] ?? "").startsWith("🔄")) {
    const round = /^\uD83D\uDD22 \*\*라운드\*\*: ([1-9][0-9]*) · ([1-4])\/4 /u.exec(lines[4] ?? "");
    const elapsed = /^\u23F1\uFE0F? \*\*ACP 시간\*\*: 전체 ([0-9]+)분 · 현재 단계 ([0-9]+)분 · 마지막 ACP 활동 ([0-9]+)분 전$/u.exec(lines[5] ?? "");
    const deltaLine = lines[9] ?? "";
    const delta = /^- Δ([0-9]+) · (.*)$/u.exec(deltaLine);
    if (!round || !elapsed || !delta) {
      fail("acp_lifecycle_guard.controller.pump_report_noncanonical");
    }
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
  if (!duration || lines.length !== 20) {
    fail("acp_lifecycle_guard.controller.pump_report_noncanonical");
  }
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

  /**
   * Drop attempts whose lease is gone.
   *
   * A released lease never ticks again, so its attempt would otherwise live
   * for the process lifetime: unbounded growth across runs, and - worse - a
   * later message with the same content would match the orphan by digest,
   * find no lease behind it, and be cancelled as a scope mismatch. Unrelated
   * traffic must stay fail-open.
   */
  private prunePending(): void {
    for (const [hash] of this.pending) {
      if (this.registry.getByHash(hash) === undefined) this.pending.delete(hash);
    }
  }

  async tick(entry: ActiveLease, sessionKey: string): Promise<ControllerTickResult> {
    this.prunePending();
    this.registry.revalidate(entry);
    if (entry.phase !== "active") {
      fail("acp_lifecycle_guard.controller.lease_prepared");
    }
    if (entry.cleanupState !== null) {
      return { status: entry.cleanupState, cleanup: "remove_current_job_then_release_lease" };
    }
    const existing = this.pending.get(entry.leaseHash);
    if (existing !== undefined && Date.now() < existing.expiresAtMs) {
      return { status: existing.outcome };
    }
    if (existing !== undefined) this.pending.delete(entry.leaseHash);
    const transport = await importAttested(entry.hostTransportEntry) as {
      REPORT_ATTEMPT_TTL_MS?: unknown;
    };
    if (!Number.isSafeInteger(transport.REPORT_ATTEMPT_TTL_MS) ||
        (transport.REPORT_ATTEMPT_TTL_MS as number) < 1000 ||
        (transport.REPORT_ATTEMPT_TTL_MS as number) > 3600000) {
      fail("acp_lifecycle_guard.controller.trust_entry_invalid");
    }
    const claimedAtMs = Date.now();
    const pump = await importAttested(entry.reportPumpEntry) as unknown as {
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
      return { status, cleanup: "remove_current_job_then_release_lease" };
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
    const publicationToken = `acp-pub-${crypto.randomUUID().replaceAll("-", "")}`;
    this.pending.set(entry.leaseHash, {
      leaseHash: entry.leaseHash, cronSessionKey: sessionKey,
      messageDigest: result.messageDigest,
      publicationTokenHash: leaseHash(publicationToken),
      message: result.message,
      report: parseCanonicalReport(result.message),
      reportId: result.reportId, reportKind: result.reportKind,
      cadence: result.cadence as number, attemptId: result.attemptId,
      fence: result.fence as number, injected: false, authorized: false,
      expiresAtMs: claimedAtMs + (transport.REPORT_ATTEMPT_TTL_MS as number),
      outcome: "delivery_uncertain",
    });
    return { status: "delivery_pending", publicationToken };
  }

  prepareMessageTool(
    params: Record<string, unknown>,
    context: { agentId?: string; sessionKey?: string },
  ): { outcome: "unrelated" | "authorized" | "ambiguous" | "scope_mismatch"; params?: Record<string, unknown> } {
    this.prunePending();
    if (params.action !== "send" || typeof params.message !== "string") {
      return { outcome: "unrelated" };
    }
    let tokenHash: string;
    try { tokenHash = leaseHash(params.message); } catch { return { outcome: "unrelated" }; }
    const tokenCandidates = [...this.pending.values()].filter((candidate) =>
      candidate.publicationTokenHash === tokenHash);
    if (tokenCandidates.length === 0) return { outcome: "unrelated" };
    const scoped = tokenCandidates.filter((candidate) => {
      const entry = this.registry.getByHash(candidate.leaseHash);
      return entry !== undefined && context.agentId === "main" &&
        candidate.cronSessionKey === context.sessionKey &&
        exactCronJob(context.sessionKey) === entry.jobId;
    });
    if (scoped.length === 0) return { outcome: "scope_mismatch" };
    if (scoped.length !== 1) return { outcome: "ambiguous" };
    const pending = scoped[0]!;
    if (pending.injected || Object.keys(params).some((key) =>
      !["action", "message", "final"].includes(key)) || params.final !== false) {
      return { outcome: "scope_mismatch" };
    }
    const entry = this.registry.getByHash(pending.leaseHash)!;
    this.registry.revalidate(entry);
    pending.injected = true;
    return {
      outcome: "authorized",
      params: {
        action: "send",
        channel: entry.destination.channel,
        target: entry.destination.conversationId,
        accountId: entry.destination.accountId,
        message: pending.message,
        final: false,
      },
    };
  }

  authorizeSending(content: string, context: { sessionKey?: string; channelId: string; accountId?: string; conversationId?: string }):
    "unrelated" | "authorized" | "ambiguous" | "scope_mismatch" {
    this.prunePending();
    const digest = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    const digestCandidates = [...this.pending.values()].filter((candidate) => candidate.messageDigest === digest);
    if (digestCandidates.length === 0) return "unrelated";
    const matches = digestCandidates.filter((candidate) => {
      const entry = this.registry.getByHash(candidate.leaseHash);
      return entry !== undefined && candidate.cronSessionKey === context.sessionKey &&
        entry.destination.channel === context.channelId && entry.destination.accountId === context.accountId &&
        entry.destination.conversationId === context.conversationId;
    });
    if (matches.length === 0) return "scope_mismatch";
    if (matches.length !== 1) return "ambiguous";
    if (!matches[0]!.injected) return "scope_mismatch";
    const entry = this.registry.getByHash(matches[0]!.leaseHash);
    if (entry === undefined) return "scope_mismatch";
    this.registry.revalidate(entry);
    matches[0]!.authorized = true;
    return "authorized";
  }

  async acknowledgeSent(event: { content: string; success: boolean; messageId?: string },
    context: { sessionKey?: string; channelId: string; accountId?: string; conversationId?: string }): Promise<"unrelated" | "ignored" | "acked" | "failed"> {
    this.prunePending();
    const digest = crypto.createHash("sha256").update(event.content, "utf8").digest("hex");
    const digestCandidates = [...this.pending.values()].filter((candidate) =>
      candidate.messageDigest === digest && candidate.authorized);
    if (digestCandidates.length === 0) return "unrelated";
    const candidates = digestCandidates.filter((candidate) => {
      const entry = this.registry.getByHash(candidate.leaseHash);
      return entry !== undefined && pendingScopeMatches(candidate, entry, context);
    });
    if (candidates.length !== 1) return "ignored";
    const pending = candidates[0]!;
    const entry = this.registry.getByHash(pending.leaseHash);
    if (!entry) return "ignored";
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
      const transport = await importAttested(entry.hostTransportEntry) as unknown as {
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
