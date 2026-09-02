// context/rpc-stub-relay.test.ts — a regression pin on the relay: it registers `onRpcBroken` on
// the session's provider stub ONCE per session, never once per page. The DO borrows the stub on
// every burst of traffic and returns it at each idle quiesce, so a long-lived device pages many
// times, and each page lends a fresh `BorrowedStub` over the SAME session stub. capnweb has no
// `offRpcBroken`, so a registration per lend would accumulate a listener per page for the session's
// life — worst on the longest-lived, most active devices. The ONE registration lives in
// `lendStubOverRelay`; the borrowed stubs share its `{ value }` broken flag.
import { afterEach, expect, test, vi } from "vitest";

// BorrowedStub extends RpcTarget from "cloudflare:workers", which node cannot resolve —
// mock JUST the base class (a no-op shell); the relay's own logic runs unmodified.
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {} }));

import { lendStubOverRelay } from "./rpc-stub-relay.ts";

/** A fake stub-pager WebSocket: records listeners and lets the test fire the `{type:"page"}`
 *  message the DO sends down this socket to make the edge re-mint and lend the stub. */
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
  /** One page: the DO says "send me the stub" — the relay answers by lending a fresh stub. */
  page(): void {
    this.#emit("message", { data: JSON.stringify({ type: "page" }) });
  }
}

afterEach(() => vi.useRealTimers());

test("a relay registers onRpcBroken on the session's stub ONCE per session, not once per page", async () => {
  // Fake timers neutralize the pager's 30s keepalive interval (no real timer leaks).
  vi.useFakeTimers();

  // The session's stub — what `provider.dup()` yields, held for the whole session. It counts every
  // onRpcBroken registration landed on it.
  let onRpcBrokenRegistrations = 0;
  const lent = {
    onRpcBroken(_cb: () => void) {
      onRpcBrokenRegistrations += 1;
    },
    [Symbol.dispose]() {},
  };
  const provider = { dup: () => lent };

  const pager = new FakePagerWebSocket();
  const context = {
    rpcStubAttach: async (_opts: { key: string }) => ({ transportId: "t1" }),
    fetch: async () => ({ status: 101, webSocket: pager }),
    // The stub is constructed EAGERLY as this call's argument, so anything its constructor
    // registered would land on every page regardless of what the lend door does.
    rpcStubLend: async (_input: { transportId: string; invoker: unknown }) => ({ ok: true }),
  };

  const relay = await lendStubOverRelay(
    context as unknown as Parameters<typeof lendStubOverRelay>[0],
    provider as unknown as Parameters<typeof lendStubOverRelay>[1],
    "key-1",
    () => {}, // waitUntil
  );

  // A long-lived, active device: five page/quiesce cycles, each lending a fresh stub.
  const PAGES = 5;
  for (let i = 0; i < PAGES; i++) pager.page();

  // capnweb has no offRpcBroken: at most ONE registration on the session's stub, whatever the count.
  expect(onRpcBrokenRegistrations).toBeLessThanOrEqual(1);

  relay.dispose();
});
