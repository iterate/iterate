type DisposableLike = {
  [Symbol.dispose]?(): void;
};

export function withOwnedRpcSession<T extends object>(stub: T, ...owned: DisposableLike[]): T {
  let disposed = false;
  return new Proxy(stub, {
    get(target, key, receiver) {
      if (key === Symbol.dispose) {
        return () => {
          if (disposed) return;
          disposed = true;
          for (const disposable of [target as DisposableLike, ...owned]) {
            disposable[Symbol.dispose]?.();
          }
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
}
