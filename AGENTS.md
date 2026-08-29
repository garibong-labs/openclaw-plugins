# Contributor and agent guide

This repository is **public**. Treat every file as permanently published the
moment it is committed, including files that are later deleted.

## Public-repository safety rules

Never commit, and never place in a commit message, branch name, issue, or test
fixture:

- channel ids, guild/server ids, thread ids, message ids, or user ids;
- session keys, run ids, cron job ids, process handles, or PTY/transport handles;
- API keys, tokens, cookies, webhook URLs, or any other credential;
- local absolute paths (`/Users/...`, `/home/...`, `C:\...`) or machine names;
- private or operator-authored prompts, system prompts, or agent instructions;
- production message content, transcripts, screenshots, or delivery receipts;
- incident details, internal ticket references, or private policy documents.

Test fixtures must be **synthetic**. Use placeholder values such as
`example-repo`, `feat/example`, `example-harness`, and `example-model-1`. If a
scenario cannot be reproduced without a real identifier, the scenario belongs in
a private repository, not here.

Runtime code follows the same rule:

- never log, persist, or return raw outbound message content;
- emit stable, prefixed reason codes and bounded metadata only;
- treat hook `blockReason` / `cancelReason` strings as things an operator will
  read in a log, and keep them free of payload text.

## Repository conventions

- One top-level directory per plugin; the directory name matches the plugin id.
- Every plugin ships `package.json`, `openclaw.plugin.json`, `README.md`, and
  `CHANGELOG.md`.
- Plugins are versioned independently. `package.json#version`,
  `openclaw.plugin.json#version`, and the `marketplace.json` entry version must
  stay in sync; `scripts/check-marketplace.mjs` enforces this.
- Runtime entries in `package.json#openclaw.extensions` point at built
  JavaScript under `./dist/`. TypeScript sources are for development only.
- Imports use focused SDK subpaths (`openclaw/plugin-sdk/<subpath>`), never the
  deprecated root barrel.
- Keep runtime dependencies at zero where possible. The OpenClaw host is an
  optional peer dependency, not a build dependency.

## Testing conventions

- Policy and validation logic lives in pure modules with no host access, no
  I/O, and no logging. Hook wiring is a thin translation layer on top.
- Tests run on the Node baselines OpenClaw supports for plugin development
  (22.22.3+, 24.15+, 25.9+) using the built-in `node --test` runner.
- Every plugin must pass `npm run check` (typecheck, unit tests, build) before
  a change is committed.
- New guard behavior needs tests for all four axes: the valid canonical case,
  the malformed case, the "must not touch this" bypass case, and the
  observability case (hook return shape plus a no-raw-content log assertion).
- Unit tests prove the pure policy, not the host wiring. Behavior that depends
  on hook registration or dispatch also needs a target-build smoke that drives
  the built entry through the installed OpenClaw hook runner from a disposable
  temp directory. Such a smoke stays out of `npm run check` and CI, because it
  requires a local OpenClaw install.

## Boundaries for automated agents

Changes in this repository are limited to this repository. Do not modify
OpenClaw core, skill repositories, local OpenClaw configuration, installed
plugins, Gateway state, or cron jobs as part of a change here. Do not install,
enable, or activate a plugin, and do not restart a Gateway; those are operator
actions performed deliberately after review.
