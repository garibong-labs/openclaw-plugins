# openclaw-plugins

Public monorepo for native [OpenClaw](https://openclaw.ai) plugins published by
garibong-labs. Each plugin lives in its own top-level directory, ships its own
`openclaw.plugin.json` manifest, and is versioned independently. The repository
root doubles as an OpenClaw remote marketplace.

## Plugin catalog

| Plugin                         | Directory              | Plugin id             | Version | What it does                                                                                                                       |
| ------------------------------ | ---------------------- | --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw-acp-lifecycle-guard` | `acp-lifecycle-guard/` | `acp-lifecycle-guard` | 0.4.3   | Validates canonical ACP lifecycle reports, cancels malformed ones before delivery, and tracks owner-checkpoint delivery receipts. |

## Install from the marketplace

```bash
openclaw plugins marketplace list garibong-labs/openclaw-plugins
openclaw plugins install openclaw-acp-lifecycle-guard --marketplace garibong-labs/openclaw-plugins
```

`marketplace.json` at the repository root exposes each plugin through a relative
path source, which is the only source kind OpenClaw accepts from a remote
marketplace manifest.

> **Installing is not activating.** Installing a plugin does not enable it, and
> enabling it does not load it into a running Gateway. Enabling
> (`openclaw plugins enable <plugin-id>` or
> `plugins.entries.<plugin-id>.enabled: true`) and restarting the Gateway are
> separate, deliberate operator actions. Nothing in this repository performs
> them for you, and no plugin here should be treated as active until an operator
> has verified its behavior on the target build.

## Local development

```bash
cd acp-lifecycle-guard
npm ci
npm run check      # typecheck + unit tests + build
```

When an OpenClaw install is present locally, `acp-lifecycle-guard` can also drive
its built entry through the installed hook runner. The smoke stages the build in
a disposable temp directory and installs, enables, and activates nothing:

```bash
npm run build
npm run smoke:target-build
```

To exercise a plugin against a local OpenClaw install without copying it into
the managed plugin root:

```bash
openclaw plugins install -l ./acp-lifecycle-guard
```

A linked install is still inert until the plugin is explicitly enabled.

To validate the marketplace manifest itself (read-only, no install):

```bash
node scripts/check-marketplace.mjs
```

## Privacy boundary

This repository is public. Everything committed here is generic and synthetic:

- no channel ids, message ids, user ids, session keys, cron ids, or process
  handles;
- no local absolute paths, credentials, tokens, or private prompts;
- no production message fixtures, transcripts, or incident details.

Plugins in this repository are held to the same standard at runtime: they log
stable reason codes and bounded metadata, never raw message content. See
[SECURITY.md](SECURITY.md) and [AGENTS.md](AGENTS.md).

## Versioning

Each plugin is versioned independently, starting at `0.1.0`, and follows
semantic versioning:

- the plugin's `package.json` version is authoritative;
- `openclaw.plugin.json#version`, the `marketplace.json` entry version, and the
  root plugin catalog version must match it (CI enforces this);
- every plugin keeps its own `CHANGELOG.md`;
- the repository itself is not versioned as a unit, and `marketplace.json`
  carries its own manifest version for catalog consumers.

## License

[MIT](LICENSE).
