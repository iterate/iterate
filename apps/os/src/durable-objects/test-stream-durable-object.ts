import { DurableObject } from "cloudflare:workers";
import {
  type Event,
  EventInput,
  STREAM_FIRST_INITIALIZED_TYPE,
  type StreamCursor,
  StreamPath,
  type StreamState,
} from "@iterate-com/shared/streams/types";

export class StreamDurableObject extends DurableObject {
  #subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  async initialize(args: { name: string }) {
    if (await this.getState()) return;

    const parsedName = JSON.parse(args.name) as { namespace?: unknown; path?: unknown };
    if (typeof parsedName.namespace !== "string") {
      throw new Error("Stream Durable Object name must include a string namespace.");
    }
    const structuredName = {
      namespace: parsedName.namespace,
      path: StreamPath.parse(parsedName.path),
    };

    await this.ctx.storage.put("state", {
      childPaths: [],
      descendantPaths: [],
      eventCount: 0,
      metadata: {},
      namespace: structuredName.namespace,
      path: structuredName.path,
      processors: {},
    } as unknown as StreamState);
    await this.append({
      type: STREAM_FIRST_INITIALIZED_TYPE,
      payload: { namespace: structuredName.namespace, path: structuredName.path },
    });
  }

  async append(inputEvent: EventInput): Promise<Event> {
    const input = EventInput.parse(inputEvent);
    const state = await this.requireState();
    const events = await this.getEvents();
    const existing =
      input.idempotencyKey == null
        ? undefined
        : events.find((event) => event.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;

    const event: Event = {
      streamPath: state.path,
      ...input,
      offset: events.length + 1,
      createdAt: new Date().toISOString(),
    };
    events.push(event);
    await this.ctx.storage.put("events", events);
    await this.ctx.storage.put("state", { ...state, eventCount: events.length });
    this.publish(event);
    return event;
  }

  async history(args: { after?: StreamCursor; before?: StreamCursor } = {}) {
    const state = await this.requireState();
    const events = await this.getEvents();
    const after = cursorToOffset(args.after, 0, state.eventCount);
    const before = cursorToOffset(args.before ?? "end", state.eventCount + 1, state.eventCount);
    return events.filter((event) => event.offset > after && event.offset < before);
  }

  async historyIfInitialized(args: { after?: StreamCursor; before?: StreamCursor } = {}) {
    if (!(await this.getState())) return [];
    return await this.history(args);
  }

  async getState() {
    return (await this.ctx.storage.get<StreamState>("state")) ?? null;
  }

  stream(args: { after?: StreamCursor; before?: StreamCursor } = {}) {
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        for (const event of await this.history(args)) {
          controller.enqueue(encodeEventLine(event));
        }

        if (args.before != null) {
          controller.close();
          return;
        }

        subscriber = controller;
        this.#subscribers.add(controller);
      },
      cancel: () => {
        if (subscriber) this.#subscribers.delete(subscriber);
      },
    });
  }

  async destroy() {
    await this.ctx.storage.deleteAll();
    return { destroyedStreamCount: 1, finalStateByPath: {} };
  }

  private async requireState() {
    const state = await this.getState();
    if (!state) throw new Error("Test stream was not initialized.");
    return state;
  }

  private async getEvents() {
    return (await this.ctx.storage.get<Event[]>("events")) ?? [];
  }

  private publish(event: Event) {
    const chunk = encodeEventLine(event);
    for (const subscriber of this.#subscribers) {
      subscriber.enqueue(chunk);
    }
  }
}

function cursorToOffset(cursor: StreamCursor | undefined, fallback: number, endOffset: number) {
  if (cursor == null) return fallback;
  if (cursor === "start") return 0;
  if (cursor === "end") return endOffset + 1;
  return cursor;
}

function encodeEventLine(event: Event) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}
