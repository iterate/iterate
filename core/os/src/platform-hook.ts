// platform-hook.ts — THE PLATFORM HOOK: the platform's own subscriber, handed every durable event of
// a project context, one call each — a deployment's birth events give each project context its
// fan-out row (app-config.ts `contextBirthEvents`). The built-in (context/built-ins.ts
// `platformHook`) answers the delivery loop alone and hands each event to what its context built
// here. A platform feature that reacts to a project's events starts here. The first sends each
// event to the telemetry lake's `events` table (docs/telemetry.md#events), through the context's
// outbox.
import { reportIssue } from "iterate/lib";
import { failureKind, isPlatformFailureKind, logPlatformFailure } from "iterate/platform-retry";
import type { StreamEvent } from "iterate/stream/processor";
import type { Pipeline } from "cloudflare:pipelines";
import { appConfigOf, type AppConfigEnv } from "./app-config.ts";

/** A row over 1 MB fails its whole batch, so a payload takes at most half that of its row
 *  (docs/telemetry.md#tables). */
const EVENTS_PAYLOAD_MAX_BYTES = 512 * 1024;

/** A stream takes no row over 1 MB, and fails the whole send that carries one. The payload's cut
 *  keeps a row under it unless another field is that big (an event type, a path). */
const ROW_MAX_BYTES = 1_000_000;

/** Pipelines takes at most 5 MB a send; this leaves room for the array around the rows, as
 *  apps/telemetry's sends do. */
const SEND_MAX_BYTES = 4 * 1024 * 1024;

/** The most that waits for the send that is out: two sends' worth. A send takes about 400 ms
 *  whatever it carries, so 4 MB leaves in that time, and only a context that commits faster for
 *  longer, or a stream that stopped answering, fills the outbox. With the send that is out a
 *  context holds at most 12 MB of rows, beside the delivery loop's own 8 MiB budgets
 *  (stream/subscription-delivery.ts). */
const OUTBOX_MAX_BYTES = 8 * 1024 * 1024;

/**
 * THE EVENTS OUTBOX of one context: each event it is handed becomes a row (`eventsRow`) that waits
 * here for the lake's `events` stream. One send is out at a time, with every row that was waiting,
 * up to SEND_MAX_BYTES; the next goes when it settles. So the first event after a quiet spell is
 * sent at once, alone, and a burst behind it is one more send, not one per event: a send costs
 * 350–450 ms whether it carries one row or a hundred (measured on a preview).
 *
 * Nothing waits on a send and nothing a send does reaches the delivery loop. A send that fails is
 * logged (`logSendFailure`) and its rows are lost, as are the rows of a send that is out when the
 * context resets; the next send goes all the same. An event that finds OUTBOX_MAX_BYTES already
 * waiting, or whose row is over ROW_MAX_BYTES, is dropped: the first drop is logged as it happens,
 * since a send that never settles would start no other, and the next send to start logs how many
 * there were. No timer: a pending one would keep the Durable Object resident.
 */
export function eventsOutbox(lake: { eventsStream: Pipeline; worker: string; projectId: string }) {
  const waiting: { row: ReturnType<typeof eventsRow>; bytes: number }[] = [];
  let waitingBytes = 0;
  let dropped = 0;
  let sending = false;
  const sendNext = () => {
    if (dropped > 0) {
      console.warn({
        event: "telemetry.events-dropped",
        message: "these events never reach the telemetry lake",
        projectId: lake.projectId,
        count: dropped,
      });
      dropped = 0;
    }
    let count = 0;
    let bytes = 0;
    while (
      count < waiting.length &&
      (count === 0 || bytes + waiting[count].bytes <= SEND_MAX_BYTES)
    )
      bytes += waiting[count++].bytes;
    const rows = waiting.splice(0, count).map(({ row }) => row);
    waitingBytes -= bytes;
    sending = rows.length > 0;
    if (!sending) return;
    // Called inside an async function, so a `send` that throws instead of returning a promise is a
    // rejection too, and is logged as one.
    void (async () => lake.eventsStream.send(rows))()
      .catch((error: unknown) => logSendFailure(error, rows))
      .finally(sendNext);
  };
  return (event: StreamEvent): void => {
    const row = eventsRow(event, lake);
    const bytes = jsonBytes(row) + 1; // and the comma after it
    if (bytes > ROW_MAX_BYTES || waitingBytes + bytes > OUTBOX_MAX_BYTES) {
      if (dropped++ === 0)
        console.warn({
          event: "telemetry.events-dropped",
          message:
            bytes > ROW_MAX_BYTES
              ? "an event's row is over 1 MB, which no stream takes"
              : "the events outbox is full: events are dropped until a send settles",
          projectId: lake.projectId,
          path: event.path,
        });
      return;
    }
    waiting.push({ row, bytes });
    waitingBytes += bytes;
    if (!sending) sendNext();
  };
}

/** ONE `events` ROW (apps/telemetry/schemas/events.json): the event, who wrote it
 *  (`source.principal.actor`, never an email), why (`source.cause`), and its payload as JSON, cut
 *  to fit EVENTS_PAYLOAD_MAX_BYTES, while `payload_bytes` is the whole payload's size. */
export function eventsRow(
  event: StreamEvent,
  { worker, projectId }: { worker: string; projectId: string },
) {
  // oxlint-disable-next-line iterate/simple-truthiness-check -- only an event with no payload gets {}: a falsy payload off the wire (0, false, "") is stored as itself
  const payload = JSON.stringify(event.payload === undefined ? {} : event.payload);
  const payloadBytes = new TextEncoder().encode(payload);
  // The budget is of the text as the row's JSON carries it, escaped: every quote and backslash
  // doubles there, so a payload of them, or one that is itself JSON in a string, is twice its
  // size in the row. Cut to the budget, then scaled down by how far its escapes take it over; a
  // cut that splits a character decodes as U+FFFD.
  let kept = payloadBytes.length;
  let text = payload;
  for (let size = jsonBytes(text); size > EVENTS_PAYLOAD_MAX_BYTES; size = jsonBytes(text)) {
    kept =
      kept > EVENTS_PAYLOAD_MAX_BYTES
        ? EVENTS_PAYLOAD_MAX_BYTES
        : Math.floor((kept * EVENTS_PAYLOAD_MAX_BYTES) / size);
    text = new TextDecoder().decode(payloadBytes.subarray(0, kept));
  }
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
    payload: text,
    payload_bytes: payloadBytes.length,
  };
}

/** THE TELEMETRY LAKE'S BINDINGS on `env`, under the names the configuration gives them
 *  (app-config.ts `telemetry`), where its parse found them; undefined where the deployment names
 *  no lake. */
export function telemetryBindingsOf(env: AppConfigEnv) {
  const names = appConfigOf(env).telemetry;
  if (!names) return undefined;
  // Asserted, not parsed: the names are the configuration's, so no type of `env` has them, and
  // nothing at runtime tells a stream from a dataset. `appConfigOf` threw unless each is bound, and
  // the config that names them binds them as these two kinds (scripts/generate-wrangler-config.ts).
  const bindings = env as unknown as Record<string, unknown>;
  return {
    eventsStream: bindings[names.eventsStreamBinding] as Pipeline,
    metricsDataset: bindings[names.metricsDatasetBinding] as AnalyticsEngineDataset,
  };
}

/** A send that failed, logged by the one rule (docs/engineering-invariants.md#failures-and-retries):
 *  the platform's failure under its kind, so the deploy's reset every context's send meets is an
 *  info and a storage reset a warn the fault alarm counts; anything else is an issue. Its rows are
 *  lost either way: no send is made again. */
function logSendFailure(error: unknown, rows: ReturnType<typeof eventsRow>[]) {
  const [{ project_id: projectId, path }] = rows;
  const kind = failureKind(error);
  if (isPlatformFailureKind(kind))
    logPlatformFailure("telemetry", "send", kind, {
      name: "telemetry-events",
      projectId,
      path,
      rows: rows.length,
      message: String(error),
    });
  else reportIssue("telemetry.send", error, { projectId, path, rows: rows.length });
}

/** A value's size as JSON, in UTF-8 bytes: what a send carries of it. */
function jsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
