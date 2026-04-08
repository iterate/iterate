import type { Event, StreamCursor } from "@iterate-com/events-contract";
import { RpcTarget } from "cloudflare:workers";
import type { DynamicWorkerAppendInput } from "./dynamic-processor.ts";

type LocalDynamicWorkerSubscriptionTarget = {
  dispose(): Promise<void>;
};

/**
 * Bridges the Stream DO's local append/history/live-stream APIs into a scoped
 * RPC capability that a dynamic worker can hold.
 *
 * Why this shape:
 * - `RpcTarget` methods run back inside the DO execution context, so the
 *   dynamic worker gets a narrow capability without a separate HTTP surface.
 * - `append()` and `history()` are simple request/response RPC methods.
 * - `subscribe()` returns another `RpcTarget` that behaves like a tiny remote
 *   async iterator (`next()` / `return()`), translating the DO's NDJSON
 *   `ReadableStream` into parsed `Event` objects.
 *
 * First-party references:
 * - RPC lifecycle / targets: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 * - Dynamic Workers RPC example patterns: https://developers.cloudflare.com/dynamic-workers/
 */
export function createDynamicWorkerStreamTarget(args: {
  append: (input: DynamicWorkerAppendInput) => Event;
  history: (args?: { after?: StreamCursor; before?: StreamCursor }) => Event[];
  stream: (args?: { after?: StreamCursor; before?: StreamCursor }) => ReadableStream<Uint8Array>;
}) {
  const subscriptions = new Set<LocalDynamicWorkerSubscriptionTarget>();
  let disposed = false;

  return new (class extends RpcTarget {
    async append(input: DynamicWorkerAppendInput) {
      return args.append(input);
    }

    async subscribe(options: { after?: StreamCursor; before?: StreamCursor } = {}) {
      if (disposed) {
        throw new Error("dynamic worker stream target was disposed");
      }

      const subscription = createDynamicWorkerSubscriptionTarget({
        onDispose: () => {
          subscriptions.delete(subscription);
        },
        stream: args.stream({
          after: options.after,
          before: options.before,
        }),
      });

      subscriptions.add(subscription);
      return subscription;
    }

    async history(options: { after?: StreamCursor; before?: StreamCursor } = {}) {
      return args.history(options);
    }

    async dispose() {
      disposed = true;
      const activeSubscriptions = Array.from(subscriptions);
      subscriptions.clear();
      await Promise.all(activeSubscriptions.map((subscription) => subscription.dispose()));
    }
  })();
}

function createDynamicWorkerSubscriptionTarget(args: {
  onDispose: () => void;
  stream: ReadableStream<Uint8Array>;
}) {
  // The DO already exposes live events as newline-delimited JSON bytes.
  // Dynamic workers cannot directly hold this reader, so we keep the reader
  // inside the DO and expose a small RPC iterator surface instead.
  const reader = args.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  let released = false;

  return new (class extends RpcTarget {
    async next() {
      if (done) {
        return { done: true as const, value: undefined };
      }

      while (true) {
        const line = await readDynamicWorkerStreamLine({
          decoder,
          getBuffer: () => buffer,
          setBuffer: (value) => {
            buffer = value;
          },
          getDone: () => done,
          setDone: (value) => {
            done = value;
          },
          reader,
        });
        if (line == null) {
          return { done: true as const, value: undefined };
        }

        try {
          const parsed = JSON.parse(line);
          if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
            continue;
          }

          return {
            done: false as const,
            value: parsed as Event,
          };
        } catch {
          continue;
        }
      }
    }

    async return() {
      if (!done) {
        done = true;
        await reader.cancel();
      }

      if (!released) {
        released = true;
        reader.releaseLock();
        args.onDispose();
      }

      return { done: true as const, value: undefined };
    }

    async dispose() {
      await this.return();
    }
  })();
}

async function readDynamicWorkerStreamLine(args: {
  decoder: TextDecoder;
  getBuffer: () => string;
  setBuffer: (value: string) => void;
  getDone: () => boolean;
  setDone: (value: boolean) => void;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}) {
  while (true) {
    const buffer = args.getBuffer();
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      args.setBuffer(buffer.slice(newlineIndex + 1));
      if (line.length === 0) {
        continue;
      }

      return line;
    }

    if (args.getDone()) {
      const finalLine = args.getBuffer().trim();
      args.setBuffer("");
      return finalLine.length > 0 ? finalLine : null;
    }

    const { done, value } = await args.reader.read();
    if (done) {
      args.setDone(true);
      args.setBuffer(args.getBuffer() + args.decoder.decode());
      continue;
    }

    args.setBuffer(args.getBuffer() + args.decoder.decode(value, { stream: true }));
  }
}
