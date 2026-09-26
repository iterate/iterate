// The two ends of a resumable upgrade over a fake context: a socket pair per dial, the context
// forwarding frames between the two sides by upgradeId and closing a side's peer when it closes
// (rpc-stubs.ts `RpcStubFetchServer`), and a `reset()` that cuts every socket it holds the way a
// deploy does (1006, no close frame). The visitor's and the provider's sockets are what a person
// and a local server see.

import { expect, test, vi } from "vitest";
import {
  contextAbortedOffsetOf,
  FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER,
  FETCH_UPGRADE_DEPLOY_ID_HEADER,
  FETCH_UPGRADE_RESUME_DEADLINE_MS,
  FETCH_UPGRADE_UNACKED_MAX_BYTES,
  FetchUpgradeSpliceEnd,
  type FetchUpgradeSpliceEvent,
  reportFetchUpgradeSpliceEvent,
} from "./fetch-upgrade-splice.ts";

test("frames flow both ways, text as text and binary as binary, and the provider's greeting sent before the visitor's side exists arrives", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.provider.send("hello from the provider before the visitor's side exists");
  splice.connectEyeball();
  splice.visitor.send("ping");
  splice.visitor.send(new Uint8Array([1, 2, 3]).buffer);
  splice.provider.send("pong");
  await vi.advanceTimersByTimeAsync(0);
  expect(splice.provider).toMatchObject({ received: ["ping", [1, 2, 3]] });
  expect(splice.visitor).toMatchObject({
    received: ["hello from the provider before the visitor's side exists", "pong"],
  });
});

test("a deploy resets the context mid-stream: both ends re-dial, what was in flight and what was sent while down arrives once and in order, and neither the visitor's nor the provider's socket closes", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  splice.visitor.send("v1");
  splice.provider.send("p1");
  await vi.advanceTimersByTimeAsync(0);
  // in flight at the reset: in the context, never forwarded
  splice.context.swallowNextFrames = 2;
  splice.visitor.send("v2");
  splice.provider.send("p2");
  await vi.advanceTimersByTimeAsync(0);
  splice.context.reset({ deployId: "deploy-2", downForMs: 1_500 });
  splice.visitor.send("v3");
  splice.provider.send("p3");
  await vi.advanceTimersByTimeAsync(5_000);
  splice.visitor.send("v4");
  await vi.advanceTimersByTimeAsync(0);
  expect(splice.provider).toMatchObject({ received: ["v1", "v2", "v3", "v4"], closed: null });
  expect(splice.visitor).toMatchObject({ received: ["p1", "p2", "p3"], closed: null });
  // dials at 0, 0.25 and 0.75 s met the reset; the one at 1.75 s was answered on the new deploy
  expect(splice).toMatchObject({
    reports: [
      { type: "resumed", deployReset: true, dials: 4, resent: 2 },
      { type: "resumed", deployReset: true, dials: 4, resent: 2 },
    ],
  });
});

test("a second reset seconds after a deploy's, on the same new deploy, is the deploy's too; one three minutes later is a platform failure", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  splice.context.reset({ deployId: "deploy-2", downForMs: 0 });
  await vi.advanceTimersByTimeAsync(2_000);
  splice.context.reset({ deployId: "deploy-2", downForMs: 0 });
  await vi.advanceTimersByTimeAsync(180_000);
  splice.context.reset({ deployId: "deploy-2", downForMs: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(splice).toMatchObject({
    reports: [
      { deployReset: true },
      { deployReset: true },
      { deployReset: true },
      { deployReset: true },
      { deployReset: false },
      { deployReset: false },
    ],
  });
});

test.for([
  { name: "a dropped leg", side: "leg" as const },
  { name: "a dropped eyeball socket", side: "eyeball" as const },
])(
  "$name without a deploy: the context closes its peer, both ends re-dial and resume, reported as a platform failure healed",
  async ({ side }) => {
    vi.useFakeTimers();
    using splice = spliced();
    splice.connectEyeball();
    splice.context.drop(side);
    splice.visitor.send("after the drop");
    await vi.advanceTimersByTimeAsync(0);
    splice.provider.send("answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(splice.provider).toMatchObject({ received: ["after the drop"] });
    expect(splice.visitor).toMatchObject({ received: ["answer"] });
    expect(splice).toMatchObject({
      reports: [
        { type: "resumed", deployReset: false },
        { type: "resumed", deployReset: false },
      ],
    });
  },
);

test("an orderly close on either socket closes the other with its code and reason, and nothing re-dials", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  splice.provider.close(4001, "the server restarted");
  await vi.advanceTimersByTimeAsync(FETCH_UPGRADE_RESUME_DEADLINE_MS * 2);
  expect(splice).toMatchObject({
    visitor: { closed: { code: 4001, reason: "the server restarted" } },
    context: { dials: 2 },
    reports: [],
  });
});

// A tunnel killed outright (`kill -9` on the CLI) ends its capnweb session, and the provider's socket
// on the relay closes without a status (capnweb's tunneled socket, on the session's end) or fails;
// a visitor's network vanishing does the same to the visitor's socket on the edge. The end knows its
// side is gone: it says so (`local-gone`, logged at info), the other side's socket closes at once
// with 1011, a drop's code (websocket-close.ts), not at the deadline, and its own socket is closed
// too (the runtime waits on it otherwise).
test.for([
  {
    gone: "the provider's socket closes without a status (1006)",
    end: (splice: ReturnType<typeof spliced>) => splice.provider.other.cut(),
    expected: {
      visitor: { closed: { code: 1011, reason: "tunnel disconnected" } },
      reports: [{ type: "local-gone", side: "leg", upgradeId: "upgrade-1", code: 1006 }],
    },
  },
  {
    gone: "the provider's socket fails",
    end: (splice: ReturnType<typeof spliced>) => splice.provider.other.emit("error", {}),
    expected: {
      visitor: { closed: { code: 1011, reason: "tunnel disconnected" } },
      provider: { other: { closed: { code: 1011, reason: "tunnel disconnected" } } },
      reports: [{ type: "local-gone", side: "leg", upgradeId: "upgrade-1", code: undefined }],
    },
  },
  {
    gone: "the visitor's socket fails",
    end: (splice: ReturnType<typeof spliced>) => splice.visitor.other.emit("error", {}),
    expected: {
      provider: { closed: { code: 1011, reason: "visitor disconnected" } },
      visitor: { other: { closed: { code: 1011, reason: "visitor disconnected" } } },
      reports: [{ type: "local-gone", side: "eyeball", upgradeId: "upgrade-1", code: undefined }],
    },
  },
])(
  "$gone: the other side's socket closes at once, and the end says so",
  async ({ end, expected }) => {
    vi.useFakeTimers();
    using splice = spliced();
    splice.connectEyeball();
    await vi.advanceTimersByTimeAsync(0);
    end(splice);
    await vi.advanceTimersByTimeAsync(0);
    expect(splice).toMatchObject(expected);
  },
);

test("an error after the local socket's own close is not its side gone: nothing more is said", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  await vi.advanceTimersByTimeAsync(0);
  splice.visitor.close(1000, "tab closed");
  await vi.advanceTimersByTimeAsync(0);
  splice.visitor.other.emit("error", {});
  await vi.advanceTimersByTimeAsync(0);
  expect(splice).toMatchObject({
    provider: { closed: { code: 1000, reason: "tab closed" } },
    reports: [],
  });
});

test("the visitor closes while the context is down: its code and reason reach the provider once the ends resume, after the frames it sent first", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  splice.context.reset({ deployId: "deploy-2", downForMs: 1_500 });
  splice.visitor.send("last words");
  splice.visitor.close(4002, "page closed");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(splice.provider).toMatchObject({
    received: ["last words"],
    closed: { code: 4002, reason: "page closed" },
  });
});

// `itx.abort()` records `itx/aborted` and then resets the context: a deliberate reset, not a
// platform failure. The incarnation it began names that record on every 101 it answers, and an end
// whose re-dial finds a record its old socket's incarnation did not name reports it.
test("a recorded itx.abort() resets the context: both ends resume and report the abort's record; a later drop in the same incarnation is a platform failure again", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  splice.context.reset({ deployId: "deploy-1", downForMs: 0, contextAbortedOffset: 41 });
  await vi.advanceTimersByTimeAsync(0);
  splice.context.drop("leg");
  await vi.advanceTimersByTimeAsync(0);
  expect(splice).toMatchObject({
    reports: [
      { type: "resumed", deployReset: false, contextAbortedOffset: 41 },
      { type: "resumed", deployReset: false, contextAbortedOffset: 41 },
      { type: "resumed", deployReset: false, contextAbortedOffset: null },
      { type: "resumed", deployReset: false, contextAbortedOffset: null },
    ],
  });
});

test.for([
  {
    resumed: "after a deploy's reset",
    deployReset: true,
    contextAbortedOffset: null,
    logged: { level: "info", event: "fetch-upgrade.deploy-reset-resumed" },
  },
  {
    resumed: "after a recorded itx.abort()",
    deployReset: false,
    contextAbortedOffset: 41,
    logged: { level: "info", event: "fetch-upgrade.context-abort-resumed" },
  },
  {
    resumed: "after anything else",
    deployReset: false,
    contextAbortedOffset: null,
    logged: { level: "warn", event: "fetch-upgrade.platform-failure-resumed" },
  },
])(
  "a resume $resumed is logged as $logged.event ($logged.level)",
  ({ deployReset, contextAbortedOffset, logged }) => {
    const lines: { level: string; event: unknown }[] = [];
    vi.spyOn(console, "info").mockImplementation((line: { event: unknown }) => {
      lines.push({ level: "info", event: line.event });
    });
    vi.spyOn(console, "warn").mockImplementation((line: { event: unknown }) => {
      lines.push({ level: "warn", event: line.event });
    });
    reportFetchUpgradeSpliceEvent({
      type: "resumed",
      side: "leg",
      upgradeId: "upgrade-1",
      downMs: 200,
      dials: 1,
      resent: 0,
      deployReset,
      contextAbortedOffset,
    });
    expect(lines).toEqual([logged]);
  },
);

test("the platform cuts every socket, and a stale close reaches the context after the edge re-dialed but before the relay did: it closes the re-dialed socket once, the edge re-dials again, and nothing is lost", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  splice.context.failing.leg = 1; // the relay's first re-dial fails: its next is 250 ms later
  splice.context.cutAll(5);
  splice.visitor.send("v1");
  splice.provider.send("p1");
  await vi.advanceTimersByTimeAsync(3_000);
  splice.visitor.send("v2");
  await vi.advanceTimersByTimeAsync(0);
  expect(splice).toMatchObject({
    provider: { received: ["v1", "v2"], closed: null },
    visitor: { received: ["p1"], closed: null },
    // the first two, then: the edge's re-dial (closed by the stale close) and its second; the
    // relay's failed one and its second
    context: { dials: 6 },
    reports: [
      { type: "resumed", side: "eyeball", dials: 2 },
      { type: "resumed", side: "leg", dials: 2 },
    ],
  });
});

test("the other end never comes back (its relay died with the tunnel): the edge's end gives up at the deadline and closes the visitor's socket 1011", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  splice.killLegEnd();
  await vi.advanceTimersByTimeAsync(FETCH_UPGRADE_RESUME_DEADLINE_MS - 1);
  expect(splice.visitor).toMatchObject({ closed: null });
  await vi.advanceTimersByTimeAsync(1);
  expect(splice).toMatchObject({
    visitor: { closed: { code: 1011, reason: "the other end did not resume within 30 s" } },
    reports: expect.arrayContaining([
      expect.objectContaining({ type: "gave-up", side: "eyeball", downMs: 30_000 }),
    ]),
  });
});

test("acknowledged frames are forgotten: 20 MiB flows through an end whose cap on unacknowledged bytes is 16 MiB", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  for (let i = 0; i < 20; i++) {
    splice.visitor.send(new Uint8Array(1024 * 1024).buffer);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(splice).toMatchObject({
    provider: { received: expect.toSatisfy((received: unknown[]) => received.length === 20) },
    visitor: { closed: null },
    reports: [],
  });
});

test("an end holding more than the cap of unacknowledged bytes gives up rather than grow", async () => {
  vi.useFakeTimers();
  using splice = spliced();
  splice.connectEyeball();
  splice.context.reset({ deployId: "deploy-2", downForMs: FETCH_UPGRADE_RESUME_DEADLINE_MS });
  splice.visitor.send(new Uint8Array(FETCH_UPGRADE_UNACKED_MAX_BYTES).buffer);
  await vi.advanceTimersByTimeAsync(0);
  expect(splice).toMatchObject({
    visitor: { closed: { code: 1011 } },
    reports: [{ type: "gave-up", side: "eyeball" }],
  });
});

// ── the fakes ──

type Listener = (event: Event) => void;

/** One half of a socket pair: what it was sent (decoded), whether it closed, and `send`/`close`
 *  reaching the other half on a later microtask, as the runtime's do. */
class FakeSocket {
  other!: FakeSocket;
  readonly received: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #listeners = new Map<string, Listener[]>();
  accept(): void {}
  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) throw new Error("closed");
    const other = this.other;
    queueMicrotask(() => {
      if (other.closed) return;
      other.received.push(
        typeof data === "string" ? data : [...new Uint8Array(data as ArrayBuffer)].slice(0, 8),
      );
      other.emit("message", { data });
    });
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = { code, reason };
    const other = this.other;
    queueMicrotask(() => {
      if (other.closed) return;
      other.closed = { code, reason };
      other.emit("close", { code, reason });
    });
  }
  /** The connection is cut: this half sees 1006 and nothing reaches the other. */
  cut(): void {
    if (this.closed) return;
    this.closed = { code: 1006, reason: "" };
    this.other.closed = { code: 1006, reason: "" };
    queueMicrotask(() => this.emit("close", { code: 1006, reason: "" }));
  }
  emit(type: string, fields: object): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(fields as Event);
  }
}

function socketPair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.other = b;
  b.other = a;
  return [a, b];
}

/** The context, as rpc-stubs.ts `RpcStubFetchServer` behaves: the sockets it holds per side,
 *  frames forwarded to the other side's current socket, a new dial of a side REPLACING the older
 *  one (closed without touching its peer), and a side's close — delivered when the context gets to
 *  it — closing the other side's current socket. A cut socket stays listed until its close is
 *  delivered, as a dead socket does in the runtime. */
class FakeContext {
  deployId = "deploy-1";
  /** The `itx/aborted` whose reset began this incarnation (null: none). */
  contextAbortedOffset: number | null = null;
  dials = 0;
  swallowNextFrames = 0;
  #downUntil = 0;
  readonly #listed: { side: "eyeball" | "leg"; socket: FakeSocket; replaced: boolean }[] = [];

  #current(side: "eyeball" | "leg") {
    return this.#listed.find((entry) => entry.side === side && !entry.replaced);
  }

  /** Dials of a side that fail next (a slow relay's re-dial). */
  readonly failing = { eyeball: 0, leg: 0 };

  /** A dial of `side`, answered as the DO's 101 is: the socket, the deploy, and the abort its
   *  incarnation began after (`FETCH_UPGRADE_*_HEADER`). */
  dial(side: "eyeball" | "leg"): Response {
    this.dials += 1;
    if (Date.now() < this.#downUntil) throw new Error("the context is resetting");
    if (this.failing[side] > 0) {
      this.failing[side] -= 1;
      throw new Error("the dial failed");
    }
    for (const older of this.#listed.filter((entry) => entry.side === side)) {
      older.replaced = true;
      older.socket.close(1000, "replaced");
    }
    const [end, held] = socketPair();
    const entry = { side, socket: held, replaced: false };
    this.#listed.push(entry);
    held.addEventListener("message", (event) => {
      if (entry.replaced) return;
      if (this.swallowNextFrames > 0) {
        this.swallowNextFrames -= 1;
        return;
      }
      const peer = this.#current(side === "leg" ? "eyeball" : "leg");
      if (peer && !peer.socket.closed)
        peer.socket.send((event as MessageEvent).data as ArrayBuffer);
    });
    held.addEventListener("close", () => this.#closed(entry));
    const headers = new Headers({ [FETCH_UPGRADE_DEPLOY_ID_HEADER]: this.deployId });
    if (this.contextAbortedOffset !== null)
      headers.set(FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER, String(this.contextAbortedOffset));
    // the 101's shape as an end reads it: a Response cannot carry a socket the runtime did not make
    return { status: 101, webSocket: end, headers } as unknown as Response;
  }

  /** The first dial of `side`, as an end is constructed with it. */
  connect(side: "eyeball" | "leg") {
    const answer = this.dial(side);
    return {
      socket: answer.webSocket as unknown as FakeSocket,
      deployId: answer.headers.get(FETCH_UPGRADE_DEPLOY_ID_HEADER),
      contextAbortedOffset: contextAbortedOffsetOf(answer),
    };
  }

  /** A side's close, delivered: forgotten, and — unless a re-dial replaced it — its peer closed. */
  #closed(entry: { side: "eyeball" | "leg"; socket: FakeSocket; replaced: boolean }): void {
    const index = this.#listed.indexOf(entry);
    if (index === -1) return;
    this.#listed.splice(index, 1);
    if (entry.replaced) return;
    this.#current(entry.side === "leg" ? "eyeball" : "leg")?.socket.close(1000, "peer closed");
  }

  /** Every socket cut, as a deploy's reset does — a fresh incarnation holds none; dials fail for
   *  `downForMs`. `contextAbortedOffset`: the reset a recorded `itx.abort()` asked for. */
  reset(input: { deployId: string; downForMs: number; contextAbortedOffset?: number }): void {
    this.deployId = input.deployId;
    this.contextAbortedOffset = input.contextAbortedOffset ?? null;
    this.#downUntil = Date.now() + input.downForMs;
    const listed = this.#listed.splice(0);
    for (const entry of listed) entry.socket.other.cut();
  }

  /** Every socket cut WITHOUT a reset (the platform dropped them): the ends see it at once, the
   *  context delivers the closes `lateMs` later — after the ends have re-dialed. */
  cutAll(lateMs: number): void {
    const cut = [...this.#listed];
    for (const entry of cut) entry.socket.other.cut();
    setTimeout(() => {
      for (const entry of cut) this.#closed(entry);
    }, lateMs);
  }

  /** One side's connection cut: the context sees it close and closes the other side's. */
  drop(side: "eyeball" | "leg"): void {
    const entry = this.#current(side);
    if (!entry) return;
    entry.socket.other.cut();
    this.#closed(entry);
  }
}

/** A provider's socket (the relay's local end), the leg end over the fake context, and — once
 *  `connectEyeball()` — the edge's end and the visitor's socket. */
function spliced() {
  const context = new FakeContext();
  const reports: FetchUpgradeSpliceEvent[] = [];
  const [provider, providerLocal] = socketPair();
  const upgradeId = "upgrade-1";
  const dial = (side: "eyeball" | "leg") => async () => context.dial(side);
  const legEnd = new FetchUpgradeSpliceEnd({
    side: "leg",
    upgradeId,
    local: providerLocal,
    localGoneReason: "tunnel disconnected",
    ...context.connect("leg"),
    dial: dial("leg"),
    report: (event) => reports.push(event),
  });
  const [visitor, visitorLocal] = socketPair();
  return {
    context,
    reports,
    provider,
    visitor,
    connectEyeball() {
      new FetchUpgradeSpliceEnd({
        side: "eyeball",
        upgradeId,
        local: visitorLocal,
        localGoneReason: "visitor disconnected",
        ...context.connect("eyeball"),
        dial: dial("eyeball"),
        report: (event) => reports.push(event),
      });
    },
    /** The relay's end is gone for good (its invocation died): its leg cut, nothing re-dials. */
    killLegEnd() {
      void legEnd;
      context.drop("leg");
      const dialContext = context.dial.bind(context);
      context.dial = (side) => {
        if (side === "leg") throw new Error("no relay dials any more");
        return dialContext(side);
      };
    },
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}
