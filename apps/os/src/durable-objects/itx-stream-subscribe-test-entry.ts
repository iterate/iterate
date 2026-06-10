import { WorkerEntrypoint } from "cloudflare:workers";
import type { StreamCursor, Event as StreamLegacyEvent } from "@iterate-com/shared/streams/types";
import { ItxStream, type ItxRuntime } from "~/itx/handle.ts";
import { getStreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";

export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { Stream as StreamDurableObject } from "@iterate-com/streams/workers/durable-objects/stream";

const projectId = "proj__test__itxsubscribe";

/**
 * Test-only RPC surface that drives ItxStream exactly the way production
 * does: the test's callback crosses a Workers RPC boundary into this
 * entrypoint (standing in for a capnweb session / cap isolate), ItxStream
 * dup()s it and forwards it through the ctx.exports loopback into
 * StreamsCapability, whose wrapper closure is what the real Stream Durable
 * Object retains for live delivery.
 */
export class ItxStreamHarness extends WorkerEntrypoint<Env> {
  async append(input: {
    path: string;
    event: { type: string; payload: Record<string, unknown> };
  }): Promise<StreamLegacyEvent> {
    return (await this.#stream(input.path).append(input.event)) as StreamLegacyEvent;
  }

  async read(input: { path: string }): Promise<StreamLegacyEvent[]> {
    return (await this.#stream(input.path).read()) as StreamLegacyEvent[];
  }

  async getState(input: { path: string }): Promise<unknown> {
    return await this.#stream(input.path).getState();
  }

  async subscribe(
    input: { afterOffset: StreamCursor; path: string },
    onEventBatch: (batch: { events: StreamLegacyEvent[]; streamMaxOffset: number }) => unknown,
  ) {
    return await this.#stream(input.path).subscribe(onEventBatch, {
      afterOffset: input.afterOffset,
    });
  }

  /**
   * Trips the append-policy check inside StreamsCapability, so the resulting
   * ItxError must cross the ctx.exports loopback (Workers RPC) back into this
   * entrypoint, then the harness boundary into the test — proving that
   * `code`/`details` survive Workers RPC hops, not just capnweb.
   */
  async appendOutsidePolicy(input: { path: string }) {
    const capability = getStreamsCapability({
      exports: this.ctx.exports as unknown as Parameters<typeof getStreamsCapability>[0]["exports"],
      props: { appendPolicy: { mode: "none" }, projectId, streamPath: input.path },
    });
    await capability.append({ event: { type: "test.iterate.com/itx-subscribe/denied" } as never });
  }

  #stream(path: string): ItxStream {
    return new ItxStream(this.#runtime(), projectId, path);
  }

  #runtime(): ItxRuntime {
    // ItxStream only touches `runtime.exports`; the rest of ItxRuntime is
    // connect-time wiring this harness does not exercise.
    return {
      access: [projectId],
      config: null as never,
      contextId: projectId,
      env: this.env,
      exports: this.ctx.exports as unknown as ItxRuntime["exports"],
      projectId,
    };
  }
}

export default {
  async fetch() {
    return new Response("itx stream subscribe test worker");
  },
} satisfies ExportedHandler<Env>;
