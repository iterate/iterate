/** The stateless byte-pushing transport loaded by each agent durable object. */
export const AI_TRANSPORT_SOURCE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class AgentAiTransport extends WorkerEntrypoint {
  async run(path, model, input, options, sink, idleBudgetMs) {
    const itx = this.env.ITX.get();
    const scoped = itx.cd(path);
    let call, reader, initialTimedOut = false;
    const idle = Math.max(1_000, Number(idleBudgetMs) || 45_000);
    const withinIdle = async (operation, message) => {
      let timer;
      try {
        return await Promise.race([
          operation,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), idle); }),
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
        new Promise((_, reject) => { initialTimer = setTimeout(() => { initialTimedOut = true; reject(new Error("model transport initial response timeout")); }, idle); }),
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
    } finally {
      call?.[Symbol.dispose]?.(); scoped[Symbol.dispose]?.(); itx[Symbol.dispose]?.();
    }
  }
}`,
};
