/**
 * Supported ACP lifecycle families.
 *
 * The guard only recognises the report layouts that the live
 * `acp-progress-reporting` skill documents as canonical:
 *
 * - `start` and `correction-start` (pre-dispatch boundary messages)
 * - `intermediate` (ten-minute cadence report)
 * - `completion` (terminal success report)
 *
 * Terminal failure, cancellation, blocker, and tracking-loss reports are
 * intentionally **not** modelled. The skill only requires them to be "plainly
 * titled" and does not define a canonical layout, so inventing one here would
 * suppress valid operator messages.
 */

export const LIFECYCLE_KINDS = [
  "start",
  "correction-start",
  "intermediate",
  "completion",
] as const;

export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

/** Bounded, content-free lifecycle label safe to place in hook metadata. */
export function isLifecycleKind(value: string): value is LifecycleKind {
  return (LIFECYCLE_KINDS as readonly string[]).includes(value);
}
