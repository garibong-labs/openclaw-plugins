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
  `cron` plus a cron job id - and the bounded correlation fields the host
  exposes there (session key, channel, conversation target id); and
- the checkpoint prompt's **first line** is exactly the public marker
  `[owner-progress-checkpoint:v1]`.

The marker alone is never authority: an interactive turn, arbitrary user text
carrying the marker, a non-cron run, or a run whose context lacks the
correlation fields is left completely untouched. Two pending runs sharing one
session key cannot be told apart on the outbound path, so both are dropped
from tracking (fail open) rather than guessed at.

**Receipt (`message_sent`).** A publication receipt is counted only when the
send succeeded, carries a non-empty message id, correlates to the tracked run
(session key, with run-id consistency checked when both sides carry one), and
was delivered to the **exact original owner conversation** captured from
trusted hook context at registration - never from free text in the prompt.
A failed send followed by an exact-target success passes; a success to any
other destination does not count; duplicate matching events are idempotent.

**Decision (`before_agent_finalize`).** If an eligible checkpoint reaches
finalize without a receipt:

- `observe` (the default) records the stable, content-free reason code
  `acp_lifecycle_guard.receipt.missing` and never intervenes;
- `enforce` returns the host's `revise` result with a fixed bounded
  instruction requiring one explicit messaging-tool send to the original
  conversation, a stable idempotency key, and a bounded `maxAttempts`.

**Cleanup (`agent_end`).** State is removed deterministically when the tracked
run ends. Entries are additionally bounded by a size cap (oldest evicted) and
a TTL, so abandoned runs cannot leak memory.

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
produces exactly one log line of the form:

```
[acp-lifecycle-guard] hook=message_sending outcome=cancelled kind=intermediate reason=acp_lifecycle_guard.intermediate.elapsed_drift
[acp-lifecycle-guard] hook=before_agent_finalize outcome=revise kind=receipt reason=acp_lifecycle_guard.receipt.missing
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
the **built** plugin through the **installed** OpenClaw hook runner, and proves
what a pure-function test cannot: that `dist/index.js` loads against the real
plugin SDK, that its `register` puts `message_sending`, `before_tool_call`,
and the four receipt hooks into the registry, that the global runner
dispatches all of them, that a valid completion carrying seconds passes, that
a malformed report is cancelled with the expected reason code, that ordinary
chat passes, and that a non-main ACP launch is blocked with
`acp_lifecycle_guard.launch.non_main_agent` while a `main` launch and an
ordinary command pass.

For the receipt guard it additionally proves, against the installed runner and
the installed harness finalize helper: an eligible cron checkpoint correlates;
a failed send followed by an exact-target success is accepted as a receipt
while a wrong-target success is not; duplicate receipts are idempotent; a
missing receipt in enforce mode yields the bounded revise result; the host's
own retry accounting allows exactly the bounded revise rounds and then
**continues (fails open)**, with the guard logging
`acp_lifecycle_guard.receipt.revise_exhausted`; `agent_end` cleans state
deterministically; ordinary and uncorrelatable turns bypass everything; and no
raw prompt text, outbound content, command text, agent id, or correlation
identifier reaches a log line, a cancel/block/revise reason, or hook metadata.
It fails with an explicit message if the installed runner no longer exposes
the expected dispatch contracts.

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
