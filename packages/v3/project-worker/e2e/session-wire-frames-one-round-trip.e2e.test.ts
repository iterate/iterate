// session-wire-frames-one-round-trip.e2e.test.ts — WIRE-LEVEL: EXACT capnweb frames (counts +
// direction) against the real worker. The client's WebSocket is OURS (instrumented send + message
// listeners record every frame with direction and order) and is handed to `newWebSocketRpcSession(ws)`.
//
// Frame grammar (capnweb protocol): every WebSocket message is ONE frame, a JSON array whose head
// names the kind — "push" (a call), "pull" (request a result), "resolve"/"reject" (answer a pulled
// result), "release" (refcount drop), "abort" (session death). A caller's whole pipelined expression
// must be ONE outbound burst of push/pull frames before the FIRST inbound frame (one round trip);
// trailing "release" frames are post-completion cleanup, never a round trip. Proves: pipelining of
// itx expressions on unresolved stubs costs ONE round trip, the exact frames-per-call census, that a
// push subscriber's socket only ever ANSWERS (and keeps receiving with its outbound stalled), deep
// dotted chains through a live provider cost one push, and the disposal contract.

import { expect, test } from "vitest";
import {
  codeOf,
  freshCtx,
  openItx,
  presence,
  rawSession,
  rejection,
  rpcStubRewriteRuleMatches,
  session,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";
import { SlackReplayTarget, Tools } from "./support/targets.ts";

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
function wireSession(): InstrumentedWire {
  const frames: WireFrame[] = [];
  let seq = 0;
  const record = (dir: "out" | "in", data: unknown) => {
    const text = String(data);
    frames.push({ dir, kind: kindOf(text), data: text, seq: seq++, atMs: Date.now() });
  };
  const stall = { active: false, held: [] as unknown[] };
  let realSend!: (data: never) => void;
  const { session, ws } = rawSession((ws) => {
    realSend = ws.send.bind(ws);
    (ws as unknown as { send: (d: unknown) => void }).send = (data: unknown) => {
      if (stall.active) {
        stall.held.push(data);
        return;
      }
      record("out", data);
      realSend(data as never);
    };
    ws.addEventListener("message", (ev) => record("in", (ev as MessageEvent).data));
  });
  const wire: InstrumentedWire = {
    session,
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

// ═══════════════════════════════ 1. PIPELINING of itx expressions on stubs ═══════════════════════════════

test("pipelining: authenticate().projects.get(ctx).invoke(whoami) with zero awaits = ONE round trip", async () => {
  const ctx = freshCtx("pipe1");
  const w = wireSession();
  // The whole chain, no intermediate awaits — three pipelined calls, one pull, one answer.
  const who: any = await w.session
    .authenticate()
    .projects.get(ctx)
    .invoke(["itx", ["whoami"]]);
  expect(who).toMatchObject({ projectId: ctx, path: "/" });
  const frames = w.frames.slice();
  expectOneRoundTrip(frames, "auth().projects.get(ctx).invoke()");
  const t = tally(frames);
  expect(t["out:push"]).toBe(3); // authenticate, get, invoke — one push each
  expect(t["out:pull"]).toBe(1); // only the awaited tail is pulled
  expect(t["in:resolve"]).toBe(1); // one answer for the one pull
  // The quiescent census, pinned EXACTLY (measured): the only extra frame is ONE outbound
  // release (the client dropping the intermediate pipeline imports) — cleanup, not a round trip.
  await sleep(300);
  expect(tally(w.frames)).toEqual({
    "out:push": 3,
    "out:pull": 1,
    "in:resolve": 1,
    "out:release": 1,
  });
});

test("pipelining: invokes on the NOT-YET-RESOLVED itx from cd() = ONE round trip", async () => {
  const ctx = freshCtx("pipe2");
  const w = wireSession();
  // NOT awaited — pure addressing: root context, then cd to a sub-context of the same project.
  const itxPromise = w.session.authenticate().projects.get(ctx).cd("/pipelined");
  const who: any = await itxPromise.invoke(["itx", ["whoami"]]);
  expect(who).toMatchObject({ projectId: ctx, path: "/pipelined" });
  const frames = w.frames.slice();
  expectOneRoundTrip(frames, "auth().projects.get(ctx).cd().invoke()");
  const t = tally(frames);
  expect(t["out:push"]).toBe(4); // authenticate, projects.get, cd, invoke — one push each
  expect(t["out:pull"]).toBe(1);
  expect(t["in:resolve"]).toBe(1);
  await sleep(300);
  expect(tally(w.frames)).toEqual({
    "out:push": 4,
    "out:pull": 1,
    "in:resolve": 1,
    "out:release": 1,
  });
});

test("pipelining: subscribe({ target: fn }) + subscribe({ name: <its UNRESOLVED name>, target: null }) = ONE round trip; the row is gone and the callback recalled", async () => {
  const ctx = freshCtx("pipe3");
  const w = wireSession();
  const itx = await w.session.authenticate().projects.get(ctx);
  const mark = w.mark();
  {
    // ONE door, one burst: the subscribe is NOT awaited; the removal names the row by pipelining
    // the unresolved handle's `name` getter as its argument (capnweb serializes it as a pipeline
    // reference, so the server delivers the removal only after the subscribe resolved).
    const subscription = itx.subscribe({ consumes: ["never"], target: () => undefined });
    await itx.subscribe({ name: subscription.name, target: null });
  }
  const frames = w.since(mark);
  expectOneRoundTrip(frames, "subscribe(fn) + subscribe({ name: result.name, target: null })");
  const t = tally(frames);
  expect(t["out:push"]).toBe(2); // subscribe, subscribe(null)
  expect(t["out:pull"]).toBe(1); // only the removal's result is awaited
  expect(t["in:resolve"]).toBe(1);
  await sleep(300);
  // Pinned EXACTLY (measured): after the round trip the cleanup is 1 outbound release (the client
  // dropping the never-pulled subscription import — which disposes the server-side handle) and 1
  // inbound release (the relay releasing the dup of the callback it lent, recalled by the removal).
  // All cleanup, still one round trip.
  expect(tally(w.since(mark))).toEqual({
    "out:push": 2,
    "out:pull": 1,
    "in:resolve": 1,
    "out:release": 1,
    "in:release": 1,
  });
  // Correctness under pipelining: the subscribe really lent the callback AND appended its row; the
  // removal (delivered after it) dropped THE row and recalled the stub — nothing left in either table.
  expect(await subscriptions(itx)).toEqual([]);
  await until("the callback recalled", async () => (await presence(itx)).length === 0);
});

// ═══════════════════════════════ 2. FRAMES PER CALL (regression pins) ═══════════════════════════════

test("frames per call: ONE settled invoke = exactly 2 outbound (push+pull) + 1 inbound (resolve)", async () => {
  const ctx = freshCtx("percall");
  const w = wireSession();
  const itx = await w.session.authenticate().projects.get(ctx); // settle the stub first
  await sleep(200);
  const mark = w.mark();
  const who: any = await itx.invoke(["itx", ["whoami"]]);
  expect(who.path).toBe("/");
  const t = tally(w.since(mark));
  expect(t["out:push"]).toBe(1);
  expect(t["out:pull"]).toBe(1);
  expect(t["in:resolve"]).toBe(1);
  // THE REGRESSION PIN — one settled call costs EXACTLY 3 outbound + 1 inbound frames
  // (push + pull + the post-resolution release out; one resolve in). Measured, exact.
  await sleep(400);
  expect(tally(w.since(mark))).toEqual({
    "out:push": 1,
    "out:pull": 1,
    "in:resolve": 1,
    "out:release": 1,
  });
});

// ═══════════════════════════════ 3. ONE-DIRECTIONAL DELIVERY at the wire ═══════════════════════════════

test("one-directional delivery: 100 ephemeral chunks arrive as inbound frames; the subscriber socket never sends push/pull — it only ever ANSWERS", async () => {
  const ctx = freshCtx("oneway");
  const w = wireSession();
  const itx = await w.session.authenticate().projects.get(ctx);
  const received: number[] = [];
  await itx.subscribe({
    name: "wire",
    consumes: ["chunk"],
    target: (events: any[]) => {
      for (const e of events) if (e.type === "chunk") received.push(e.payload.n);
    },
  });
  await sleep(400); // let the lend/row fully settle before the census window opens

  const producer = openItx(ctx); // a SECOND session appends
  const mark = w.mark();
  for (let i = 0; i < 100; i++)
    await producer.invoke([
      "itx",
      ["append", { type: "chunk", ephemeral: true, payload: { n: i } }],
    ]);
  await until("all 100 chunks delivered", () => received.length >= 100, 30_000);
  await sleep(500); // let the last acks flush into the census
  const frames = w.since(mark);
  const t = tally(frames);

  // THE INVARIANT: the subscriber's socket never INITIATES — zero outbound push/pull frames.
  const outboundRequests = frames.filter(
    (f) => f.dir === "out" && (f.kind === "push" || f.kind === "pull"),
  );
  expect(outboundRequests.map((f) => f.data)).toEqual([]);
  // CHARACTERIZATION, pinned EXACTLY (measured): per delivered batch the wire carries
  //   in:  1 push (the delivery call) + 1 pull (the relay awaits the callback's result)
  //        + 1 release (the server dropping its import of the answer),
  //   out: 1 resolve (the callback's `undefined` answer) — a RESPONSE, never an initiation.
  // So "one-directional" at the wire = the client only ever ANSWERS.
  expect(t).toEqual({ "in:push": 100, "in:pull": 100, "in:release": 100, "out:resolve": 100 });
  expect(received).toEqual([...Array(100).keys()]); // in order, no loss, no dups
}, 90_000);

test("one-directional delivery: batches keep flowing with the subscriber's outbound STALLED — nothing outbound is load-bearing", async () => {
  // Only the EVALUATION is serialized; the client's answers are not load-bearing — deliveries arrive
  // at append rate while the client's answers are held. This is the hibernation story (a tab that
  // answers late must not back-pressure the DO) and the throughput story (batches flow at append
  // rate, not at the client's round-trip rate).
  const ctx = freshCtx("stall");
  const w = wireSession();
  const itx = await w.session.authenticate().projects.get(ctx);
  const received: number[] = [];
  await itx.subscribe({
    name: "wire",
    consumes: ["chunk"],
    target: (events: any[]) => {
      for (const e of events) if (e.type === "chunk") received.push(e.payload.n);
    },
  });
  const producer = openItx(ctx);
  const chunk = (n: number) =>
    producer.invoke(["itx", ["append", { type: "chunk", ephemeral: true, payload: { n } }]]);
  await chunk(0); // one probe proves the lane before the stall
  await until("the probe delivered", () => received.length >= 1, 10_000);
  await sleep(300); // its answer flushes before the stall

  // THE STALL PROOF: hold every outbound frame; deliveries must keep arriving regardless.
  w.stallOutbound();
  const stallMark = w.mark();
  for (let i = 1; i <= 20; i++) await chunk(i);
  await until("20 more chunks delivered THROUGH the stall", () => received.length >= 21, 8_000);
  const stalledWindow = w.since(stallMark);
  expect(stalledWindow.every((f) => f.dir === "in")).toBe(true); // zero outbound frames flushed
  w.flushOutbound();
  expect(received).toEqual([...Array(21).keys()]); // in order, no loss, no dups
}, 60_000);

// ═══════════════════════════════ 4. DEEP CHAINING through live rpc stubs ═══════════════════════════════

test("deep chaining: 3+ segment dotted paths through a live provider (getter → object of fns) resolve correctly, costing the client ONE round trip", async () => {
  const ctx = freshCtx("deep");
  const slack = new SlackReplayTarget();
  await openItx(ctx).provide("itx.slack", { stub: slack, rewrite: "itx.slack" });

  const w = wireSession();
  const itx = await w.session.authenticate().projects.get(ctx);
  await until("the slack bridge is attached", async () =>
    (await presence(itx)).includes("itx.slack"),
  );

  // String half: deep dots + a trailing call, straight through the rewrite rule.
  const mark1 = w.mark();
  const posted: any = await itx.invoke(
    "itx.slack.chat.postMessage({ channel: '#wire', text: 'deep' })",
  );
  expect(posted).toMatchObject({ ok: true, ts: "1755.000100", channel: "#wire" });
  expectOneRoundTrip(w.since(mark1), "deep chain (string half)");
  const t1 = tally(w.since(mark1));
  expect(t1["out:push"]).toBe(1); // the whole deep chain is ONE push — the server walks the dots
  expect(t1["out:pull"]).toBe(1);
  expect(t1["in:resolve"]).toBe(1);

  // Array half: structured args through the same path.
  const listed: any = await itx.invoke(["itx", "slack", "conversations", ["list", { limit: 1 }]]);
  expect(listed).toMatchObject({ ok: true });
  expect(listed.channels).toEqual([{ id: "C1", name: "general" }]);

  // The provider-side SDK saw the exact call.
  expect(slack.calls).toContainEqual(["chat.postMessage", { channel: "#wire", text: "deep" }]);
});

// ═══════════════════════════════ 5. THE DISPOSAL CONTRACT ═══════════════════════════════

test("disposal: `using` on the /api session stub recalls its lent stubs at scope exit — and un-sets their rules (default-deny afterwards)", async () => {
  // A provided stub is two things, session-scoped as a pair: the STUB is physical — `Symbol.dispose`
  // on the session recalls every stub it lent, so `itx.rpcStubs.list()` stops listing them; the
  // REWRITE RULE is data, and capnweb disposes the provided handle with the session, which un-sets
  // it. Nothing lingers: seen from another session the match is default-deny again.
  const ctx = freshCtx("using");
  const observer = openItx(ctx);
  {
    using scoped = session();
    await scoped
      .authenticate()
      .projects.get(ctx)
      .provide("itx.scoped", { stub: new Tools("scoped"), rewrite: "itx.scoped" });
    await until("the stub present while the scope lives", async () =>
      (await presence(observer)).includes("itx.scoped"),
    );
    expect(await observer.invoke("itx.scoped.hello()")).toBe("hello-from-scoped");
    expect(await rpcStubRewriteRuleMatches(observer)).toContain("itx.scoped");
  } // ← Symbol.dispose fires here: capnweb says goodbye, the session tears every relay down
  await until(
    "the stub gone from presence after scope exit",
    async () => !(await presence(observer)).includes("itx.scoped"),
  );
  await until(
    "the rule un-set after scope exit",
    async () => !(await rpcStubRewriteRuleMatches(observer)).includes("itx.scoped"),
  );
  const err = await rejection(observer.invoke("itx.scoped.hello()"));
  expect(codeOf(err)).toBe("NO_ITX_EXPRESSION_MATCH"); // default-deny, seen from another session
});

test("disposal: dup() survives disposal of the original; the LAST dispose kills the stub with the pinned error", async () => {
  const w = wireSession();
  const itx: any = await w.session.authenticate().projects.get(freshCtx("dup"));
  const dup = itx.dup();
  itx[Symbol.dispose]();
  // The duplicate still works — refcounted, not killed by the sibling's disposal.
  const who: any = await dup.invoke(["itx", ["whoami"]]);
  expect(who.path).toBe("/");
  dup[Symbol.dispose]();
  // The LAST duplicate is gone — calls reject with the library's documented disposal error
  // (a prompt classifiable rejection, never a hang).
  const err = await rejection(dup.invoke(["itx", ["whoami"]]));
  expect(String(err)).toContain("Attempted to use RPC stub after it has been disposed.");
});

test("disposal: onRpcBroken fires on dirty transport death (the relay relies on this)", async () => {
  const w = wireSession();
  const itx: any = await w.session.authenticate().projects.get(freshCtx("broken"));
  const broken: unknown[] = [];
  itx.onRpcBroken((e: unknown) => broken.push(e));
  (w.session as any).onRpcBroken((e: unknown) => broken.push(e));
  w.ws.close(); // dirty: no capnweb goodbye
  await until("both stubs report brokenness", () => broken.length >= 2);
  expect(String(broken[0])).toMatch(/WebSocket/);
});
