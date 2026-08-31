# Changelog

All notable changes to `openclaw-acp-lifecycle-guard` are documented here. This
plugin is versioned independently of the repository and follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-08-31

### Fixed

- The canonical intermediate elapsed line now matches the live
  `acp-progress-reporting` contract's activity label: only
  `⏱ **ACP 시간**: 전체 <N>분 · 현재 단계 <N>분 · 마지막 ACP 활동 <N>분 전`
  is accepted, and the legacy `마지막 변화` label is rejected with the
  existing `acp_lifecycle_guard.intermediate.elapsed_drift` reason. The
  previous release had the two labels inverted, so every live canonical
  intermediate report was cancelled as elapsed drift. The activity-age
  segment remains structurally independent of the `새 결과` delta bullet:
  `Δ0` alongside a recent activity age stays valid, and no semantic coupling
  between the two fields is inferred. Shape validation only; no scope change.

## [0.4.2] - 2026-08-31

### Fixed

- Near-canonical titles across all four lifecycle families now enter strict
  validation when the first visible line has the family's marker, standalone
  `ACP`, family intent, and at least two recognizable body anchors. Completion
  intent includes narrow `완료`, `종료`, and `마무리` forms while excluding
  non-completion, pending, failure, cancellation, blocker, and tracking-loss
  titles. Ordinary marker chat remains untouched. Rejected candidates use an
  existing content-free drift reason, which depends on the earliest structural
  mismatch and is not always title drift.
- Added an independently owned synthetic contract fixture proving that the
  external terminal builder's exact 20-line completion shape passes without a
  dependency on another repository.
- Normalized report text to NFC so decomposed Hangul cannot bypass any family.

## [0.4.1] - 2026-08-30

### Fixed

- **Stopped global Codex approval-prompt promotion.** The plugin no longer
  registers `before_tool_call` on OpenClaw 2026.7.1-2. That host promotes
  native Codex approval policy for every Codex session whenever any global
  `before_tool_call` hook exists, so the previous defense-in-depth hook caused
  ordinary native command and file operations to produce repeated operator
  approval prompts. `message_sending` remains the authoritative lifecycle
  report enforcement boundary, and the four owner-checkpoint receipt hooks
  remain registered.
- The target-build smoke now proves `before_tool_call` is absent from the
  global runner. The legacy policy implementation and its configuration keys
  remain for schema compatibility, but are intentionally inactive in this
  release.

## [0.4.0] - 2026-08-30

### Added

- **Owner-checkpoint delivery-receipt guard** on `before_agent_run`,
  `message_sent`, `before_agent_finalize`, and `agent_end`. A run is tracked
  only when trusted scheduler provenance (hook context `trigger` exactly
  `cron` and the host's bounded correlation fields) coincides with the exact
  first-line prompt marker `[owner-progress-checkpoint:v1]`; the marker alone
  is never authority, and interactive turns, non-cron runs, and
  uncorrelatable or ambiguous runs stay untouched. Eligibility deliberately
  does **not** require a cron `jobId`: the installed `openclaw@2026.7.1-2`
  embedded cron runner receives `jobId` in `runEmbeddedAgent` but omits it
  from the `before_agent_run` hook context it assembles (only the CLI-runner
  path exposes it), so a job-id requirement would misclassify every real
  embedded owner checkpoint as ineligible. `jobId` is accepted as an optional
  context field, never read for decisions and never logged; the target-build
  smoke proves eligibility behaviorally on both installed cron context
  shapes (without `jobId`, and with an inert `jobId`). A publication receipt requires a successful send with a
  non-empty message id, matching run/session correlation, and delivery to the
  exact original owner conversation derived from trusted hook context (a
  failed send followed by an exact-target success passes; a wrong-target
  success does not; duplicates are idempotent). At finalize, a missing
  receipt is logged with `acp_lifecycle_guard.receipt.missing` in observe
  mode; enforce mode returns the host's `revise` result with a fixed bounded
  instruction, a stable idempotency key, and a bounded `maxAttempts`, logging
  each requested round with `acp_lifecycle_guard.receipt.revise_requested`.
  State is cleaned on `agent_end` only with proven run identity and bounded
  by a size cap, a TTL, and observable displacement.
- **Single correlation rule across all receipt transitions.** `message_sent`,
  `before_agent_finalize`, and `agent_end` share one lookup: the session key
  selects the entry (the installed outbound path never populates `runId` on
  `message_sent`, pinned through the host's own sent-message mappers in the
  smoke), and run ids act as a consistency check - a contradiction always
  means "not the tracked run". The destructive `agent_end` cleanup requires
  **proof** of identity: both run ids present and equal. Matching absence is
  not proof - two id-less runs on one session key are indistinguishable, so
  an unrelated id-less run ending can never disarm a tracked id-less
  checkpoint. An end that cannot prove identity retains the entry as an
  **end-observed terminal candidate**, surfaced with
  `acp_lifecycle_guard.receipt.end_unproven`: it keeps guarding, is
  displaced by the next registration as an observable eviction, is preferred
  by cap eviction after stale tombstones, and stays bounded by the TTL.
- **Conservative same-session-key registration.** A re-registration that
  proves the same run id is idempotent and preserves receipt state; two
  live registrations that cannot prove they are the same run (differing run
  ids, or either side missing one) drop tracking for the session key entirely
  (fail open) instead of overwriting the first run's state. An end-observed
  terminal candidate is the exception: the next registration displaces it as
  an observable eviction rather than an ambiguity drop, so consecutive
  id-less checkpoints stay guarded.
- **Bounded state without silent disarmament.** Past the TTL a pending entry
  becomes a stale tombstone: enforcement is disarmed, but a receipt-less
  finalize is reported explicitly with
  `acp_lifecycle_guard.receipt.stale_missing`, a late exact-target receipt
  still confirms, and a provable `agent_end` still cleans up. Size-cap
  pressure and tombstone displacement are surfaced with
  `acp_lifecycle_guard.receipt.evicted` (stale entries evicted before fresh
  ones) instead of removing tracked checkpoints silently.
- **Host-mirroring destination normalization.** Destination comparison strips
  the installed host's conversation-target wrapper vocabulary (`channel:`,
  `chat:`, `direct:`, `dm:`, `group:`, `thread:`, `user:`, plus the channel's
  own name) **repeatedly** with a bound, because the two comparison sides
  pass through the host's single-strip normalization a different number of
  times. Prefixes compare case-insensitively; conversation ids keep their
  case; unknown prefixes are preserved.
- **Distinct unverifiable-destination outcome.** A correlated successful send
  whose destination metadata is absent is reported with
  `acp_lifecycle_guard.receipt.target_unverifiable` instead of being
  misreported as a target mismatch, and never counts as a receipt.
- **Near-miss marker drift signal.** A trusted cron prompt carrying the
  marker stem without the exact first-line form (version skew, decoration,
  or a marker off the first line) emits the content-free
  `acp_lifecycle_guard.receipt.marker_drift` signal without tracking; exact
  unrelated cron prompts stay silent, and untrusted provenance never
  produces the signal.
- **Host-authoritative revise budget (no local accounting).** The guard
  requests the same bounded, idempotent revise on every receipt-less enforce
  round and keeps no local requested-rounds counter: the installed host's
  finalize merge lets another plugin's `finalize` win without
  acknowledgment, so local accounting would let overridden requests consume
  the guard's effective budget and stop it from ever revising. The
  authoritative bound on *applied* rounds is the host's per-run,
  per-idempotency-key retry accounting (keyed by
  `event.runId ?? event.sessionId ?? "unknown-run"`, so bounded even for
  id-less runs), charged **only when a revise decision wins the merge** and
  continuing once `maxAttempts` applied rounds are spent. Overridden
  requests consume nothing, the guard never authors a false exhausted
  signal (it cannot know which rounds won), and the per-round
  `revise_requested` log is the truthful trace. Both sides are pinned in
  the target-build smoke against the installed build.
- Configurable `ownerCheckpointReceiptMode` (`"observe"` | `"enforce"`,
  default `"observe"`). Deliberately independent of the legacy `enforce`
  boolean: enabling the shape guards never activates receipt enforcement,
  which remains a separate operator rollout.
- New stable reason codes under `acp_lifecycle_guard.receipt.*`
  (`checkpoint_registered`, `uncorrelatable`, `marker_drift`, `confirmed`,
  `target_mismatch`, `target_unverifiable`, `missing`, `stale_missing`,
  `evicted`, `revise_requested`, `end_unproven`).
- **Explicit `before_agent_run` pass contract.** The receipt guard's
  `before_agent_run` handler returns the host's explicit
  `{ outcome: "pass" }` gate decision on every non-blocking path - eligible,
  ordinary, uncorrelatable, ambiguous, and internal-error (fail-open) alike -
  and never signals "no opinion" with `void`. The exported host type
  (`PluginHookBeforeAgentRunResult`) allows `void`, but the installed
  `openclaw@2026.7.1-2` runner's `runBeforeAgentRun` merge blocks a `null`
  handler result outright (`before_agent_run returned an invalid decision`),
  and an `undefined` result escapes the same normalization only through an
  incidental `!== undefined` guard in the generic merge layer; runtime
  behavior is authoritative, and a handler relying on `void` is one host
  refactor away from blocking every agent run.
- Target-build smoke coverage driving the built plugin through the installed
  hook runner and the installed harness finalize helper for all four receipt
  hooks, in phases with the established gates first. Phase A proves the
  **shipped default configuration** end to end (no `pluginConfig`: shape
  guards enforce, receipt guard observes and never revises). Phase B proves
  the enforce-mode receipt scenarios, eligibility on both installed cron
  context shapes (the embedded runner's `jobId`-less shape and the CLI
  runner's inert-`jobId` shape - replacing the earlier bundling-sensitive
  embedded-runner source probe with behavioral evidence), and a receipt
  delivered through the **installed sent-message mappers** from
  `openclaw/plugin-sdk/hook-runtime`, pinning the delivery-path correlation
  contract (no `runId`, preserved `sessionKey`, raw wrapper-prefixed `to` as
  `conversationId`). Phase B also proves the id-less identity rule end to
  end: an unprovable id-less `agent_end` retains the guarded checkpoint
  (logged as `receipt.end_unproven`), its finalize still revises, and the
  next registration displaces the end-observed candidate as an observable
  eviction. Phase C composes the guard with synthetic second
  plugins: earlier and later `before_agent_run` blocks stay sticky over the
  guard's explicit pass; a synthetic `finalize` decision wins the installed
  merge over the guard's revise for two rounds without consuming any budget,
  after which the guard's winning revise is applied and charged for exactly
  the bounded rounds before the host continues; and the installed finalize
  budget is proven to be charged only when
  a revise decision wins the merge. The smoke also pins the installed gate's
  nullish normalization with a synthetic probe (`null` blocks; `undefined`
  survives only an incidental guard in the generic merge layer) and asserts
  every `before_agent_run` scenario yields an explicit pass decision from
  the installed runner.

- The mirrored `AgentHookContext` in `src/host-contract.ts` is narrowed to
  exactly the fields the receipt hooks read (`runId`, `jobId`, `sessionKey`,
  `trigger`, `channel`, `channelId`), so the contract no longer suggests that
  unused fields participate in receipt eligibility.

### Notes

- The installed host's finalize retry accounting allows exactly the bounded
  applied revise rounds per run and idempotency key and then **continues**:
  exhausted retries fail open at the host and the run finalizes without a
  receipt. The smoke proves this sequence against the installed build. The
  guard therefore claims no fail-closed delivery guarantee; it guarantees
  the miss is never silent (every requested round is logged with
  `acp_lifecycle_guard.receipt.revise_requested`) and is never reported as a
  confirmed receipt. The guard authors no exhausted signal of its own: it
  cannot know which requested rounds won the finalize merge, and a
  plugin-authored exhausted state would misreport overridden rounds as
  spent budget.
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
