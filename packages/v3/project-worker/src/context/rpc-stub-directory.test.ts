// context/rpc-stub-directory.test.ts — the borrowed table's one lifetime rule beyond lend/return:
// A BROKEN STUB IS DROPPED (v4 §2.7). workerd stamps `retryable: true` on a call that failed at the
// transport (DISCONNECTED — "Network connection lost.", a DO reset), and a stub whose transport is
// gone fails every later call the same way; kept borrowed it would answer that error until the idle
// return, while its pager could lend a live one. A client's own throw, or a coded refusal, is not a
// broken transport and keeps the stub warm. Node: the pager layer is never entered (no sockets).
import { describe, expect, test } from "vitest";
import type { RpcStubFetchServer } from "../fetch/rpc-stub-fetch.ts";
import { RpcStubDirectory, type BorrowedRpcStub } from "./rpc-stub-directory.ts";

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
