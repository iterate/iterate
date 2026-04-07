import type { Event } from "@iterate-com/events-contract";
import { RpcTarget } from "cloudflare:workers";
import type { DynamicWorkerAppendInput } from "./dynamic-processor.ts";

type LocalDynamicWorkerSubscriptionTarget = {
  dispose(): Promise<void>;
};

export function createDynamicWorkerStreamTarget(args: {
  append: (input: DynamicWorkerAppendInput) => Event;
  history: (args?: { afterOffset?: number }) => Event[];
  stream: (args?: { afterOffset?: number; live?: boolean }) => ReadableStream<Uint8Array>;
}) {
  const subscriptions = new Set<LocalDynamicWorkerSubscriptionTarget>();
  let disposed = false;

  return new (class extends RpcTarget {
    async append(input: DynamicWorkerAppendInput) {
      return args.append(input);
    }

    async subscribe(options: { afterOffset?: number; live?: boolean } = {}) {
      if (disposed) {
        throw new Error("dynamic worker stream target was disposed");
      }

      const subscription = createDynamicWorkerSubscriptionTarget({
        onDispose: () => {
          subscriptions.delete(subscription);
        },
        stream: args.stream({
          afterOffset: options.afterOffset,
          live: options.live ?? true,
        }),
      });

      subscriptions.add(subscription);
      return subscription;
    }

    async history(options: { afterOffset?: number } = {}) {
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
