/**
 * Groups an authenticated child stub with the parent stubs that keep it alive.
 *
 * Cap'n Web callers often want `using project = connectItx({ projectId })`, but
 * that project stub is reached through a root session and authentication stub.
 * This proxy makes disposal and `dup()` preserve the whole ownership chain, so
 * disposing the child also tells the server it can release the parent stubs.
 */

type DisposableLike = {
  [Symbol.dispose]?(): void;
  dup?(): DisposableLike;
};

export function withOwnedRpcSession<T extends object>(stub: T, ...owned: DisposableLike[]): T {
  let liveWrappers = 1;

  const makeWrapper = (target: DisposableLike): T => {
    let disposed = false;
    return new Proxy(target as T, {
      get(target, key, receiver) {
        if (key === Symbol.dispose) {
          return () => {
            if (disposed) return;
            disposed = true;
            const releaseParents = --liveWrappers === 0;
            disposeAll(target as DisposableLike, ...(releaseParents ? owned : []));
          };
        }
        if (key === "dup") {
          return () => {
            if (disposed) throw new Error("Cannot dup a disposed scoped RPC stub");
            const duplicate = dup(target as DisposableLike);
            liveWrappers += 1;
            return makeWrapper(duplicate);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
  };

  return makeWrapper(stub as DisposableLike);
}

function dup(disposable: DisposableLike): DisposableLike {
  if (disposable.dup === undefined) {
    throw new Error("Cannot dup scoped RPC stub because an owned stub does not expose dup()");
  }
  return disposable.dup();
}

function disposeAll(...disposables: DisposableLike[]): void {
  const errors: unknown[] = [];
  for (const disposable of disposables) {
    try {
      disposable[Symbol.dispose]?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose RPC resources");
}
