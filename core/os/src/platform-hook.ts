// platform-hook.ts — THE PLATFORM HOOK: the platform's own subscriber, handed every durable event of
// a project context, one call each — a deployment's birth events give each project context its
// fan-out row (app-config.ts `contextBirthEvents`). The built-in (context/built-ins.ts
// `platformHook`) answers the delivery loop alone and hands each event here with the worker's
// bindings, as every platform built-in holds them, and the context's project. A platform feature
// that reacts to a project's events starts here. The first sends each event to the telemetry
// lake's `events` table (docs/telemetry.md#events).
import type { StreamEvent } from "iterate/stream/processor";
import type { Pipeline } from "cloudflare:pipelines";
import { appConfigOf, type AppConfigEnv } from "./app-config.ts";

/** A row over 1 MB fails its whole batch, so a payload is cut at half that
 *  (docs/telemetry.md#tables). */
const EVENTS_PAYLOAD_MAX_BYTES = 512 * 1024;

/** THE TELEMETRY LAKE'S BINDINGS on `env`, under the names the configuration gives them
 *  (app-config.ts `telemetry`), where its parse found them; undefined where the deployment names
 *  no lake. */
export function telemetryBindingsOf(env: AppConfigEnv) {
  const names = appConfigOf(env).telemetry;
  if (!names) return undefined;
  const bindings = env as unknown as Record<string, unknown>;
  return {
    eventsStream: bindings[names.eventsStreamBinding] as Pipeline,
    metricsDataset: bindings[names.metricsDatasetBinding] as AnalyticsEngineDataset,
  };
}

export function deliverToPlatformHook(
  lake: { eventsStream: Pipeline | undefined; worker: string },
  projectId: string,
  event: StreamEvent,
): void {
  if (!lake.eventsStream) return; // the deployment names no lake (app-config.ts `telemetry`)
  const row = eventsRow(event, { worker: lake.worker, projectId });
  // Never awaited (docs/telemetry.md#failures): an event in flight when the context resets is lost,
  // and this line says so.
  void lake.eventsStream.send([row]).catch((error: unknown) =>
    console.error({
      event: "telemetry.send-failed",
      projectId,
      path: event.path,
      offset: event.offset,
      error: String(error),
    }),
  );
}

/** ONE `events` ROW (apps/telemetry/schemas/events.json): the event, who wrote it
 *  (`source.principal.actor`, never an email), why (`source.cause`), and its payload as JSON — cut
 *  at EVENTS_PAYLOAD_MAX_BYTES, while `payload_bytes` is the whole payload's size. */
export function eventsRow(
  event: StreamEvent,
  { worker, projectId }: { worker: string; projectId: string },
) {
  const payload = JSON.stringify(event.payload || {});
  const payloadBytes = new TextEncoder().encode(payload);
  const { principal, cause } = event.source;
  return {
    time: event.createdAt,
    worker,
    project_id: projectId,
    path: event.path,
    offset: event.offset,
    type: event.type,
    actor: principal?.actor || null,
    cause_chain: cause?.chain || null,
    cause_depth: cause?.depth ?? null,
    cause_parent: cause?.parent || null,
    payload:
      payloadBytes.length > EVENTS_PAYLOAD_MAX_BYTES
        ? new TextDecoder().decode(payloadBytes.subarray(0, EVENTS_PAYLOAD_MAX_BYTES))
        : payload,
    payload_bytes: payloadBytes.length,
  };
}
