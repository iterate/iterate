import { CONFIG_REPO_PATH } from "../repos/paths.ts";
import { SCHEDULER_PRIMARY_PATH } from "../scheduler/utils.ts";
import { EMAIL_INTEGRATION_STREAM_PATH } from "../email/utils.ts";
import type { StreamSubscriptionListEntry } from "../streams/stream-durable-object.ts";

/**
 * The fan-out bound for `itx.subscriptionHealth()`: every scan dials one
 * Durable Object per stream (waking it), so agent streams are capped to the
 * most recently active ones — an old idle agent's subscriptions can only
 * carry stale facts anyway. The well-known platform streams always ride.
 * Callers choose their own bound per scan; this is the default, and
 * {@link clampAgentStreamLimit} keeps any request inside the hard cap.
 */
export const DEFAULT_AGENT_STREAM_LIMIT = 20;

/** No caller widens a scan past this — the fan-out stays bounded by design. */
const MAX_AGENT_STREAM_LIMIT = 100;

/** The effective agent-stream bound for one scan: the default when absent,
 * floored at 0 (platform streams only) and capped at the hard maximum. */
export function clampAgentStreamLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_AGENT_STREAM_LIMIT;
  return Math.min(MAX_AGENT_STREAM_LIMIT, Math.max(0, Math.floor(requested)));
}

/** The streams every scan covers regardless of activity. */
const WELL_KNOWN_HEALTH_STREAM_PATHS = [
  "/",
  CONFIG_REPO_PATH,
  SCHEDULER_PRIMARY_PATH,
  EMAIL_INTEGRATION_STREAM_PATH,
];

/**
 * Severity tiers, in the order the dashboard escalates them:
 * - `halted` — delivery durably gave up; nothing flows until a human resumes
 *   it (red badge);
 * - `lagging` — delivery is failing and backing off right now, so events are
 *   piling up (amber badge);
 * - `informational` — a historical `lastError` on an otherwise-delivering
 *   subscription (the skip policy leaves these standing for a long time);
 *   shown as a quiet line, never a badge — alarm fatigue kills the surface.
 */
export type SubscriptionHealthTier = "halted" | "lagging" | "informational";

/** One troubled subscription in the rollup: its tier plus the delivery facts behind it. */
export type SubscriptionHealthEntry = {
  name: string;
  tier: SubscriptionHealthTier;
  lag: number;
  confirmedOffset: number;
  attempt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  /** When lastError was recorded (ISO); null = unknown age (rows written
   * before the column existed). */
  lastErrorAt: string | null;
};

/** One scanned stream's troubled subscriptions, or the read error that hid them. */
export type StreamSubscriptionHealth = {
  path: string;
  subscriptions: SubscriptionHealthEntry[];
  /** Non-null when the stream could not be read; its subscriptions are unknown. */
  error: string | null;
};

/** What `itx.subscriptionHealth()` returns. */
export type ProjectSubscriptionHealth = {
  generatedAt: string;
  /** Every stream the scan covered — the fan-out bound made visible. */
  scannedPaths: string[];
  /** Only streams with something to report; healthy subscriptions are omitted. */
  streams: StreamSubscriptionHealth[];
};

/**
 * The streams one scan covers: the well-known platform streams plus the most
 * recently active agent streams. `lastActivityAt` comes from the project's
 * streams index; catalog-only paths (streams predating the index) rank last.
 */
export function selectSubscriptionHealthStreamPaths(input: {
  streamsIndex: Record<string, { lastActivityAt: string }>;
  catalogPaths: string[];
  agentStreamLimit: number;
}): string[] {
  const agentPaths = [
    ...new Set(
      [...Object.keys(input.streamsIndex), ...input.catalogPaths].filter((path) =>
        path.startsWith("/agents/"),
      ),
    ),
  ]
    .sort((left, right) => {
      const leftActivity = input.streamsIndex[left]?.lastActivityAt || "";
      const rightActivity = input.streamsIndex[right]?.lastActivityAt || "";
      return rightActivity.localeCompare(leftActivity);
    })
    .slice(0, input.agentStreamLimit);
  return [...WELL_KNOWN_HEALTH_STREAM_PATHS, ...agentPaths];
}

/** One subscription's tier, or null when it is healthy (and omitted). */
export function classifySubscriptionHealth(
  entry: StreamSubscriptionListEntry,
): SubscriptionHealthEntry | null {
  const tier: SubscriptionHealthTier | null =
    entry.status === "halted"
      ? "halted"
      : entry.nextAttemptAt !== null
        ? "lagging"
        : entry.lastError !== null
          ? "informational"
          : null;
  if (tier === null) return null;
  return {
    name: entry.name,
    tier,
    lag: entry.lag,
    confirmedOffset: entry.confirmedOffset,
    attempt: entry.attempt,
    nextAttemptAt: entry.nextAttemptAt,
    lastError: entry.lastError,
    lastErrorAt: entry.lastErrorAt,
  };
}
