// context/rpc-stubs.test.ts — the rpc stubs' unit pins: the borrowed table's lifetime rule (the
// directory) and the relay's one-registration rule. Node: the pager layer is never entered (no sockets).

import { describe, expect, test, afterEach, vi } from "vitest";
import {
  type RpcStubFetchServer,
  RpcStubDirectory,
  type BorrowedRpcStub,
  lendRpcStubOverPager,
} from "./rpc-stubs.ts";

// LentRpcStub extends RpcTarget from "cloudflare:workers", which node cannot resolve —
// mock JUST the base class (a no-op shell); the relay's own logic runs unmodified.
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {} }));

// ── rpc stub directory ── the borrowed table's one lifetime rule beyond lend/return:
// A BROKEN STUB IS DROPPED (v4 §2.7). workerd stamps `retryable: true` on a call that failed at the
// transport (DISCONNECTED — "Network connection lost.", a DO reset), and a stub whose transport is
// gone fails every later call the same way; kept borrowed it would answer that error until the idle
// return, while its pager could lend a live one. A client's own throw, or a coded refusal, is not a
// broken transport and keeps the stub warm. Node: the pager layer is never entered (no sockets).

/** A lent stub whose `invoke` answers from `answer` — a value, or a rejection. Counts its calls
 *  and its disposal. */
function fakeBorrowedRpcStub(answer: () => Promise<unknown>) {
  const stub = {
    calls: 0,
    disposed: false,
    invoke: async () => {
      stub.calls += 1;
      return await answer();
    },
    fetch: async () => undefined,
    [Symbol.dispose]: () => void (stub.disposed = true),
  };
  return stub as typeof stub & BorrowedRpcStub;
}

const directory = () =>
  new RpcStubDirectory({
    ctx: { acceptWebSocket: () => {}, getWebSockets: () => [] },
    onPresence: () => {},
    rpcStubFetch: { serve: async () => undefined } as unknown as RpcStubFetchServer,
    appendEvents: () => {},
  });

describe("a borrowed stub after a rejected call", () => {
  test.each([
    {
      rejects: "a transport failure (workerd's `retryable: true` stamp)",
      error: Object.assign(new Error("Network connection lost."), { retryable: true }),
      becomes:
        "DROPPED and disposed — the next call finds nothing borrowed (RPC_STUB_OFFLINE, no pager)",
      dropped: true,
    },
    {
      rejects: "the client's own throw",
      error: new Error("bad input"),
      becomes: "KEPT warm — the next call rides the same stub",
      dropped: false,
    },
    {
      rejects: "the relay's coded RPC_STUB_OFFLINE (the client's session broke behind a live leg)",
      error: Object.assign(new Error("the lent rpc stub went offline mid-invoke"), {
        code: "RPC_STUB_OFFLINE",
      }),
      becomes: "KEPT — its pager's close is what returns it",
      dropped: false,
    },
  ])("rejecting with $rejects → $becomes", async ({ error, dropped }) => {
    const rpcStubDirectory = directory();
    const stub = fakeBorrowedRpcStub(() => Promise.reject(error));
    rpcStubDirectory.lendRpcStub({ rpcStubKey: "k", stub });
    await expect(rpcStubDirectory.invokeRpcStub("k", [["", 1]])).rejects.toBe(error);
    expect(stub.disposed).toBe(dropped);
    expect(rpcStubDirectory.hasBorrowedRpcStubs()).toBe(!dropped);
    if (dropped) {
      await expect(rpcStubDirectory.invokeRpcStub("k", [["", 2]])).rejects.toMatchObject({
        code: "RPC_STUB_OFFLINE",
      });
      expect(stub.calls).toBe(1); // never called again
    } else {
      await expect(rpcStubDirectory.invokeRpcStub("k", [["", 2]])).rejects.toBe(error);
      expect(stub.calls).toBe(2);
    }
  });

  test("a late transport failure of a stub RE-LENT meanwhile drops nothing: the live replacement stays borrowed", async () => {
    const rpcStubDirectory = directory();
    let failOld!: (error: unknown) => void;
    const old = fakeBorrowedRpcStub(() => new Promise((_, reject) => (failOld = reject)));
    const replacement = fakeBorrowedRpcStub(async () => "ok");
    rpcStubDirectory.lendRpcStub({ rpcStubKey: "k", stub: old });
    const inFlight = rpcStubDirectory.invokeRpcStub("k", [["", 1]]);
    rpcStubDirectory.lendRpcStub({ rpcStubKey: "k", stub: replacement }); // a re-lend REPLACES (and returns the old)
    failOld(Object.assign(new Error("Network connection lost."), { retryable: true }));
    await expect(inFlight).rejects.toMatchObject({ retryable: true });
    expect(await rpcStubDirectory.invokeRpcStub("k", [["", 2]])).toBe("ok");
    expect(replacement.disposed).toBe(false);
    expect(rpcStubDirectory.hasBorrowedRpcStubs()).toBe(true);
  });
});

// ── rpc stub relay ── a regression pin on the relay: it registers `onRpcBroken` on
// the session's provider stub ONCE per session, never once per page. The DO borrows the stub on
// every burst of traffic and returns it at each idle quiesce, so a long-lived device pages many
// times, and each page lends a fresh `LentRpcStub` over the SAME session stub. capnweb has no
// `offRpcBroken`, so a registration per lend would accumulate a listener per page for the session's
// life — worst on the longest-lived, most active devices. The ONE registration lives in
// `lendRpcStubOverPager`; the lent stubs share its `{ reason }` lend-ended holder.

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
    fetch: async () => ({ status: 101, webSocket: pager }),
    // The stub is constructed EAGERLY as this call's argument, so anything its constructor
    // registered would land on every page regardless of what the lend door does.
    lendRpcStub: async (_input: { rpcStubKey: string; stub: unknown }) => undefined,
  };

  const relay = await lendRpcStubOverPager(
    context as unknown as Parameters<typeof lendRpcStubOverPager>[0],
    provider as unknown as Parameters<typeof lendRpcStubOverPager>[1],
    "key-1",
    [], // the events that name the key — none for a bare pager
    () => {}, // waitUntil
  );

  // A long-lived, active device: five page/quiesce cycles, each lending a fresh stub.
  const PAGES = 5;
  for (let i = 0; i < PAGES; i++) pager.page();

  // capnweb has no offRpcBroken: at most ONE registration on the session's stub, whatever the count.
  expect(onRpcBrokenRegistrations).toBeLessThanOrEqual(1);

  relay.dispose();
});

// The pager upgrade carries the events that name the key, and the DO appends them as it accepts the
// pager: a REFUSED append (a paused stream) is the upgrade's answer — a non-101 whose JSON body carries
// the code. The relay must then lend NOTHING: release the session's dup, register no listener, and
// re-throw the same CODED error the append door would have (lib.ts: classify by code).
test("a refused pager upgrade (the DO would not append what names the key) lends nothing and re-throws the refusal's code", async () => {
  vi.useFakeTimers();
  let disposed = 0;
  let onRpcBrokenRegistrations = 0;
  const lent = {
    onRpcBroken(_cb: () => void) {
      onRpcBrokenRegistrations += 1;
    },
    [Symbol.dispose]() {
      disposed += 1;
    },
  };
  const provider = { dup: () => lent };
  let lends = 0;
  const context = {
    fetch: async () => ({
      status: 409,
      webSocket: null,
      json: async () => ({ code: "STREAM_PAUSED", message: "stream paused: review" }),
    }),
    lendRpcStub: async () => {
      lends += 1;
    },
  };

  const refusal = await lendRpcStubOverPager(
    context as unknown as Parameters<typeof lendRpcStubOverPager>[0],
    provider as unknown as Parameters<typeof lendRpcStubOverPager>[1],
    "key-2",
    [{ type: "events.iterate.com/itx/rewrite-rule-configured", payload: {} }],
    () => {},
  ).then(
    () => undefined,
    (e: unknown) => e as Error & { code?: string },
  );

  expect(refusal).toBeInstanceOf(Error);
  expect(refusal?.code).toBe("STREAM_PAUSED");
  expect(refusal?.message).toBe("stream paused: review");
  expect(disposed).toBe(1); // the session's dup released — nothing is lent
  expect(onRpcBrokenRegistrations).toBe(0);
  expect(lends).toBe(0);
});

// The relay dups the client's stub for the session BEFORE it dials the DO. A fetch that REJECTS
// outright (the DO's constructor throwing on a bad APP_CONFIG_* var) must not leave that dup alive for
// the session's life: the dup is disposed, then the error propagates as it is.
test("a DO fetch that REJECTS releases the session's dup before the error propagates", async () => {
  let disposed = 0;
  const lent = {
    onRpcBroken() {},
    [Symbol.dispose]() {
      disposed += 1;
    },
  };
  const provider = { dup: () => lent };
  const context = {
    fetch: async () => {
      throw new Error("APP_CONFIG_ENVIRONMENT_NAME: required, got nothing");
    },
  };
  await expect(
    lendRpcStubOverPager(
      context as unknown as Parameters<typeof lendRpcStubOverPager>[0],
      provider as unknown as Parameters<typeof lendRpcStubOverPager>[1],
      "key-3",
      [],
      () => {},
    ),
  ).rejects.toThrow(/APP_CONFIG_ENVIRONMENT_NAME/);
  expect(disposed).toBe(1);
});
