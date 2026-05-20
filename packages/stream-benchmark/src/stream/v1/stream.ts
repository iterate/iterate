import { DurableObject } from "cloudflare:workers";
import type { StreamEventInput as SharedStreamEventInput } from "@iterate-com/shared/stream-processors";
import { createDurableObjectClient, type SyncClient } from "sqlfu";
import { killDurableObject } from "../../durable-object-kill.js";
import { migrate } from "./db/migrations/.generated/migrations.js";
import * as sqlfu from "./db/queries/.generated/queries.js";
import { SubscriptionProcessorContract } from "./processors/subscriptions/contract.js";
import { createSubscriptionProcessor } from "./processors/subscriptions/implementation.js";
import type {
  ProcessorPushFrame,
  ProcessorReplyFrame,
  StreamCursor,
  StreamEvent,
  StreamEventInput,
  StreamEventSource,
  StreamPath,
  StreamSocketServerFrame,
} from "./types.js";

export class StreamV1 extends DurableObject<Env> {
  private readonly sql: SyncClient;
  private readonly connectionSourceByWebSocket = new WeakMap<WebSocket, StreamEventSource>();
  private readonly subscriptionProcessor: ReturnType<typeof createSubscriptionProcessor>;
  private subscriptionState = SubscriptionProcessorContract.stateSchema.parse(
    SubscriptionProcessorContract.initialState,
  );

  /**
   * The Worker routes the whole URL path to the Durable Object name:
   *
   *   env.STREAM.getByName(url.pathname).fetch(request)
   *
   * `ctx.id.name` is therefore the stream path. It is not stored in SQLite,
   * and it is not an input to reads or appends. We only echo it on events so
   * subscribers that share generic client code can tell which stream produced
   * a message.
   *
   * Cloudflare source:
   * https://developers.cloudflare.com/durable-objects/api/id/#name
   */
  get path(): StreamPath {
    const name = this.ctx.id.name;
    if (name === undefined) {
      throw new Error("Stream Durable Object must be addressed by name.");
    }
    return name as StreamPath;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = createDurableObjectClient(ctx.storage);
    this.subscriptionProcessor = createSubscriptionProcessor();

    /**
     * WebSocket hibernation is the first-class Durable Object pattern for
     * server-side WebSockets. `setWebSocketAutoResponse` lets Cloudflare answer
     * trivial keepalive messages without waking the Durable Object.
     *
     * Cloudflare sources:
     * https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-hibernation
     * https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse
     */
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    migrate(this.sql);
    this.subscriptionState = {
      subscribersByKey: Object.fromEntries(
        sqlfu.listSubscribers(this.sql).map((subscriber) => [
          subscriber.key,
          {
            key: subscriber.key,
            processorSlug: subscriber.processor_slug,
            lastSentOffset: subscriber.last_sent_offset,
          },
        ]),
      ),
    };
  }

  async append(args: { event: StreamEventInput }): Promise<StreamEvent> {
    await this.subscriptionProcessor.implementation.beforeAppend?.({
      event: args.event as SharedStreamEventInput,
      state: this.subscriptionState,
    });

    if (args.event.idempotencyKey !== undefined) {
      const existing = sqlfu.findEventByIdempotencyKey(this.sql, {
        idempotencyKey: args.event.idempotencyKey,
      });
      if (existing != null) {
        return rowToEvent({ streamPath: this.path, row: existing });
      }
    }

    const nextOffset = (sqlfu.countEvents(this.sql)?.count ?? 0) + 1;
    if (args.event.offset !== undefined) {
      if (args.event.offset !== nextOffset) {
        throw new Error(
          `Offset precondition failed: expected ${nextOffset}, got ${args.event.offset}`,
        );
      }
    }

    const committedEvent = this.commitAppend({ event: args.event, offset: nextOffset });
    await this.afterAppend({ event: committedEvent });
    return committedEvent;
  }

  async appendBatch(args: { events: StreamEventInput[] }): Promise<StreamEvent[]> {
    const committedEvents: StreamEvent[] = [];
    for (const event of args.events) {
      committedEvents.push(await this.append({ event }));
    }
    return committedEvents;
  }

  /** Forcibly reset this instance (`ctx.abort`). RPC rejects; object restarts on next request. */
  kill(args?: { reason?: string }): never {
    killDurableObject({ ctx: this.ctx, reason: args?.reason });
  }

  read(args?: { after?: StreamCursor; before?: StreamCursor }): StreamEvent[] {
    return readEventRows({
      client: this.sql,
      after: args?.after,
      before: args?.before ?? "end",
    }).map((row) => rowToEvent({ streamPath: this.path, row }));
  }

  stream(args?: { after?: StreamCursor; before?: StreamCursor }): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const rows = readEventRows({
      client: this.sql,
      after: args?.after,
      before: args?.before ?? "end",
    });
    const path = this.path;
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index >= rows.length) {
          controller.close();
          return;
        }
        const event = rowToEvent({ streamPath: path, row: rows[index++] });
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (request.method !== "GET") {
        return new Response("WebSocket connections must use GET", { status: 400 });
      }

      const cursor = parseCursor({
        value: url.searchParams.get("after") ?? url.searchParams.get("start"),
      });
      const after =
        cursor === "end"
          ? (sqlfu.getLatestEventOffset(this.sql)?.offset ?? 0)
          : resolveCursor({ cursor });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const attachment = {
        lastSentOffset: after,
        tracing: {
          cfRayId: request.headers.get("cf-ray") ?? undefined,
          cfRequestId: request.headers.get("cf-request-id") ?? undefined,
        },
      };

      /**
       * This is the key hibernation call. It accepts the server side of the
       * WebSocket without pinning this Durable Object in memory while the
       * socket is idle. If the object hibernates, Cloudflare reconstructs the
       * class and delivers future socket events to `webSocketMessage` /
       * `webSocketClose`.
       *
       * We immediately serialize the only per-socket state we need: the last
       * offset sent to this client. Attachments survive hibernation and are
       * restored with `deserializeAttachment`.
       *
       * Cloudflare sources:
       * https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
       * https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment
       */
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(attachment);
      this.connectionSourceByWebSocket.set(server, { tracing: attachment.tracing });
      this.sendFrame({
        ws: server,
        frame: {
          type: "ready",
          streamPath: this.path,
          after,
          cfRay: attachment.tracing.cfRayId,
        },
      });

      for (const row of readEventRows({
        client: this.sql,
        after,
        before: Number.MAX_SAFE_INTEGER,
      })) {
        this.sendEvent({
          ws: server,
          event: rowToEvent({ streamPath: this.path, row }),
          attachment,
        });
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET") {
      const after = parseCursor({
        value: url.searchParams.get("after") ?? url.searchParams.get("start"),
      });
      const beforeParam = url.searchParams.get("before");
      const before = beforeParam == null ? "end" : parseCursor({ value: beforeParam });
      return Response.json(this.read({ after, before }));
    }

    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      /**
       * Cloudflare delivers messages for hibernating sockets here. The client
       * protocol is intentionally tiny for benchmarking:
       *
       *   { "op": "append", "event": { ...StreamEventInput } }
       *   { "op": "appendBatch", "events": [{ ...StreamEventInput }] }
       *
       * Each committed append is synchronously persisted to SQLite, decorated
       * with this Durable Object's `streamPath`, then broadcast to every
       * hibernating WebSocket returned by `ctx.getWebSockets()`.
       *
       * Cloudflare sources:
       * https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketmessage
       * https://developers.cloudflare.com/durable-objects/api/state/#getwebsockets
       */
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Expected a JSON object frame.");
      }

      const frame = parsed as { op?: unknown; event?: unknown; events?: unknown };
      if (frame.op !== "append" && frame.op !== "appendBatch") {
        throw new Error("Expected op to be append or appendBatch.");
      }

      const events = frame.op === "append" ? [frame.event] : frame.events;

      if (!Array.isArray(events)) {
        throw new Error("appendBatch frames must include an events array.");
      }

      const deserialized = ws.deserializeAttachment() as StreamSocketAttachment | undefined;
      const source = this.connectionSourceByWebSocket.get(ws) ?? {
        tracing: {
          cfRayId:
            typeof deserialized?.tracing?.cfRayId === "string"
              ? deserialized.tracing.cfRayId
              : undefined,
          cfRequestId:
            typeof deserialized?.tracing?.cfRequestId === "string"
              ? deserialized.tracing.cfRequestId
              : undefined,
        },
      };

      for (const event of events) {
        if (!event || typeof event !== "object" || typeof event.type !== "string") {
          throw new Error("events must be objects with a string type.");
        }

        const eventInput = event as StreamEventInput;
        const eventSource: StreamEventSource = {
          ...eventInput.source,
          tracing: {
            ...eventInput.source?.tracing,
            ...source.tracing,
          },
        };
        if (
          eventSource.tracing &&
          eventSource.tracing.cfRayId === undefined &&
          eventSource.tracing.cfRequestId === undefined
        ) {
          delete eventSource.tracing;
        }

        await this.append({
          event: {
            ...eventInput,
            ...(eventSource.processor !== undefined || eventSource.tracing !== undefined
              ? { source: eventSource }
              : {}),
          },
        });
      }
    } catch (error) {
      this.sendFrame({
        ws,
        frame: {
          type: "error",
          message: error instanceof Error ? error.message : "Failed to handle WebSocket message.",
        },
      });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    /**
     * On compatibility dates >= 2026-04-07 Cloudflare auto-replies to close
     * frames. Calling `close` remains safe and mirrors the first-party examples.
     *
     * Cloudflare source:
     * https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
     */
    ws.close(code, reason);
  }

  private commitAppend(args: { event: StreamEventInput; offset: number }): StreamEvent {
    const createdAt = new Date().toISOString();
    const committedEvent: StreamEvent = {
      streamPath: this.path,
      offset: args.offset,
      createdAt,
      type: args.event.type,
      ...(args.event.payload === undefined ? {} : { payload: args.event.payload }),
      ...(args.event.metadata === undefined ? {} : { metadata: args.event.metadata }),
      ...(args.event.source === undefined ? {} : { source: args.event.source }),
      ...(args.event.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: args.event.idempotencyKey }),
    };
    const row = sqlfu.appendEvent(this.sql, {
      offset: committedEvent.offset,
      type: args.event.type,
      idempotencyKey: committedEvent.idempotencyKey ?? null,
      createdAt,
      rawJson: JSON.stringify(committedEvent),
    });

    recordAppendMetric({ env: this.env, streamPath: this.path });

    const storedEvent = rowToEvent({ streamPath: this.path, row });
    const nextSubscriptionState =
      SubscriptionProcessorContract.reduce?.({
        contract: SubscriptionProcessorContract,
        event: storedEvent as never,
        state: this.subscriptionState,
      }) ?? this.subscriptionState;

    if (nextSubscriptionState !== this.subscriptionState) {
      this.subscriptionState = nextSubscriptionState;
      for (const subscriber of Object.values(this.subscriptionState.subscribersByKey)) {
        sqlfu.upsertSubscriber(this.sql, {
          key: subscriber.key,
          processorSlug: subscriber.processorSlug,
          lastSentOffset: subscriber.lastSentOffset,
        });
      }
    }

    return storedEvent;
  }

  private broadcast(event: StreamEvent): void {
    for (const ws of this.ctx.getWebSockets()) {
      const deserialized = ws.deserializeAttachment() as StreamSocketAttachment | undefined;
      const attachment = {
        lastSentOffset:
          typeof deserialized?.lastSentOffset === "number" ? deserialized.lastSentOffset : 0,
        tracing: {
          cfRayId:
            typeof deserialized?.tracing?.cfRayId === "string"
              ? deserialized.tracing.cfRayId
              : undefined,
          cfRequestId:
            typeof deserialized?.tracing?.cfRequestId === "string"
              ? deserialized.tracing.cfRequestId
              : undefined,
        },
      };
      if (attachment.lastSentOffset >= event.offset) continue;
      this.sendEvent({ ws, event, attachment });
    }
  }

  private sendEvent(args: {
    ws: WebSocket;
    event: StreamEvent;
    attachment: StreamSocketAttachment;
  }): void {
    try {
      this.sendFrame({ ws: args.ws, frame: { type: "event", event: args.event } });
      args.ws.serializeAttachment({ ...args.attachment, lastSentOffset: args.event.offset });
    } catch {
      args.ws.close(1011, "Failed to send stream event.");
    }
  }

  private sendFrame(args: { ws: WebSocket; frame: StreamSocketServerFrame }): void {
    args.ws.send(JSON.stringify(args.frame));
  }

  private async afterAppend(args: { event: StreamEvent }) {
    this.broadcast(args.event);

    if (args.event.type === "subscription-configured") {
      const payload = SubscriptionProcessorContract.events[
        "events.iterate.com/stream/processor-subscribed"
      ].payloadSchema.parse(args.event.payload);
      const subscriber = this.subscriptionState.subscribersByKey[payload.key];
      if (subscriber == null) return;

      let lastSentOffset = subscriber.lastSentOffset;
      for (const event of readEventRows({
        client: this.sql,
        after: lastSentOffset,
        before: "end",
      }).map((row) => rowToEvent({ streamPath: this.path, row }))) {
        await this.deliverEventToSubscriber({
          event,
          subscriber: { ...subscriber, lastSentOffset },
        });
        lastSentOffset = event.offset;
      }
      return;
    }

    for (const subscriber of Object.values(this.subscriptionState.subscribersByKey)) {
      if (subscriber.lastSentOffset >= args.event.offset) continue;
      await this.deliverEventToSubscriber({ event: args.event, subscriber });
    }
  }

  private async deliverEventToSubscriber(args: {
    event: StreamEvent;
    subscriber: ReturnType<
      typeof SubscriptionProcessorContract.stateSchema.parse
    >["subscribersByKey"][string];
  }) {
    const socket = await getSubscriberSocket({
      env: this.env,
      streamPath: this.path,
      subscriber: args.subscriber,
      onReply: async (frame) => {
        if (frame.op === "cursor") {
          this.updateSubscriberCursor({
            key: args.subscriber.key,
            offset: frame.offset,
          });
          return;
        }

        await this.append({ event: frame.event });
      },
    });

    if (args.event.offset <= args.subscriber.lastSentOffset) return;

    sendProcessorFrame({
      socket,
      frame: { type: "event", event: args.event },
    });

    this.updateSubscriberCursor({
      key: args.subscriber.key,
      offset: args.event.offset,
    });
    args.subscriber.lastSentOffset = args.event.offset;
  }

  private updateSubscriberCursor(args: { key: string; offset: number }) {
    sqlfu.updateSubscriberCursor(this.sql, { lastSentOffset: args.offset }, { key: args.key });

    const subscriber = this.subscriptionState.subscribersByKey[args.key];
    if (subscriber != null) {
      subscriber.lastSentOffset = args.offset;
    }
  }
}

type StreamSocketAttachment = {
  lastSentOffset: number;
  tracing?: {
    cfRayId?: unknown;
    cfRequestId?: unknown;
  };
};

function readEventRows(args: {
  client: SyncClient;
  after?: StreamCursor;
  before?: StreamCursor;
}): sqlfu.readEventsRange.Result[] {
  return sqlfu.readEventsRange(args.client, {
    afterOffset: resolveCursor({ cursor: args.after }),
    beforeOffset: resolveCursor({ cursor: args.before }),
  });
}

function rowToEvent(args: {
  streamPath: StreamPath;
  row: sqlfu.readEventsRange.Result;
}): StreamEvent {
  const event = JSON.parse(args.row.raw_json) as StreamEvent;
  return {
    ...event,
    streamPath: args.streamPath,
    offset: args.row.offset,
    type: args.row.type,
    createdAt: args.row.created_at,
    idempotencyKey: args.row.idempotency_key ?? undefined,
  };
}

/**
 * Converts protocol cursors into the numeric offset bounds used by the SQL
 * event range query. `start` means "strictly after offset 0"; `end` is represented
 * as a very large exclusive upper bound so the same query can serve both reads
 * and catch-up streams.
 */
function resolveCursor(args: { cursor: StreamCursor | undefined }): number {
  if (args.cursor === undefined || args.cursor === "start") return 0;
  if (args.cursor === "end") return Number.MAX_SAFE_INTEGER;
  return args.cursor;
}

/**
 * Parses cursor values from URL search params. The wire protocol uses readable
 * sentinels (`start`, `end`) plus numeric offsets, while internal callers pass
 * around the typed `StreamCursor` union.
 */
function parseCursor(args: { value: string | null | undefined }): StreamCursor | undefined {
  if (args.value == null || args.value === "" || args.value === "start") return "start";
  if (args.value === "end") return "end";

  const offset = Number(args.value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`Invalid stream cursor: ${args.value}`);
  }
  return offset;
}

/**
 * One Workers Analytics Engine row per committed append. Count at query time via
 * SUM(_sample_interval), not double1: 1.
 *
 * https://developers.cloudflare.com/analytics/analytics-engine/get-started/
 */
function recordAppendMetric(args: { env: Env; streamPath: StreamPath }) {
  args.env.METRICS.writeDataPoint({
    indexes: [args.streamPath],
    blobs: [args.streamPath, "append", args.env.ENV_NAME],
    doubles: [],
  });

  console.log(
    JSON.stringify({
      metric: "stream.append",
      streamPath: args.streamPath,
      env: args.env.ENV_NAME,
      version: "v1",
    }),
  );
}

const subscriberSockets = new Map<string, WebSocket>();
const subscriberConnectPromises = new Map<string, Promise<WebSocket>>();

async function getSubscriberSocket(args: {
  env: Env;
  onReply(args: ProcessorReplyFrame): Promise<void>;
  streamPath: StreamPath;
  subscriber: ReturnType<
    typeof SubscriptionProcessorContract.stateSchema.parse
  >["subscribersByKey"][string];
}): Promise<WebSocket> {
  const key = subscriberSocketKey({ key: args.subscriber.key, streamPath: args.streamPath });
  const cached = subscriberSockets.get(key);
  if (cached != null && cached.readyState === WebSocket.OPEN) {
    return cached;
  }

  const inFlight = subscriberConnectPromises.get(key);
  if (inFlight != null) return inFlight;

  const connectPromise = connectSubscriberSocket(args);
  subscriberConnectPromises.set(key, connectPromise);

  try {
    const socket = await connectPromise;
    subscriberSockets.set(key, socket);
    return socket;
  } finally {
    if (subscriberConnectPromises.get(key) === connectPromise) {
      subscriberConnectPromises.delete(key);
    }
  }
}

async function connectSubscriberSocket(args: {
  env: Env;
  onReply(args: ProcessorReplyFrame): Promise<void>;
  streamPath: StreamPath;
  subscriber: ReturnType<
    typeof SubscriptionProcessorContract.stateSchema.parse
  >["subscribersByKey"][string];
}): Promise<WebSocket> {
  const key = subscriberSocketKey({ key: args.subscriber.key, streamPath: args.streamPath });
  const stub = args.env.STREAM_PROCESSOR.getByName(
    `${args.streamPath}:${args.subscriber.processorSlug}`,
  );
  const response = await stub.fetch(
    new Request("https://stream-processor.internal/", {
      headers: { Upgrade: "websocket" },
    }),
  );

  const socket = response.webSocket;
  if (socket == null) {
    throw new Error(`Processor "${args.subscriber.processorSlug}" did not return a WebSocket.`);
  }

  // Client-side accept for cross-DO WebSocket fetch:
  // https://developers.cloudflare.com/durable-objects/best-practices/websockets/#connect-to-a-websocket-server-from-a-durable-object
  socket.accept();

  socket.addEventListener("message", (event) => {
    void handleSubscriberSocketMessage({
      event,
      onReply: args.onReply,
      socketKey: key,
    });
  });
  socket.addEventListener("close", () => {
    subscriberSockets.delete(key);
  });
  socket.addEventListener("error", () => {
    subscriberSockets.delete(key);
  });

  sendProcessorFrame({
    socket,
    frame: {
      type: "ready",
      streamPath: args.streamPath,
      after: args.subscriber.lastSentOffset,
      subscriberKey: args.subscriber.key,
    },
  });

  return socket;
}

async function handleSubscriberSocketMessage(args: {
  event: MessageEvent;
  onReply(args: ProcessorReplyFrame): Promise<void>;
  socketKey: string;
}) {
  const raw =
    typeof args.event.data === "string"
      ? args.event.data
      : new TextDecoder().decode(args.event.data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[stream-v1] processor sent invalid JSON", { socketKey: args.socketKey });
    return;
  }

  const frame = parsed as ProcessorReplyFrame & { type?: string };
  if (frame.type === "error") return;

  if (frame.op === "append" || frame.op === "cursor") {
    await args.onReply(frame);
  }
}

function sendProcessorFrame(args: { socket: WebSocket; frame: ProcessorPushFrame }) {
  args.socket.send(JSON.stringify(args.frame));
}

function subscriberSocketKey(args: { key: string; streamPath: StreamPath }) {
  return `${args.streamPath}:${args.key}`;
}
