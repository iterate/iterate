import { createHash } from "node:crypto";

export type PostHogEvent = {
  event: string;
  timestamp: string;
  uuid: string;
  properties: Record<string, unknown>;
};

/**
 * Delivers CI events to the iterate PostHog project through the batch capture endpoint
 * (https://posthog.com/docs/api/capture#batch-events). Only the CI telemetry sync calls this, with
 * one event per Depot workflow run and job attempt: #2494 cut delivery to zero because per-test
 * events were over 70% of the project's ingestion, and test data stays in the Depot artifacts.
 */
export async function sendPostHogEvents(
  events: readonly PostHogEvent[],
  project: { apiKey: string; host: string },
) {
  // A batch request may carry up to 20 MB; a CI event is under 2 KB, so 1,000 per request stays far
  // below it.
  for (let start = 0; start < events.length; start += 1_000) {
    const batch = events.slice(start, start + 1_000);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${project.host}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: project.apiKey, batch }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
          throw new Error(`PostHog returned ${response.status}: ${await response.text()}`);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (lastError) throw new Error("PostHog CI telemetry delivery failed", { cause: lastError });
  }
}

/**
 * One CI event with no person profile. `insertId` names the occurrence (a Depot attempt ID, say):
 * the top-level `uuid` derives from it, and PostHog deduplicates a re-sent event by that UUID, so a
 * replayed window never counts twice.
 */
export function systemEvent(
  event: string,
  insertId: string,
  distinctId: string,
  properties: Record<string, unknown>,
  timestamp: string,
): PostHogEvent {
  return {
    event,
    timestamp,
    uuid: deterministicEventUuid(insertId),
    properties: {
      distinct_id: distinctId,
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

export function durationMs(start: string | undefined, end: string | undefined) {
  if (!start || !end) return undefined;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
