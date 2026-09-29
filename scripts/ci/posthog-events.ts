import { createHash } from "node:crypto";
import { fetchRetryingPlatformFailures } from "@iterate-com/shared/platform-retry";
import { z } from "zod";

export type PostHogEvent = {
  event: string;
  timestamp: string;
  uuid: string;
  properties: Record<string, unknown>;
};

/**
 * Delivers CI events to the iterate PostHog project through the batch capture endpoint
 * (https://posthog.com/docs/api/capture#batch-events): the CI telemetry sync's, one per Depot
 * workflow run and job attempt, and the health job's PR time to green and latency measurements
 * (scripts/monitors/health.ts). Never one per test, which would be most of the project's
 * ingestion: per-test data lives in the test evidence in R2 (docs/test-evidence.md).
 *
 * A batch PostHog failed is sent again (fetchRetryingPlatformFailures): PostHog deduplicates a
 * re-sent event by its UUID (systemEvent), so a batch that landed after all counts once. A batch it
 * answered 200 may still have been dropped: only `queryPostHog` shows what it kept.
 */
export async function sendPostHogEvents(
  events: readonly PostHogEvent[],
  project: { apiKey: string; host: string },
) {
  // A batch request may carry up to 20 MB; a CI event is under 2 KB, so 1,000 per request stays far
  // below it.
  for (let start = 0; start < events.length; start += 1_000) {
    const batch = events.slice(start, start + 1_000);
    const response = await fetchRetryingPlatformFailures(
      `POST ${project.host}/batch/`,
      (signal) =>
        fetch(`${project.host}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: project.apiKey, batch }),
          signal,
        }),
      { area: "posthog", idempotent: true, timeoutMs: 15_000 },
    );
    if (!response.ok)
      throw new Error(
        `PostHog CI telemetry delivery failed: ${response.status} ${await response.text()}`,
      );
  }
}

/**
 * THE READ-BACK: the rows of one HogQL query on the iterate project, "iterate (prd)" (id 115112) in
 * PostHog EU, the project `sendPostHogEvents` delivers to. A delivery's answer proves nothing:
 * capture answers 200 `{"status":"Ok"}` to a batch it drops because the organization is over its
 * billing limit, keeping only the batch's `$exception` events ("Event capture still returns `200`
 * when your project is over its billing quota", https://posthog.com/docs/api; `BillingLimit` in
 * https://github.com/PostHog/posthog/blob/master/rust/capture/src/v0_endpoint.rs), so only a query
 * of what PostHog holds shows what landed. `{name}` placeholders in `query` take `values` (HogQLQuery
 * in https://github.com/PostHog/posthog/blob/master/frontend/src/queries/schema/schema-general.ts).
 * `apiKey` is a personal API key with the `query:read` scope (https://posthog.com/docs/api/queries).
 */
export async function queryPostHog(
  query: string,
  options: { values: Record<string, string>; apiKey: string },
) {
  const url = "https://eu.posthog.com/api/projects/115112/query/";
  const response = await fetchRetryingPlatformFailures(
    `POST ${url}`,
    (signal) =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query, values: options.values } }),
        signal,
      }),
    { area: "posthog", idempotent: true },
  );
  if (!response.ok)
    throw new Error(`PostHog query failed: ${response.status} ${await response.text()}`);
  return z.object({ results: z.array(z.array(z.unknown())) }).parse(await response.json()).results;
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
