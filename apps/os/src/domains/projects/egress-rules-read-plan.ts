/**
 * When an egress request needs the project's rules, this decides whether the
 * Project Durable Object may answer from the copy it already holds.
 *
 * The rules live in the project processor's fold on the root stream; reading
 * them is a cross-Durable-Object snapshot (~100–200 ms warm, seconds cold),
 * and it used to sit in front of EVERY provider dial older than five seconds.
 * Rules only change through committed root-stream batches, and every such
 * batch is delivered to the Project DO (`indexCommittedBatchFacts`), so the
 * held copy is exact until that delivery marks it invalidated. The staleness
 * bound is a safety net for a missed delivery and refreshes in the background
 * rather than on the caller's path.
 */
export const EGRESS_RULES_MAX_QUIET_MS = 60_000;

export type EgressRulesReadPlan =
  /** No usable copy, or a root-stream commit invalidated it: read before answering. */
  | "await-refresh"
  /** The copy is exact as far as deliveries say, but old: answer now, refresh behind. */
  | "serve-and-refresh"
  /** Answer from the held copy. */
  | "serve";

export function egressRulesReadPlan(input: {
  hasCachedRules: boolean;
  invalidatedByRootCommit: boolean;
  readAtMs: number;
  nowMs: number;
}): EgressRulesReadPlan {
  if (!input.hasCachedRules || input.invalidatedByRootCommit) return "await-refresh";
  if (input.nowMs - input.readAtMs > EGRESS_RULES_MAX_QUIET_MS) return "serve-and-refresh";
  return "serve";
}
