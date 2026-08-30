/**
 * ACP launch-route policy - defense in depth, not the enforcement boundary.
 *
 * Only the main OpenClaw agent is expected to launch ACP. Another OpenClaw
 * agent reaching a recognized ACP launch route through the shared orchestrator
 * is outside the intended lifecycle, so a recognized launch call passes only
 * when the hook context identifies the caller as exactly `main`.
 *
 * Recognition is deliberately narrow and fails open: only the canonical launch
 * entrypoints (matched by basename inside an inspectable shell command) and an
 * explicit `runtime: "acp"` session spawn are treated as ACP launches. An
 * uninspectable command, an unrelated shell command, an unrelated session
 * spawn, and every other tool call pass through untouched. Human-operated
 * actions never reach this hook, so they are unaffected by construction.
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

/** Shell metacharacters that separate command words alongside whitespace. */
const COMMAND_SEPARATORS = /[\s;|&()<>]+/u;

/** Quote characters stripped from the ends of a command word. */
const EDGE_QUOTES = /^["']+|["']+$/gu;

export type LaunchDecision =
  | { action: "pass" }
  | { action: "block"; reasonCode: ReasonCode }
  | { action: "observe"; reasonCode: ReasonCode };

/**
 * True when an inspectable shell command references a canonical ACP launch
 * entrypoint by basename. A non-string command cannot be inspected and is not
 * treated as a launch (recognition fails open, consistent with the rest of
 * this plugin).
 */
export function commandInvokesAcpEntrypoint(command: unknown): boolean {
  if (typeof command !== "string") {
    return false;
  }
  for (const word of command.split(COMMAND_SEPARATORS)) {
    const unquoted = word.replace(EDGE_QUOTES, "");
    const basename = unquoted.split(/[\\/]/u).pop() ?? "";
    if (ACP_LAUNCH_ENTRYPOINT_BASENAMES.includes(basename.toLowerCase())) {
      return true;
    }
  }
  return false;
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
