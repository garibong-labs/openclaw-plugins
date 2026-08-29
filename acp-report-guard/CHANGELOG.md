# Changelog

All notable changes to `openclaw-acp-report-guard` are documented here. This
plugin is versioned independently of the repository and follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Completion reports using the minute-plus-seconds elapsed form (`17분 31초`)
  were cancelled with `acp_report_guard.completion.duration_drift`. The
  completion duration grammar now accepts both the minute-only and the
  minute-plus-seconds form, with seconds bounded to `0`-`59`. Malformed
  durations (`17분 60초`, `17분 31`, `17분31초`) still fail, and the metadata
  line and round grammar are unchanged.

### Added

- `npm run smoke:target-build`: a disposable target-build smoke that drives the
  built plugin through the installed OpenClaw hook runner and asserts
  `message_sending` registration, a passing completion with seconds, a cancelled
  malformed report, passing ordinary chat, and no raw outbound content in logs,
  the cancel reason, or hook metadata. It does not install, enable, or activate
  the plugin, does not touch OpenClaw config, and does not contact Gateway.

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
