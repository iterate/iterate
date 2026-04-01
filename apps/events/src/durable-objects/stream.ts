import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  Event,
  EventInput,
  JSONObject,
  Offset,
  StreamMetadataUpdatedPayload,
  StreamPath,
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  SUBSCRIPTION_CURSOR_UPDATED_TYPE,
  SUBSCRIPTION_DELIVERY_FAILED_TYPE,
  SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
  SUBSCRIPTION_REMOVED_TYPE,
  SUBSCRIPTION_SET_TYPE,
  SubscriptionRemovedPayload,
  SubscriptionSetPayload,
} from "@iterate-com/events-contract";
import { ROOT_STREAM_PATH, getParentPath } from "~/lib/utils.ts";

const INITIAL_OFFSET_WIDTH = 16;
const textEncoder = new TextEncoder();
const createdAt = z.iso.datetime({ offset: true });

/**
 * These tiny fixed retry delays are a deliberate v0 fence. They keep the retry
 * story easy to reason about while we prove the event-sourced scheduler shape:
 * subscription state owns `nextDeliveryAt`, and the single DO alarm is derived
 * from `min(nextDeliveryAt)` across subscriptions.
 *
 * Durable Object alarms:
 * https://developers.cloudflare.com/durable-objects/api/alarms/
 *
 * Agents scheduling prior art:
 * https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
 * https://developers.cloudflare.com/agents/api-reference/retries/
 */
const retryDelayMs = [250, 1_000, 5_000] as const;
const maxBodyPreviewLength = 200;
const webhookTimeoutMs = 2_000;
const bodyPreviewTimeoutMs = 250;

/**
 * One stream per Durable Object: append-only event log in SQLite, one reduced
 * projection in memory/storage, and one DO alarm derived from the minimum
 * `subscriptions[slug].cursor.nextDeliveryAt`.
 *
 * The important fence in this file is that internal `subscription.*` events
 * stay visible in raw history and SSE, but the alarm-driven webhook delivery
 * loop must never forward them to webhook consumers or it would feed its own
 * bookkeeping back into subscribers.
 *
 * Durable Object docs:
 * - https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
 * - https://developers.cloudflare.com/durable-objects/api/state/
 * - https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
 */
export class StreamDurableObject extends DurableObject<Env> {
  private state: StreamState = createEmptyStreamState();
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Cloudflare recommends `blockConcurrencyWhile()` for schema setup and
    // state hydration so requests never observe a half-initialized object:
    // https://developers.cloudflare.com/durable-objects/api/state/
    void this.ctx.blockConcurrencyWhile(async () => {
      this.initializeStorage();
      this.state = this.loadState();
    });
  }

  /**
   * Appends validated events inside one transaction.
   *
   * Per-event idempotency is stream-local: when an input includes an
   * `idempotencyKey` that already exists in this stream, we return the stored
   * event instead of creating a second row or advancing offsets/state.
   */
  async append(args: { events: EventInput[] }) {
    if (args.events.length === 0) {
      throw new Error("At least one event is required.");
    }

    const created = this.state.eventCount === 0;
    let nextState = structuredClone(this.state);
    const events: Event[] = [];
    const insertedEvents: Event[] = [];

    this.ctx.storage.transactionSync(() => {
      for (const inputEvent of args.events) {
        const existingEvent =
          inputEvent.idempotencyKey == null
            ? null
            : this.getEventByIdempotencyKey({
                path: inputEvent.path,
                idempotencyKey: inputEvent.idempotencyKey,
              });

        if (existingEvent != null) {
          events.push(existingEvent);
          continue;
        }

        const insertedEvent = this.insertEventSync({
          inputEvent,
          prevOffset: nextState.lastOffset,
        });

        events.push(insertedEvent);
        nextState = reduceStreamState({
          state: nextState,
          event: insertedEvent,
        });
        insertedEvents.push(insertedEvent);
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO reduced_state (singleton, json)
         VALUES (1, json(?))
         ON CONFLICT(singleton) DO UPDATE SET json = excluded.json`,
        JSON.stringify(nextState),
      );
    });

    this.state = nextState;
    await this.updateAlarm();

    for (const event of insertedEvents) {
      this.publish(event);
    }

    if (created && insertedEvents[0] != null) {
      this.propagateStreamCreated(insertedEvents[0]);
    }

    return { created, events };
  }

  /**
   * Keep the whole delivery pass awaited inside `alarm()`. Cloudflare only
   * retries alarms on uncaught handler failures, so detached background work
   * would escape the raw retry semantics:
   * https://developers.cloudflare.com/durable-objects/api/alarms/
   */
  async alarm() {
    const path = this.state.path;
    if (path == null) {
      return;
    }

    const dueSubscriptions = getDueSubscriptions({ now: Date.now(), state: this.state });
    if (dueSubscriptions.length === 0) {
      await this.updateAlarm();
      return;
    }

    // Agents runs due schedules sequentially to prevent overlap inside one
    // schedule. We deliberately diverge here because each subscription owns an
    // independent webhook target and cursor, so parallel delivery avoids
    // head-of-line blocking between unrelated subscribers.
    const results = await Promise.allSettled(
      dueSubscriptions.map(async ([slug, subscription]) => {
        const events = await this.history({
          afterOffset: subscription.cursor.lastAcknowledgedOffset ?? undefined,
        });

        return this.attemptWebhookDelivery({
          events,
          path,
          slug,
          subscription,
        });
      }),
    );
    const outcomeEvents = results.flatMap((result) => {
      if (result.status !== "fulfilled" || result.value == null) {
        return [];
      }

      return [result.value];
    });

    if (outcomeEvents.length === 0) {
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (firstFailure) {
        throw firstFailure.reason;
      }

      await this.updateAlarm();
      return;
    }

    // This stream is intentionally at-least-once for outbound delivery. If the
    // webhook side effects succeed and this append then fails, a later alarm
    // retry can redeliver the same event. We accept that fence to keep delivery
    // state fully event-sourced instead of mutating hidden scheduler state.
    await this.append({ events: outcomeEvents });

    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (firstFailure) {
      throw firstFailure.reason;
    }
  }

  /**
   * Reconstruct canonical events from trusted SQLite rows.
   *
   * We validate aggressively on append and trust stored rows on read so an older
   * row does not start throwing `Event.parse()` exceptions on every history or
   * live-stream read. The NDJSON consumer in `decodeEventStream()` still expects
   * newline-delimited JSON objects, but it skips malformed lines instead of
   * killing the whole live subscription.
   */
  async history(args: { afterOffset?: string } = {}): Promise<Event[]> {
    if (this.state.path == null) {
      if (this.state.eventCount === 0) {
        return [];
      }

      throw new Error(
        "Stream durable object cannot read events before its reduced path is initialized.",
      );
    }

    const path = this.state.path;
    return this.listEventsAfterOffset({
      path,
      afterOffset: args.afterOffset ?? "",
    });
  }

  /**
   * Returns newline-delimited JSON so backlog and live events share the same
   * framing as `decodeEventStream()` in `~/lib/utils.ts`.
   */
  async stream(
    args: { afterOffset?: string; live?: boolean } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const backlogPromise = this.history(args);
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const backlog = await backlogPromise;
        for (const event of backlog) {
          controller.enqueue(encodeEventLine(event));
        }

        if (!args.live) {
          controller.close();
          return;
        }

        subscriber = controller;
        this.subscribers.add(controller);
      },
      cancel: () => {
        if (subscriber) {
          this.subscribers.delete(subscriber);
        }
      },
    });
  }

  async getState(): Promise<StreamState> {
    return structuredClone(this.state);
  }

  /**
   * `events` is the append-only log; `reduced_state` is the fast projection we
   * can return from `getState()` without replaying the whole stream on every
   * request.
   */
  private initializeStorage() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        offset TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        metadata TEXT CHECK(metadata IS NULL OR (json_valid(metadata) AND json_type(metadata) = 'object')),
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reduced_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        json TEXT NOT NULL CHECK(json_valid(json))
      )
    `);
  }

  /**
   * Hydrates in-memory state from the reduced projection and cross-checks it
   * against the append-only log so corruption fails fast instead of silently
   * leaking inconsistent reads.
   */
  private loadState() {
    const eventRowCount =
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one()
        ?.count ?? 0;
    const persistedStateRow = this.ctx.storage.sql
      .exec<{ json: string }>("SELECT json FROM reduced_state WHERE singleton = 1")
      .next().value;

    if (persistedStateRow == null) {
      if (eventRowCount === 0) {
        return createEmptyStreamState();
      }

      throw new Error(
        "Stream durable object is missing reduced_state even though events exist. This object is in a broken state.",
      );
    }

    const persistedState = streamStateSchema.parse(JSON.parse(persistedStateRow.json));
    if (persistedState.eventCount !== eventRowCount) {
      throw new Error(
        `Persisted reduced_state eventCount ${persistedState.eventCount} does not match ${eventRowCount} event rows.`,
      );
    }

    if (persistedState.eventCount > 0 && persistedState.path == null) {
      throw new Error("Persisted reduced_state is missing a path even though events exist.");
    }

    if (persistedState.eventCount > 0 && persistedState.lastOffset == null) {
      throw new Error("Persisted reduced_state is missing lastOffset even though events exist.");
    }

    return persistedState;
  }

  /**
   * Inserts a fresh event row using the caller-provided previous offset.
   *
   * This cannot read `this.state.lastOffset` directly because a single append
   * call can insert multiple new events, and each later event must see the
   * offset produced earlier in the same batch.
   */
  private insertEventSync(args: { inputEvent: EventInput; prevOffset: string | null }) {
    const { inputEvent, prevOffset } = args;

    const event = Event.parse({
      path: inputEvent.path,
      offset: this.nextOffset({ prevOffset }),
      type: inputEvent.type,
      payload: inputEvent.payload,
      metadata: inputEvent.metadata,
      idempotencyKey: inputEvent.idempotencyKey,
      createdAt: new Date().toISOString(),
    });

    this.ctx.storage.sql.exec(
      `INSERT INTO events (offset, type, payload, metadata, idempotency_key, created_at)
       VALUES (?, ?, json(?), ?, ?, ?)`,
      event.offset,
      event.type,
      JSON.stringify(event.payload),
      event.metadata === undefined ? null : JSON.stringify(event.metadata),
      event.idempotencyKey ?? null,
      event.createdAt,
    );

    return event;
  }

  private listEventsAfterOffset(args: { path: StreamPath; afterOffset: string }) {
    const { path, afterOffset } = args;

    return this.ctx.storage.sql
      .exec<{
        offset: string;
        type: string;
        payload: string;
        metadata: string | null;
        idempotency_key: string | null;
        created_at: string;
      }>(
        `SELECT offset, type, payload, metadata, idempotency_key, created_at
        FROM events
        WHERE offset > ?
        ORDER BY offset ASC`,
        afterOffset,
      )
      .toArray()
      .map((row) => parseStoredEventRow({ path, row }));
  }

  private getEventByIdempotencyKey(args: { path: StreamPath; idempotencyKey: string }) {
    const { path, idempotencyKey } = args;

    const row = this.ctx.storage.sql
      .exec<{
        offset: string;
        type: string;
        payload: string;
        metadata: string | null;
        idempotency_key: string | null;
        created_at: string;
      }>(
        `SELECT offset, type, payload, metadata, idempotency_key, created_at
         FROM events
         WHERE idempotency_key = ?
         LIMIT 1`,
        idempotencyKey,
      )
      .next().value;

    if (row == null) {
      return null;
    }

    return parseStoredEventRow({ path, row });
  }

  private nextOffset(args: { prevOffset: string | null }) {
    const { prevOffset } = args;

    // Offsets are fixed-width decimal strings so plain lexicographic ordering in
    // SQLite matches append order.
    if (prevOffset == null) {
      return Offset.parse("1".padStart(INITIAL_OFFSET_WIDTH, "0"));
    }

    if (!/^\d+$/.test(prevOffset)) {
      throw new Error(`Cannot generate the next offset after non-numeric offset ${prevOffset}.`);
    }

    const width = Math.max(prevOffset.length, INITIAL_OFFSET_WIDTH);
    return Offset.parse((BigInt(prevOffset) + 1n).toString().padStart(width, "0"));
  }

  /**
   * One Durable Object gets one alarm slot. We recompute it from reduced state
   * after every append/alarm pass rather than persisting a second schedule
   * table:
   * https://developers.cloudflare.com/durable-objects/api/alarms/
   */
  private async updateAlarm() {
    const nextAlarmAt = getNextAlarmAt(this.state);
    if (nextAlarmAt == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextAlarmAt);
  }

  private async attemptWebhookDelivery(args: {
    events: Event[];
    path: string;
    slug: string;
    subscription: SubscriptionState;
  }) {
    const { nextEvent, followingEvent } = getDeliveryWindow(args.events);
    if (!nextEvent) {
      // Clearing `nextDeliveryAt` is still event-sourced. A caught-up pass emits
      // an internal cursor event instead of mutating hidden scheduler state.
      return EventInput.parse({
        path: args.path,
        type: SUBSCRIPTION_CURSOR_UPDATED_TYPE,
        payload: {
          slug: args.slug,
          deliveryRevision: args.subscription.revision,
          observedLastOffset:
            args.events.at(-1)?.offset ?? args.subscription.cursor.lastAcknowledgedOffset,
          reason: "caught-up",
          cursor: {
            ...args.subscription.cursor,
            nextDeliveryAt: null,
          },
        },
      });
    }

    const attemptedAt = new Date().toISOString();
    const observedLastOffset =
      args.events.at(-1)?.offset ?? args.subscription.cursor.lastAcknowledgedOffset;
    const headers = {
      "content-type": "application/json",
      ...args.subscription.headers,
    };
    const attempted = makeAttemptedRecord({
      at: attemptedAt,
      event: nextEvent,
      headers,
      slug: args.slug,
      url: args.subscription.url,
    });

    let response: Response;
    try {
      response = await postWebhookWithTimeout({
        timeoutMs: webhookTimeoutMs,
        url: args.subscription.url,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(attempted.body),
        },
      });
    } catch (error) {
      const message = readErrorMessage(error, webhookTimeoutMs);
      return makeDeliveryFailedEvent({
        attempted,
        bodyPreview: null,
        deliveredEventOffset: nextEvent.offset,
        deliveryRevision: args.subscription.revision,
        lastAcknowledgedOffset: args.subscription.cursor.lastAcknowledgedOffset,
        message,
        observedLastOffset,
        path: args.path,
        retries: args.subscription.cursor.retries + 1,
        slug: args.slug,
        statusCode: null,
      });
    }

    // Response previews are audit context only. Never let a peer that sends
    // headers and then stalls the body pin the whole alarm pass.
    const bodyPreview = await readResponsePreview({
      maxLength: maxBodyPreviewLength,
      response,
      timeoutMs: bodyPreviewTimeoutMs,
    });
    if (!response.ok) {
      const message = `Webhook failed with ${response.status}`;
      return makeDeliveryFailedEvent({
        attempted,
        bodyPreview,
        deliveredEventOffset: nextEvent.offset,
        deliveryRevision: args.subscription.revision,
        lastAcknowledgedOffset: args.subscription.cursor.lastAcknowledgedOffset,
        message,
        observedLastOffset,
        path: args.path,
        retries: args.subscription.cursor.retries + 1,
        slug: args.slug,
        statusCode: response.status,
      });
    }

    return EventInput.parse({
      path: args.path,
      type: SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
      payload: {
        slug: args.slug,
        deliveryRevision: args.subscription.revision,
        deliveredEventOffset: nextEvent.offset,
        observedLastOffset,
        attempted,
        response: {
          statusCode: response.status,
          bodyPreview,
        },
        cursor: {
          lastAcknowledgedOffset: nextEvent.offset,
          nextDeliveryAt: followingEvent == null ? null : attemptedAt,
          retries: 0,
          lastError: null,
        },
      },
    });
  }

  private propagateStreamCreated(firstEvent: Event) {
    if (this.state.path == null) {
      throw new Error(
        "Stream durable object cannot propagate before its reduced path is initialized.",
      );
    }

    const createdPath = this.state.path;
    if (createdPath === ROOT_STREAM_PATH) {
      return;
    }

    const parentPaths: StreamPath[] = [];
    let parentPath = getParentPath(createdPath);
    while (parentPath != null) {
      parentPaths.push(parentPath);
      parentPath = getParentPath(parentPath);
    }

    console.info("[stream-do] propagating stream-created", {
      createdPath,
      parentPaths,
      firstOffset: firstEvent.offset,
    });

    // Parent discovery is helpful but not required for the child append to commit,
    // so we fan out in the background and only log failures.
    void Promise.allSettled(
      parentPaths.map((parentPath) => {
        const events: EventInput[] = [
          {
            path: parentPath,
            type: STREAM_CREATED_TYPE,
            payload: {
              path: createdPath,
            },
          },
        ];

        const streamStub = this.env.STREAM.getByName(parentPath);
        return streamStub.append({ events });
      }),
    ).then((results) => {
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          continue;
        }

        console.error("[stream-do] failed to propagate stream-created", {
          createdPath,
          parentPath: parentPaths[index],
          error: result.reason,
        });
      }
    });
  }

  private publish(event: Event) {
    const chunk = encodeEventLine(event);

    for (const subscriber of this.subscribers) {
      try {
        subscriber.enqueue(chunk);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }
}

const subscriptionCursorErrorSchema = z.object({
  message: z.string(),
  statusCode: z.number().int().nullable(),
  bodyPreview: z.string().nullable(),
  at: createdAt,
});

const subscriptionCursorSchema = z.object({
  lastAcknowledgedOffset: Offset.nullable(),
  nextDeliveryAt: createdAt.nullable(),
  retries: z.number().int().nonnegative(),
  lastError: subscriptionCursorErrorSchema.nullable(),
});

const subscriptionStateSchema = z.object({
  type: z.literal("webhook"),
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  revision: z.number().int().nonnegative(),
  cursor: subscriptionCursorSchema,
});

const subscriptionAttemptedSchema = z.object({
  at: createdAt,
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  body: z.object({
    subscriptionSlug: z.string().trim().min(1),
    event: Event,
  }),
});

const subscriptionDeliverySucceededPayloadSchema = z.object({
  slug: z.string().trim().min(1),
  deliveryRevision: z.number().int().nonnegative(),
  deliveredEventOffset: Offset,
  observedLastOffset: Offset.nullable(),
  attempted: subscriptionAttemptedSchema,
  response: z.object({
    statusCode: z.number().int(),
    bodyPreview: z.string().nullable(),
  }),
  cursor: subscriptionCursorSchema.extend({
    lastAcknowledgedOffset: Offset,
    lastError: z.null(),
  }),
});

const subscriptionDeliveryFailedPayloadSchema = z.object({
  slug: z.string().trim().min(1),
  deliveryRevision: z.number().int().nonnegative(),
  deliveredEventOffset: Offset,
  observedLastOffset: Offset.nullable(),
  attempted: subscriptionAttemptedSchema,
  response: z.object({
    statusCode: z.number().int().nullable(),
    bodyPreview: z.string().nullable(),
    message: z.string(),
  }),
  cursor: subscriptionCursorSchema.extend({
    nextDeliveryAt: createdAt,
    lastError: subscriptionCursorErrorSchema,
  }),
});

const subscriptionCursorUpdatedPayloadSchema = z.object({
  slug: z.string().trim().min(1),
  deliveryRevision: z.number().int().nonnegative(),
  observedLastOffset: Offset.nullable(),
  reason: z.enum(["caught-up"]),
  cursor: subscriptionCursorSchema,
});

/**
 * `getState()` stays implementation-shaped JSON. The reduced projection lives
 * with the Durable Object because this actor owns both the append-only log and
 * the derived scheduler state.
 */
const streamStateSchema = z.object({
  path: StreamPath.nullable(),
  lastOffset: Offset.nullable(),
  eventCount: z.number().int().nonnegative(),
  metadata: JSONObject,
  subscriptions: z.record(z.string(), subscriptionStateSchema).default({}),
});

type StreamState = z.infer<typeof streamStateSchema>;
type SubscriptionState = z.infer<typeof subscriptionStateSchema>;
type SubscriptionAttempted = z.infer<typeof subscriptionAttemptedSchema>;

type StoredEventRow = {
  offset: string;
  type: string;
  payload: string;
  metadata: string | null;
  idempotency_key: string | null;
  created_at: string;
};

export function createEmptyStreamState(): StreamState {
  return {
    path: null,
    lastOffset: null,
    eventCount: 0,
    metadata: {},
    subscriptions: {},
  } satisfies StreamState;
}

function parseStoredEventRow(args: { path: StreamPath; row: StoredEventRow }) {
  const { path, row } = args;

  return Event.parse({
    path,
    offset: row.offset,
    type: row.type,
    payload: JSON.parse(row.payload),
    ...(row.metadata == null ? {} : { metadata: JSON.parse(row.metadata) }),
    ...(row.idempotency_key == null ? {} : { idempotencyKey: row.idempotency_key }),
    createdAt: row.created_at,
  });
}

/**
 * Replay and append share the same reducer so state cannot drift based on which
 * code path produced it. The key subscription fences are:
 * - stale outcomes are ignored when `deliveryRevision` no longer matches
 * - caught-up or successful outcomes re-arm when the stream advanced while the
 *   webhook call was in flight
 */
export function reduceStreamState(args: { state: StreamState; event: Event }): StreamState {
  const { state, event } = args;
  const path = state.path ?? event.path;
  if (state.path != null && state.path !== event.path) {
    throw new Error(`Stream path mismatch. Expected ${state.path}, received ${event.path}.`);
  }

  const nextState = structuredClone(state);
  nextState.path = path;
  nextState.lastOffset = event.offset;
  nextState.eventCount = state.eventCount + 1;

  switch (event.type) {
    case STREAM_METADATA_UPDATED_TYPE:
      nextState.metadata = StreamMetadataUpdatedPayload.parse(event.payload).metadata;
      return nextState;
    case SUBSCRIPTION_SET_TYPE: {
      const payload = SubscriptionSetPayload.parse(event.payload);
      const currentSubscription = nextState.subscriptions[payload.slug];
      nextState.subscriptions[payload.slug] = {
        type: payload.subscription.type,
        url: payload.subscription.url,
        headers: payload.subscription.headers ?? {},
        revision: (currentSubscription?.revision ?? 0) + 1,
        cursor: makeCursorFromStartFrom({
          createdAt: event.createdAt,
          eventOffset: event.offset,
          startFrom: payload.subscription.startFrom,
        }),
      };
      return nextState;
    }
    case SUBSCRIPTION_REMOVED_TYPE: {
      const payload = SubscriptionRemovedPayload.parse(event.payload);
      delete nextState.subscriptions[payload.slug];
      return nextState;
    }
    case SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE: {
      const payload = subscriptionDeliverySucceededPayloadSchema.parse(event.payload);
      const subscription = nextState.subscriptions[payload.slug];
      // Outcome events are tied to one subscription revision. If the slug was
      // removed or rewound while the webhook call was in flight, the stale
      // outcome must not overwrite the newer cursor.
      if (!subscription || payload.deliveryRevision !== subscription.revision) {
        return nextState;
      }

      subscription.cursor = payload.cursor;
      // If the stream advanced during the attempt, clearing `nextDeliveryAt`
      // would strand newer user events. Re-arm and rescan instead.
      rearmSubscriptionIfStreamAdvanced({
        createdAt: event.createdAt,
        observedLastOffset: payload.observedLastOffset,
        previousLastOffset: state.lastOffset,
        subscription,
      });
      return nextState;
    }
    case SUBSCRIPTION_DELIVERY_FAILED_TYPE: {
      const payload = subscriptionDeliveryFailedPayloadSchema.parse(event.payload);
      const subscription = nextState.subscriptions[payload.slug];
      if (!subscription || payload.deliveryRevision !== subscription.revision) {
        return nextState;
      }

      subscription.cursor = payload.cursor;
      return nextState;
    }
    case SUBSCRIPTION_CURSOR_UPDATED_TYPE: {
      const payload = subscriptionCursorUpdatedPayloadSchema.parse(event.payload);
      const subscription = nextState.subscriptions[payload.slug];
      // `subscription.cursor-updated(reason: "caught-up")` keeps quiescing in
      // the event log instead of hiding it as mutable scheduler state.
      if (!subscription || payload.deliveryRevision !== subscription.revision) {
        return nextState;
      }

      subscription.cursor = payload.cursor;
      rearmSubscriptionIfStreamAdvanced({
        createdAt: event.createdAt,
        observedLastOffset: payload.observedLastOffset,
        previousLastOffset: state.lastOffset,
        subscription,
      });
      return nextState;
    }
    default: {
      if (!isInternalSubscriptionEventType(event.type)) {
        for (const subscription of Object.values(nextState.subscriptions)) {
          if (subscription.cursor.nextDeliveryAt == null) {
            subscription.cursor.nextDeliveryAt = event.createdAt;
          }
        }
      }

      return nextState;
    }
  }
}

function encodeEventLine(event: Event) {
  return textEncoder.encode(`${JSON.stringify(event)}\n`);
}

function makeCursorFromStartFrom(args: {
  createdAt: string;
  eventOffset: string;
  startFrom: SubscriptionSetPayload["subscription"]["startFrom"];
}): SubscriptionState["cursor"] {
  if (args.startFrom === "head") {
    return {
      lastAcknowledgedOffset: null,
      nextDeliveryAt: args.createdAt,
      retries: 0,
      lastError: null,
    } satisfies SubscriptionState["cursor"];
  }

  if (args.startFrom === "tail") {
    return {
      lastAcknowledgedOffset: args.eventOffset,
      nextDeliveryAt: null,
      retries: 0,
      lastError: null,
    } satisfies SubscriptionState["cursor"];
  }

  return {
    lastAcknowledgedOffset: args.startFrom.afterOffset,
    nextDeliveryAt: args.createdAt,
    retries: 0,
    lastError: null,
  } satisfies SubscriptionState["cursor"];
}

/**
 * Internal subscription events stay visible in raw history and SSE, but the
 * server-managed delivery loop must never forward them to webhook consumers.
 */
export function isInternalSubscriptionEventType(type: string) {
  return (
    type === SUBSCRIPTION_SET_TYPE ||
    type === SUBSCRIPTION_REMOVED_TYPE ||
    type === SUBSCRIPTION_CURSOR_UPDATED_TYPE ||
    type === SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE ||
    type === SUBSCRIPTION_DELIVERY_FAILED_TYPE
  );
}

function getRetryDelayMs(retries: number) {
  return retryDelayMs[Math.min(Math.max(retries, 1), retryDelayMs.length) - 1]!;
}

function computeNextRetryAt(args: { now: number; retries: number }) {
  return new Date(args.now + getRetryDelayMs(args.retries)).toISOString();
}

function getNextAlarmAt(state: StreamState) {
  let nextAlarmAt: number | null = null;

  for (const subscription of Object.values(state.subscriptions)) {
    if (subscription.cursor.nextDeliveryAt == null) {
      continue;
    }

    const dueAt = Date.parse(subscription.cursor.nextDeliveryAt);
    if (nextAlarmAt == null || dueAt < nextAlarmAt) {
      nextAlarmAt = dueAt;
    }
  }

  return nextAlarmAt;
}

function getDueSubscriptions(args: { now: number; state: StreamState }) {
  return Object.entries(args.state.subscriptions).filter(([, subscription]) => {
    if (subscription.cursor.nextDeliveryAt == null) {
      return false;
    }

    return Date.parse(subscription.cursor.nextDeliveryAt) <= args.now;
  });
}

function getDeliveryWindow(events: Event[]) {
  let nextEvent: Event | null = null;
  let followingEvent: Event | null = null;

  for (const event of events) {
    if (isInternalSubscriptionEventType(event.type)) {
      continue;
    }

    if (nextEvent == null) {
      nextEvent = event;
      continue;
    }

    followingEvent = event;
    break;
  }

  return {
    nextEvent,
    followingEvent,
  };
}

function rearmSubscriptionIfStreamAdvanced(args: {
  createdAt: string;
  observedLastOffset: string | null;
  previousLastOffset: string | null;
  subscription: SubscriptionState;
}) {
  if (
    args.subscription.cursor.nextDeliveryAt == null &&
    args.previousLastOffset !== args.observedLastOffset
  ) {
    args.subscription.cursor.nextDeliveryAt = args.createdAt;
  }
}

function makeDeliveryFailedEvent(args: {
  attempted: SubscriptionAttempted;
  bodyPreview: string | null;
  deliveredEventOffset: string;
  deliveryRevision: number;
  lastAcknowledgedOffset: string | null;
  message: string;
  observedLastOffset: string | null;
  path: string;
  retries: number;
  slug: string;
  statusCode: number | null;
}) {
  return EventInput.parse({
    path: args.path,
    type: SUBSCRIPTION_DELIVERY_FAILED_TYPE,
    payload: {
      slug: args.slug,
      deliveryRevision: args.deliveryRevision,
      deliveredEventOffset: args.deliveredEventOffset,
      observedLastOffset: args.observedLastOffset,
      attempted: args.attempted,
      response: {
        statusCode: args.statusCode,
        bodyPreview: args.bodyPreview,
        message: args.message,
      },
      cursor: {
        lastAcknowledgedOffset: args.lastAcknowledgedOffset,
        nextDeliveryAt: computeNextRetryAt({ now: Date.now(), retries: args.retries }),
        retries: args.retries,
        lastError: {
          message: args.message,
          statusCode: args.statusCode,
          bodyPreview: args.bodyPreview,
          at: args.attempted.at,
        },
      },
    },
  });
}

function makeAttemptedRecord(args: {
  at: string;
  event: Event;
  headers: Record<string, string>;
  slug: string;
  url: string;
}): SubscriptionAttempted {
  return {
    at: args.at,
    url: args.url,
    headers: args.headers,
    body: {
      subscriptionSlug: args.slug,
      event: args.event,
    },
  };
}

async function postWebhookWithTimeout(args: { url: string; init: RequestInit; timeoutMs: number }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Webhook request timed out after ${args.timeoutMs}ms`));
  }, args.timeoutMs);

  try {
    return await fetch(args.url, {
      ...args.init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function readErrorMessage(error: unknown, timeoutMs: number) {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return `Webhook request timed out after ${timeoutMs}ms`;
    }

    return error.message;
  }

  return String(error);
}

async function readResponsePreview(args: {
  response: Response;
  timeoutMs: number;
  maxLength: number;
}) {
  if (args.response.body == null) {
    return null;
  }

  const reader = args.response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let previewLength = 0;

  try {
    while (previewLength < args.maxLength) {
      const chunk = await readStreamChunkWithTimeout({
        reader,
        timeoutMs: args.timeoutMs,
      });
      if (chunk == null || chunk.done) {
        break;
      }

      const text = decoder.decode(chunk.value, { stream: true });
      previewLength += text.length;
      chunks.push(text);
    }

    chunks.push(decoder.decode());
  } catch {
    return truncateBodyPreview({
      body: chunks.join(""),
      maxLength: args.maxLength,
    });
  } finally {
    // `cancel()` can itself hang against a peer that never finishes the body.
    // Fire-and-forget cleanup here because the preview is best-effort audit
    // data, not part of the delivery success fence.
    void reader.cancel().catch(() => {});
  }

  return truncateBodyPreview({
    body: chunks.join(""),
    maxLength: args.maxLength,
  });
}

async function readStreamChunkWithTimeout(args: {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  timeoutMs: number;
}) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      args.reader.read(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), args.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout != null) {
      clearTimeout(timeout);
    }
  }
}

function truncateBodyPreview(args: { body: string; maxLength: number }) {
  if (args.body.length === 0) {
    return null;
  }

  if (args.body.length <= args.maxLength) {
    return args.body;
  }

  return `${args.body.slice(0, args.maxLength)}...`;
}
