/** The stateless byte-pushing transport loaded by each agent durable object. A Durable Object that
 *  receives a provider Response or stream from a second Durable Object makes the Workers runtime
 *  report a hung request (./ai-transport.md), so this Worker consumes provider I/O itself and pushes
 *  each byte chunk into the caller's AgentAiSink under an idle bound; no Response, stream or reader
 *  crosses back to the Durable Object. It imports `withItx` alone (`iterate/with-itx`, ~1.5 KB) and never
 *  `iterate/sdk`, so no model call loads the whole SDK. */
export const AI_TRANSPORT_SOURCE = {
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/with-itx";
export default class AgentAiTransport extends WorkerEntrypoint {
  // One withItx round trip for the whole model call: the scope, its cd(path) and the ai.run call are
  // released after the drain, the whole body inside. The agent facet's runInBackground claim is what
  // keeps this call alive that long (processor.ts #runLlmRequest).
  run(path, model, input, options, sink, idleBudgetMs) {
    return withItx(this.env.ITX, (itx) => this.#run(itx.cd(path), model, input, options, sink, idleBudgetMs));
  }
  async #run(scoped, model, input, options, sink, idleBudgetMs) {
    let call, reader, initialTimedOut = false;
    const withinIdle = async (operation, message) => {
      let timer;
      try {
        return await Promise.race([
          operation,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), idleBudgetMs); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const read = () => withinIdle(reader.read(), "model transport idle timeout");
    const write = (bytes) => withinIdle(sink.write(bytes), "model transport sink timeout");
    const drain = async (body) => {
      reader = body.getReader();
      try {
        for (;;) { const next = await read(); if (next.done) break; await write(next.value); }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    };
    try {
      call = scoped.ai.run(model, input, options);
      // A provider can stall before it produces headers, where no reader exists to watchdog.
      // Race that dial too, and cancel a late body so a timed-out call cannot keep provider I/O open.
      void call
        .then((late) => {
          if (!initialTimedOut) return;
          if (late instanceof Response) return late.body?.cancel();
          if (late instanceof ReadableStream) return late.cancel();
        })
        .catch(() => undefined);
      let initialTimer;
      const raw = await Promise.race([
        call,
        new Promise((_, reject) => { initialTimer = setTimeout(() => { initialTimedOut = true; reject(new Error("model transport initial response timeout")); }, idleBudgetMs); }),
      ]).finally(() => clearTimeout(initialTimer));
      if (raw instanceof Response) {
        await sink.start({ kind: "response", status: raw.status, statusText: raw.statusText, headers: [...raw.headers], hasBody: raw.body !== null });
        if (raw.body) await drain(raw.body);
      } else if (raw instanceof ReadableStream) {
        await sink.start({ kind: "stream" }); await drain(raw);
      } else await sink.start({ kind: "value", value: raw });
      return { kind: "complete" };
    } catch (error) {
      // Cleanup may itself depend on the stalled peer. Start it, but preserve the watchdog's
      // bounded failure by never awaiting that peer during error unwinding.
      void reader?.cancel(error).catch(() => {});
      void sink.error(error instanceof Error ? error.message : String(error)).catch(() => {});
      throw error;
    }
  }
}`,
};
