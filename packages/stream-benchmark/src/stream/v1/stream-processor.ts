import { DurableObject } from "cloudflare:workers";
import { killDurableObject } from "../../durable-object-kill.js";
import { echoProcessor, type EchoProcessorState } from "./processors/echo.js";
import type {
  ProcessorPushFrame,
  ProcessorReplyFrame,
  StreamEvent,
  StreamEventInput,
  StreamPath,
} from "./types.js";

const STORED_STATE_KEY = "stream-processor:stored-state";

type StoredProcessorState = {
  streamPath: StreamPath | null;
  subscriberKey: string | null;
  processorState: EchoProcessorState;
  lastProcessedOffset: number;
  afterAppendCompletedThroughOffset: number;
};

/**
 * A stream processor runner as its own Durable Object. Only `fetch()` accepts
 * inbound WebSocket upgrades from the Stream DO; there is no RPC surface.
 *
 * Reduced state and processing cursors persist in Durable Object storage so the
 * object can hibernate between events.
 *
 * Cloudflare WebSocket hibernation on the server side:
 * https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 */
export class StreamProcessor extends DurableObject<Env> {
  private outboundStreamSocket: WebSocket | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Forcibly reset this instance (`ctx.abort`). RPC rejects; object restarts on next request. */
  kill(args?: { reason?: string }): never {
    killDurableObject({ ctx: this.ctx, reason: args?.reason });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    if (request.method !== "GET") {
      return new Response("WebSocket connections must use GET", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.outboundStreamSocket = server;

    const stored = this.loadStoredState();
    server.send(
      JSON.stringify({
        type: "processor-ready",
        lastProcessedOffset: stored.lastProcessedOffset,
        streamPath: stored.streamPath,
        subscriberKey: stored.subscriberKey,
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      const frame = JSON.parse(raw) as ProcessorPushFrame;

      if (frame.type === "ready") {
        const stored = this.loadStoredState();
        this.saveStoredState({
          ...stored,
          streamPath: frame.streamPath,
          subscriberKey: frame.subscriberKey,
        });
        return;
      }

      if (frame.type === "error") {
        console.error("[stream-processor] stream reported error", frame.message);
        return;
      }

      if (frame.type !== "event") {
        throw new Error("Expected push frame type ready, event, or error.");
      }

      await this.processEvent({ event: frame.event, ws });
    } catch (error) {
      this.sendReply({
        ws,
        frame: {
          type: "error",
          message: error instanceof Error ? error.message : "Failed to handle stream frame.",
        },
      });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (this.outboundStreamSocket === ws) {
      this.outboundStreamSocket = null;
    }
    ws.close(code, reason);
  }

  private async processEvent(args: { event: StreamEvent; ws: WebSocket }) {
    const stored = this.loadStoredState();
    const decision = this.beforeProcessEvent({ event: args.event, state: stored });
    if (decision.skip) return;

    const committed = this.commitProcessedEvent({
      event: args.event,
      state: stored,
    });

    await this.afterProcessEvent({
      event: args.event,
      state: committed,
      ws: args.ws,
    });
  }

  private beforeProcessEvent(args: { event: StreamEvent; state: StoredProcessorState }) {
    if (args.event.offset <= args.state.afterAppendCompletedThroughOffset) {
      return { skip: true };
    }

    if (args.event.offset > args.state.lastProcessedOffset + 1) {
      throw new Error(
        `Gap before offset ${args.event.offset}; processor last saw ${args.state.lastProcessedOffset}.`,
      );
    }

    return { skip: false };
  }

  private commitProcessedEvent(args: {
    event: StreamEvent;
    state: StoredProcessorState;
  }): StoredProcessorState {
    const nextProcessorState = echoProcessor.reduce({
      state: args.state.processorState,
      event: args.event,
    });

    const nextState = {
      ...args.state,
      processorState: nextProcessorState,
      lastProcessedOffset: args.event.offset,
    };
    this.saveStoredState(nextState);
    return nextState;
  }

  private async afterProcessEvent(args: {
    event: StreamEvent;
    state: StoredProcessorState;
    ws: WebSocket;
  }) {
    const append = async (event: StreamEventInput) => {
      this.sendReply({ ws: args.ws, frame: { op: "append", event } });
    };

    try {
      await echoProcessor.afterAppend({
        event: args.event,
        state: args.state.processorState,
        append,
      });
    } catch (error) {
      console.error("[stream-processor] afterAppend failed", {
        offset: args.event.offset,
        type: args.event.type,
        error,
      });
      throw error;
    }

    const stored = {
      ...this.loadStoredState(),
      afterAppendCompletedThroughOffset: args.event.offset,
    };
    this.saveStoredState(stored);

    this.sendReply({ ws: args.ws, frame: { op: "cursor", offset: args.event.offset } });
  }

  private loadStoredState(): StoredProcessorState {
    const stored = this.ctx.storage.kv.get<StoredProcessorState>(STORED_STATE_KEY);
    if (stored != null) return stored;

    return {
      streamPath: null,
      subscriberKey: null,
      processorState: echoProcessor.initialState,
      lastProcessedOffset: 0,
      afterAppendCompletedThroughOffset: 0,
    };
  }

  private saveStoredState(state: StoredProcessorState) {
    this.ctx.storage.kv.put(STORED_STATE_KEY, state);
  }

  private sendReply(args: {
    ws: WebSocket;
    frame: ProcessorReplyFrame | { type: "error"; message: string };
  }) {
    args.ws.send(JSON.stringify(args.frame));
  }
}
