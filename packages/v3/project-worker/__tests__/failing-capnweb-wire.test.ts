// __tests__/failing-capnweb-wire.test.ts — WIRE-LEVEL bug hunt: EXACT capnweb frames (counts +
// direction) against the REAL worker, the way apps/os asserts transport behavior. The client's
// WebSocket is OURS (instrumented send + message listeners record every frame with direction and
// order) and is handed to `newWebSocketRpcSession(ws)` — capnweb accepts an existing socket
// (dist typings: `newWebSocketRpcSession(webSocket: WebSocket | string, ...)`).
//
// Frame grammar (capnweb protocol): every WebSocket message is ONE frame, a JSON array whose
// head names the kind — "push" (a call), "pull" (request a result), "resolve"/"reject" (answer
// a pulled result), "release" (refcount drop), "abort" (session death). A caller's whole
// pipelined expression must be ONE outbound burst of push/pull frames before the FIRST inbound
// frame (one round trip); trailing "release" frames are post-completion cleanup, never a round
// trip.
//
// Every test asserts CORRECT behavior. `test.fails` marks behavior VERIFIED BROKEN by running
// this file (BUG/EXPECTED/ACTUAL/WHY blocks inline). Run:
//   pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-capnweb-wire.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

// Unique ctx per test AND per run (local DO storage may outlive one vitest invocation).
const RUN = Date.now().toString(36);
const c = (name: string) => `prj_wire${RUN}_${name}`;

let harness: ProjectHarness;
const wires: InstrumentedWire[] = [];
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  for (const w of wires) {
    try {
      w.flushOutbound(); // never leave a stalled socket behind
      (w.session as Record<symbol, () => void>)[Symbol.dispose]?.();
    } catch {
      /* already broken */
    }
    try {
      w.ws.close();
    } catch {
      /* already closed */
    }
  }
  await harness?.stop();
});

// ─────────────────────────────── the wire instrument ───────────────────────────────

type WireFrame = { dir: "out" | "in"; kind: string; data: string; seq: number; atMs: number };

type InstrumentedWire = {
  session: any;
  ws: WebSocket;
  frames: WireFrame[];
  /** Bookmark the frame log; pair with `since`. */
  mark: () => number;
  since: (mark: number) => WireFrame[];
  /** Hold every outbound frame in a queue (recorded + sent only at flush). */
  stallOutbound: () => void;
  flushOutbound: () => void;
};

const kindOf = (data: string): string => {
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? String(parsed[0]) : typeof parsed;
  } catch {
    return "unparseable";
  }
};

/** A capnweb session over a WebSocket WE instrumented: `send` is wrapped (outbound frames are
 *  recorded at the moment they actually hit the socket — capnweb queues sends until open, so
 *  recording at ws.send is wire-truthful), and our "message" listener registers BEFORE capnweb's
 *  so inbound frames are recorded at arrival. */
function wireSession(ctx: string): InstrumentedWire {
  const ws = new WebSocket(`ws://${harness.url.host}/api?ctx=${ctx}`);
  const frames: WireFrame[] = [];
  let seq = 0;
  const record = (dir: "out" | "in", data: unknown) => {
    const text = String(data);
    frames.push({ dir, kind: kindOf(text), data: text, seq: seq++, atMs: Date.now() });
  };
  const realSend = ws.send.bind(ws);
  const stall = { active: false, held: [] as unknown[] };
  (ws as unknown as { send: (d: unknown) => void }).send = (data: unknown) => {
    if (stall.active) {
      stall.held.push(data);
      return;
    }
    record("out", data);
    realSend(data as never);
  };
  ws.addEventListener("message", (ev) => record("in", (ev as MessageEvent).data));
  const session = newWebSocketRpcSession(ws as never);
  const wire: InstrumentedWire = {
    session: session as never,
    ws,
    frames,
    mark: () => frames.length,
    since: (mark: number) => frames.slice(mark),
    stallOutbound: () => {
      stall.active = true;
    },
    flushOutbound: () => {
      stall.active = false;
      for (const data of stall.held.splice(0)) {
        record("out", data);
        realSend(data as never);
      }
    },
  };
  wires.push(wire);
  return wire;
}

/** Frame census: {"out:push": n, "in:resolve": m, ...} — the pinnable shape. */
const tally = (frames: WireFrame[]): Record<string, number> => {
  const t: Record<string, number> = {};
  for (const f of frames) t[`${f.dir}:${f.kind}`] = (t[`${f.dir}:${f.kind}`] ?? 0) + 1;
  return t;
};

/** THE pipelining assertion: within `frames`, every REQUEST-BEARING outbound frame (push/pull)
 *  precedes the first inbound frame — one contiguous outbound burst, then answers. Trailing
 *  outbound `release` frames are cleanup, not round trips. Round trips == 1 by construction:
 *  one burst, one answer wave. */
function expectOneRoundTrip(frames: WireFrame[], label: string): void {
  const firstIn = frames.find((f) => f.dir === "in");
  expect(firstIn, `${label}: expected at least one inbound frame`).toBeDefined();
  const requestFrames = frames.filter(
    (f) => f.dir === "out" && (f.kind === "push" || f.kind === "pull"),
  );
  expect(
    requestFrames.length,
    `${label}: expected at least one outbound request frame`,
  ).toBeGreaterThan(0);
  const late = requestFrames.filter((f) => f.seq > firstIn!.seq);
  expect(
    late.map((f) => f.data),
    `${label}: outbound push/pull AFTER the first inbound frame = a second round trip`,
  ).toEqual([]);
}

// ─────────────────────────────── shared test helpers ───────────────────────────────

async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 15_000,
  pollMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = `falsy: ${JSON.stringify(v)}`;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline)
      throw new Error(`until(${label}): deadline after ${timeoutMs}ms — last: ${String(last)}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The machine-readable error channel (core/errors.ts): classify by code, never by message. */
const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;

const errorOf = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
};

class Tools extends RpcTarget {
  #tag: string;
  constructor(tag: string) {
    super();
    this.#tag = tag;
  }
  hello() {
    return `hello-from-${this.#tag}`;
  }
}

/** The prove_slack shape: an RpcTarget whose GETTER returns a plain object of functions — the
 *  deep-chaining provider (slack → chat → postMessage). */
class SlackReplayTarget extends RpcTarget {
  calls: unknown[][] = [];
  get chat() {
    return {
      postMessage: (opts: Record<string, unknown>) => {
        this.calls.push(["chat.postMessage", opts]);
        return { ok: true, ts: "1755.000100", channel: opts.channel };
      },
    };
  }
  get conversations() {
    return {
      list: (opts?: { limit?: number }) => ({
        ok: true,
        channels: [
          { id: "C1", name: "general" },
          { id: "C2", name: "random" },
        ].slice(0, opts?.limit ?? 99),
      }),
    };
  }
}

// ═══════════════════════════════ 1. PIPELINING of itx expressions on stubs ═══════════════════════════════

test("pipelining: authenticate().get().invokeCapability(whoami) with zero awaits = ONE round trip", async () => {
  const ctx = c("pipe1");
  const w = wireSession(ctx);
  // The whole chain, no intermediate awaits — three pipelined calls, one pull, one answer.
  const who: any = await w.session
    .authenticate()
    .get()
    .invokeCapability({ path: ["whoami"], args: [] });
  expect(who).toMatchObject({ projectId: ctx, path: "/" });
  const frames = w.frames.slice();
  expectOneRoundTrip(frames, "auth().get().invokeCapability()");
  const t = tally(frames);
  expect(t["out:push"]).toBe(3); // authenticate, get, invokeCapability — one push each
  expect(t["out:pull"]).toBe(1); // only the awaited tail is pulled
  expect(t["in:resolve"]).toBe(1); // one answer for the one pull
  // The quiescent census, pinned EXACTLY (measured): the only extra frame is ONE outbound
  // release (the client dropping the intermediate pipeline imports) — cleanup, not a round trip.
  await settle(300);
  console.log("[wire] pipeline auth.get.invokeCapability:", JSON.stringify(tally(w.frames)));
  expect(tally(w.frames)).toEqual({
    "out:push": 3,
    "out:pull": 1,
    "in:resolve": 1,
    "out:release": 1,
  });
});

test("pipelining: invokes on the NOT-YET-RESOLVED itx from connect() = ONE round trip", async () => {
  const ctx = c("pipe2");
  const w = wireSession(ctx);
  const itxPromise = w.session.connect({ context: "/pipelined" }); // NOT awaited
  const who: any = await itxPromise.invokeCapability({ path: ["whoami"], args: [] });
  expect(who).toMatchObject({ projectId: ctx, path: "/pipelined" });
  const frames = w.frames.slice();
  expectOneRoundTrip(frames, "connect().invokeCapability()");
  const t = tally(frames);
  expect(t["out:push"]).toBe(2);
  expect(t["out:pull"]).toBe(1);
  expect(t["in:resolve"]).toBe(1);
  await settle(300);
  console.log("[wire] pipeline connect.invokeCapability:", JSON.stringify(tally(w.frames)));
  expect(tally(w.frames)).toEqual({
    "out:push": 2,
    "out:pull": 1,
    "in:resolve": 1,
    "out:release": 1,
  });
});

test("pipelining: provideCapability(...).revoke() on the UNRESOLVED provision = ONE round trip, and the mount really dies", async () => {
  const ctx = c("pipe3");
  const w = wireSession(ctx);
  const itx = await w.session.authenticate().get();
  const mark = w.mark();
  {
    // The returned CapabilityProvision is used BEFORE it resolves: .revoke() rides the same burst.
    using provisionPromise = itx.provideCapability({
      path: ["piptool"],
      capability: (x: number) => x + 1,
    });
    await provisionPromise.revoke();
  }
  const frames = w.since(mark);
  expectOneRoundTrip(frames, "provideCapability().revoke()");
  const t = tally(frames);
  expect(t["out:push"]).toBe(2); // provideCapability, revoke
  expect(t["out:pull"]).toBe(1); // only revoke's result is awaited
  expect(t["in:resolve"]).toBe(1);
  await settle(300);
  console.log("[wire] pipeline provide.revoke:", JSON.stringify(tally(w.since(mark))));
  // Pinned EXACTLY (measured): the extras are 2 outbound releases (the provision import + the
  // exported callback the provide carried) and 1 INBOUND release (the server dropping its dup
  // of that callback after the revoke) — all cleanup, still one round trip.
  expect(tally(w.since(mark))).toEqual({
    "out:push": 2,
    "out:pull": 1,
    "in:resolve": 1,
    "in:release": 1,
    "out:release": 2,
  });
  // Correctness under pipelining: the provide really mounted, then the revoke really unmounted.
  const err = await errorOf(itx.invokeCapability({ path: ["piptool"], args: [1] }));
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
});

// ═══════════════════════════════ 2. FRAMES PER CALL (regression pins) ═══════════════════════════════

test("frames per call: ONE settled invokeCapability = exactly 2 outbound (push+pull) + 1 inbound (resolve)", async () => {
  const ctx = c("percall");
  const w = wireSession(ctx);
  const itx = await w.session.authenticate().get(); // settle the stub first
  await settle(200);
  const mark = w.mark();
  const who: any = await itx.invokeCapability({ path: ["whoami"], args: [] });
  expect(who.path).toBe("/");
  const callFrames = w.since(mark);
  const t = tally(callFrames);
  expect(t["out:push"]).toBe(1);
  expect(t["out:pull"]).toBe(1);
  expect(t["in:resolve"]).toBe(1);
  // THE REGRESSION PIN — one settled call costs EXACTLY 3 outbound + 1 inbound frames
  // (push + pull + the post-resolution release out; one resolve in). Measured, exact.
  await settle(400);
  const quiescent = tally(w.since(mark));
  console.log("[wire] frames-per-call (quiescent):", JSON.stringify(quiescent));
  expect(quiescent).toEqual({ "out:push": 1, "out:pull": 1, "in:resolve": 1, "out:release": 1 });
});

// ═══════════════════════════════ 3. ONE-DIRECTIONAL DELIVERY at the wire ═══════════════════════════════

test("one-directional delivery: 100 ephemeral chunks arrive as inbound frames; the subscriber socket never sends push/pull; deliveries keep flowing with outbound STALLED", async () => {
  const ctx = c("oneway");
  const w = wireSession(ctx);
  const itx = await w.session.authenticate().get();
  const received: number[] = [];
  await itx.subscribe({
    name: "wire",
    consumes: ["chunk"],
    target: (events: any[]) => {
      for (const e of events) if (e.type === "chunk") received.push(e.payload.n);
    },
  });
  await settle(400); // let the park/mount fully settle before the census window opens

  const producer = await harness.itx(ctx); // a SECOND session appends
  const mark = w.mark();
  for (let i = 0; i < 100; i++)
    await producer.invokeCapability({
      path: ["stream", "append"],
      args: [{ type: "chunk", ephemeral: true, payload: { n: i } }],
    });
  await until("all 100 chunks delivered", () => received.length >= 100, 30_000);
  await settle(500); // let the last acks flush into the census
  const frames = w.since(mark);
  const t = tally(frames);
  console.log("[wire] one-directional census for 100 single-chunk batches:", JSON.stringify(t));

  // THE INVARIANT: the subscriber's socket never INITIATES — zero outbound push/pull frames.
  const outboundRequests = frames.filter(
    (f) => f.dir === "out" && (f.kind === "push" || f.kind === "pull"),
  );
  expect(outboundRequests.map((f) => f.data)).toEqual([]);
  // CHARACTERIZATION, pinned EXACTLY (measured): per delivered batch the wire carries
  //   in:  1 push (the delivery call) + 1 pull (the relay awaits the callback's result)
  //        + 1 release (the server dropping its import of the answer),
  //   out: 1 resolve (the callback's `undefined` answer) — a RESPONSE, never an initiation.
  // So "one-directional" at the wire = the client only ever ANSWERS; the stall proof below
  // shows even those answers are not load-bearing for delivery.
  expect(t).toEqual({ "in:push": 100, "in:pull": 100, "in:release": 100, "out:resolve": 100 });

  // THE STALL PROOF: nothing outbound is awaited/blocking — deliveries keep arriving with the
  // client's outbound artificially held.
  w.stallOutbound();
  const stallMark = w.mark();
  for (let i = 100; i < 120; i++)
    await producer.invokeCapability({
      path: ["stream", "append"],
      args: [{ type: "chunk", ephemeral: true, payload: { n: i } }],
    });
  await until("20 more chunks delivered THROUGH the stall", () => received.length >= 120, 20_000);
  const stalledWindow = w.since(stallMark);
  expect(stalledWindow.every((f) => f.dir === "in")).toBe(true); // zero outbound frames flushed
  w.flushOutbound();
  expect(received.slice(0, 120)).toEqual([...Array(120).keys()]); // in order, no loss, no dups
}, 90_000);

// ═══════════════════════════════ 4. DEEP CHAINING through live capabilities ═══════════════════════════════

test("deep chaining: 3+ segment dotted paths through a live provider (getter → object of fns) resolve correctly, costing the client ONE round trip", async () => {
  const ctx = c("deep");
  const slack = new SlackReplayTarget();
  const provider = harness.session(ctx);
  await provider.connect({ connectionKey: "slack", capabilities: slack });

  const w = wireSession(ctx);
  const itx = await w.session.authenticate().get();
  await until("the slack bridge is attached", async () =>
    ((await itx.invoke("itx.connections.list()")) as any[]).some(
      (r) => r.connectionKey === "slack",
    ),
  );

  // String half: deep dots + a trailing call.
  const mark1 = w.mark();
  const posted: any = await itx.invoke(
    "itx.connections.get('slack').chat.postMessage({ channel: '#wire', text: 'deep' })",
  );
  expect(posted).toMatchObject({ ok: true, ts: "1755.000100", channel: "#wire" });
  expectOneRoundTrip(w.since(mark1), "deep chain (string half)");
  const t1 = tally(w.since(mark1));
  expect(t1["out:push"]).toBe(1); // the whole deep chain is ONE push — the server walks the dots
  expect(t1["out:pull"]).toBe(1);
  expect(t1["in:resolve"]).toBe(1);

  // Array half: a mid-path call with structured args.
  const listed: any = await itx.invoke([
    "itx",
    "connections",
    ["get", "slack"],
    "conversations",
    ["list", { limit: 1 }],
  ]);
  expect(listed).toMatchObject({ ok: true });
  expect(listed.channels).toEqual([{ id: "C1", name: "general" }]);

  // The provider-side SDK saw the exact call.
  expect(slack.calls).toContainEqual(["chat.postMessage", { channel: "#wire", text: "deep" }]);
});

// ═══════════════════════════════ 5. THE DISPOSAL CONTRACT ═══════════════════════════════
// (The natural-dotted-client-surface hunt — `itx.kv.put(...)` as plain proxy access — lives in a
// sibling file; this file owns the wire.)

test("disposal: `using` on the /api session stub tears its connection down at scope exit", async () => {
  const ctx = c("using");
  const observer = await harness.itx(ctx);
  {
    using scoped = newWebSocketRpcSession(`ws://${harness.url.host}/api?ctx=${ctx}`) as any;
    await scoped.connect({ connectionKey: "scoped", capabilities: new Tools("scoped") });
    await until("'scoped' listed while the scope lives", async () =>
      ((await observer.invoke("itx.connections.list()")) as any[]).some(
        (r) => r.connectionKey === "scoped",
      ),
    );
  } // ← Symbol.dispose fires here: capnweb says goodbye, ProjectSession tears the relay down
  await until(
    "'scoped' left the currently-connected list after scope exit",
    async () =>
      !((await observer.invoke("itx.connections.list()")) as any[]).some(
        (r) => r.connectionKey === "scoped",
      ),
  );
});

// BUG: disposing a CapabilityProvision handle does NOT revoke its mount. CapabilityProvision
//   (core/itx-surface.ts) declares no Symbol.dispose, so when the client's `using` scope ends —
//   capnweb sends the release, the server drops its dup of the RpcTarget — nothing happens
//   server-side: no revokeCapability, no dropItxConnection, no relay.dispose.
// EXPECTED: the capnweb ownership contract (README "Automatic disposal": stubs returned in a
//   result are OWNED by the caller; disposal releases the associated resources) — disposing the
//   ownership handle IS revoke(): the mount pops and the parked connection drops at scope exit.
// ACTUAL: the mount keeps answering indefinitely (still "hello-from-scopedtool" 4s+ after the
//   handle was disposed and released on the wire; only the provider session's death would reap it).
// WHY IT MATTERS: the handle is the ONLY holder of providedAtOffset + connectionId — once it is
//   disposed without an explicit revoke() there is no handle-precise revocation left (only a
//   by-path revoke that also pops whatever later shadowed the path). `using provision = await
//   itx.provideCapability(...)` — the spelling the capnweb README teaches — silently leaks the
//   mount + the parked connection + the relay until the whole session dies.
// FIXED (defect 23): CapabilityProvision now implements Symbol.dispose → revoke().
test("disposal: `using` on a CapabilityProvision auto-revokes its mount at scope exit", async () => {
  const ctx = c("provdispose");
  const observer = await harness.itx(ctx);
  const w = wireSession(ctx);
  const itx = await w.session.authenticate().get();
  {
    using provision = await itx.provideCapability({
      path: ["scopedtool"],
      capability: new Tools("scopedtool"),
    });
    expect(await observer.invokeCapability({ path: ["scopedtool", "hello"], args: [] })).toBe(
      "hello-from-scopedtool",
    );
    void provision; // used via `using` only
  } // ← the ownership handle is disposed — the mount must not outlive its owner
  const gone = await until(
    "the mount auto-revoked after its handle was disposed",
    async () => {
      const err = await errorOf(
        observer.invokeCapability({ path: ["scopedtool", "hello"], args: [] }),
      );
      return codeOf(err) === "NO_CAPABILITY_MATCH";
    },
    4_000,
  ).catch(() => false);
  expect(gone).toBe(true);
});

test("disposal: dup() survives disposal of the original; the LAST dispose kills the stub with the pinned error", async () => {
  const ctx = c("dup");
  const w = wireSession(ctx);
  const itx: any = await w.session.authenticate().get();
  const dup = itx.dup();
  itx[Symbol.dispose]();
  // The duplicate still works — refcounted, not killed by the sibling's disposal.
  const who: any = await dup.invokeCapability({ path: ["whoami"], args: [] });
  expect(who.path).toBe("/");
  dup[Symbol.dispose]();
  // The LAST duplicate is gone — calls reject with the library's documented disposal error
  // (a prompt classifiable rejection, never a hang).
  const err = await errorOf(dup.invokeCapability({ path: ["whoami"], args: [] }));
  expect(String(err)).toContain("Attempted to use RPC stub after it has been disposed.");
});

test("disposal: onRpcBroken fires on dirty transport death (the relay relies on this)", async () => {
  const ctx = c("broken");
  const w = wireSession(ctx);
  const itx: any = await w.session.authenticate().get();
  const broken: unknown[] = [];
  itx.onRpcBroken((e: unknown) => broken.push(e));
  (w.session as any).onRpcBroken((e: unknown) => broken.push(e));
  w.ws.close(); // dirty: no capnweb goodbye
  await until("both stubs report brokenness", () => broken.length >= 2);
  expect(String(broken[0])).toMatch(/WebSocket/);
});
