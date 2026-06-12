// The handle-side normalization of LIVE capability targets — split from
// handle.ts so the pure wrapper logic is unit-testable without the handle's
// server dependencies (D1 queries, the Project DO).

import { RpcTarget } from "cloudflare:workers";
import { RpcStub } from "capnweb";
import {
  isCapabilityAddress,
  isLocalBareFunction,
  replayPathCall,
  type CapabilityTarget,
  type PathCall,
} from "./itx.ts";

/**
 * Normalize a live capability before it crosses to the context node. Bare
 * functions auto-wrap. Plain objects pass through UNTOUCHED: they cross
 * every transport by value (with their functions as stubs), the core
 * dup-retains those member stubs at registration (itx.ts), and dispatch
 * replays paths onto them directly — no wrapper exists.
 *
 * - A LOCAL function (prototype Function/AsyncFunction.prototype — never
 *   true of an RPC stub) wraps directly.
 * - A capnweb stub is ALWAYS a callable proxy, so a remote bare function and
 *   a remote call-less class are indistinguishable from a call-implementing
 *   provider by type. It is probed: `await stub.call` is a pure property
 *   pull (no user code runs) that resolves `undefined` exactly when the
 *   remote target implements no `call` — those get the wrapper (which both
 *   calls and member-replays); a call-implementing provider keeps its own
 *   call semantics. Probe failures fall back to the historical
 *   call-convention dispatch.
 */
export async function resolveLiveCapability(
  capability: CapabilityTarget,
): Promise<CapabilityTarget> {
  if (isCapabilityAddress(capability)) return capability;
  if (isLocalBareFunction(capability)) {
    return new LiveCallableCapability(capability) as unknown as CapabilityTarget;
  }
  if (typeof capability === "function" && (capability as object) instanceof RpcStub) {
    const callMember = await Promise.resolve(
      (capability as unknown as { call: unknown }).call,
    ).then(
      (value) => value,
      () => "unprobeable" as const,
    );
    if (callMember === undefined) {
      return new LiveCallableCapability(
        capability as unknown as (...args: never[]) => unknown,
      ) as unknown as CapabilityTarget;
    }
    (callMember as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
  }
  return capability;
}

/**
 * The ONE wrapper for callable live targets that don't speak `call({ path,
 * args })` themselves: bare functions AND call-less classes behind a capnweb
 * stub. It speaks the calling convention by replaying the path on the
 * target — an empty path calls the function; a member path pipelines onto
 * its members (a stub materializes them; a local bare function has none and
 * misses with the path error). Extends RpcTarget so it crosses the
 * worker → context-node hop as a stub while the function (local or a capnweb
 * stub of the provider's process) stays callable right here.
 */
export class LiveCallableCapability extends RpcTarget {
  readonly #fn: (...args: never[]) => unknown;

  constructor(fn: (...args: never[]) => unknown) {
    super();
    // Retain a dup when the function is itself a session stub: RPC disposes
    // argument stubs when the provide call returns.
    const dup = (fn as { dup?: () => (...args: never[]) => unknown }).dup;
    this.#fn = typeof dup === "function" ? dup.call(fn) : fn;
  }

  call(input: PathCall): unknown {
    return replayPathCall(this.#fn, input);
  }

  onRpcBroken(callback: (error: unknown) => void): void {
    (this.#fn as { onRpcBroken?: (callback: (error: unknown) => void) => void }).onRpcBroken?.(
      callback,
    );
  }

  [Symbol.dispose](): void {
    (this.#fn as Partial<Disposable>)[Symbol.dispose]?.();
  }
}
