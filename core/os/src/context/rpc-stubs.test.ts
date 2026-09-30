// context/rpc-stubs.test.ts — the directory's unit pins (the DO side: the borrowed table's lifetime
// rule and the page timeout) and the fetch headers. The relay's are rpc-stub-relay.test.ts; the pager
// layer's sockets, the Workers suite's (test/vitest/os-workers/rpc-stub-pager-*.test.ts).

import type { ItxExpression } from "iterate/expression";
import { expect, onTestFinished, test, vi } from "vitest";
import type { RpcStubFetchServer } from "./fetch-upgrade.ts";
import {
  RpcStubDirectory,
  type BorrowedRpcStub,
  encodeFetchExpression,
  stampCallerHeaders,
} from "./rpc-stubs.ts";

test("fetch expression headers preserve Unicode worker source through the HTTP ByteString boundary", () => {
  const expression: ItxExpression = [
    "itx",
    "workers",
    ["get", { source: { "worker.js": 'return "東京 🌍 café";' } }],
  ];
  const headers = new Headers({ "x-itx-expression": encodeFetchExpression(expression) });
  expect(JSON.parse(headers.get("x-itx-expression")!)).toEqual(expression);
});

test("stampCallerHeaders strips every header the DO's fetch trusts as the platform's (caller and protocol) before writing the hop's caller: a Request's own copy never survives", () => {
  const trusted = [
    "x-itx-principal",
    "x-itx-grant",
    "x-itx-caller-path",
    "x-itx-app",
    "x-itx-platform-origin",
    "x-itx-rpc-stub-pager",
    "x-itx-fetch-upgrade",
    "x-itx-fetch-upgrade-eyeball",
  ];
  const forged = () =>
    new Headers([
      ...trusted.map((name): [string, string] => [name, "forged"]),
      ["x-itx-expression", "itx.fetch"],
      ["x-iterate-routing-slug", "forged"],
    ]);
  const leaving = forged();
  stampCallerHeaders(leaving, null);
  expect([...leaving.keys()]).toEqual([]); // leaving the platform: not even the routing slug
  const app = forged();
  stampCallerHeaders(app, { principal: null, app: true, platformOrigin: "https://os.iterate.com" });
  expect(app.get("x-itx-expression")).toBeNull();
  expect(app.get("x-iterate-routing-slug")).toBe("forged"); // a hop's caller keeps the edge's word
  expect(Object.fromEntries(trusted.map((name) => [name, app.get(name)]))).toEqual({
    "x-itx-principal": null,
    "x-itx-grant": null,
    "x-itx-caller-path": null,
    "x-itx-app": "1",
    "x-itx-platform-origin": "https://os.iterate.com",
    "x-itx-rpc-stub-pager": null,
    "x-itx-fetch-upgrade": null,
    "x-itx-fetch-upgrade-eyeball": null,
  });
});

// ── rpc stub directory ── the borrowed table's one lifetime rule beyond lend/return:
// A BROKEN STUB IS DROPPED. workerd stamps `retryable: true` on a call that failed at the
// transport (DISCONNECTED — "Network connection lost.", a DO reset), and a stub whose transport is
// gone fails every later call the same way; kept borrowed it would answer that error until the idle
// return, while its pager could lend a live one. A client's own throw, or a coded refusal, is not a
// broken transport and keeps the stub warm. Node: the pager layer is never entered (no sockets).

test.for([
  {
    rejects: "a transport failure (workerd's `retryable: true` stamp)",
    error: Object.assign(new Error("Network connection lost."), { retryable: true }),
    becomes:
      "OFFLINE (a 502, never an uncoded 500), DROPPED and disposed — the next call finds nothing borrowed",
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
])(
  "a borrowed stub after a rejected call: rejecting with $rejects → $becomes",
  async ({ error, dropped }) => {
    const rpcStubDirectory = directory();
    const stub = fakeBorrowedRpcStub(() => Promise.reject(error));
    rpcStubDirectory.lendRpcStub({ rpcStubKey: "k", stub });
    await expect(rpcStubDirectory.invokeRpcStub("k", [["", 1]])).rejects.toMatchObject(
      dropped
        ? { code: "RPC_STUB_OFFLINE", message: expect.stringContaining("Network connection lost.") }
        : error,
    );
    expect(stub).toMatchObject({ disposed: dropped });
    expect(rpcStubDirectory.hasBorrowedRpcStubs()).toBe(!dropped);
    if (dropped) {
      await expect(rpcStubDirectory.invokeRpcStub("k", [["", 2]])).rejects.toMatchObject({
        code: "RPC_STUB_OFFLINE",
      });
      expect(stub).toMatchObject({ calls: 1 }); // never called again
    } else {
      await expect(rpcStubDirectory.invokeRpcStub("k", [["", 2]])).rejects.toBe(error);
      expect(stub).toMatchObject({ calls: 2 });
    }
  },
);

test("a borrowed stub after a rejected call: a late transport failure of a stub RE-LENT meanwhile drops nothing: the live replacement stays borrowed", async () => {
  const rpcStubDirectory = directory();
  let failOld!: (error: unknown) => void;
  const old = fakeBorrowedRpcStub(() => new Promise((_, reject) => (failOld = reject)));
  const replacement = fakeBorrowedRpcStub(async () => "ok");
  rpcStubDirectory.lendRpcStub({ rpcStubKey: "k", stub: old });
  const inFlight = rpcStubDirectory.invokeRpcStub("k", [["", 1]]);
  rpcStubDirectory.lendRpcStub({ rpcStubKey: "k", stub: replacement }); // a re-lend REPLACES (and returns the old)
  failOld(Object.assign(new Error("Network connection lost."), { retryable: true }));
  await expect(inFlight).rejects.toMatchObject({ code: "RPC_STUB_OFFLINE" });
  expect(await rpcStubDirectory.invokeRpcStub("k", [["", 2]])).toBe("ok");
  expect(replacement).toMatchObject({ disposed: false });
  expect(rpcStubDirectory.hasBorrowedRpcStubs()).toBe(true);
});

// A PAGE THAT TIMES OUT loses what waited on it — a live client's push among them, which delivery
// treats as heal-by-read and never logs — so the timeout is logged where it happens, once per page
// however many calls share it. 2026-09-24: 33 of 200 pushes lost this way left no trace.
test("a page the relay never answers fails every call waiting on it after 10 s, logged once", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const pager = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ rpcStubKey: "fan-7" }),
    send: vi.fn(),
  };
  const rpcStubDirectory = directory([pager as unknown as WebSocket]);
  const waiting = [1, 2].map((round) =>
    rpcStubDirectory.invokeRpcStub("fan-7", [["", round]]).catch((error: unknown) => error),
  );
  expect(pager.send).toHaveBeenCalledOnce(); // one page for both calls
  await vi.advanceTimersByTimeAsync(9_999);
  expect(warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  for (const error of await Promise.all(waiting))
    expect(error).toMatchObject({
      code: "RPC_STUB_OFFLINE",
      message: expect.stringContaining("page timed out"),
    });
  expect(warn.mock).toMatchObject({
    calls: [
      [
        expect.objectContaining({
          event: "rpc-stub-page-timed-out",
          rpcStubKey: "fan-7",
          waitedMs: 10_000,
        }),
      ],
    ],
  });
});

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

/** A directory over a fake Durable Object whose open stub-pager sockets are `pagers`. The one cast:
 *  no test here serves a terminal fetch, so the fetch server is a stand-in. */
const directory = (pagers: WebSocket[] = []) =>
  new RpcStubDirectory({
    ctx: { acceptWebSocket: () => {}, getWebSockets: () => pagers },
    onPresence: () => {},
    rpcStubFetch: { serve: async () => undefined } as unknown as RpcStubFetchServer,
    appendEvents: () => {},
  });
