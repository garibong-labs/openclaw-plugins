# Security policy

## Scope

This repository contains OpenClaw plugins that run in-process inside a user's
own Gateway. A plugin here can observe outbound message content and tool
parameters through OpenClaw plugin hooks, so defects that leak content or that
suppress delivery incorrectly are treated as security-relevant.

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do **not** open a public
issue for an unfixed vulnerability.

Use GitHub's **Report a vulnerability** flow (Security → Advisories) on this
repository. That is the only supported private reporting channel; please do not
route reports through other addresses or channels.

Include:

- the affected plugin and version;
- a description of the impact;
- minimal reproduction steps using **synthetic** data only.

Do not include real channel ids, message ids, user ids, session keys, tokens,
transcripts, or any other production identifier in a report. If a reproduction
appears to require one, describe its shape instead and we will work out a
synthetic equivalent.

Expect an acknowledgement within 7 days. Fixes are released as a patch version
of the affected plugin with an entry in that plugin's `CHANGELOG.md`.

## Supported versions

Only the latest released version of each plugin receives fixes. Plugins are
versioned independently; see the catalog in [README.md](README.md).

## Design commitments

Plugins in this repository:

- never log, persist, or transmit raw outbound message content;
- emit only stable, prefixed reason codes and bounded metadata;
- keep policy decisions in pure, unit-tested modules;
- fail open on classification (unrecognized content is left alone) and fail
  closed on validation (a recognized but malformed report is stopped), so a
  guard defect degrades toward delivering a message rather than silently
  destroying unrelated traffic.

## Operator responsibility

Installing a plugin from this repository does not enable it, and enabling it
does not load it into a running Gateway. Verify the behavior of any delivery- or
tool-affecting plugin on your target OpenClaw build before enabling it in an
environment you depend on.
