type DisposableLike = {
  [Symbol.dispose]?(): void;
  dup?(): DisposableLike;
};

export function withOwnedRpcSession<T extends object>(stub: T, ...owned: DisposableLike[]): T {
  let disposed = false;
  return new Proxy(stub, {
    get(target, key, receiver) {
      if (key === Symbol.dispose) {
        return () => {
          if (disposed) return;
          disposed = true;
          disposeAll(target as DisposableLike, ...owned);
        };
      }
      if (key === "dup") {
        return () => withOwnedRpcSession(dup(target as DisposableLike), ...owned.map(dup));
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

function dup(disposable: DisposableLike): DisposableLike {
  if (disposable.dup === undefined) {
    throw new Error("Cannot dup scoped RPC stub because an owned stub does not expose dup()");
  }
  return disposable.dup();
}

function disposeAll(...disposables: DisposableLike[]): void {
  let firstError: unknown;
  for (const disposable of disposables) {
    try {
      disposable[Symbol.dispose]?.();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
