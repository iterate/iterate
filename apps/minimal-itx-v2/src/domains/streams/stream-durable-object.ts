import { env, RpcTarget } from "cloudflare:workers";
import { Stream } from "@iterate-com/os/src/domains/streams/engine/workers/durable-objects/stream.ts";
import type { StreamEventInput } from "@iterate-com/os/src/domains/streams/engine/shared/event.ts";
import type { StreamRpc } from "../../itx-types.ts";
import { formatDurableObjectName } from "../durable-object-names.ts";

// The reference implementation uses the real apps/os Stream Durable Object, but
// gives it a domain-local class name so the Worker binding table reads like the
// rest of this app: PROJECT, AGENT, REPO, STREAM are all local domain objects.
export class StreamDurableObject extends Stream implements StreamRpc {
  async create(input: Record<string, unknown> = {}) {
    const requested = await this.append({
      event: {
        type: "events.iterate.com/stream/create-requested",
        payload: input,
      },
    });
    const created = this.waitForEvent({
      afterOffset: requested.offset,
      eventTypes: ["events.iterate.com/stream/domain-created"],
      predicate: () => true,
      timeoutMs: 5_000,
    });
    await this.append({
      event: {
        type: "events.iterate.com/stream/domain-created",
        payload: { ...input, path: this.name.path, projectId: this.name.projectId },
      },
    });
    return await created;
  }
}

export class StreamRpcTarget extends RpcTarget implements StreamRpc {
  constructor(readonly props: { path: string; projectId: string }) {
    super();
  }

  append(args: { streamPath?: string; event: StreamEventInput }) {
    return this.#stub().append(args);
  }

  appendBatch(args: { streamPath?: string; events: StreamEventInput[] }) {
    return this.#stub().appendBatch(args);
  }

  create(input: Record<string, unknown> = {}) {
    return this.#stub().create(input);
  }

  getEvents(args?: { afterOffset?: number; beforeOffset?: number | null; limit?: number }) {
    return this.#stub().getEvents(args);
  }

  #stub() {
    return env.STREAM.getByName(formatDurableObjectName(this.props));
  }
}
