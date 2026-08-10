import { createHash } from "node:crypto";

export type PostHogEvent = {
  event: string;
  timestamp?: string;
  uuid: string;
  properties: Record<string, unknown>;
};

// PostHog accepts batch request bodies up to 20 MB and documents no event-count
// ceiling. Keep each request below both 5 MB and 100 events: accepted 2,000+
// event CI bursts remained unqueryable. Space the bounded requests by 500 ms
// because preview and unit finalizers can otherwise burst concurrently. Mark
// these retained CI artifacts as a historical migration so PostHog processes
// them in order without spike detection. The preview suite currently emits
// roughly 8,000 events per run.
const POSTHOG_BATCH_EVENT_BUDGET_BYTES = 5_000_000;
const POSTHOG_BATCH_EVENT_LIMIT = 100;
const POSTHOG_BATCH_INTERVAL_MS = 500;

export function readPostHogConfig(environment = process.env): { apiKey: string; host: string } {
  const raw = environment.APP_CONFIG_POSTHOG?.trim();
  if (!raw) throw new Error("APP_CONFIG_POSTHOG is required for CI telemetry");
  const parsed = JSON.parse(raw) as { apiKey?: unknown; host?: unknown };
  if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) {
    throw new Error("APP_CONFIG_POSTHOG.apiKey is required for CI telemetry");
  }
  return {
    apiKey: parsed.apiKey,
    host:
      typeof parsed.host === "string" ? parsed.host.replace(/\/$/, "") : "https://eu.i.posthog.com",
  };
}

/** Delivers deterministic system events. Callers supply stable identities for backfill safety. */
export async function sendPostHogEvents(events: PostHogEvent[], config = readPostHogConfig()) {
  const batches = postHogEventBatches(
    events,
    POSTHOG_BATCH_EVENT_BUDGET_BYTES,
    POSTHOG_BATCH_EVENT_LIMIT,
  );
  for (const [batchIndex, batch] of batches.entries()) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${config.host}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: config.apiKey,
            batch,
            historical_migration: true,
          }),
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
    if (batchIndex < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, POSTHOG_BATCH_INTERVAL_MS));
    }
  }
}

export function postHogEventBatches(
  events: readonly PostHogEvent[],
  eventBudgetBytes: number,
  eventLimit: number,
): PostHogEvent[][] {
  if (!Number.isSafeInteger(eventBudgetBytes) || eventBudgetBytes <= 0) {
    throw new TypeError("PostHog batch event budget must be a positive safe integer");
  }
  if (!Number.isSafeInteger(eventLimit) || eventLimit <= 0) {
    throw new TypeError("PostHog batch event limit must be a positive safe integer");
  }

  const batches: PostHogEvent[][] = [];
  let batch: PostHogEvent[] = [];
  let batchBytes = 0;
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    const separatorBytes = batch.length === 0 ? 0 : 1;
    if (
      batch.length > 0 &&
      (batch.length >= eventLimit || batchBytes + separatorBytes + eventBytes > eventBudgetBytes)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(event);
    batchBytes += (batch.length === 1 ? 0 : 1) + eventBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
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
    ...(timestamp ? { timestamp } : {}),
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
