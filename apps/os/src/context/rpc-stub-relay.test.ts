// context/rpc-stub-relay.test.ts — the relay's unit pins (the edge side of a lend,
// rpc-stub-relay.ts): the one onRpcBroken registration, the page's lend and its repeat [A], the lent
// call's liveness probe [C], and the pager's keepalive and re-dial [B] (the recoveries are named in
// rpc-stubs.ts). The pager is a fake socket; the Workers suite drops real ones
// (test/vitest/os-workers/rpc-stub-pager-drop.test.ts).

import type { StreamEventInput } from "iterate/stream/processor";
import { expect, onTestFinished, test, vi } from "vitest";
import { lendRpcStubOverPager } from "./rpc-stub-relay.ts";
import {
  type BorrowedRpcStub,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
} from "./rpc-stubs.ts";

// ── rpc stub relay ── ONE `onRpcBroken` registration per session, never one per page (why:
// rpc-stub-relay.ts, LentRpcStub's `#lendEnded`).

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

// ── rpc stub relay ── A PAGE'S LEND THE PLATFORM FAILED IS LENT AGAIN (the lend's recovery [A];
// the schedule and what each outcome logs: rpc-stub-relay.ts `answerPage`).

test.for([
  {
    lendFails: "once with the transport cut",
    error: Object.assign(new Error("Network connection lost."), { retryable: true }),
    failures: 1,
    outcome: "lent again at once",
    tries: 2,
    logged: [
      {
        event: "rpc-stubs.platform-failure-retry",
        name: "lendRpcStub",
        rpcStubKey: "subscription:fan-104",
        message: "Error: Network connection lost.",
        attempt: 1,
        retryInMs: 0,
      },
    ],
  },
  {
    lendFails: "on every try with the transport cut",
    error: Object.assign(new Error("Network connection lost."), { retryable: true }),
    failures: Infinity,
    outcome: "four tries in 4 s, then given up",
    tries: 4,
    logged: [
      { event: "rpc-stubs.platform-failure-retry", attempt: 1 },
      { event: "rpc-stubs.platform-failure-retry", attempt: 2 },
      { event: "rpc-stubs.platform-failure-retry", attempt: 3 },
      { event: "rpc-stubs.platform-failure-gave-up", attempts: 4 },
      { event: "rpc-stub-lend-failed", rpcStubKey: "subscription:fan-104" },
    ],
  },
  {
    lendFails: "once with a deploy's reset",
    error: new Error("Durable Object reset because its code was updated."),
    failures: 1,
    outcome: "lent again at once, logged at info",
    tries: 2,
    logged: [{ event: "rpc-stubs.deploy-reset-retry", name: "lendRpcStub", attempt: 1 }],
  },
  {
    lendFails: "with the DO overloaded",
    error: Object.assign(new Error("Durable Object is overloaded."), { overloaded: true }),
    failures: 1,
    outcome: "never lent again at once",
    tries: 1,
    logged: [
      { event: "rpc-stubs.platform-failure-gave-up", kind: "overloaded", attempts: 1 },
      { event: "rpc-stub-lend-failed", rpcStubKey: "subscription:fan-104" },
    ],
  },
  {
    lendFails: "with the DO's own error",
    error: new Error("the DO refused the lend"),
    failures: 1,
    outcome: "never lent again",
    tries: 1,
    logged: [{ event: "rpc-stub-lend-failed", error: "Error: the DO refused the lend" }],
  },
])("a page whose lend fails $lendFails: $outcome", async ({ error, failures, tries, logged }) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const lines: unknown[] = [];
  for (const level of ["info", "warn"] as const)
    vi.spyOn(console, level).mockImplementation((line) => void lines.push(line));
  const session = { dup: () => session, onRpcBroken() {}, [Symbol.dispose]() {} };
  const pager = new FakePagerWebSocket();
  let lendTries = 0;
  let lent = 0;
  const context = {
    fetch: async () => ({ status: 101, webSocket: pager }),
    lendRpcStub: async () => {
      lendTries += 1;
      if (lendTries > failures) return void (lent += 1);
      throw error;
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
  expect({ lendTries, lent, lines }).toMatchObject({
    lendTries: tries,
    lent: failures < tries ? 1 : 0,
    lines: logged,
  });
});

test("a lend recalled while its repeat waits is not lent again, and its failure is not logged", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(0.5); // the 1 s wait jittered to 750 ms
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
  await vi.advanceTimersByTimeAsync(500); // the first try and its repeat at 0 ms failed; the next waits 750 ms
  relay.dispose();
  await vi.advanceTimersByTimeAsync(4_000);
  await Promise.all(waitedUntil);
  expect(lendTries).toBe(2);
  expect(warn.mock.calls.map(([line]) => (line as { event: string }).event)).toEqual([
    "rpc-stubs.platform-failure-retry",
    "rpc-stubs.platform-failure-retry",
  ]);
});

// ── rpc stub relay ── A LENT CALL IS BOUNDED BY THE CLIENT'S ANSWERS (the lend's recovery [C]:
// rpc-stub-relay.ts `whileClientAnswers`).

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

// ── rpc stub relay ── THE LEND IS THE SESSION'S, NOT THE SOCKET'S: a pager closed 1000 ends the
// lend, and any other close is re-dialed (the lend's recovery [B]: rpc-stub-relay.ts, the pager's
// close handler in `lendRpcStubOverPager`).

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

// A reset whose close this end never hears is caught by the keepalive the DO stops answering (the
// lend's recovery [B]: rpc-stub-relay.ts, THE PAGER'S LIVENESS).
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

// A deploy's reset answers the pager's re-dials with a 5xx or a throw until the context's fresh
// incarnation serves. The re-dials come at once, then 0.25, 0.5, 1, 2, 4 and 8 s apart, the last
// at 55.75 s: an outage shorter than that keeps the lend; a longer one ends it with an error, which
// pages. `dials` counts the first dial too.
test.for([
  {
    outage: "503s for 30 s",
    status: 503,
    forMs: 30_000,
    outcome: "back in service on the ninth re-dial",
    expected: {
      dials: 10,
      disposed: 0,
      ended: null,
      logged: { event: "rpc-stub-pager-redialed", attempt: 9, downMs: 31_750 },
    },
  },
  {
    outage: "resets for 55 s",
    status: null,
    forMs: 55_000,
    outcome: "back in service on the twelfth re-dial",
    expected: {
      dials: 13,
      disposed: 0,
      ended: null,
      logged: { event: "rpc-stub-pager-redialed", attempt: 12, downMs: 55_750 },
    },
  },
  {
    // the lender hears why (`lendEnded()`, the lend's recovery [E]): `iterate tunnel` lends again
    outage: "resets past the twelfth re-dial",
    status: null,
    forMs: Infinity,
    outcome: "the lend ends, logged as an error, and says why",
    expected: {
      dials: 13,
      disposed: 1,
      ended: "went offline (its pager dropped and could not be re-dialed)",
      logged: {
        event: "rpc-stub-pager-redial-failed",
        rpcStubKey: "key-4",
        lastFailure: "Durable Object reset",
        downMs: 55_750,
      },
    },
  },
])(
  "a pager that drops under a live session while its context answers $outage: $outcome",
  async ({ status, forMs, expected }) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let droppedAt = Infinity;
    const fake = await relayOverFakeDurableObject((dial) => {
      if (dial === 1 || Date.now() - droppedAt >= forMs) return new FakePagerWebSocket();
      return status ? new Response(null, { status }) : new Error("Durable Object reset");
    });

    droppedAt = Date.now();
    fake.pagers[0].close(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    await fake.waitedUntil[0];
    expect({
      dials: fake.dials,
      disposed: fake.disposed,
      ended: await Promise.race([fake.relay.lendEnded, Promise.resolve(null)]), // null: not ended
      logged: [...warn.mock.calls, ...error.mock.calls].map(([line]) => line),
    }).toEqual({ ...expected, logged: [expect.objectContaining(expected.logged)] });
  },
);

// A 5xx answer to a re-dial is the DO not ready yet (a deploy's reset), so the re-dial goes on; a
// 4xx is the DO's refusal, and the lend ends.
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

test("a re-dial the DO never answers is given up 60 s after the drop, never dialed again beside it: the late pager is closed, never taken into service", async () => {
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
  await vi.advanceTimersByTimeAsync(59_999);
  expect(error).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await fake.waitedUntil[0];
  expect(fake).toMatchObject({ dials: 2, disposed: 1 }); // one re-dial, never a second beside it
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "rpc-stub-pager-redial-failed",
      lastFailure: "no answer within 60 s of the drop",
      downMs: 60_000,
    }),
  );
  answerLate(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toHaveBeenCalledWith(1000, "re-dial abandoned");
});

// A drop is logged with the re-dial's outcome, so a session that ends mid-dial logs nothing (why:
// rpc-stub-relay.ts `redialPager`).
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
  await vi.advanceTimersByTimeAsync(60_000);
  await fake.waitedUntil[0];
  expect(error).not.toHaveBeenCalled();
  answerLate(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toHaveBeenCalledWith(1000, "re-dial abandoned");
});

// A refused attach lends nothing and re-throws the DO's code (the refusal's wire: rpc-stubs.ts
// `acceptRpcStubPagerWebSocket`; its handling: rpc-stub-relay.ts `lendRpcStubOverPager`).
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
