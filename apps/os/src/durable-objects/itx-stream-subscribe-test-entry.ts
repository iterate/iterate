import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  StreamCursor,
  Event as StreamEvent,
  StreamState,
} from "@iterate-com/shared/streams/types";
import type { ItxRuntime } from "~/itx/handle.ts";
import { ItxStream } from "~/itx/capabilities/streams.ts";
import { getStreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";
import { coreStateToStreamState } from "~/domains/streams/stream-runtime.ts";

export { StreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";
export { Stream as StreamDurableObject } from "~/domains/streams/engine/workers/durable-objects/stream.ts";

const projectId = "proj__test__itxsubscribe";

/**
 * Test-only RPC surface that drives ItxStream exactly the way production
 * does: the test's callback crosses a Workers RPC boundary into this
 * entrypoint (standing in for a capnweb session / cap isolate). Because this
 * harness wraps the callback before passing it on, it must retain the callback
 * itself; ItxStream then retains that wrapper for the next ctx.exports loopback
 * into StreamsBackend, whose wrapper closure is what the real Stream Durable
 * Object retains for live delivery.
 */
export class ItxStreamHarness extends WorkerEntrypoint<Env> {
  async append(input: {
    path: string;
    event: { type: string; payload: Record<string, unknown> };
  }): Promise<StreamEvent> {
    return (await this.#stream(input.path).append({ event: input.event })) as StreamEvent;
  }

  async read(input: { path: string }): Promise<StreamEvent[]> {
    return (await this.#stream(input.path).getEvents()) as StreamEvent[];
  }

  async getState(input: { path: string }): Promise<unknown> {
    const state = await this.#stream(input.path).runtimeState();
    return coreStateToStreamState(state.coreProcessorState);
  }

  async subscribe(
    input: { afterOffset: StreamCursor; events?: boolean; path: string },
    onEventBatch: (batch: {
      events: StreamEvent[];
      state: StreamState;
      streamMaxOffset: number;
    }) => unknown,
  ) {
    const retainedOnEventBatch = retainCallback(onEventBatch);
    try {
      const subscription = await this.#stream(input.path).subscribe({
        replayAfterOffset:
          input.afterOffset === "start"
            ? 0
            : typeof input.afterOffset === "number"
              ? input.afterOffset
              : undefined,
        events: input.events,
        processEventBatch: (batch) =>
          retainedOnEventBatch({
            events: batch.events as never,
            state: coreStateToStreamState(batch.state),
            streamMaxOffset: batch.streamMaxOffset,
          }),
      });
      return withCallbackRelease(subscription, retainedOnEventBatch);
    } catch (error) {
      retainedOnEventBatch[Symbol.dispose]?.();
      throw error;
    }
  }

  /** The state-only sugar, end-to-end through the same capability loopback. */
  async onStateChange(input: { path: string }, onState: (state: StreamState) => unknown) {
    const retainedOnState = retainCallback(onState);
    try {
      const subscription = await this.#stream(input.path).subscribe({
        events: false,
        processEventBatch: (batch) => retainedOnState(coreStateToStreamState(batch.state)),
      });
      return withCallbackRelease(subscription, retainedOnState);
    } catch (error) {
      retainedOnState[Symbol.dispose]?.();
      throw error;
    }
  }

  /**
   * Trips the append-policy check inside StreamsBackend, so the resulting
   * ItxError must cross the ctx.exports loopback (Workers RPC) back into this
   * entrypoint, then the harness boundary into the test — proving that
   * `code`/`details` survive Workers RPC hops, not just capnweb.
   */
  async appendOutsidePolicy(input: { path: string }) {
    const capability = getStreamsBackend({
      exports: this.ctx.exports as unknown as Parameters<typeof getStreamsBackend>[0]["exports"],
      props: { appendPolicy: { mode: "none" }, projectId, streamPath: input.path },
    });
    await capability.append({ event: { type: "test.iterate.com/itx-subscribe/denied" } as never });
  }

  #stream(path: string): ItxStream {
    return new ItxStream(
      { access: [projectId], exports: this.#runtime().exports as never },
      projectId,
      path,
    );
  }

  #runtime(): ItxRuntime {
    // ItxStream only touches `runtime.exports`; the rest of ItxRuntime is
    // connect-time wiring this harness does not exercise.
    return {
      access: [projectId],
      config: null as never,
      contextAddress: null,
      contextRef: `${projectId}:/`,
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

function retainCallback<T extends (...args: never[]) => unknown>(
  callback: T,
): T & Partial<Disposable> {
  return ((callback as { dup?(): T & Partial<Disposable> }).dup?.() ?? callback) as T &
    Partial<Disposable>;
}

function withCallbackRelease(
  subscription: { unsubscribe(): void | Promise<void> },
  callback: Partial<Disposable>,
): { unsubscribe(): Promise<void> } {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    callback[Symbol.dispose]?.();
  };
  return {
    async unsubscribe() {
      try {
        await subscription.unsubscribe();
      } finally {
        release();
      }
    },
  };
}
