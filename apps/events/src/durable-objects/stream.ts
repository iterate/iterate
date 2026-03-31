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
  SubscriptionCursorUpdatedPayload,
  SubscriptionDeliveryFailedPayload,
  SubscriptionDeliverySucceededPayload,
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

/**
 * `getState()` stays implementation-shaped JSON. The concrete reduced-state
 * schema lives with the DO because this actor owns the projection and persists
 * it locally.
 */
export const streamStateSchema = z.object({
  path: StreamPath.nullable(),
  lastOffset: Offset.nullable(),
  eventCount: z.number().int().nonnegative(),
  metadata: JSONObject,
  subscriptions: z.record(z.string(), subscriptionStateSchema).default({}),
});

export type StreamState = z.infer<typeof streamStateSchema>;
export type SubscriptionState = z.infer<typeof subscriptionStateSchema>;

/**
 * One stream per Durable Object: append-only event log in SQLite, a reduced
 * projection kept in memory and storage, and newline-delimited fanout for live
 * readers.
 *
 * Raw history and SSE keep internal subscription bookkeeping events visible.
 * Only the server-managed webhook delivery loop filters those events out, or it
 * would feed its own cursor-management events back into subscribers.
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

    this.state = structuredClone(nextState);
    await this.updateAlarm(nextState);

    for (const event of insertedEvents) {
      this.publish(event);
    }

    if (created && insertedEvents[0] != null) {
      this.propagateStreamCreated(insertedEvents[0]);
    }

    return { created, events };
  }

  async getState(): Promise<StreamState> {
    return structuredClone(this.state);
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
      await this.updateAlarm(this.state);
      return;
    }

    const outcomeEvents = (
      await Promise.all(
        dueSubscriptions.map(async ([slug, subscription]) => {
          const events = await this.history({
            afterOffset: subscription.cursor.lastAcknowledgedOffset ?? undefined,
          });

          return this.deliverSubscriptionEvent({
            events,
            path,
            slug,
            subscription,
          });
        }),
      )
    ).filter((event): event is EventInput => event != null);

    if (outcomeEvents.length === 0) {
      await this.updateAlarm(this.state);
      return;
    }

    await this.append({ events: outcomeEvents });
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

    return structuredClone(persistedState);
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
      .map((row) =>
        Event.parse({
          path,
          offset: row.offset,
          type: row.type,
          payload: JSON.parse(row.payload),
          ...(row.metadata == null ? {} : { metadata: JSON.parse(row.metadata) }),
          ...(row.idempotency_key == null ? {} : { idempotencyKey: row.idempotency_key }),
          createdAt: row.created_at,
        }),
      );
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

  private async updateAlarm(state: StreamState) {
    const nextAlarmAt = getNextAlarmAt(state);
    if (nextAlarmAt == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextAlarmAt);
  }

  private async deliverSubscriptionEvent(args: {
    events: Event[];
    path: string;
    slug: string;
    subscription: SubscriptionState;
  }) {
    const deliverableEvents = getDeliverableEvents(args.events);
    const nextEvent = deliverableEvents[0];
    if (!nextEvent) {
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

    let response: Response;
    try {
      response = await postWebhookWithTimeout({
        timeoutMs: webhookTimeoutMs,
        url: args.subscription.url,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...args.subscription.headers,
          },
          body: JSON.stringify({
            subscriptionSlug: args.slug,
            event: nextEvent,
          }),
        },
      });
    } catch (error) {
      const message = readErrorMessage(error, webhookTimeoutMs);
      const retries = args.subscription.cursor.retries + 1;

      return EventInput.parse({
        path: args.path,
        type: SUBSCRIPTION_DELIVERY_FAILED_TYPE,
        payload: {
          slug: args.slug,
          deliveryRevision: args.subscription.revision,
          deliveredEventOffset: nextEvent.offset,
          observedLastOffset,
          response: {
            statusCode: null,
            bodyPreview: null,
            message,
          },
          cursor: {
            lastAcknowledgedOffset: args.subscription.cursor.lastAcknowledgedOffset,
            nextDeliveryAt: computeNextRetryAt({ now: Date.now(), retries }),
            retries,
            lastError: {
              message,
              statusCode: null,
              bodyPreview: null,
              at: attemptedAt,
            },
          },
        },
      });
    }

    const bodyPreview = truncateBodyPreview(await safeReadResponseText(response));
    if (!response.ok) {
      const message = `Webhook failed with ${response.status}`;
      const retries = args.subscription.cursor.retries + 1;

      return EventInput.parse({
        path: args.path,
        type: SUBSCRIPTION_DELIVERY_FAILED_TYPE,
        payload: {
          slug: args.slug,
          deliveryRevision: args.subscription.revision,
          deliveredEventOffset: nextEvent.offset,
          observedLastOffset,
          response: {
            statusCode: response.status,
            bodyPreview,
            message,
          },
          cursor: {
            lastAcknowledgedOffset: args.subscription.cursor.lastAcknowledgedOffset,
            nextDeliveryAt: computeNextRetryAt({ now: Date.now(), retries }),
            retries,
            lastError: {
              message,
              statusCode: response.status,
              bodyPreview,
              at: attemptedAt,
            },
          },
        },
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
        response: {
          statusCode: response.status,
          bodyPreview,
        },
        cursor: {
          lastAcknowledgedOffset: nextEvent.offset,
          nextDeliveryAt: deliverableEvents[1] == null ? null : attemptedAt,
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

export function createEmptyStreamState(): StreamState {
  return {
    path: null,
    lastOffset: null,
    eventCount: 0,
    metadata: {},
    subscriptions: {},
  } satisfies StreamState;
}

/**
 * Replay and append share the same reducer so state cannot drift based on which
 * code path produced it.
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
      const payload = SubscriptionDeliverySucceededPayload.parse(event.payload);
      const subscription = nextState.subscriptions[payload.slug];
      if (!subscription || payload.deliveryRevision !== subscription.revision) {
        return nextState;
      }

      subscription.cursor = payload.cursor;
      if (
        payload.cursor.nextDeliveryAt == null &&
        state.lastOffset !== payload.observedLastOffset
      ) {
        subscription.cursor.nextDeliveryAt = event.createdAt;
      }
      return nextState;
    }
    case SUBSCRIPTION_DELIVERY_FAILED_TYPE: {
      const payload = SubscriptionDeliveryFailedPayload.parse(event.payload);
      const subscription = nextState.subscriptions[payload.slug];
      if (!subscription || payload.deliveryRevision !== subscription.revision) {
        return nextState;
      }

      subscription.cursor = payload.cursor;
      return nextState;
    }
    case SUBSCRIPTION_CURSOR_UPDATED_TYPE: {
      const payload = SubscriptionCursorUpdatedPayload.parse(event.payload);
      const subscription = nextState.subscriptions[payload.slug];
      if (!subscription || payload.deliveryRevision !== subscription.revision) {
        return nextState;
      }

      subscription.cursor = payload.cursor;
      if (
        payload.cursor.nextDeliveryAt == null &&
        state.lastOffset !== payload.observedLastOffset
      ) {
        subscription.cursor.nextDeliveryAt = event.createdAt;
      }
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

export function getRetryDelayMs(retries: number) {
  return retryDelayMs[Math.min(Math.max(retries, 1), retryDelayMs.length) - 1]!;
}

export function computeNextRetryAt(args: { now: number; retries: number }) {
  return new Date(args.now + getRetryDelayMs(args.retries)).toISOString();
}

export function getNextAlarmAt(state: StreamState) {
  const dueAt = Object.values(state.subscriptions)
    .flatMap((subscription) =>
      subscription.cursor.nextDeliveryAt == null
        ? []
        : [Date.parse(subscription.cursor.nextDeliveryAt)],
    )
    .sort((left, right) => left - right)[0];

  return dueAt ?? null;
}

function getDueSubscriptions(args: { now: number; state: StreamState }) {
  return Object.entries(args.state.subscriptions).filter(([, subscription]) => {
    if (subscription.cursor.nextDeliveryAt == null) {
      return false;
    }

    return Date.parse(subscription.cursor.nextDeliveryAt) <= args.now;
  });
}

export function getDeliverableEvents(events: Event[]) {
  return events.filter((event) => !isInternalSubscriptionEventType(event.type));
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

async function safeReadResponseText(response: Response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncateBodyPreview(body: string) {
  if (body.length <= maxBodyPreviewLength) {
    return body || null;
  }

  return `${body.slice(0, maxBodyPreviewLength)}...`;
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
