// App-owned agent facet, loaded into a project through the public SDK.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { ItxScope as ItxEntrypointScope } from "iterate/sdk";
import type { AgentState } from "./contract.ts";
import { AgentProcessor, STREAM_IDLE_BUDGET_MS } from "./processor.ts";
import { AgentAiSink } from "./ai-transport.ts";
import { AI_TRANSPORT_SOURCE } from "./ai-transport-source.ts";

/** The agent's facet: the processor's shell, and the byte bridge its model calls ride. A person's
 *  words, or another agent's, are no call here: `itx.agents.get(path).message(…)` is the caller's own
 *  append on this agent's context (collection.ts), stamped with who wrote it. */
export class AgentDurableObject extends StreamProcessorDurableObject<
  AgentState,
  { ITX: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new AgentProcessor({
    withItx: (call) => this.withItx(call),
    runModel: (path, model, input, options, signal) =>
      this.#runModel(path, model, input, options, signal),
  });

  /**
   * The loaded stateless worker drains the provider response and awaits every byte handed to this
   * sink. It returns only a plain completion; this DO gives the processor a fresh local body as
   * soon as headers arrive, then closes that body only after the remote call has completed.
   */
  async #runModel(
    path: string,
    model: string,
    input: unknown,
    options: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const sink = new AgentAiSink();
    const remote = this.withItx(
      async (itx) =>
        await itx.workers
          .get({ source: AI_TRANSPORT_SOURCE })
          .invoke([["run", path, model, input, options, sink, STREAM_IDLE_BUDGET_MS]]),
    );
    let locallyAborted = false;
    const finished = remote.then(
      () => (locallyAborted ? undefined : sink.close()),
      async (error) => {
        // An interrupted processor has already rejected the local body. The bridge observes that
        // as its next awaited write failing; keep that normal cancellation out of waitUntil's
        // exception channel while preserving real transport failures below.
        if (locallyAborted) return;
        await sink.error(error instanceof Error ? error.message : String(error));
        throw error;
      },
    );
    this.ctx.waitUntil(finished);
    const abort = () => {
      locallyAborted = true;
      void sink.abort(signal.reason || new Error("model stream aborted")).catch(() => undefined);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void finished.then(
      () => signal.removeEventListener("abort", abort),
      () => signal.removeEventListener("abort", abort),
    );
    const started = await sink.started;
    if (started.kind === "value") return started.value;
    if (started.kind === "stream") return sink.stream.readable;
    if (!started.hasBody)
      return new Response(null, {
        status: started.status,
        statusText: started.statusText,
        headers: started.headers,
      });
    return new Response(sink.stream.readable, {
      status: started.status,
      statusText: started.statusText,
      headers: started.headers,
    });
  }
}
