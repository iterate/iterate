import type { RpcStub, RpcTarget } from "capnweb";

export function dupStub<T extends RpcTarget>(stub: RpcStub<T>): RpcStub<T> {
  return ((stub as { dup?: () => RpcStub<T> }).dup?.() ?? stub) as RpcStub<T>;
}

export function disposeStub(stub: unknown): void {
  try {
    (stub as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  } catch {}
}
