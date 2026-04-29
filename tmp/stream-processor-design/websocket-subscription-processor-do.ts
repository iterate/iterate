import { DurableObject } from "cloudflare:workers";
import type {
  Processor,
  ProcessorState,
  ProcessorStreamApi,
  StreamEvent,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";
import {
  getProcessorStateSchema,
  runProcessorAfterAppend,
  runProcessorOnStart,
  runProcessorReduce,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";

/**
 * Inbound WebSocket subscription DO sketch.
 *
 * This matches the existing Events WebSocket subscription style: the Events
 * worker pushes committed events into this DO over a socket. The DO appends
 * derived events back through StreamApi.
 *
 * This is probably the first replacement for the current `IterateAgent`.
 */

type StoredProcessorState<Contract> = {
  state: ProcessorState<Contract>;
  reducedThroughOffset: number;
  started: boolean;
};

export abstract class WebSocketSubscriptionProcessorDO<
  Env,
  Contract extends { slug: string; state: unknown },
> extends DurableObject<Env> {
  protected abstract readonly processor: Processor<Contract>;
  protected abstract createStreamApi(): ProcessorStreamApi<Contract>;

  #state: StoredProcessorState<Contract> | null = null;

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("message", (message) => {
      this.ctx.waitUntil(this.#handleSocketMessage(message));
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async #loadState() {
    if (this.#state != null) return this.#state;
    const stored = await this.ctx.storage.kv.get<unknown>("stream-processor-state");
    const parsedState = getProcessorStateSchema(this.processor.contract).parse(
      typeof stored === "object" && stored !== null && "state" in stored
        ? (stored as { state: unknown }).state
        : undefined,
    ) as ProcessorState<Contract>;

    this.#state = {
      state: parsedState,
      reducedThroughOffset:
        typeof stored === "object" && stored !== null && "reducedThroughOffset" in stored
          ? Number((stored as { reducedThroughOffset: unknown }).reducedThroughOffset)
          : 0,
      started: false,
    };
    return this.#state;
  }

  async #saveState(state: StoredProcessorState<Contract>) {
    await this.ctx.storage.kv.put("stream-processor-state", state);
    this.#state = state;
  }

  async #handleSocketMessage(message: MessageEvent) {
    const event = parseStreamSocketEvent(message.data);
    if (event == null) return;

    const stored = await this.#loadState();
    const streamApi = this.createStreamApi();
    const signal = new AbortController().signal;

    /**
     * For push-based hosts, onStart fires lazily before first live afterAppend.
     * If the host needs historic catch-up, it should do it here before onStart.
     */
    if (!stored.started) {
      await runProcessorOnStart({
        processor: this.processor,
        state: stored.state,
        streamApi,
        signal,
      });
      stored.started = true;
      await this.#saveState(stored);
    }

    const reduction = runProcessorReduce({
      processor: this.processor,
      event,
      state: stored.state,
    });
    if (reduction == null) return;

    await this.#saveState({
      state: reduction.state,
      reducedThroughOffset: event.offset,
      started: true,
    });

    await runProcessorAfterAppend({
      processor: this.processor,
      ...reduction,
      streamApi,
      signal,
    });
  }
}

function parseStreamSocketEvent(raw: unknown): StreamEvent | null {
  if (typeof raw !== "string") return null;
  const data = JSON.parse(raw) as unknown;
  if (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "event" &&
    "event" in data
  ) {
    return data.event as StreamEvent;
  }
  return null;
}
