# Changelog

All notable changes to `openclaw-acp-lifecycle-guard` are documented here. This
plugin is versioned independently of the repository and follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-30

### Added

- **Owner-checkpoint delivery-receipt guard** on `before_agent_run`,
  `message_sent`, `before_agent_finalize`, and `agent_end`. A run is tracked
  only when trusted scheduler provenance (hook context `trigger` exactly
  `cron` plus a cron job id and the host's bounded correlation fields)
  coincides with the exact first-line prompt marker
  `[owner-progress-checkpoint:v1]`; the marker alone is never authority, and
  interactive turns, non-cron runs, and uncorrelatable or ambiguous runs stay
  untouched. A publication receipt requires a successful send with a
  non-empty message id, matching run/session correlation, and delivery to the
  exact original owner conversation derived from trusted hook context (a
  failed send followed by an exact-target success passes; a wrong-target
  success does not; duplicates are idempotent). At finalize, a missing
  receipt is logged with `acp_lifecycle_guard.receipt.missing` in observe
  mode; enforce mode returns the host's `revise` result with a fixed bounded
  instruction, a stable idempotency key, and a bounded `maxAttempts`. State
  is cleaned deterministically on `agent_end` and bounded by a size cap and
  TTL.
- Configurable `ownerCheckpointReceiptMode` (`"observe"` | `"enforce"`,
  default `"observe"`). Deliberately independent of the legacy `enforce`
  boolean: enabling the shape guards never activates receipt enforcement,
  which remains a separate operator rollout.
- New stable reason codes under `acp_lifecycle_guard.receipt.*`
  (`checkpoint_registered`, `uncorrelatable`, `confirmed`, `target_mismatch`,
  `missing`, `revise_requested`, `revise_exhausted`).
- Target-build smoke coverage driving the built plugin through the installed
  hook runner and the installed harness finalize helper for all four receipt
  hooks: registration, correlation, receipt acceptance, enforce-mode revise,
  cleanup, ordinary-turn bypass, and no-raw-content logging.

### Notes

- The installed host's finalize retry accounting allows exactly the bounded
  revise rounds per run and idempotency key and then **continues**: exhausted
  retries fail open at the host and the run finalizes without a receipt. The
  smoke proves this sequence against the installed build. The guard therefore
  claims no fail-closed delivery guarantee; it guarantees the miss is never
  silent (`acp_lifecycle_guard.receipt.revise_exhausted` is logged) and is
  never reported as a confirmed receipt.
- No raw prompt text, outbound content, destination, message id, session key,
  run id, or command reaches a log line, a revise reason or instruction, or
  hook metadata. Correlation identifiers live only in bounded in-memory
  state.

## [0.3.0] - 2026-08-30

### Changed

- **Breaking: identity rename.** The plugin previously published as
  `openclaw-acp-report-guard` (plugin id `acp-report-guard`, display name
  "ACP Report Guard", reason-code prefix `acp_report_guard.`) is now
  `openclaw-acp-lifecycle-guard` with plugin id `acp-lifecycle-guard`,
  display name "ACP Lifecycle Guard", reason-code prefix
  `acp_lifecycle_guard.`, and log prefix `[acp-lifecycle-guard]`. Runtime
  behavior is unchanged from 0.2.0. There is no compatibility alias:
  installs of the old identity must install the new package, move config to
  `plugins.entries.acp-lifecycle-guard.config`, and re-key any consumers of
  the old reason codes or log prefix. Entries below 0.3.0 predate the
  rename and are shown under the current identity.

## [0.2.0] - 2026-08-30

### Added

- `before_tool_call` now also guards agent-started ACP launch routes as
  defense in depth: a shell/exec tool call whose inspectable command invokes a
  canonical ACP launch entrypoint (`acp-host-transport-cli.mjs`,
  `acpx-foreground-supervisor.mjs`, `claude-acp-launcher.mjs`) in command
  position - executed directly or as the script argument of `node`, including
  after `;`, `&&`, `||`, or `|` - or a session-spawn tool call with
  `runtime: "acp"`, passes only when the hook context `agentId` is exactly
  `main`. A missing, empty, differently cased, or other agent id is blocked
  with the new stable reason code `acp_lifecycle_guard.launch.non_main_agent`.
  Recognition fails open: uninspectable commands, ordinary shell commands
  (including ones that merely mention a launcher basename as data, such as a
  `cat`, `rg`, or `echo` argument), unrelated session spawns, and all other
  tool calls pass through untouched, and actions outside an OpenClaw tool
  hook are unaffected.
- Configurable `blockNonMainAcpLaunches` (default `true`). With `enforce`
  false, or with this toggle off, non-main launches are observed and logged
  but never blocked.
- `npm run smoke:target-build`: a disposable target-build smoke that drives the
  built plugin through the installed OpenClaw hook runner and asserts
  `message_sending` and `before_tool_call` registration and dispatch, a passing
  completion with seconds, a cancelled malformed report, passing ordinary chat,
  a blocked non-main ACP launch alongside a passing `main` launch and ordinary
  command, and no raw outbound content, command text, or agent id in logs, the
  cancel reason, the block reason, or hook metadata. It fails clearly if the
  installed runner no longer exposes the expected `before_tool_call` dispatch
  contract. It does not install, enable, or activate the plugin, does not touch
  OpenClaw config, and does not contact Gateway.

### Fixed

- Completion reports using the minute-plus-seconds elapsed form (`17분 31초`)
  were cancelled with `acp_lifecycle_guard.completion.duration_drift`. The
  completion duration grammar now accepts both the minute-only and the
  minute-plus-seconds form, with seconds bounded to `0`-`59`. Malformed
  durations (`17분 60초`, `17분 31`, `17분31초`) still fail, and the metadata
  line and round grammar are unchanged.

## [0.1.0] - 2026-08-29

Initial release.

### Added

- `message_sending` hook as the authoritative final outbound safeguard:
  classifies ACP lifecycle candidates, validates the canonical start,
  correction-round start, intermediate, and completion layouts, and cancels
  malformed candidates before delivery.
- `before_tool_call` hook as defense in depth: blocks direct `message` tool
  publication of ACP intermediate reports so the disabled watchdog announce
  path stays the sole normal intermediate publisher. Start, correction-start,
  and completion reports, approval evidence, ordinary discussion, and unrelated
  messages are not blocked.
- Strict positional validation covering title, metadata order, section names,
  section order, blank-line placement, single-bullet sections, the optional
  trailing issue section, Markdown hard-break whitespace, delta markers,
  forbidden non-ACP subjects, pre-dispatch progress claims, and size ceilings.
- Rejection of the early legacy elapsed-only line in favour of the current
  total / current-stage / last-change form.
- Stable, content-free reason codes; hook metadata limited to
  `{ pluginId, lifecycleKind, reasonCode }`.
- Configurable `enforce`, `blockDirectIntermediateToolCalls`,
  `maxIntermediateChars`, and `maxBoundaryReportChars`.
- Unit tests for valid layouts, malformed variants, ordinary-chat bypass,
  direct-intermediate blocking, hook return shapes, and no-raw-content logging.

### Notes

- Terminal failure, cancellation, blocker, and tracking-loss reports are not
  guarded: the reporting contract does not define a canonical layout for them.
- `before_tool_call` alone is not the enforcement boundary. A live
  `message_sending` cancellation smoke on the target OpenClaw build is required
  before operational activation. See the host caveat in `README.md`.
- Built and verified against `openclaw@2026.7.1-2` plugin SDK contracts.
