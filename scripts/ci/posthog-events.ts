import { createHash } from "node:crypto";

export type PostHogEvent = {
  event: string;
  timestamp?: string;
  uuid: string;
  properties: Record<string, unknown>;
};

/**
 * CI telemetry delivery is downsampled to ZERO: CI test events were 70%+ of
 * all PostHog ingestion (millions of events per month) and the bill has to
 * come down. Telemetry artifacts are still written and uploaded to CI storage
 * — only the PostHog egress is dropped. Every CI event flows through this one
 * chokepoint, so restoring delivery (ideally sampled) means reverting this
 * function to its pre-zero implementation in git history (batching, retries,
 * APP_CONFIG_POSTHOG credentials).
 */
export async function sendPostHogEvents(events: PostHogEvent[]) {
  console.log(
    `[ci-telemetry] PostHog delivery is downsampled to zero; dropped ${events.length} event(s)`,
  );
}

export function systemEvent(
  event: string,
  insertId: string,
  distinctId: string,
  properties: Record<string, unknown>,
  timestamp?: string,
): PostHogEvent {
  return {
    event,
    ...(timestamp && { timestamp }),
    uuid: deterministicEventUuid(insertId),
    properties: {
      distinct_id: distinctId,
      schema_version: 2,
      $process_person_profile: false,
      $insert_id: insertId,
      ...properties,
    },
  };
}

/** UUIDv5 using the RFC URL namespace; PostHog deduplicates retries by this top-level field. */
function deterministicEventUuid(identity: string) {
  const urlNamespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(urlNamespace).update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function durationMs(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return undefined;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
