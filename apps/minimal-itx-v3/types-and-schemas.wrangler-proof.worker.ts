import { DurableObject } from "cloudflare:workers";
import type { RpcStub } from "capnweb";
import {
  StreamEvent as StreamEventSchema,
  type Json,
  type Stream,
  type StreamEvent,
  type StreamEventInput,
} from "./types-and-schemas.ts";

export class ProofStreamDurableObject
  extends DurableObject<Record<string, never>>
  implements Stream
{
  #events: StreamEvent[] = [];

  append(args: { event: StreamEventInput }): StreamEvent {
    return this.appendBatch({ events: [args.event] })[0]!;
  }

  appendBatch(args: { events: StreamEventInput[] }): StreamEvent[] {
    const committed = args.events.map((event, index) =>
      StreamEventSchema.parse({
        ...event,
        createdAt: new Date().toISOString(),
        offset: this.#events.length + index + 1,
      }),
    );
    this.#events.push(...committed);
    return committed;
  }

  getEvents(
    args: {
      afterOffset?: number;
      beforeOffset?: number | null;
      limit?: number;
    } = {},
  ): StreamEvent[] {
    const afterOffset = args.afterOffset ?? 0;
    const beforeOffset = args.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.#events
      .filter((event) => event.offset > afterOffset && event.offset < beforeOffset)
      .slice(0, args.limit ?? Number.MAX_SAFE_INTEGER);
  }

  at(_path: string): RpcStub<Stream> {
    return this as unknown as RpcStub<Stream>;
  }

  jsonRoundTrip(value: Json): Json {
    return value;
  }
}

export default {
  fetch() {
    return new Response("types-and-schemas proof");
  },
} satisfies ExportedHandler<Record<string, never>>;
