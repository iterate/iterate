// rpc-stub-broken-leak.failing.test.ts — a listener-accumulation LEAK in the capnweb callback relay.
//
// This file is intentionally RED (a plain `test`, not `test.fails`): it PROVES the bug is live and
// must stay failing until iterate-context.ts is fixed. DO NOT fix the production code here, and DO NOT
// convert this to `test.fails` to make the suite green — the red assertion IS the deliverable.
//
// BUG: a client's provided callback stub is duped ONCE per relay (`retained = provider.dup()` in
//   startRpcStubRelay) and lives for the whole session. But the DO pages that stub IN on every
//   burst of traffic and DISPOSES it at each idle quiesce, so a long-lived device pages many times.
//   EACH page mints a fresh `new RetainedCallbackInvoker(retained)` (iterate-context.ts:146), and the
//   RetainedCallbackInvoker constructor registers ANOTHER `onRpcBroken` handler on the SAME
//   long-lived `retained` stub (iterate-context.ts:62-64). capnweb has no `offRpcBroken`, so the
//   handlers accumulate for the life of the session.
// EXPECTED: the relay registers `onRpcBroken` on the retained stub at most ONCE (startRpcStubRelay
//   already registers exactly one, at iterate-context.ts:154, to close the pager socket on break).
// ACTUAL: N page/quiesce cycles leave N+1 registrations on the retained stub — unbounded growth.
// WHY IT MATTERS: it is worst precisely on the longest-lived, most-active devices (the ones that
//   page most often). Nothing frees these until the session ends; a session that never cleanly ends
//   leaks for its entire lifetime.
import { afterEach, expect, test, vi } from "vitest";

// RetainedCallbackInvoker (the leaking constructor) extends RpcTarget from "cloudflare:workers",
// which node cannot resolve — mock JUST the base class (a no-op shell), the same trick
// wave2-sweep.failing.test.ts uses. The invoker's own constructor (the onRpcBroken registration
// under test) runs unmodified.
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {} }));

import { startRpcStubRelay } from "./rpc-stub-relay.ts";

const DISPOSE = (Symbol as { dispose?: symbol }).dispose ?? Symbol.for("dispose");

/** A fake stub-pager WebSocket: records listeners and lets the test fire the `{type:"page"}`
 *  message the DO sends down this socket to make the edge re-mint (page in) the stub. */
class FakePagerWebSocket {
  readonly #listeners = new Map<string, Set<(e: unknown) => void>>();
  accept(): void {}
  send(_data: string): void {}
  close(): void {
    this.#emit("close", {});
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(cb);
  }
  #emit(type: string, event: unknown): void {
    for (const cb of this.#listeners.get(type) ?? []) cb(event);
  }
  /** One page: the DO says "send me the stub" — the relay answers by minting a fresh invoker. */
  page(): void {
    this.#emit("message", { data: JSON.stringify({ type: "page" }) });
  }
}

afterEach(() => vi.useRealTimers());

test("a relay registers onRpcBroken ONCE, not once per page (retained-stub listener leak)", async () => {
  // Fake timers neutralize openStubPagerWebSocket's 30s keepalive interval (no real timer leaks).
  vi.useFakeTimers();

  // The retained stub — what `provider.dup()` yields, held for the whole session. It counts every
  // onRpcBroken registration landed on it.
  let onRpcBrokenRegistrations = 0;
  const retained = {
    onRpcBroken(_cb: () => void) {
      onRpcBrokenRegistrations += 1;
    },
    [DISPOSE]() {},
  };
  const provider = { dup: () => retained };

  const pager = new FakePagerWebSocket();
  const context = {
    rpcStubAttach: async (_opts: { key: string }) => ({ transportId: "t1" }),
    fetch: async () => ({ status: 101, webSocket: pager }),
    // The invoker is constructed EAGERLY as this call's argument, so its onRpcBroken registration
    // fires on every page regardless of what activate does.
    rpcStubActivate: async (_input: { transportId: string; invoker: unknown }) => ({ ok: true }),
  };

  const relay = await startRpcStubRelay(
    context as unknown as Parameters<typeof startRpcStubRelay>[0],
    provider as unknown as Parameters<typeof startRpcStubRelay>[1],
    "key-1",
    () => {}, // waitUntil
  );

  // A long-lived, active device: five page/quiesce cycles. Each page mints a fresh
  // RetainedCallbackInvoker(retained) — exactly iterate-context.ts:146.
  const PAGES = 5;
  for (let i = 0; i < PAGES; i++) pager.page();

  // capnweb has no offRpcBroken, so every per-page registration sticks for the session's life.
  // Correct behavior: at most ONE registration on the retained stub.
  expect(onRpcBrokenRegistrations).toBeLessThanOrEqual(1);

  relay.dispose();
});
