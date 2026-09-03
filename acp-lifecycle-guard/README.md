# openclaw-acp-lifecycle-guard

Native OpenClaw plugin that validates canonical ACP lifecycle reports and owns
the durable, fenced handoff between one ACP run and one report-pump automation.

- Plugin id: `acp-lifecycle-guard`
- Required OpenClaw version: `2026.8.1` or newer
- Runtime dependencies: none
- Primary tool: `acp_report_controller`

## Controller contract

The controller exposes four actions through one plugin tool:

- `register`: main-owner only. Binds an opaque lease token to the exact owner
  session/run, ACP transport file and process handle, report-pump job,
  Discord conversation/account, and attested skills pump/transport entries.
- `status`: available to an authenticated `main` owner run in the exact
  registered owner session, or to the exact bound cron session. This permits
  inspection after the registering run has ended without widening sessions.
- `tick`: available only to `main` running as the exact `cron:<jobId>` session.
  It imports the attested skills pump in-process and returns either a fresh
  canonical `message`, `none_due`, or a terminal control status.
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

The token is hashed before persistence and is never logged or returned. The
registry lives below OpenClaw's state directory, uses a `0700` directory and a
`0600` atomically replaced file, and is capped at 64 active leases. The
transport and optional snapshot must be owner-only regular files. Every path
must be absolute, non-symlinked, and owned by the current user. The mutable
transport remains bound to that exact private path while its atomically
replaced contents evolve. The snapshot and two trusted skills entries are
content-hash attested and must remain unchanged; the skills entries must also
have their canonical basenames in one directory.

Duplicate tokens, jobs, transports, and owner run bindings are rejected. The
caller cannot supply a job identity to `tick`; the controller derives it from
the host-authenticated cron session key and compares it with the registration.

## Authoritative delivery

`message_sending` remains the strict layout gate. For a controller publication
it additionally hashes the complete logical content and requires exactly one
pending attempt with the same cron session, Discord destination, and account.
No candidate, stale candidate, ambiguous digest, or scope mismatch is guessed.
Unrelated traffic stays fail-open.

`message_sent` acknowledges only host-proven success for that same full logical
content and route. OpenClaw 2026.8.1 emits one logical sent event after all
chunks settle; its canonical message id is the last provider message id for a
multipart delivery. A partial delivery emits failure and is never accepted.
For Discord the controller derives `deliveredAt` from the snowflake when the
hook has no provider timestamp, then calls the attested transport's fenced
`acknowledgeHostTransportReport` with private state retained in memory. None of
those values appears in public content, hook metadata, or logs.

Failed sends, uncertain delivery, expired/stale fences, acknowledgement errors,
and pump errors retain the durable lease. A host failure without a message ID
is reported as `delivery_missing`; a failure with a possible provider message
or an acknowledgement failure is `delivery_uncertain`. The controller does not
publish either attempt again before the skills transport's attested attempt TTL
expires. A later tick may then ask the pump to reclaim it under a new fence.
`tracking_lost` permanently stops publication. The controller never starts or
relaunches ACP.

After terminal acknowledgement, the next tick returns a `terminal_acked`
status, the authenticated current job id, and the fixed cleanup value
`remove_current_job_then_release_lease`. Tracking loss returns the same cleanup
fields with status `tracking_lost`. The isolated cron run must remove only its
own job using the host's self-removal restriction, then release the lease.
Every release is denied while active.

The tool declares a closed structured output schema for every success, quiet,
terminal, delivery, and error result. A pending result includes the exact
registered Discord channel, account, and conversation route; scripts consume
these declared fields directly rather than parsing rendered tool content.

## Automation payload

[templates/report-controller-automation.json](templates/report-controller-automation.json)
is the exact deterministic every-600000-ms isolated job template. Replace only
`LEASE_TOKEN` while preparing the private job. Its OpenClaw 2026.8.1 `script`
payload runs in the headless code-mode executor with a 60-second timeout, a
five-call budget, and an exact three-tool allowlist. It has no model fields,
shell command, static report snapshot, fallback delivery, or prose
interpretation. It forwards the controller's returned message byte-for-byte
with `message(final:false)` to the returned registered route, then performs one
bounded tick. A terminal result removes the returned authenticated current job
and releases only after removal succeeds; every other result stays silent.

The host already restricts a cron run's `automations` tool to introspection and
removal of its own job. The controller independently binds tick and release to
the same job identity.

## Active-lease lifecycle enforcement

The manifest declares the scoped trusted policy
`acp-report-controller-lifecycle-v1`. It applies only to
`acp_report_controller`, `sessions_yield`, and `message`:

- `sessions_yield` is blocked for the exact owner run while its lease is active.
- `message(final:true)` and an omitted `final` are blocked; required lifecycle
  publication uses `message(final:false)` and remains allowed.
- `before_agent_finalize` requests a bounded fail-closed revision while the
  exact owner lease is active.
- `agent_end` emits one bounded, content-free violation and does not release the
  lease.

OpenClaw's ordinary `agent_end` hook is observational and has no cancellation
result. The plugin therefore cannot cancel an end after the host's bounded
finalize revisions are exhausted. Durable persistence is the fallback: an
unavoidable owner end never erases the lease, and the cron controller continues
without the direct owner turn.

Persisted terminal leases remain recoverable after that end: a fresh
owner-authenticated `main` run in the same canonical owner session may inspect
status and release `terminal_acked` or `tracking_lost`. A different session,
agent, unauthenticated sender, or active lease is denied. Tick authority and all
active lifecycle blocking remain bound to the original exact run and exact cron
job.

## Lifecycle validation and migration

Layouts remain positional and bounded: titles, metadata, separators, section
order, one-bullet sections, size ceilings, and forbidden operational subjects
are enforced.

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
disposable directory. It does not install or enable the plugin, modify config,
contact Gateway, or change scheduler state.
