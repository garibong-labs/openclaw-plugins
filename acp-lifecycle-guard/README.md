# openclaw-acp-lifecycle-guard

Native OpenClaw plugin that prevents **malformed ACP lifecycle reports** from
being delivered and tracks **owner-checkpoint delivery receipts**.

- Plugin id: `acp-lifecycle-guard`
- Package: `openclaw-acp-lifecycle-guard`
- Hooks: `message_sending` (authoritative), `before_tool_call` (defense in
  depth), `before_agent_run` / `message_sent` / `before_agent_finalize` /
  `agent_end` (owner-checkpoint receipt tracking)
- Runtime dependencies: none

## Why

The ACP progress-reporting contract defines exact public layouts for the
start, correction-round start, ten-minute cadence, and completion reports. A
report that drifts from those layouts is worse than no report: it looks
authoritative while misstating lifecycle state. This plugin is the last gate
before such a payload reaches a channel.

## What it does

### `message_sending` - the enforcement boundary

Every outbound payload is classified. If the payload is a supported ACP
lifecycle report, it is validated against the canonical layout for its family.
A malformed report is cancelled with `{ cancel: true, cancelReason }` before
delivery. Anything else passes through untouched.

Validation is positional, because line order, blank separators, metadata order,
section names, and the one-bullet-per-section rule are all part of the contract.
The guard rejects:

- title drift, including an invalid clock value;
- metadata drift, reordering, or a model/repository/branch value that is not
  inline code;
- the early legacy elapsed-only line (`⏱ **ACP 시간**: 20분`) instead of the
  current total / current-stage / last-change form;
- completion durations outside the canonical `<n>분` and `<n>분 <s>초` forms -
  both are valid, but seconds are bounded to `0`-`59`, so `17분 60초`,
  `17분 31`, and `17분31초` are drift;
- section renames, reordering, extra sections, nested bullets, and extra or
  missing bullets;
- blank-line drift and leading/trailing structural noise;
- Markdown hard-break trailing whitespace;
- new-result bullets that do not use the canonical `Δ0` sentence or a `Δ+N`
  marker;
- non-ACP subjects the intermediate contract forbids;
- pre-dispatch progress claims inside a start report;
- oversized reports.

The optional `⚠ **이슈**` section is preserved exactly where the intermediate
contract permits it: as the trailing section, with one bullet, and nowhere else.

### `before_tool_call` - defense in depth

Two narrow rules run on this hook.

**Direct intermediate publication.** The disabled watchdog announce path is the
only normal publisher of ACP intermediate cadence reports. A direct `message`
tool `send`/`broadcast` that carries an intermediate report bypasses that
publisher, so it is blocked regardless of whether its layout happens to be
valid.

**Non-main ACP launches.** Only the OpenClaw agent whose hook context reports
`agentId` exactly equal to `main` may invoke a recognized agent-started ACP
launch route. Recognized routes are:

- a shell/exec tool call whose inspectable `command` string invokes one of the
  canonical launch entrypoints (`acp-host-transport-cli.mjs`,
  `acpx-foreground-supervisor.mjs`, `claude-acp-launcher.mjs`) in command
  position - executed directly or as the script argument of `node`, including
  after `;`, `&&`, `||`, or `|`. A launcher basename that appears only as
  data (a `cat`, `rg`, or `echo` argument, for example) is not a launch;
- a session-spawn tool call with `runtime: "acp"`.

A missing, empty, or differently cased context agent id is unauthorized. The
block reason is the stable code `acp_lifecycle_guard.launch.non_main_agent` plus
generic wording; command text and agent ids are never echoed. Recognition
fails open: an uninspectable command, an ordinary shell command, an unrelated
session spawn, and every other tool call pass through untouched, and
human-operated actions outside an OpenClaw tool hook are unaffected by
construction.

Nothing else is blocked: ordinary ACP discussion, approval evidence, status
answers, start reports, correction-round start reports, completion reports, and
unrelated messages all pass through. Layout enforcement belongs to
`message_sending`.

### Owner-checkpoint delivery receipts - completeness, not shape

The guards above only see payloads that are actually sent. A scheduler-created
owner progress checkpoint that runs with `delivery.mode=none` is expected to
publish its result through an explicit messaging-tool send; when the run
finishes without ever sending, nothing enters `message_sending`, the run looks
terminally green, and the missing report is invisible. Four hooks close that
gap.

**Eligibility (`before_agent_run`).** A run is tracked only when *both* hold:

- trusted scheduler provenance from the hook context - `trigger` exactly
  `cron` - and the bounded correlation fields the host exposes there
  (session key, channel, conversation target id); and
- the checkpoint prompt's **first line** is exactly the public marker
  `[owner-progress-checkpoint:v1]`.

Eligibility deliberately does **not** require a cron `jobId`. The host type
declares the field, but on the installed `openclaw@2026.7.1-2` embedded cron
path the executor passes `jobId` into `runEmbeddedAgent` and the
`before_agent_run` hook context assembled inside the embedded runner omits
it - only the CLI-runner path exposes it. Requiring a job id would therefore
misclassify every real embedded owner checkpoint as ineligible. `jobId` is
accepted as an optional context field that is never read for decisions and
never logged; the target-build smoke proves eligibility behaviorally on both
installed shapes (context without `jobId`, and with an inert `jobId`).

The marker alone is never authority: an interactive turn, arbitrary user text
carrying the marker, a non-cron run, or a run whose context lacks the
correlation fields is left completely untouched. A **trusted cron** prompt
that carries a *near-miss* of the marker (the stable stem
`[owner-progress-checkpoint` without the exact first-line form - a version
skew, a decorated marker, or a marker that slipped off the first line) is
still not tracked, but emits the stable content-free drift signal
`acp_lifecycle_guard.receipt.marker_drift` so a contract skew cannot rot
silently; exact unrelated cron prompts stay silent, and untrusted provenance
never produces the signal.

Registrations on one session key are conservative: a re-registration that
proves the **same run id** is idempotent (receipt and revise state are
preserved), while two live registrations that cannot prove they are the same
run - differing run ids, or either side missing one - are indistinguishable
on the outbound path, so both are dropped from tracking (fail open) rather
than guessed at.

Whatever the classification - eligible, ordinary, uncorrelatable, ambiguous,
or an internal guard defect - the handler returns the host's explicit
`{ outcome: "pass" }` gate decision, never `void`. The exported host type
(`PluginHookBeforeAgentRunResult`) allows `void`, but on the installed build
`runBeforeAgentRun` blocks a `null` handler result outright
(`before_agent_run returned an invalid decision`), and an `undefined` result
avoids the same normalization only through an incidental `!== undefined`
guard in the generic hook-merge layer - so a `void`-returning handler is one
host refactor away from blocking every run it observes. The target-build
smoke pins both behaviors with synthetic probes and asserts every scenario
yields an explicit pass decision from the installed runner.

**Receipt (`message_sent`).** A publication receipt is counted only when the
send succeeded, carries a non-empty message id, correlates to the tracked run
(session key, with run-id consistency checked when both sides carry one -
the installed outbound path never populates `runId` on `message_sent`, which
the target-build smoke pins through the host's own sent-message mappers),
and was delivered to the **exact original owner conversation** captured from
trusted hook context at registration - never from free text in the prompt.
A failed send followed by an exact-target success passes; a success to any
other destination does not count; duplicate matching events are idempotent.
A correlated successful send whose destination metadata is absent is
reported as `acp_lifecycle_guard.receipt.target_unverifiable`, distinct from
a verified mismatch, and never counts as a receipt.

Destination comparison uses bounded normalization mirroring the installed
host's conversation-target vocabulary (`channel:`, `chat:`, `direct:`,
`dm:`, `group:`, `thread:`, `user:`, plus the channel's own name): wrappers
are stripped **repeatedly** (bounded) on both sides, because the two sides
pass through the host's single-strip normalization a different number of
times. Prefixes compare case-insensitively; the remaining conversation id
keeps its case, since ids are case-sensitive on some channels. Unknown
prefixes are preserved, never guessed at.

**Decision (`before_agent_finalize`).** If an eligible checkpoint reaches
finalize without a receipt:

- `observe` (the default) records the stable, content-free reason code
  `acp_lifecycle_guard.receipt.missing` and never intervenes;
- `enforce` returns the host's `revise` result with a fixed bounded
  instruction requiring one explicit messaging-tool send to the original
  conversation, a stable idempotency key, and a bounded `maxAttempts`; each
  requested round is logged with
  `acp_lifecycle_guard.receipt.revise_requested`.

**Cleanup (`agent_end`).** State is removed deterministically when the ending
run's identity **provably agrees** with the tracked one: both run ids present
and equal, or both absent (the pinned host builds both hook contexts from the
same run params, so matching absence is the same-run shape). A different or
unprovable run can never silently disarm a pending checkpoint.

Bounded state never disarms silently. Past the TTL a pending entry becomes a
**stale tombstone**: enforcement is disarmed (a run that old is never
revised on stale correlation) but a finalize without a receipt is still
reported explicitly with `acp_lifecycle_guard.receipt.stale_missing`, a late
exact-target receipt still confirms, and a provable `agent_end` still cleans
up. When the size cap or a new registration displaces entries, every removal
is surfaced with `acp_lifecycle_guard.receipt.evicted` (stale tombstones are
evicted before any fresh pending entry).

**What enforcement can and cannot guarantee.** The installed host's finalize
retry accounting (`normalizeBeforeAgentFinalizeResult`) allows exactly
`maxAttempts` revise rounds per run and idempotency key, then turns further
revise requests into plain continuation: **exhausted retries fail open at the
host - the run finalizes without a receipt**. The target-build smoke drives
the installed helper to prove exactly this sequence. The guard therefore does
not claim fail-closed delivery: what it guarantees is that a missing receipt
is never silent - the exhaustion is logged with
`acp_lifecycle_guard.receipt.revise_exhausted`, and the guard never records or
reports a receipt that did not happen.

The guard's own revise counter bounds **requested** rounds. The installed
host merges finalize results across plugins (another plugin's `finalize`
decision wins over this guard's `revise`) and acknowledges nothing back to
handlers, while its own retry accounting charges the per-run,
per-idempotency-key budget only when a revise decision actually wins the
merge - that accounting is the authoritative bound on **applied** rounds.
When another plugin's decision wins, this guard under-requests rather than
over-revises: it degrades toward finalizing without a receipt (this
repository's fail-open direction) and the miss still surfaces through the
exhausted log. The target-build smoke pins both sides of this contract
against the installed build.

## What it deliberately does **not** guard

Guarding something the contract has not fixed would suppress valid operator
messages, so the scope is narrow on purpose:

- **Terminal failure, cancellation, blocker, and tracking-loss reports.** The
  reporting contract only requires these to be "plainly titled" and defines no
  canonical layout. The guard has no strict schema for them and lets them
  through.
- **Payloads that do not begin with a lifecycle marker line.** Classification is
  anchored on the first visible line beginning with the family's marker emoji
  and phrase. A quoted, fenced, prefixed, or paraphrased report is treated as
  ordinary content. The guard fails open on classification and fails closed on
  validation; it is a malformed-delivery safeguard, not a completeness oracle.
- **Truth of the values.** The guard checks shape, not whether the elapsed
  minutes, round index, or counters are accurate.
- **Semantic rules it cannot verify locally**, such as absolute-path or
  raw-command prose inside an otherwise well-formed bullet.

## Configuration

`plugins.entries.acp-lifecycle-guard.config`:

| Key                                | Type    | Default     | Meaning                                                                     |
| ---------------------------------- | ------- | ----------- | --------------------------------------------------------------------------- |
| `enforce`                          | boolean | `true`      | Cancel/block on violation. `false` classifies and logs only.                |
| `blockDirectIntermediateToolCalls` | boolean | `true`      | Block direct message-tool publication of intermediate reports.              |
| `blockNonMainAcpLaunches`          | boolean | `true`      | Block recognized ACP launch routes when the context agent id is not `main`. |
| `ownerCheckpointReceiptMode`       | string  | `"observe"` | Owner-checkpoint receipt completeness: `observe` logs, `enforce` revises.   |
| `maxIntermediateChars`             | integer | `1400`      | Character ceiling for the cadence report (the contract's published cap).    |
| `maxBoundaryReportChars`           | integer | `2000`      | Character ceiling for start / correction-start / completion reports.        |

Out-of-range or non-integer values fall back to the defaults rather than
disabling the guard.

`ownerCheckpointReceiptMode` is deliberately **independent of `enforce`**: the
legacy boolean governs the established shape guards, and turning it on never
activates receipt enforcement. The receipt guard ships observing only;
switching it to `enforce` is a separate, deliberate operator rollout after an
observe-mode soak confirms only genuine misses are logged.

## Host caveat: `before_tool_call` is not the enforcement boundary

`before_tool_call` only sees tool invocations. Outbound lifecycle reports can
also reach a channel through delivery paths that never pass through a message
tool call - scheduled announce delivery, reply dispatch, and other host-owned
outbound routes. A guard built only on `before_tool_call` will therefore appear
to work in local testing while leaving the real publication path unguarded.
That is why `message_sending` is treated here as the authoritative final
safeguard and `before_tool_call` only as defense in depth.

Hook availability and cancellation semantics are host-version dependent. Before
switching this plugin on operationally:

1. run `npm run smoke:target-build` (see below) to confirm the built entry
   registers `message_sending` and cancels as expected against the OpenClaw
   build installed on this machine;
2. install and enable it on the target OpenClaw build (an explicit operator
   action, deliberately not automated by this repository);
3. run it with `enforce: false` first and confirm the expected
   `outcome=observed` log lines appear for a deliberately malformed synthetic
   report;
4. run a **live `message_sending` cancellation smoke** on that build: send a
   synthetic malformed lifecycle report through a real outbound path and
   confirm the delivery is actually suppressed, not merely logged;
5. only then enable enforcement.

Do not infer live cancellation behavior from unit tests. The unit tests prove
the policy; the target-build smoke proves the registration and dispatch wiring;
only the live smoke proves end-to-end delivery suppression on a running host.

## Observability and privacy

The guard never logs, persists, or returns raw prompt text, outbound content,
destinations, message ids, session keys, run ids, or commands. A decision
produces exactly one log line (plus one `receipt.evicted` line when
bounded-state eviction occurred) of the form:

```
[acp-lifecycle-guard] hook=message_sending outcome=cancelled kind=intermediate reason=acp_lifecycle_guard.intermediate.elapsed_drift
[acp-lifecycle-guard] hook=before_agent_finalize outcome=revise kind=receipt reason=acp_lifecycle_guard.receipt.revise_requested
```

`cancelReason` is a bare reason code. Hook metadata is limited to
`{ pluginId, lifecycleKind, reasonCode }`. The receipt guard's revise result
carries only a reason code, the fixed bounded instruction, the stable
idempotency key, and the numeric attempt bound; correlation identifiers live
solely in bounded in-memory state and never leave the process. Reason codes
are stable, prefixed `acp_lifecycle_guard.`, and enumerated in
`src/lifecycle/reason-codes.ts`; a unit test asserts that no other string
shape can be emitted.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run check   # all of the above
```

### Target-build smoke

```bash
npm run build
npm run smoke:target-build
```

`npm test` exercises the pure policy functions. The target-build smoke exercises
the **built** plugin through the **installed** OpenClaw hook runner in phases,
with the long-established guarantees always first. Phase A runs the **shipped
default configuration** (no `pluginConfig` at all) end to end: `dist/index.js`
loads against the real plugin SDK, `register` puts `message_sending`,
`before_tool_call`, and the four receipt hooks into the registry, the global
runner dispatches all of them, a valid completion carrying seconds passes, a
malformed report is cancelled with the expected reason code, ordinary chat
passes, a non-main ACP launch is blocked with
`acp_lifecycle_guard.launch.non_main_agent` while a `main` launch and an
ordinary command pass, and an eligible checkpoint that misses its receipt is
**observed, never revised** - proving the shipped observe default.

Phase B re-registers with `ownerCheckpointReceiptMode: "enforce"` and proves,
against the installed runner and the installed harness finalize helper: an
eligible cron checkpoint correlates on **both** installed context shapes
(without `jobId`, the embedded-runner shape, and with an inert `jobId`, the
CLI-runner shape); a failed send followed by an exact-target success is
accepted as a receipt while a wrong-target success is not; duplicate receipts
are idempotent; a `message_sent` built by the **installed sent-message
mappers** (imported from `openclaw/plugin-sdk/hook-runtime`) confirms a
receipt while pinning the delivery-path contract - no `runId` on either
projection, `sessionKey` preserved, and the raw wrapper-prefixed `to` passed
through as `conversationId`; a missing receipt in enforce mode yields the
bounded revise result; the host's own retry accounting allows exactly the
bounded revise rounds and then **continues (fails open)**, with the guard
logging `acp_lifecycle_guard.receipt.revise_exhausted`; a near-miss cron
marker emits `acp_lifecycle_guard.receipt.marker_drift` without tracking;
`agent_end` cleans state deterministically; and ordinary and uncorrelatable
turns bypass everything.

Phase C composes the guard with synthetic second plugins: an earlier
higher-priority `before_agent_run` block short-circuits and a later
lower-priority block still wins over the guard's explicit pass (a block is
never un-stuck); a synthetic plugin's `finalize` decision wins the installed
merge, discarding the guard's revise request while the guard conservatively
under-requests and still logs the miss; and the installed finalize budget is
proven to be charged per run and idempotency key **only when a revise
decision wins the merge**. Synthetic probes also pin the installed gate's
nullish normalization (`null` blocks outright; `undefined` survives only an
incidental merge-layer guard). Throughout, no raw prompt text, outbound
content, command text, agent id, or correlation identifier reaches a log
line, a cancel/block/revise reason, or hook metadata. It fails with an
explicit message if the installed runner no longer exposes the expected
dispatch contracts.

It is non-invasive: it copies `dist` into a private temp directory, links that
directory's `node_modules/openclaw` at the installed package, redirects
`OPENCLAW_HOME` into the same directory, and removes everything on exit. It
never installs, enables, or activates the plugin, never reads or writes OpenClaw
config, and never contacts Gateway. It needs OpenClaw present locally, so it is
not part of `npm run check` or CI; set `OPENCLAW_SMOKE_PACKAGE_ROOT` if OpenClaw
is not installed globally.

The OpenClaw host is an **optional peer dependency**, so the test and typecheck
lanes do not download it. `src/host-contract.ts` mirrors the hook types this
plugin consumes from `openclaw@2026.7.1-2`, and
`src/types/openclaw-plugin-sdk.d.ts` declares the single SDK subpath imported at
runtime (`openclaw/plugin-sdk/plugin-entry`). When the host contract changes,
update both files together.

## Layout

```
src/
  index.ts                 plugin entry (definePluginEntry)
  register.ts              hook wiring + content-free logging
  config.ts                config resolution
  host-contract.ts         mirrored host hook types
  policy/outbound.ts       message_sending decision (pure)
  policy/tool.ts           before_tool_call report decision (pure)
  policy/launch.ts         before_tool_call ACP launch decision (pure)
  receipt/checkpoint.ts    owner-checkpoint receipt state + decisions (pure)
  lifecycle/classify.ts    lifecycle candidate classification
  lifecycle/layouts.ts     canonical line layouts
  lifecycle/validate.ts    strict layout validation
  lifecycle/normalize.ts   transport-level normalization
  lifecycle/reason-codes.ts stable reason codes
test/                      unit tests (node --test)
  smoke/                   target-build smoke against the installed host
```

## License

MIT
