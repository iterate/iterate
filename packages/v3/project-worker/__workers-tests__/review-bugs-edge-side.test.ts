// __workers-tests__/review-bugs-edge-side.test.ts — RED PROOFS from the 2026-09-02 edge/rpc-stub
// bug hunt (docs/reviews/2026-09-02-bugs-edge-side.md). The half that needs a real DO: the pager
// swap inside RpcStubDirectory (src/context/rpc-stub-directory.ts), driven through the DO's own
// transport verbs the way the edge relay drives them. `test.fails` is the house convention for a
// known-red proof — the lane stays green.

import { RpcTarget } from "cloudflare:workers";
import { expect, test } from "vitest";
import { RPC_STUB_PAGER_WEBSOCKET_HEADER } from "../src/context/rpc-stub-directory.ts";
import { stub } from "./support.ts";

const until = async (label: string, fn: () => unknown | Promise<unknown>, timeoutMs = 8_000) => {
  const t0 = Date.now();
  for (;;) {
    if (await Promise.resolve(fn()).catch(() => undefined)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`until(${label}): timed out`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Open a pager for `rpcStubKey` exactly as `lendRpcStubOverPager` does: attach (mint the
 *  transportId), then upgrade at the DO's fetch door carrying it. */
async function openRpcStubPager(ctx: string, rpcStubKey: string) {
  const s = stub(ctx);
  const { transportId } = await s.attachRpcStubPager({ rpcStubKey });
  const response = await s.fetch("https://rpc-stub-pager.internal/", {
    headers: { Upgrade: "websocket", [RPC_STUB_PAGER_WEBSOCKET_HEADER]: transportId },
  });
  if (response.status !== 101 || !response.webSocket)
    throw new Error(`pager upgrade returned ${response.status}`);
  response.webSocket.accept();
  return { transportId, ws: response.webSocket };
}

/** What a relay lends: the `invoke(steps)` half of a BorrowedRpcStub. */
class LentAnswer extends RpcTarget {
  readonly #tag: string;
  constructor(tag: string) {
    super();
    this.#tag = tag;
  }
  async invoke(itxExpressionSteps: unknown[]): Promise<string> {
    return `${this.#tag}:${JSON.stringify(itxExpressionSteps)}`;
  }
}

// BUG: a RECONNECT at a key with a page in flight fails that page with RPC_STUB_OFFLINE, even
//      though the replacement pager is attached and lends immediately.
// WHY: `acceptRpcStubPagerWebSocket` enforces one-pager-per-key by calling
//      `dropRpcStubPager(old, "replaced")` (rpc-stub-directory.ts:212), and `dropRpcStubPager` ends
//      in `#returnRpcStubAndFailItsPage` (:241 → :335), which rejects `#rpcStubPagesInFlight[key]`
//      with RPC_STUB_OFFLINE. The page is per-KEY, not per-socket, so the swap that exists to make
//      the key keep working is what kills the call waiting on it. `rpcStubPagerClosed` is careful
//      here ("another pager for this key is open → return"); the replace path is not.
// EXPECTED: a replaced pager is a reconnect, not a close (the module header's own words) — the
//      in-flight page should survive the swap and be answered by the new pager's lend, exactly as
//      it would have been by the old one.
test("a pager reconnect while a page is in flight kills the page (RPC_STUB_OFFLINE) instead of letting the new pager answer it", async () => {
  const ctx = "prj_review_page_replaced";
  const s = stub(ctx);
  const rpcStubKey = "itx.reconnecting";

  // Pager #1 is attached but DELIBERATELY never answers — it stands in for the relay whose
  // isolate is on its way out, the one a client reconnects to replace.
  let pagesSeenByFirstPager = 0;
  const first = await openRpcStubPager(ctx, rpcStubKey);
  first.ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string" && event.data.includes('"page"')) pagesSeenByFirstPager++;
  });

  // A cold call on the key: nothing borrowed, so the DO pages and waits.
  const call = s.invoke([
    "itx",
    "rpcStubs",
    ["get", rpcStubKey],
    ["echo", "hi"],
  ]) as Promise<unknown>;
  call.catch(() => undefined); // settled by the assertion below, never an unhandled rejection
  await until("the page reached pager #1", () => pagesSeenByFirstPager > 0);
  expect((await s.rpcStubTransportState()).rpcStubPagesInFlight).toBe(1);

  // THE RECONNECT: the client re-provides at the same key from a fresh relay. Its pager attaches
  // (the DO drops pager #1 as "replaced") and it answers pages with a lend, like any relay.
  const second = await openRpcStubPager(ctx, rpcStubKey);
  second.ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string" && event.data.includes('"page"'))
      void s.lendRpcStub({ rpcStubKey, stub: new LentAnswer("reconnected") as never });
  });
  await s.lendRpcStub({ rpcStubKey, stub: new LentAnswer("reconnected") as never });

  try {
    // The stub is right there under the key — the waiting call should be served, not refused.
    await expect(call).resolves.toContain("reconnected");
  } finally {
    first.ws.close(1000, "test done");
    second.ws.close(1000, "test done");
  }
});
