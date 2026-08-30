/**
 * Plugin configuration resolution.
 *
 * Config comes from `plugins.entries.acp-lifecycle-guard.config` and is validated
 * by the host against `openclaw.plugin.json#configSchema` before it reaches
 * this module. Resolution here is still defensive: unknown or out-of-range
 * values fall back to the canonical defaults rather than disabling the guard.
 */

import {
  DEFAULT_VALIDATION_LIMITS,
  type ValidationLimits,
} from "./lifecycle/validate.ts";

export type GuardConfig = {
  /**
   * When false the guard classifies and logs but never cancels or blocks.
   * Use this for the required live `message_sending` cancellation smoke on a
   * target build before switching enforcement on.
   */
  enforce: boolean;
  /** Defense in depth for direct message-tool publication of cadence reports. */
  blockDirectIntermediateToolCalls: boolean;
  /** Defense in depth for ACP launch routes invoked by a non-`main` agent. */
  blockNonMainAcpLaunches: boolean;
  limits: ValidationLimits;
};

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  enforce: true,
  blockDirectIntermediateToolCalls: true,
  blockNonMainAcpLaunches: true,
  limits: DEFAULT_VALIDATION_LIMITS,
};

const MIN_CHAR_LIMIT = 200;
const MAX_CHAR_LIMIT = 4000;

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readCharLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  if (value < MIN_CHAR_LIMIT || value > MAX_CHAR_LIMIT) {
    return fallback;
  }
  return value;
}

export function resolveGuardConfig(raw: unknown): GuardConfig {
  if (raw === null || typeof raw !== "object") {
    return DEFAULT_GUARD_CONFIG;
  }
  const record = raw as Record<string, unknown>;
  return {
    enforce: readBoolean(record.enforce, DEFAULT_GUARD_CONFIG.enforce),
    blockDirectIntermediateToolCalls: readBoolean(
      record.blockDirectIntermediateToolCalls,
      DEFAULT_GUARD_CONFIG.blockDirectIntermediateToolCalls,
    ),
    blockNonMainAcpLaunches: readBoolean(
      record.blockNonMainAcpLaunches,
      DEFAULT_GUARD_CONFIG.blockNonMainAcpLaunches,
    ),
    limits: {
      maxIntermediateChars: readCharLimit(
        record.maxIntermediateChars,
        DEFAULT_VALIDATION_LIMITS.maxIntermediateChars,
      ),
      maxBoundaryReportChars: readCharLimit(
        record.maxBoundaryReportChars,
        DEFAULT_VALIDATION_LIMITS.maxBoundaryReportChars,
      ),
    },
  };
}
