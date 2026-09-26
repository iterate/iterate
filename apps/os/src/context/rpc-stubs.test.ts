// context/rpc-stubs.test.ts — the rpc stubs' unit pins: the borrowed table's lifetime rule (the
// directory) and the relay's one-registration rule. Node: the pager layer is never entered (no sockets).

import type { ItxExpression } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  type RpcStubFetchServer,
  RpcStubDirectory,
  type BorrowedRpcStub,
  lendRpcStubOverPager,
  encodeFetchExpression,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
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
      ["x-itx-expression-hops", "2"],
      ["x-itx-expression", "itx.fetch"],
    ]);
  const leaving = forged();
  stampCallerHeaders(leaving, null);
  expect([...leaving.keys()].sort()).toEqual(["x-itx-expression", "x-itx-expression-hops"]); // the edge's hop count and a self-addressed expression ride on
  const app = forged();
  stampCallerHeaders(app, { principal: null, app: true, platformOrigin: "https://os.iterate.com" });
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

// ── rpc stub relay ── a regression pin on the relay: it registers `onRpcBroken` on
// the session's provider stub ONCE per session, never once per page. The DO borrows the stub on
// every burst of traffic and returns it at each pins' release, so a long-lived device pages many
// times, and each page lends a fresh `LentRpcStub` over the SAME session stub. capnweb has no
// `offRpcBroken`, so a registration per lend would accumulate a listener per page for the session's
// life — worst on the longest-lived, most active devices. The ONE registration lives in
// `lendRpcStubOverPager`; the lent stubs share its `{ reason }` lend-ended holder.

test("a relay registers onRpcBroken on the session's stub ONCE per session, not once per page", async () => {
  // Fake timers neutralize the pager's 30s keepalive interval (no real timer leaks).
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());

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
    // registered would land on every page regardless of what the lend does.
    lendRpcStub: async (_input: { rpcStubKey: string; stub: unknown }) => undefined,
  };

  const relay = await lend(context, provider, "key-1");

  // A long-lived, active device: five page/release cycles, each lending a fresh stub.
  const PAGES = 5;
  for (let i = 0; i < PAGES; i++) pager.page();

  // capnweb has no offRpcBroken: at most ONE registration on the session's stub, whatever the count.
  expect(onRpcBrokenRegistrations).toBeLessThanOrEqual(1);

  relay.dispose();
});

// ── rpc stub relay ── A PAGE'S LEND THE PLATFORM FAILED IS LENT AGAIN. A relay's connection to
// the DO can drop under a burst of lends, and workerd fails every lend in flight with a retryable
// "Network connection lost.". The relay lends again on a fresh stub (a re-lend replaces the key's
// stub, so a repeat is harmless) after 0, 1 and 3 s, inside the DO's 10 s page timeout, each repeat
// a `rpc-stubs.platform-failure-relend` warn. A lend that still fails, or fails with the DO's own
// error, is one `rpc-stub-lend-failed` warn: the DO's page times out and a push waiting on it is lost.

test.for([
  {
    lendFails: "once with the transport cut",
    failures: 1,
    transportCut: true,
    outcome: "lent again at once",
    tries: 2,
    events: ["rpc-stubs.platform-failure-relend"],
  },
  {
    lendFails: "on every try with the transport cut",
    failures: Infinity,
    transportCut: true,
    outcome: "four tries in 4 s, then given up",
    tries: 4,
    events: [
      "rpc-stubs.platform-failure-relend",
      "rpc-stubs.platform-failure-relend",
      "rpc-stubs.platform-failure-relend",
      "rpc-stub-lend-failed",
    ],
  },
  {
    lendFails: "with the DO's own error",
    failures: 1,
    transportCut: false,
    outcome: "never lent again",
    tries: 1,
    events: ["rpc-stub-lend-failed"],
  },
])(
  "a page whose lend fails $lendFails: $outcome",
  async ({ failures, transportCut, tries, events }) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = { dup: () => session, onRpcBroken() {}, [Symbol.dispose]() {} };
    const pager = new FakePagerWebSocket();
    let lendTries = 0;
    let lent = 0;
    const context = {
      fetch: async () => ({ status: 101, webSocket: pager }),
      lendRpcStub: async () => {
        lendTries += 1;
        if (lendTries > failures) return void (lent += 1);
        throw transportCut
          ? Object.assign(new Error("Network connection lost."), { retryable: true })
          : new Error("the DO refused the lend");
      },
    };
    const waitedUntil: Promise<unknown>[] = [];
    const relay = await lend(
      context,
      session,
      "subscription:fan-104",
      [],
      (p) => void waitedUntil.push(p),
    );
    onTestFinished(() => relay.dispose());
    pager.page();
    await vi.advanceTimersByTimeAsync(4_000); // the last repeat, well inside the DO's 10 s page timeout
    await Promise.all(waitedUntil);
    expect({ lendTries, lent }).toEqual({ lendTries: tries, lent: failures < tries ? 1 : 0 });
    expect(warn.mock.calls.map(([line]) => (line as { event: string }).event)).toEqual(events);
    if (transportCut)
      expect(warn.mock.calls[0][0]).toMatchObject({
        name: "lendRpcStub",
        rpcStubKey: "subscription:fan-104",
        message: "Error: Network connection lost.",
        attempt: 1,
        retryInMs: 0,
      });
  },
);

test("a lend recalled while its repeat waits is not lent again, and its failure is not logged", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const session = { dup: () => session, onRpcBroken() {}, [Symbol.dispose]() {} };
  const pager = new FakePagerWebSocket();
  let lendTries = 0;
  const context = {
    fetch: async () => ({ status: 101, webSocket: pager }),
    lendRpcStub: async () => {
      lendTries += 1;
      throw Object.assign(new Error("Network connection lost."), { retryable: true });
    },
  };
  const waitedUntil: Promise<unknown>[] = [];
  const relay = await lend(
    context,
    session,
    "subscription:fan-104",
    [],
    (p) => void waitedUntil.push(p),
  );
  pager.page();
  await vi.advanceTimersByTimeAsync(500); // the first try and its repeat at 0 ms failed; the next waits 1 s
  relay.dispose();
  await vi.advanceTimersByTimeAsync(4_000);
  await Promise.all(waitedUntil);
  expect(lendTries).toBe(2);
  expect(warn.mock.calls.map(([line]) => (line as { event: string }).event)).toEqual([
    "rpc-stubs.platform-failure-relend",
    "rpc-stubs.platform-failure-relend",
  ]);
});

// ── rpc stub relay ── A LENT CALL IS BOUNDED BY THE CLIENT'S ANSWERS. A client whose network went
// away without a close (a laptop asleep, a NAT mapping expired) answers nothing and its socket stays
// open at the edge until the edge's TCP gives up: on prd 2026-09-25 a tunnel's visitors waited 12 to
// 16 minutes, then got a 500. A call unanswered for 10 s is followed by a liveness probe (a call on a
// member no client has, which a live one answers at once with an error); a probe unanswered for
// 10 s more fails the call RPC_STUB_OFFLINE, logged. A client that answers the probe is only slow,
// and its call waits on.

test.for([
  {
    client: "answers nothing (its network is gone)",
    callAnswersAfterMs: null,
    probeAnswers: false,
    outcome: "RPC_STUB_OFFLINE at 20 s, logged",
  },
  {
    client: "answers every probe and the call at 35 s (a slow local server)",
    callAnswersAfterMs: 35_000,
    probeAnswers: true,
    outcome: "the call's answer, three probes asked, nothing logged",
  },
])("a lent call whose client $client → $outcome", async ({ callAnswersAfterMs, probeAnswers }) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let probes = 0;
  const never = () => new Promise(() => {});
  const client = {
    dup: () => client,
    onRpcBroken() {},
    [Symbol.dispose]() {},
    hello: () =>
      callAnswersAfterMs === null
        ? never()
        : new Promise((resolve) => setTimeout(() => resolve("hi"), callAnswersAfterMs)),
    itxLivenessProbe: () => {
      probes += 1;
      return probeAnswers
        ? Promise.reject(new TypeError("'itxLivenessProbe' is not a function."))
        : never();
    },
  };
  const lentStubs: BorrowedRpcStub[] = [];
  const pager = new FakePagerWebSocket();
  const context = {
    fetch: async () => ({ status: 101, webSocket: pager }),
    lendRpcStub: async (input: { stub: BorrowedRpcStub }) => void lentStubs.push(input.stub),
  };
  const relay = await lend(context, client, "itx.tunnels.laptop");
  onTestFinished(() => relay.dispose());
  pager.page();
  const call = lentStubs[0].invoke([["hello"]]).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if (callAnswersAfterMs === null) {
    await vi.advanceTimersByTimeAsync(19_999);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await call).toMatchObject({
      error: { code: "RPC_STUB_OFFLINE", message: expect.stringContaining("stopped answering") },
    });
    expect(probes).toBe(1);
    expect(warn.mock).toMatchObject({
      calls: [
        [
          expect.objectContaining({
            event: "rpc-stub-client-unanswered",
            rpcStubKey: "itx.tunnels.laptop",
            waitedMs: 20_000,
          }),
        ],
      ],
    });
  } else {
    await vi.advanceTimersByTimeAsync(callAnswersAfterMs);
    expect(await call).toEqual({ value: "hi" });
    expect(probes).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  }
});

// ── rpc stub relay ── THE LEND IS THE SESSION'S, NOT THE SOCKET'S. The pager is a connection between
// the /api isolate and the DO, never the client's own socket, so it drops while the session lives (a
// fault on the hop between colos; a DO reset kills every hibernatable socket). What a close MEANS is
// its code: 1000 is deliberate — this side's dispose, the DO replacing the pager with a newer one —
// and ends the lend; anything else is a drop, and the relay dials the DO again (redial.ts: eight
// tries over ~24 s, all within 30 s of the drop) while the session's dup stays lent.

test.for([
  {
    closes: "with 1006 (the leg dropped: the DO reset, the hop failed)",
    code: 1006,
    becomes: "RE-DIALED — a second pager attaches, its page lends, the session's dup stays",
    redialed: true,
  },
  {
    closes: "with 1000 (a deliberate close: the DO replaced it with a newer pager)",
    code: 1000,
    becomes: "the lend ENDS — no re-dial, the session's dup released",
    redialed: false,
  },
])(
  "a pager that closes under a live session: closing $closes → $becomes",
  async ({ code, redialed }) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const fake = await relayOverFakeDurableObject(() => new FakePagerWebSocket());
    expect(fake.pagers).toHaveLength(1);

    fake.pagers[0].close(code);
    await Promise.all(fake.waitedUntil); // the re-dial, if one was fired
    expect(fake.pagers).toHaveLength(redialed ? 2 : 1);
    expect(fake).toMatchObject({ disposed: redialed ? 0 : 1 });
    if (redialed) {
      fake.pagers[1].page(); // the DO pages down the NEW pager, and the relay still lends
      await Promise.all(fake.waitedUntil);
      expect(fake).toMatchObject({ lends: 1 });
    }
  },
);

// prd 2026-09-25: a deploy reset the templestein context at 13:16:33 and its fresh incarnation
// served from 13:16:37, but its pagers' relay ends heard their close only at 13:17:35 — every stub
// lent in it offline for a minute, its visitors answered 502. The relay no longer waits for the
// close: the DO's auto-response stops answering the keepalive with the reset.
test("a pager whose keepalives go unanswered (a reset whose close the relay never hears) is re-dialed within 2 s, before it is closed, its downtime counted from its last answer", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let closedBeforeRedial: number | undefined;
  const fake = await relayOverFakeDurableObject((dial) => {
    if (dial === 2) closedBeforeRedial = closed.mock.calls.length;
    return new FakePagerWebSocket();
  });
  const dead = fake.pagers[0];
  const closed = vi.spyOn(dead, "close").mockImplementation(() => {}); // a dead pager hears nothing

  await vi.advanceTimersByTimeAsync(10_000); // the DO answers: the pager stays
  expect(fake).toMatchObject({ dials: 1 });

  dead.silent = true; // the reset, at 10 s
  await vi.advanceTimersByTimeAsync(2_000);
  await Promise.all(fake.waitedUntil);
  expect(fake).toMatchObject({ dials: 2, disposed: 0 });
  // re-dialed first: a DO that was only slow sees a swap, never a detach that un-sets the key's rows
  expect(closedBeforeRedial).toBe(0);
  expect(closed).toHaveBeenCalledWith(4000, "keepalive unanswered");
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "rpc-stub-pager-redialed",
      code: 4000,
      attempt: 1,
      downMs: 2_000, // the last answer came at 10 s; the re-dial is in service at 12 s
    }),
  );

  fake.pagers[1].page(); // the DO pages down the NEW pager, and the relay still lends
  await Promise.all(fake.waitedUntil);
  expect(fake).toMatchObject({ lends: 1 });
  await vi.advanceTimersByTimeAsync(60_000); // and the new pager, answered, stays
  expect(fake).toMatchObject({ dials: 2 });
});

test("a pager that closes under a live session: a re-dial the DO never answers is given up after eight tries over ~24 s, logged as an error: the dup is released, the lend ends", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fake = await relayOverFakeDurableObject((dial) =>
    dial === 1 ? new FakePagerWebSocket() : new Error("Durable Object reset"),
  );

  fake.pagers[0].close(1006);
  const redial = fake.waitedUntil[0]!; // try 1 is immediate; then 0.25, 0.5, 1, 2, 4, 8 and 8 s apart
  await vi.advanceTimersByTimeAsync(30_000);
  await redial;
  expect(fake).toMatchObject({ dials: 9, disposed: 1 }); // the first dial and eight re-dials
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "rpc-stub-pager-redial-failed",
      rpcStubKey: "key-4",
      lastFailure: "Durable Object reset",
      downMs: 23_750,
    }),
  );
});

// 2026-09-24 14:06: a deploy's reset answered the voice boards' re-dials with 503, and the relay
// read that as a refusal and gave up on the first answer. A 5xx is the DO not ready yet.
test.for([
  { answers: "503 (the DO not ready yet)", status: 503, dials: 3, disposed: 0 },
  { answers: "409 (the DO's refusal)", status: 409, dials: 2, disposed: 1 },
])(
  "a re-dial the DO answers with $answers is tried again only on a 5xx",
  async ({ status, dials, disposed }) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const fake = await relayOverFakeDurableObject((dial) =>
      dial === 2 ? new Response(null, { status }) : new FakePagerWebSocket(),
    );

    fake.pagers[0].close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await fake.waitedUntil[0];
    expect(fake).toMatchObject({ dials, disposed });
  },
);

test("a re-dial the DO never answers is given up 30 s after the drop, never dialed again beside it: the late pager is closed, never taken into service", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let answerLate: (pager: FakePagerWebSocket) => void = () => {};
  const late = new FakePagerWebSocket();
  const closed = vi.spyOn(late, "close");
  const fake = await relayOverFakeDurableObject((dial) =>
    dial === 2
      ? new Promise<FakePagerWebSocket>((resolve) => (answerLate = resolve))
      : new FakePagerWebSocket(),
  );

  fake.pagers[0].close(1006);
  await vi.advanceTimersByTimeAsync(30_000);
  await fake.waitedUntil[0];
  expect(fake).toMatchObject({ dials: 2, disposed: 1 }); // one re-dial, never a second beside it
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "rpc-stub-pager-redial-failed",
      lastFailure: "no answer within 30 s of the drop",
      downMs: 30_000,
    }),
  );
  answerLate(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toHaveBeenCalledWith(1000, "re-dial abandoned");
});

// A voice board that goes away takes its /api session with it, and its pager often drops a moment
// before the session's own end reaches the lend. The drop is logged with its outcome, so a session
// that ends while the re-dial is in flight logs nothing; a live one logs the drop once it is back.
test.for([
  {
    session: "ends while the re-dial is in flight",
    endSession: true,
    logged: [],
  },
  {
    session: "is live",
    endSession: false,
    logged: [{ event: "rpc-stub-pager-redialed", code: 1006, attempt: 1, downMs: 200 }],
  },
])(
  "a pager that drops (1006) while its session $session: logged $logged.length time(s), with its outcome",
  async ({ endSession, logged }) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const redialed = new FakePagerWebSocket();
    const closed = vi.spyOn(redialed, "close");
    const fake = await relayOverFakeDurableObject(async (dial) => {
      if (dial === 1) return new FakePagerWebSocket();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return redialed;
    });

    fake.pagers[0].close(1006);
    if (endSession) fake.breakSession();
    await vi.advanceTimersByTimeAsync(200);
    await fake.waitedUntil[0];
    expect({
      logged: [...warn.mock.calls, ...error.mock.calls].map(([line]) => line),
      redialedPagerClosed: closed.mock.calls.length > 0,
    }).toEqual({
      logged: logged.map((line) => expect.objectContaining(line)),
      redialedPagerClosed: endSession,
    });
  },
);

test("a lend recalled while a re-dial hangs ends quietly at the deadline: no error, the late pager closed", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let answerLate: (pager: FakePagerWebSocket) => void = () => {};
  const late = new FakePagerWebSocket();
  const closed = vi.spyOn(late, "close");
  const fake = await relayOverFakeDurableObject((dial) =>
    dial === 2
      ? new Promise<FakePagerWebSocket>((resolve) => (answerLate = resolve))
      : new FakePagerWebSocket(),
  );

  fake.pagers[0].close(1006);
  await vi.advanceTimersByTimeAsync(1_000);
  fake.relay.dispose(); // the lender recalls it mid-dial
  await vi.advanceTimersByTimeAsync(30_000);
  await fake.waitedUntil[0];
  expect(error).not.toHaveBeenCalled();
  answerLate(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toHaveBeenCalledWith(1000, "re-dial abandoned");
});

// The pager upgrade carries the events that name the key, and the DO appends them as it accepts the
// pager: a REFUSED append (a paused stream) is the upgrade's answer — a non-101 whose JSON body carries
// the code. The relay must then lend NOTHING: release the session's dup, register no listener, and
// re-throw the same CODED error the append would have (lib.ts: classify by code).
test("a refused pager upgrade (the DO would not append what names the key) lends nothing and re-throws the refusal's code", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
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

  const refusal = await lend(context, provider, "key-2", [
    { type: "events.iterate.com/itx/rewrite-rule-configured", payload: {} },
  ]).then(
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
      throw new Error(
        "APP_CONFIG secrets.key (APP_CONFIG_SECRETS__KEY): required, but unset or blank",
      );
    },
  };
  await expect(lend(context, provider, "key-3")).rejects.toThrow(/APP_CONFIG_SECRETS__KEY/);
  expect(disposed).toBe(1);
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

/** A fake stub-pager WebSocket: records listeners and lets the test fire the `{type:"page"}`
 *  message the DO sends down this socket to make the edge re-mint and lend the stub. */
class FakePagerWebSocket {
  readonly #listeners = new Map<string, Set<(e: unknown) => void>>();
  /** A DO that answers nothing on this pager any more: reset, with no close the relay can hear. */
  silent = false;
  accept(): void {}
  /** The DO's auto-response: every keepalive is answered at once, unless the pager went silent. */
  send(data: string): void {
    if (data === RPC_STUB_PAGER_KEEPALIVE_REQUEST && !this.silent)
      queueMicrotask(() => this.#emit("message", { data: RPC_STUB_PAGER_KEEPALIVE_RESPONSE }));
  }
  /** Close with `code` — 1000 is a deliberate close (this side's dispose, the DO's "replaced");
   *  anything else is the leg dropping under a live lend. */
  close(code = 1000, _reason = ""): void {
    this.#emit("close", { code, reason: "" });
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

/** A relay over a DO whose `fetch` answers each dial from `answerDial`: every pager it hands out is
 *  kept (a test drops one, pages the next), every lend and the dup's disposal are counted, and the
 *  relay's `waitUntil` promises are kept so a test awaits the re-dial it fired. */
async function relayOverFakeDurableObject(
  answerDial: (dial: number) => FakePagerWebSocket | Error | Response | Promise<FakePagerWebSocket>,
) {
  const fake = {
    pagers: [] as FakePagerWebSocket[],
    lends: 0,
    disposed: 0,
    waitedUntil: [] as Promise<unknown>[],
    dials: 0,
    /** capnweb's death signal for the client's session (`onRpcBroken`). */
    breakSession: () => {},
  };
  const lent = {
    onRpcBroken(breakSession: () => void) {
      fake.breakSession = breakSession;
    },
    [Symbol.dispose]() {
      fake.disposed += 1;
    },
  };
  const context = {
    fetch: async () => {
      const answer = await answerDial(++fake.dials);
      if (answer instanceof Error) throw answer;
      if (answer instanceof Response) return answer;
      fake.pagers.push(answer);
      return { status: 101, webSocket: answer };
    },
    lendRpcStub: async () => {
      fake.lends += 1;
    },
  };
  const relay = await lend(
    context,
    { dup: () => lent },
    "key-4",
    [],
    (p) => void fake.waitedUntil.push(p),
  );
  return Object.assign(fake, { relay });
}

/** `lendRpcStubOverPager` over fakes: `context` is the DO stub with only the calls a relay makes,
 *  `clientRpcStub` the client's stub with only what the relay touches, so both are cast once here. */
function lend(
  context: object,
  clientRpcStub: object,
  rpcStubKey: string,
  appendEvents: StreamEventInput[] = [],
  waitUntil: (p: Promise<unknown>) => void = () => {},
) {
  return lendRpcStubOverPager(
    (() => context) as unknown as Parameters<typeof lendRpcStubOverPager>[0],
    clientRpcStub as unknown as Parameters<typeof lendRpcStubOverPager>[1],
    rpcStubKey,
    appendEvents,
    waitUntil,
  );
}
