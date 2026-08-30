# openclaw-acp-lifecycle-guard

Native OpenClaw plugin that prevents **malformed ACP lifecycle reports** from
being delivered.

- Plugin id: `acp-lifecycle-guard`
- Package: `openclaw-acp-lifecycle-guard`
- Hooks: `message_sending` (authoritative), `before_tool_call` (defense in depth)
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

| Key                                | Type    | Default | Meaning                                                                     |
| ---------------------------------- | ------- | ------- | --------------------------------------------------------------------------- |
| `enforce`                          | boolean | `true`  | Cancel/block on violation. `false` classifies and logs only.                |
| `blockDirectIntermediateToolCalls` | boolean | `true`  | Block direct message-tool publication of intermediate reports.              |
| `blockNonMainAcpLaunches`          | boolean | `true`  | Block recognized ACP launch routes when the context agent id is not `main`. |
| `maxIntermediateChars`             | integer | `1400`  | Character ceiling for the cadence report (the contract's published cap).    |
| `maxBoundaryReportChars`           | integer | `2000`  | Character ceiling for start / correction-start / completion reports.        |

Out-of-range or non-integer values fall back to the defaults rather than
disabling the guard.

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

The guard never logs, persists, or returns raw outbound content. A decision
produces exactly one log line of the form:

```
[acp-lifecycle-guard] hook=message_sending outcome=cancelled kind=intermediate reason=acp_lifecycle_guard.intermediate.elapsed_drift
```

`cancelReason` is a bare reason code. Hook metadata is limited to
`{ pluginId, lifecycleKind, reasonCode }`. Reason codes are stable, prefixed
`acp_lifecycle_guard.`, and enumerated in `src/lifecycle/reason-codes.ts`; a unit
test asserts that no other string shape can be emitted.

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
plugin SDK, that its `register` puts `message_sending` and `before_tool_call`
handlers into the registry, that the global runner dispatches both hooks, that a
valid completion carrying seconds passes, that a malformed report is cancelled
with the expected reason code, that ordinary chat passes, that a non-main ACP
launch is blocked with `acp_lifecycle_guard.launch.non_main_agent` while a `main`
launch and an ordinary command pass, and that no raw outbound content, command
text, or agent id reaches a log line, the cancel reason, the block reason, or
the hook metadata. It fails with an explicit message if the installed runner no
longer exposes the expected `before_tool_call` dispatch contract.

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
