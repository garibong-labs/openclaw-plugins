# openclaw-acp-lifecycle-guard

Native OpenClaw plugin that validates canonical ACP lifecycle reports and owns
the durable, fenced handoff between one ACP run and one report-pump automation.

- Plugin id: `acp-lifecycle-guard`
- Required OpenClaw version: `2026.8.1` or newer
- Runtime dependencies: none
- Primary tool: `acp_report_controller`

## Required installation permission

OpenClaw 2026.8.1 does not fully install this non-bundled plugin with
`enabled: true` alone. Its entry must explicitly grant conversation-hook
access:

```json
{
  "plugins": {
    "entries": {
      "acp-lifecycle-guard": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

Without that grant the loader blocks `before_agent_run`,
`before_agent_finalize`, and `agent_end` with the bounded diagnostic
`typed hook "<hook>" blocked because non-bundled plugins must set plugins.entries.acp-lifecycle-guard.hooks.allowConversationAccess=true`.
Do not treat that state as fully functional. An isolated runtime inspect of the
granted configuration must show `acp_report_controller` in `toolNames`, all
expected typed hook registrations, and no tool-registration error or blocked
hook diagnostic. Applying this
configuration and restarting a Gateway are deliberate operator rollout steps;
this package never edits live configuration or restarts services.

## Controller contract

The controller exposes six closed actions through one plugin tool:

- `register`: main-owner only. The trusted tool requester may prove ownership
  directly. When a bridged tool call omits that optional requester bit, the
  controller accepts only a host-proven `before_agent_run` owner admission
  bound to the exact `main` agent, session, and run; an explicit non-owner bit
  is never overridden, and the bridge is revoked at `agent_end`. Registration
  binds an opaque lease token to the exact owner session/run, ACP transport file
  and process handle, report-pump job, Discord conversation/account, and
  attested skills pump/transport entries. It persists the lease in `prepared`;
  registration never authorizes a pump.
- `commit_activation`: main-owner only in the exact registered owner session,
  including a fresh authenticated run. It takes only `action` and `leaseToken`.
  The controller calls the content-attested host transport's
  `confirmHostTransportActivation({ transportFile, processHandle })` and
  requires exactly
  `{ schemaVersion:"acp-host-controller-lease.v1", type:"host_transport_activation_confirmed", processHandle }`
  before persisting `prepared` → `active`. A caller cannot supply activation
  evidence. Failed persistence leaves `prepared`, so this commit is retryable.
- `abort_preactivation`: available to the authenticated main owner in that same
  owner session or the exact registered main cron job, and takes only `action`
  and `leaseToken`. It calls the attested transport's
  `abortHostTransportPreactivation({ transportFile, processHandle })` and
  removes the prepared lease only for exactly
  `{ schemaVersion:"acp-host-controller-lease.v1", type:"host_transport_preactivation_aborted", processHandle }`.
  That transport operation must atomically stop/seal the prepared transport
  and prove ACP mutation never began. Activation confirmation, `started`/ACP
  evidence, post-activation terminal intent, live ambiguity, mismatches, or
  unreadable evidence must fail closed. It can never remove an active lease.
- `status`: available to an authenticated `main` owner run in the exact
  registered owner session, or to the exact bound cron session. This permits
  inspection after the registering run has ended without widening sessions.
- `tick`: available only to `main` running as the exact `cron:<jobId>` session.
  A prepared lease returns a stable error and cannot publish. Once active it
  imports the attested skills pump in-process and returns either a one-shot
  opaque publication token, `none_due`, or a terminal control status.
- `release`: available after `terminal_acked` or `tracking_lost` to an
  authenticated `main` owner run in the exact registered owner session, or to
  the bound cron session. Active manual release is explicitly denied.

Registration requires these fields in addition to `action` and `leaseToken`:

```json
{
  "action": "register",
  "leaseToken": "OPAQUE_RANDOM_LEASE_TOKEN",
  "transportFile": "ABSOLUTE_OWNER_PRIVATE_TRANSPORT_FILE",
  "processHandle": "OPAQUE_PROCESS_HANDLE",
  "jobId": "EXACT_REPORT_PUMP_JOB_ID",
  "destination": {
    "channel": "discord",
    "accountId": "EXACT_DISCORD_ACCOUNT",
    "conversationId": "DECIMAL_DISCORD_DESTINATION"
  },
  "reportPumpEntry": "ABSOLUTE_TRUSTED_ACP_REPORT_PUMP_ENTRY",
  "hostTransportEntry": "ABSOLUTE_TRUSTED_ACP_HOST_TRANSPORT_ENTRY",
  "snapshotFile": "OPTIONAL_ABSOLUTE_OWNER_PRIVATE_SNAPSHOT"
}
```

Successful `register`, `commit_activation`, and `abort_preactivation` outputs
are exactly `{ "status":"prepared" }`, `{ "status":"active" }`, and
`{ "status":"aborted" }`. `status` returns `prepared` or `active`, or the
existing terminal cleanup shape.

If a successful `register` response is lost, replaying the exact same prepared
registration from a fresh authenticated run in the same owner session returns
the same bounded result without creating another lease or using more capacity,
and transfers the lifecycle completion fence to the recovery run. Recovery
compares the token, owner session, job, transport, destination, process,
attested entries, and optional snapshot; any other mismatch or replay after the
lease changes phase fails closed.

The lease token is hashed before persistence and is never logged or returned. The
registry lives below OpenClaw's state directory, uses a `0700` directory and a
`0600` atomically replaced file, and is capped at 64 prepared/active leases.
Repeated preparation failures in one owner session are additionally capped at
four, ordered by `registeredAt`; age alone never deletes a lease. The transport
and optional snapshot must be owner-only regular files. Every path must be
absolute, have no symlink in its resolved path, and be owned by the current
POSIX uid. The direct controller is POSIX-only and degrades closed on a host
without `getuid`; the base lifecycle layout and receipt guard still load. The mutable
transport remains bound to that exact private path while its atomically
replaced contents evolve. The snapshot and two trusted skills entries are
content-hash attested and must remain unchanged; the skills entries must also
have their canonical basenames in one directory.

Duplicate tokens, jobs, transports, and owner run bindings are rejected. The
caller cannot supply a job identity to `tick`; the controller derives it from
the host-authenticated cron session key and compares it with the registration.

The preparation coordinator's exact successful order is automation add/arm,
transport prepare, controller `register` (`prepared`), transport `activate`,
then controller `commit_activation` (`active`). Before activation begins,
cleanup has two distinct ownership branches, both gated on proven removal of
the exact automation job:

- **Persisted prepared lease (including a lost registration response recovered
  as `prepared`).** After exact-job removal is proven, the authenticated owner
  or preparation coordinator calls controller
  `abort_preactivation({ leaseToken })`. Only the controller's exact attested
  preactivation-aborted proof releases that lease. If removal is unproven, the
  lease and job are retained; if abort fails after proven removal, the job stays
  removed and the prepared lease is retained for owner recovery. Active,
  ambiguous, unreadable, or changed transport state also retains the lease.
- **Proven pre-persistence rejection (no controller lease exists).** When
  `register` is deterministically rejected before persistence, the preparation
  coordinator first proves exact-job removal, then directly calls the attested
  `abortHostTransportPreactivation({ transportFile, processHandle })`. This
  branch cleans up the unregistered prepared transport and has no controller
  lease to abort, retain, or release.

A thrown, lost, malformed, or otherwise unresolved registration response is
not a proven pre-persistence rejection. Retain the exact private inputs and job
for byte-identical registration replay; do not remove, abort, release, activate,
or commit. If transport activation succeeds but commit does not, neither
removal nor abort is safe: retain the token privately and retry only
`commit_activation` from a fresh authenticated `main` run in the same canonical
owner session.

The shipped scheduler template treats `lease_prepared` as inert. It returns the
scheduler-safe plain object `{}` without removing the job, aborting or releasing
the lease, sending a message, activating the transport, or committing
activation. This preserves an armed job and a possibly persisted prepared lease
while an owner still holds unresolved registration recovery and can make an
exact replay. There is no time-only expiry because a prepared registry record
may represent a transport that activated just before a failed durable commit.

## Authoritative delivery

`message_sending` remains the strict layout gate. For a controller publication
it additionally hashes the complete logical content and requires exactly one
pending attempt with the same cron session, Discord destination, and account,
after the trusted policy has consumed that attempt's one-shot publication token.
No candidate, stale candidate, ambiguous digest, or scope mismatch is guessed.
Unrelated traffic stays fail-open.

General lifecycle validation continues to normalize CRLF/CR endings, trailing
newlines, variation selectors, and NFC-equivalent text. Controller publication
is intentionally stricter: its content-attested pump must return the current
canonical-builder byte form (NFC, LF-only, no trailing newline, current activity
label and delta grammar). A normalized or migration-form pump result fails
closed with `acp_lifecycle_guard.controller.pump_report_noncanonical` before a
publication token is created. This is required because the transport rebuilds
the canonical report for acknowledgement and checks the receipt digest against
those rebuilt bytes; the controller never publishes a byte variant that could
become unacknowledgeable.

`message_sent` acknowledges only host-proven success for that same full logical
content and route. OpenClaw 2026.8.1 emits one logical sent event after all
chunks settle; its canonical message id is the last provider message id for a
multipart delivery. A partial delivery emits failure and is never accepted.
For Discord the controller derives `deliveredAt` from the snowflake when the
hook has no provider timestamp, then calls the attested transport's fenced
`acknowledgeHostTransportReport` with the exact closed-shape structured report
returned by the pump and private state retained in memory. It never reconstructs
minute-sensitive fields from rendered text. None of those values appears in
public content, hook metadata, or logs.

Failed sends, uncertain delivery, expired/stale fences, acknowledgement errors,
and pump errors retain the durable lease. A host failure without a message ID
is reported as `delivery_missing`; a failure with a possible provider message
or an acknowledgement failure is `delivery_uncertain`. The controller does not
publish either attempt again before the skills transport's attested attempt TTL
expires. A later tick may then ask the pump to reclaim it under a new fence.
`tracking_lost` permanently stops publication. The controller never starts or
relaunches ACP.

After terminal acknowledgement, the next tick returns a `terminal_acked`
status and the fixed cleanup value
`remove_current_job_then_release_lease`. Tracking loss returns the same cleanup
control with status `tracking_lost`. The isolated cron template already holds
its exact job id and must remove only that job using the host's self-removal
restriction, then release the lease.
Every ordinary release is denied while prepared or active.

The tool declares a closed structured output schema for every success, quiet,
terminal, delivery, and error result. Tool `content` and `details` contain only
bounded status/control values: never the report, destination, job id, transport
path, or receipt identifiers. A pending result contains only
`status:"delivery_pending"` and an opaque publication token. The trusted policy
consumes that token once, verifies the exact main cron session and attested
lease, and rewrites the message call to the privately held byte-exact report and
registered route before the real message tool executes.

## Automation payload

[templates/report-controller-automation.json](templates/report-controller-automation.json)
is the exact deterministic every-60000-ms isolated polling job template. Report
eligibility remains transport-owned at each 600000-ms cadence; polling does not
make an intermediate report eligible early. Replace only
`LEASE_TOKEN` and `JOB_ID` while preparing the private job. Its OpenClaw 2026.8.1 `script`
payload runs in the headless code-mode executor with a 60-second timeout, a
five-call budget, and an exact three-tool allowlist. It has no model fields,
shell command, static report snapshot, fallback delivery, or prose
interpretation. It passes only the controller's opaque publication token to
`message(final:false)`; the trusted policy injects the exact report and route,
then the script performs one bounded tick. A terminal result removes its exact
current job and releases only after a strict verifier proves removal from consistent
top-level and plain-object `details` evidence. Prepared and other error results
remain silent and inert: they do not remove the job or invoke
`abort_preactivation`, and return the scheduler-safe plain object `{}`. Any
persisted prepared-lease cleanup remains in the owner-driven preparation
coordinator, while a proven pre-persistence rejection leaves no controller
lease and the coordinator directly aborts the attested transport. Absent,
malformed, negative, failure-bearing, or contradictory removal evidence fails
closed. Every path that does not throw returns an empty object accepted by the
scheduler result parser; every non-cleanup result stays silent.

The host already restricts a cron run's `automations` tool to introspection and
removal of its own job. The controller independently binds tick and release to
the same job identity.

## Lease lifecycle enforcement

The manifest declares the scoped trusted policy
`acp-report-controller-lifecycle-v1`. It applies only to
`acp_report_controller`, `sessions_yield`, and `message`:

- `sessions_yield` is blocked for the exact owner run while its lease is prepared or active.
- `message(final:true)` and an omitted `final` are blocked; required lifecycle
  publication uses the one-shot token with `message(final:false)`. A raw or
  replayed message call from the bound cron job is blocked.
- `before_agent_finalize` requests a bounded fail-closed revision while the
  exact owner lease is prepared or active.
- `agent_end` emits one bounded, content-free violation and does not release the
  lease.

OpenClaw's ordinary `agent_end` hook is observational and has no cancellation
result. The plugin therefore cannot cancel an end after the host's bounded
finalize revisions are exhausted. Durable persistence is the fallback: an
unavoidable owner end never erases the lease, and the cron controller continues
without the direct owner turn.

Persisted terminal leases remain recoverable after that end: a fresh
owner-authenticated `main` run in the same canonical owner session may commit a
proven activation, abort a transport-proven preactivation exit, inspect status,
and release `terminal_acked` or `tracking_lost`. A different session, agent,
unauthenticated sender, prepared ordinary release, or active release is denied.
Tick authority and lifecycle blocking remain bound to the original exact run
and exact cron job.

## Lifecycle validation and migration

Layouts remain positional and bounded: titles, metadata, separators, section
order, one-bullet sections, size ceilings, and forbidden operational subjects
are enforced.

The harness metadata boundary is closed to exactly `Claude Code` and `Codex`,
matching the controller parser. Any other harness label is metadata drift, so a
report accepted by the layout guard cannot later fail controller parsing solely
because of harness identity.

The current `acp-reporting-v3` intermediate form is `Δ<N> · <result>` for a
positive delta. The historical `Δ+<N> <result>` form remains accepted as the
single migration alternative; it is never emitted or rewritten. `Δ0` retains
its exact canonical sentence.

Terminal validation accepts v3 completed, cancelled, and failed title/outcome
pairs. The elapsed slot accepts normalized minutes, optional bounded seconds,
or the builder's `측정 불가`. The next-step bullet is a structured single-line
slot rather than one hard-coded sentence. Fixed layout, size, bullet shape, and
the forbidden operational-content screen still apply.

The earlier owner-checkpoint v1 receipt observer remains available for staged
migration. It is separate from controller leases and cannot authorize a pump.

## Verification

```sh
npm run check
npm run smoke:target-build
```

The target-build smoke uses the locally installed OpenClaw package from a
disposable directory. It drives the real plugin loader/registry twice: the
permissioned configuration proves the tool and all hooks register without a
diagnostic; the enable-only configuration proves the three conversation hooks
produce the expected bounded diagnostic. It does not install or activate the
plugin, modify live config, contact Gateway, or change scheduler state.

The automation contract changed in this correction. The matching
`openclaw-skills` PR #75 must adopt the same opaque-token message call and
`JOB_ID` cleanup/recovery template before coordinated rollout; this repository
does not modify that separate project.
