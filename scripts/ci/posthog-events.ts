import { createHash } from "node:crypto";

export type PostHogEvent = {
  event: string;
  timestamp?: string;
  uuid: string;
  properties: Record<string, unknown>;
};

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
  for (let offset = 0; offset < events.length; offset += 100) {
    const batch = events.slice(offset, offset + 100);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${config.host}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: config.apiKey, batch }),
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
