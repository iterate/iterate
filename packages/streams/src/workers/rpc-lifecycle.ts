import type { ProcessEventBatch } from "../types.ts";

type RetainedProcessEventBatch = ProcessEventBatch &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

type RetainableProcessEventBatch = ProcessEventBatch &
  Partial<Disposable> & {
    dup?(): RetainedProcessEventBatch;
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

export function retainProcessEventBatch(
  processEventBatch: ProcessEventBatch,
): RetainedProcessEventBatch {
  const retainable = processEventBatch as RetainableProcessEventBatch;
  const retained = retainable.dup?.() ?? retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  const callback: RetainedProcessEventBatch = Object.assign(
    (batch: Parameters<ProcessEventBatch>[0]) => {
      const result = retained(batch);
      disposeIgnoredRpcResult(result);
    },
    {
      [Symbol.dispose]() {
        dispose?.();
      },
    },
  );
  if (Object.hasOwn(retained, "onRpcBroken") && typeof retained.onRpcBroken === "function") {
    callback.onRpcBroken = retained.onRpcBroken.bind(retained);
  }
  return callback;
}

export function disposeIgnoredRpcResult(result: unknown): void {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    Symbol.dispose in result
  ) {
    (result as Disposable)[Symbol.dispose]();
  }
}
