/**
 * ACP launch-route policy - defense in depth, not the enforcement boundary.
 *
 * Only the main OpenClaw agent is expected to launch ACP. Another OpenClaw
 * agent reaching a recognized ACP launch route through the shared orchestrator
 * is outside the intended lifecycle, so a recognized launch call passes only
 * when the hook context identifies the caller as exactly `main`.
 *
 * Recognition is deliberately narrow and fails open: only the canonical launch
 * entrypoints (matched by basename in shell command position, either executed
 * directly or as the script argument of `node`) and an explicit
 * `runtime: "acp"` session spawn are treated as ACP launches. A launcher
 * basename that merely appears as data - a `cat`/`rg`/`echo` argument, for
 * example - is not a launch. An uninspectable command, an unrelated shell
 * command, an unrelated session spawn, and every other tool call pass through
 * untouched. Human-operated actions never reach this hook, so they are
 * unaffected by construction.
 */

import type { GuardConfig } from "../config.ts";
import { ReasonCodes, type ReasonCode } from "../lifecycle/reason-codes.ts";

/** Canonical ACP launch entrypoint script basenames. */
export const ACP_LAUNCH_ENTRYPOINT_BASENAMES: readonly string[] = [
  "acp-host-transport-cli.mjs",
  "acpx-foreground-supervisor.mjs",
  "claude-acp-launcher.mjs",
];

/** Shell tools whose `command` parameter can invoke a launch entrypoint. */
export const SHELL_TOOL_NAMES: readonly string[] = ["exec"];

/** Tools that spawn OpenClaw sessions with a selectable runtime. */
export const SESSION_SPAWN_TOOL_NAMES: readonly string[] = ["sessions_spawn"];

/** The spawn runtime value that launches an ACP session. */
export const ACP_SPAWN_RUNTIME = "acp";

/** The only hook-context agent id allowed to invoke ACP launch routes. */
export const AUTHORIZED_LAUNCH_AGENT_ID = "main";

/** Runner whose first script argument executes the named file. */
const NODE_RUNNER_BASENAME = "node";

/** A leading `NAME=value` environment assignment before the command word. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Characters that end the current shell segment (a new command position). */
const SEGMENT_BREAKS = new Set([";", "|", "&", "(", ")", "\n"]);

/** Characters that end the current word without opening a command position. */
const WORD_BREAKS = new Set([" ", "\t", "\r", "<", ">"]);

export type LaunchDecision =
  | { action: "pass" }
  | { action: "block"; reasonCode: ReasonCode }
  | { action: "observe"; reasonCode: ReasonCode };

/** Lowercased final path component of a shell word. */
function wordBasename(word: string): string {
  return (word.split(/[\\/]/u).pop() ?? "").toLowerCase();
}

/**
 * Split a shell command into segments of whitespace-separated words. Segments
 * start after `;`, `|`, `&`, `(`, `)`, and newlines, so `&&`, `||`, and pipes
 * all open a fresh command position. Quotes group a word and are dropped;
 * their contents (including spaces) are kept verbatim. This is a word
 * splitter, not a shell parser - just enough structure to tell a command
 * position from an argument.
 */
function splitCommandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;

  const endWord = (): void => {
    if (word !== "") {
      words.push(word);
      word = "";
    }
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) {
      segments.push(words);
      words = [];
    }
  };

  for (const char of command) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (SEGMENT_BREAKS.has(char)) {
      endSegment();
    } else if (WORD_BREAKS.has(char)) {
      endWord();
    } else {
      word += char;
    }
  }
  endSegment();
  return segments;
}

/**
 * True when one shell segment invokes a canonical launch entrypoint: the
 * command word itself (after any `NAME=value` prefixes), or the first
 * non-option argument of a `node` command.
 */
function segmentInvokesAcpEntrypoint(words: string[]): boolean {
  let index = 0;
  while (index < words.length && ENV_ASSIGNMENT.test(words[index] ?? "")) {
    index += 1;
  }
  const commandWord = words[index];
  if (commandWord === undefined) {
    return false;
  }
  const commandBasename = wordBasename(commandWord);
  if (ACP_LAUNCH_ENTRYPOINT_BASENAMES.includes(commandBasename)) {
    return true;
  }
  if (commandBasename !== NODE_RUNNER_BASENAME) {
    return false;
  }
  index += 1;
  while (index < words.length && (words[index] ?? "").startsWith("-")) {
    index += 1;
  }
  const script = words[index];
  return (
    script !== undefined &&
    ACP_LAUNCH_ENTRYPOINT_BASENAMES.includes(wordBasename(script))
  );
}

/**
 * True when an inspectable shell command invokes a canonical ACP launch
 * entrypoint in command position - executed directly or as the script
 * argument of `node`. A launcher basename appearing only as data (an argument
 * to `cat`, `rg`, `echo`, ...) is not a launch. A non-string command cannot
 * be inspected and is not treated as a launch (recognition fails open,
 * consistent with the rest of this plugin).
 */
export function commandInvokesAcpEntrypoint(command: unknown): boolean {
  if (typeof command !== "string") {
    return false;
  }
  return splitCommandSegments(command).some(segmentInvokesAcpEntrypoint);
}

/** True when the tool call is a recognized agent-started ACP launch route. */
export function isRecognizedAcpLaunch(event: {
  toolName: string;
  params: Record<string, unknown>;
}): boolean {
  if (SHELL_TOOL_NAMES.includes(event.toolName)) {
    return commandInvokesAcpEntrypoint(event.params.command);
  }
  if (SESSION_SPAWN_TOOL_NAMES.includes(event.toolName)) {
    return event.params.runtime === ACP_SPAWN_RUNTIME;
  }
  return false;
}

/**
 * Decide a recognized ACP launch call. Authorization is exact: only a hook
 * context whose `agentId` is the string `main` may launch. A missing, empty,
 * differently cased, or any other agent id is unauthorized.
 */
export function evaluateAcpLaunch(
  event: { toolName: string; params: Record<string, unknown> },
  context: { agentId?: string | undefined },
  config: GuardConfig,
): LaunchDecision {
  if (!isRecognizedAcpLaunch(event)) {
    return { action: "pass" };
  }
  if (context.agentId === AUTHORIZED_LAUNCH_AGENT_ID) {
    return { action: "pass" };
  }
  if (!config.enforce || !config.blockNonMainAcpLaunches) {
    return { action: "observe", reasonCode: ReasonCodes.LaunchNonMainAgent };
  }
  return { action: "block", reasonCode: ReasonCodes.LaunchNonMainAgent };
}
