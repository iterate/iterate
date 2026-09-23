import { RpcTarget } from "cloudflare:workers";

export type ModelTransportStart =
  | {
      kind: "response";
      status: number;
      statusText: string;
      headers: [string, string][];
      hasBody: boolean;
    }
  | { kind: "stream" }
  | { kind: "value"; value: unknown };

/** The receiving end of the byte-only RPC bridge. */
export class AgentAiSink extends RpcTarget {
  readonly stream = new TransformStream<Uint8Array>();
  readonly writer = this.stream.writable.getWriter();
  #resolve!: (value: ModelTransportStart) => void;
  #reject!: (reason: unknown) => void;
  readonly started = new Promise<ModelTransportStart>((resolve, reject) => {
    this.#resolve = resolve;
    this.#reject = reject;
  });

  start(value: ModelTransportStart): void {
    this.#resolve(value);
  }
  write(bytes: Uint8Array): Promise<void> {
    return this.writer.write(bytes);
  }
  close(): Promise<void> {
    return this.writer.close();
  }
  error(message: string): Promise<void> {
    const error = new Error(message);
    this.#reject(error);
    return this.writer.abort(error);
  }
  abort(reason: unknown): Promise<void> {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.#reject(error);
    return this.writer.abort(error);
  }
}

/**
 * This worker owns the raw provider body.  Returning a Response/ReadableStream through Workers
 * RPC is avoided entirely: the only stream boundary is an awaited byte write to AgentAiSink.
 */
export const AI_TRANSPORT_SOURCE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class AgentAiTransport extends WorkerEntrypoint {
  async run(path, model, input, options, sink, idleBudgetMs) {
    const itx = this.env.ITX.get();
    const scoped = itx.cd(path);
    let call, reader, initialTimedOut = false;
    const idle = Math.max(1_000, Number(idleBudgetMs) || 45_000);
    const read = async () => {
      let timer;
      try {
        return await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("model transport idle timeout")), idle); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const drain = async (body) => {
      reader = body.getReader();
      try {
        for (;;) { const next = await read(); if (next.done) break; await sink.write(next.value); }
      } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
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
      try { await reader?.cancel(error); } catch {}
      try { await sink.error(error instanceof Error ? error.message : String(error)); } catch {}
      throw error;
    } finally {
      call?.[Symbol.dispose]?.(); scoped[Symbol.dispose]?.(); itx[Symbol.dispose]?.();
    }
  }
}`,
};
