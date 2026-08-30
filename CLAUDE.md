# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Public monorepo of native OpenClaw plugins published by garibong-labs. Each plugin lives in its own top-level directory (directory name == plugin id), ships its own `openclaw.plugin.json` manifest, and is versioned independently. The repo root doubles as an OpenClaw remote marketplace via `marketplace.json` (relative-path sources only).

Read `AGENTS.md` before making changes — it is the authoritative contributor/agent guide. The critical points:

- **This repo is public.** Never commit real identifiers of any kind: channel/message/user/session ids, cron ids, process handles, credentials, webhook URLs, local absolute paths, private prompts, or production message content — not in code, fixtures, commit messages, or branch names. All test fixtures are synthetic (`example-repo`, `example-model-1`, ...).
- **Runtime privacy invariant:** plugins never log, persist, or return raw outbound message content. They emit only stable, prefixed reason codes (e.g. `acp_lifecycle_guard.*`) and bounded metadata. `blockReason`/`cancelReason` strings must stay free of payload text, command text, and agent ids.
- **Agent boundaries:** changes stay inside this repo. Never modify OpenClaw core, local OpenClaw config, installed plugins, Gateway state, or cron jobs; never install, enable, or activate a plugin; never restart a Gateway. Those are deliberate operator actions.

## Commands

Per-plugin development (run inside the plugin directory, e.g. `acp-lifecycle-guard/`):

```bash
npm ci
npm run check        # typecheck + unit tests + build — must pass before committing
npm run typecheck    # tsc -p tsconfig.json (noEmit)
npm test             # node --test test/*.test.ts
npm run build        # tsc -p tsconfig.build.json → dist/
```

Run a single test file / single test:

```bash
node --test test/validate.test.ts
node --test --test-name-pattern="pattern" test/validate.test.ts
```

Tests execute TypeScript directly with Node's built-in runner and type stripping (hence `erasableSyntaxOnly` and `.ts` relative imports in source). Supported Node baselines: 22.22.3+, 24.15+, 25.9+ (CI runs all three).

Repo-level:

```bash
node scripts/check-marketplace.mjs   # validate marketplace.json ↔ plugin manifests (read-only)
```

Target-build smoke (needs a local OpenClaw install; deliberately NOT part of `npm run check` or CI):

```bash
npm run build
npm run smoke:target-build           # set OPENCLAW_SMOKE_PACKAGE_ROOT if OpenClaw isn't installed globally
```

## Architecture

### Marketplace / versioning layer

Each plugin's `package.json#version` is authoritative; `openclaw.plugin.json#version` and its `marketplace.json` entry must match, and `scripts/check-marketplace.mjs` (run in CI) enforces this plus manifest shape. Every plugin keeps its own `CHANGELOG.md`. Runtime entries in `package.json#openclaw.extensions` point at built JS under `./dist/` — TypeScript sources are development-only.

### Plugin design pattern (see `acp-lifecycle-guard/`)

The load-bearing structure, expected of any plugin here:

1. **Pure policy core** — all decision logic lives in pure modules with no host access, no I/O, no logging. In `acp-lifecycle-guard`: `src/policy/*.ts` (one decision function per hook concern: `outbound.ts`, `tool.ts`, `launch.ts`) delegating to `src/lifecycle/*.ts` (classify → normalize → validate against canonical layouts, returning enumerated reason codes from `reason-codes.ts`).
2. **Thin hook wiring** — `src/register.ts` resolves config, calls the pure policy, translates the decision into the host's hook-result shape (`{cancel, cancelReason}` / `{block, blockReason}`), and emits exactly one content-free log line per decision. `src/index.ts` is just `definePluginEntry`.
3. **Mirrored host contract** — `openclaw` is an *optional* peer dependency so test/typecheck lanes never download it. `src/host-contract.ts` mirrors the hook types the plugin consumes and `src/types/openclaw-plugin-sdk.d.ts` declares the one SDK subpath imported at runtime. When the host contract changes, update both files together. Imports use focused SDK subpaths (`openclaw/plugin-sdk/<subpath>`), never the deprecated root barrel.

Guard semantics: **fail open on classification** (unrecognized content passes untouched) and **fail closed on validation** (a recognized-but-malformed report is stopped). `message_sending` is the authoritative enforcement boundary (registered at low priority so it sees final content); `before_tool_call` is defense in depth only — outbound content can reach channels without any tool call, so never build enforcement solely on `before_tool_call`.

### Testing conventions

- Unit tests prove the pure policy, not host wiring. New guard behavior needs all four axes: the valid canonical case, the malformed case, the "must not touch this" bypass case, and the observability case (hook return shape + a no-raw-content log assertion).
- Behavior depending on hook registration/dispatch needs the target-build smoke (`test/smoke/target-build.ts`), which drives the **built** entry through the **installed** OpenClaw hook runner from a disposable temp directory. It installs/enables/activates nothing and stays out of `npm run check` and CI.
- Keep runtime dependencies at zero where possible.
