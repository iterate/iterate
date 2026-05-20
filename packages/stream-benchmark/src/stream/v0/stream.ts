import { DurableObject } from "cloudflare:workers";
import { createDurableObjectClient, type SyncClient } from "sqlfu";
import { migrate } from "./db/migrations/.generated/migrations.js";
import * as sqlfu from "./db/queries/.generated/queries.js";
import type {
  StreamCursor,
  StreamEvent,
  StreamEventInput,
  StreamEventSource,
  StreamPath,
  StreamSocketServerFrame,
} from "./types.js";

export class Stream extends DurableObject<Env> {
  private readonly sql: SyncClient;
  private readonly connectionSourceByWebSocket = new WeakMap<WebSocket, StreamEventSource>();

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
    if (!name.startsWith("/")) {
      throw new Error(`Stream path must start with "/": ${name}`);
    }
    return name as StreamPath;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = createDurableObjectClient(ctx.storage);

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
  }

  append({ event }: { event: StreamEventInput }): StreamEvent {
    const result = this.commit({ event });
    if (result.committed) this.broadcast(result.event);
    return result.event;
  }

  appendBatch({ events }: { events: StreamEventInput[] }): StreamEvent[] {
    return events.map((event) => this.append({ event }));
  }

  read(args?: { after?: StreamCursor; before?: StreamCursor }): StreamEvent[] {
    return readEventRows({
      client: this.sql,
      after: args?.after,
      before: args?.before,
    }).map((row) => rowToEvent({ streamPath: this.path, row }));
  }

  stream(args?: { after?: StreamCursor; before?: StreamCursor }): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const rows = readEventRows({
      client: this.sql,
      after: args?.after,
      before: args?.before,
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
      const before = parseCursor({ value: url.searchParams.get("before") });
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

        const result = this.commit({ event, source });
        if (result.committed) this.broadcast(result.event);
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

  private commit({
    event,
    source: commitSource,
  }: {
    event: StreamEventInput;
    source?: StreamEventSource;
  }) {
    if (event.idempotencyKey) {
      const existing = sqlfu.findEventByIdempotencyKey(this.sql, {
        idempotencyKey: event.idempotencyKey,
      });
      if (existing != null) {
        return {
          event: rowToEvent({ streamPath: this.path, row: existing }),
          committed: false,
        };
      }
    }

    if (event.offset !== undefined) {
      const nextOffset = (sqlfu.countEvents(this.sql)?.c ?? 0) + 1;
      if (event.offset !== nextOffset) {
        throw new Error(`Offset precondition failed: expected ${nextOffset}, got ${event.offset}`);
      }
    }

    const source: StreamEventSource = {
      ...event.source,
      tracing: {
        ...event.source?.tracing,
        ...commitSource?.tracing,
      },
    };
    if (
      source.tracing &&
      source.tracing.cfRayId === undefined &&
      source.tracing.cfRequestId === undefined
    ) {
      delete source.tracing;
    }

    const row = sqlfu.appendEvent(this.sql, {
      type: event.type,
      payload: event.payload !== undefined ? JSON.stringify(event.payload) : null,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      source:
        source.processor !== undefined || source.tracing !== undefined
          ? JSON.stringify(source)
          : null,
      idempotencyKey: event.idempotencyKey ?? null,
    });

    return {
      event: rowToEvent({ streamPath: this.path, row }),
      committed: true,
    };
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

  private sendEvent({
    ws,
    event,
    attachment,
  }: {
    ws: WebSocket;
    event: StreamEvent;
    attachment: StreamSocketAttachment;
  }): void {
    try {
      this.sendFrame({ ws, frame: { type: "event", event } });
      ws.serializeAttachment({ ...attachment, lastSentOffset: event.offset });
    } catch {
      ws.close(1011, "Failed to send stream event.");
    }
  }

  private sendFrame({ ws, frame }: { ws: WebSocket; frame: StreamSocketServerFrame }): void {
    ws.send(JSON.stringify(frame));
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
  return {
    streamPath: args.streamPath,
    offset: args.row.offset,
    createdAt: args.row.created_at,
    type: args.row.type,
    payload: args.row.payload ? JSON.parse(args.row.payload) : undefined,
    metadata: args.row.metadata ? JSON.parse(args.row.metadata) : undefined,
    source: args.row.source ? JSON.parse(args.row.source) : undefined,
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
