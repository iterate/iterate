// __tests__/failing-connections.test.ts — BUG HUNT: ItxConnections / ItxConnectionSessions /
// the stub pager (src/itx-connection-directory.ts + src/core/hibernatable-rpc-stub.ts +
// src/core/itx-surface.ts). Every test asserts the CORRECT behavior per those files' own
// contracts; tests marked `test.fails` are verified-failing bugs (BUG/EXPECTED/ACTUAL/WHY
// blocks inline). Run:
//   pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-connections.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

const STARTED = "events.iterate.com/itx-connection/connection-session-started";
const ENDED = "events.iterate.com/itx-connection/connection-session-ended";

// Unique ctx per test AND per run (local DO storage may outlive one vitest invocation).
const RUN = Date.now().toString(36);
const c = (name: string) => `prj_fc${RUN}_${name}`;

let harness: ProjectHarness;
const rawSockets: WebSocket[] = [];
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  for (const ws of rawSockets) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  await harness?.stop();
});

// ── helpers ──

/** A capnweb session whose underlying WebSocket WE hold — so a test can sever the transport
 *  (network death) without any capnweb-level goodbye. */
function rawSession(ctx: string): { session: any; ws: WebSocket } {
  const ws = new WebSocket(`ws://${harness.url.host}/api?ctx=${ctx}`);
  rawSockets.push(ws);
  return { session: newWebSocketRpcSession(ws as any) as any, ws };
}

/** Poll until `fn` returns truthy (deadline, never a bare sleep). Returns the truthy value. */
async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 10_000,
  intervalMs = 100,
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
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Await a promise that MUST reject promptly; hands back the rejection error. Throws if it
 *  resolves or is still pending at the deadline (a hang is a bug, never a wait). */
async function rejectionOf(
  p: Promise<unknown>,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  const settled = p.then(
    (v) => ({ kind: "resolved" as const, v }),
    (e) => ({ kind: "rejected" as const, e }),
  );
  const HUNG = { kind: "hung" as const };
  const out = await Promise.race([
    settled,
    new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), timeoutMs)),
  ]);
  if (out.kind === "hung")
    throw new Error(`${label}: still pending after ${timeoutMs}ms — expected a prompt rejection`);
  if (out.kind === "resolved")
    throw new Error(`${label}: resolved (${JSON.stringify(out.v)}) — expected a rejection`);
  return out.e;
}

/** The machine-readable error channel (core/errors.ts): classify by code, never by message. */
const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e ? String((e as any).code) : undefined;

const listConnections = (itx: any): Promise<any[]> => itx.invoke("itx.connections.list()");

/** The DURABLE log (ephemeral opened/closed facts never land here — only session facts do). */
async function connectionFacts(itx: any): Promise<any[]> {
  const page = await itx.invokeCapability({ path: ["stream", "read"], args: [0, 500] });
  return (page.events as any[]).filter((e) =>
    String(e.type).startsWith("events.iterate.com/itx-connection/"),
  );
}
const sessionFactsFor = (facts: any[], key: string) =>
  facts.filter((e) => e.payload?.connectionKey === key);

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

/** A provider whose method never answers — the mid-invoke death rig. */
class HangTools extends RpcTarget {
  hangStarted = false;
  hello() {
    return "hang-tools";
  }
  hang() {
    this.hangStarted = true;
    return new Promise(() => {
      /* never resolves — the test kills the session instead */
    });
  }
}

// ── the hunt ──

test("calling a connection that never existed rejects with code CONNECTION_OFFLINE", async () => {
  const itx = await harness.itx(c("offline"));
  const err = await rejectionOf(
    itx.invoke("itx.connections.get('never-existed').hello()"),
    10_000,
    "invoke on a never-attached connection",
  );
  // The code must survive the DO → edge → capnweb hops (core/errors.ts contract).
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
});

test("stub pager upgrade with an unknown connectionId is refused with 409 (attach first)", async () => {
  // Two-phase attach: the pager door must 409 an id it never minted, so a relay that outlived
  // a DO restart re-attaches instead of silently pairing a socket to nothing.
  const res = await fetch(`http://${harness.url.host}/state?ctx=${c("pager409")}`, {
    headers: { "x-itx-stub-pager": "424242" },
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("attach first");
});

test("same-key replace: survivor keeps the session, its key mounts survive, only by-id mounts of the dead transport auto-revoke", async () => {
  const ctx = c("replace");
  const observer = await harness.itx(ctx);
  const s1 = harness.session(ctx);
  await s1.connect({
    connectionKey: "dup",
    description: "first transport",
    capabilities: new Tools("one"),
  });
  const first = await until("first 'dup' transport listed", async () =>
    (await listConnections(observer)).find((r) => r.connectionKey === "dup"),
  );
  // Two mounts: one names the KEY (must survive a replace), one names the first transport's
  // connectionId (must auto-revoke when that transport dies).
  await observer.provide({ path: "itx.dupTool", target: "itx.connections.get('dup')" });
  await observer.provide({
    path: "itx.oldById",
    target: `itx.connections.get('${first.connectionId}')`,
  });

  // Second LIVE session, same key → replaces the predecessor transport (same logical client).
  const s2 = harness.session(ctx);
  await s2.connect({
    connectionKey: "dup",
    description: "second transport",
    capabilities: new Tools("two"),
  });
  const survivor = await until(
    "exactly one 'dup' transport, under a NEW connectionId",
    async () => {
      const dups = (await listConnections(observer)).filter((r) => r.connectionKey === "dup");
      return dups.length === 1 && dups[0].connectionId !== first.connectionId ? dups[0] : undefined;
    },
  );
  expect(survivor.connectionKey).toBe("dup");

  // Deterministic settle: #connectionClosed appends its facts BEFORE onFinalClose runs, so once
  // the by-id mount is auto-revoked the replaced transport's close is FULLY processed.
  await until("by-id mount of the replaced transport auto-revoked", async () => {
    try {
      await observer.invokeCapability({ path: ["oldById", "hello"], args: [] });
      return undefined;
    } catch (e) {
      return codeOf(e) === "NO_CAPABILITY_MATCH";
    }
  });

  // The survivor's key mount must NOT have been auto-revoked ("replaced" is never key-final)…
  const hello = await observer.invokeCapability({ path: ["dupTool", "hello"], args: [] });
  expect(hello).toBe("hello-from-two");
  // …and the replace is ONE session: exactly one started fact, no ended fact.
  const facts = sessionFactsFor(await connectionFacts(observer), "dup");
  expect(facts.map((f) => f.type)).toEqual([STARTED]);
});

test("clean close ends the session: fact sequence started → ended → started across a disposed reconnect", async () => {
  const ctx = c("clean");
  const observer = await harness.itx(ctx);
  const s1 = harness.session(ctx);
  await s1.connect({ connectionKey: "tidy", capabilities: new Tools("tidy1") });
  await until("'tidy' listed", async () =>
    (await listConnections(observer)).some((r) => r.connectionKey === "tidy"),
  );
  // Dispose the WHOLE client session — capnweb tells the server, ProjectSession[Symbol.dispose]
  // tears the relay down: a CLEAN final close, which must end the session NOW.
  (s1 as any)[Symbol.dispose]?.();
  await until(
    "'tidy' left the currently-connected list",
    async () => !(await listConnections(observer)).some((r) => r.connectionKey === "tidy"),
  );
  await until("durable session-ended fact filed", async () =>
    sessionFactsFor(await connectionFacts(observer), "tidy").some((f) => f.type === ENDED),
  );
  // Reconnect under the same key → a NEW session (clean end ended the old one).
  const s2 = harness.session(ctx);
  await s2.connect({ connectionKey: "tidy", capabilities: new Tools("tidy2") });
  await until("second session-started fact filed", async () => {
    const seq = sessionFactsFor(await connectionFacts(observer), "tidy").map((f) => f.type);
    return seq.length === 3 ? seq : undefined;
  }).then((seq) => expect(seq).toEqual([STARTED, ENDED, STARTED]));
});

// BUG: a DIRTY client death is filed as a CLEAN session end — the session rule's storm clause
//   is unreachable. itx-surface.ts closes the pager WebSocket with code 1000 on BOTH paths
//   (onRpcBroken → close(1000, "provider session broke"); ProjectSession dispose →
//   close(1000, "relay disposed")), and itx-connection-directory.ts#connectionClosed treats
//   code 1000 as "a clean, final end closes the session NOW" (kv deleted, ended fact filed).
// EXPECTED: per the directory's own header — "two transports under one client-chosen
//   connectionKey belong to the same ItxConnectionSession unless separated by a CLEAN final
//   close or ≥ T of absence… a crash-loop reconnect storm is ONE session and ONE durable fact;
//   a dirty death ends nothing until superseded". Fact sequence for the key: [started].
// ACTUAL: [started, ended, started] — the severed transport (no capnweb goodbye, the client
//   could reconnect any second) immediately ends the session, and the reconnect seconds later
//   mints a brand-new one.
// WHY IT MATTERS: every network blip now files a durable ended+started pair per client — a
//   crash-loop storm floods the durable log with exactly the facts the session rule exists to
//   coalesce, and who-was-connected-Tuesday history splits one logical session into many.
test.fails("dirty transport death + reconnect within seconds shares ONE ItxConnectionSession (the storm rule)", async () => {
  const ctx = c("dirty");
  const observer = await harness.itx(ctx);
  const { session: sA, ws: wsA } = rawSession(ctx);
  await sA.connect({
    connectionKey: "phoenix",
    description: "t1",
    capabilities: new Tools("phx1"),
  });
  const first = await until("'phoenix' listed", async () =>
    (await listConnections(observer)).find((r) => r.connectionKey === "phoenix"),
  );
  // Settle rig: a by-id mount whose auto-revoke proves the close was FULLY processed
  // (#connectionClosed appends facts before onFinalClose).
  await observer.provide({
    path: "itx.phoenixById",
    target: `itx.connections.get('${first.connectionId}')`,
  });

  // DIRTY death: sever the client's underlying WebSocket. No session dispose, no capnweb
  // goodbye — from the platform's view this client may reconnect any second.
  wsA.close();
  await until(
    "'phoenix' left the currently-connected list",
    async () => !(await listConnections(observer)).some((r) => r.connectionKey === "phoenix"),
  );
  await until("dead transport's close fully processed (by-id mount auto-revoked)", async () => {
    try {
      await observer.invokeCapability({ path: ["phoenixById", "hello"], args: [] });
      return undefined;
    } catch (e) {
      return codeOf(e) === "NO_CAPABILITY_MATCH";
    }
  });

  // Reconnect within seconds — the session rule: two transports under one key belong to the
  // SAME session unless separated by a CLEAN final close or ≥15min of absence.
  const s2 = harness.session(ctx);
  await s2.connect({
    connectionKey: "phoenix",
    description: "t2",
    capabilities: new Tools("phx2"),
  });
  await until("'phoenix' re-listed", async () =>
    (await listConnections(observer)).some((r) => r.connectionKey === "phoenix"),
  );
  const seq = sessionFactsFor(await connectionFacts(observer), "phoenix").map((f) => f.type);
  expect(seq).toEqual([STARTED]); // one session, one durable fact — a crash-loop storm files ONE
});

test("disposing a client session removes its connections promptly and auto-revokes its live-cap mounts", async () => {
  const ctx = c("dispose");
  const observer = await harness.itx(ctx);
  const sA = harness.session(ctx);
  const itxA = await sA.connect({ connectionKey: "prov", capabilities: new Tools("prov") });
  await itxA.provideCapability({
    type: "live",
    path: ["ghosttool"],
    capability: new Tools("ghost"),
  });
  expect(await observer.invokeCapability({ path: ["ghosttool", "hello"], args: [] })).toBe(
    "hello-from-ghost",
  );
  const parked = await until("the parked anonymous connection listed", async () =>
    (await listConnections(observer)).find((r) => r.connectionKey === undefined),
  );

  (sA as any)[Symbol.dispose]?.(); // the client session ends — every relay must die with it

  await until(
    "both of the session's connections left the list",
    async () => (await listConnections(observer)).length === 0,
  );
  await until("live-cap mount auto-revoked (default-deny restored)", async () => {
    try {
      await observer.invokeCapability({ path: ["ghosttool", "hello"], args: [] });
      return undefined;
    } catch (e) {
      return codeOf(e) === "NO_CAPABILITY_MATCH";
    }
  });
  // The stale connectionId is now simply offline — coded, not a hang.
  const err = await rejectionOf(
    observer.invoke(`itx.connections.get('${parked.connectionId}').hello()`),
    10_000,
    "invoke on the disposed session's parked connection",
  );
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
});

// BUG: an in-flight invoke on a connection that dies mid-call rejects with the PROVIDER's raw
//   transport error, uncoded — not the CONNECTION_OFFLINE the offline paths throw.
//   hibernatable-rpc-stub.ts codes only the pre-call paths (no pager socket; #forget rejecting
//   a PENDING page); a call already inside `retained.invoker.invoke(...)` propagates whatever
//   the relay's dying capnweb session threw.
// EXPECTED: rejection with errorCode(e) === "CONNECTION_OFFLINE" (the connection is gone —
//   same condition, same code, whether it died before or during the call).
// ACTUAL: prompt rejection (~100ms, no hang) with `Error: "Peer closed WebSocket: 1005 "`,
//   own props [remote], code undefined — the provider-side WebSocket close leaks verbatim to
//   an unrelated caller.
// WHY IT MATTERS: core/errors.ts is explicit — "never classify by name, instanceof, or message
//   regex across a hop; check the code". A caller that handles CONNECTION_OFFLINE (retry,
//   heal-by-pull, fall back) cannot recognize this rejection as the same condition without the
//   forbidden message-sniffing; it also leaks another client's transport internals.
test.fails("killing the provider session mid-invoke rejects the in-flight call promptly with code CONNECTION_OFFLINE", async () => {
  const ctx = c("midinvoke");
  const observer = await harness.itx(ctx);
  const hangTools = new HangTools();
  const { session: sA, ws: wsA } = rawSession(ctx);
  await sA.connect({ connectionKey: "hanger", capabilities: hangTools });
  await until("'hanger' listed", async () =>
    (await listConnections(observer)).some((r) => r.connectionKey === "hanger"),
  );
  expect(await observer.invoke("itx.connections.get('hanger').hello()")).toBe("hang-tools");

  const inFlight: Promise<unknown> = observer.invoke("itx.connections.get('hanger').hang()");
  inFlight.catch(() => undefined); // settled later via rejectionOf — never an unhandled rejection
  await until("hang() reached the provider", () => hangTools.hangStarted);

  wsA.close(); // the provider dies with the call in flight

  const err = await rejectionOf(inFlight, 20_000, "in-flight invoke on a dying provider");
  // The connection went offline mid-call — the caller must get the CODED offline error
  // (core/errors.ts: classify by code, never by message; codes survive every hop).
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
});

test("connections.each() drops dead members (allSettled) and still answers from the alive one", async () => {
  const ctx = c("each");
  const observer = await harness.itx(ctx);
  const sAlive = harness.session(ctx);
  await sAlive.connect({ connectionKey: "alive", capabilities: new Tools("alive") });
  const { session: sDead, ws: wsDead } = rawSession(ctx);
  await sDead.connect({ connectionKey: "doomed", capabilities: new Tools("doomed") });
  // An anonymous parked subscriber with NO hello() — allSettled must drop it silently too.
  await observer.subscribe({ target: () => undefined });
  await until("both keyed transports listed", async () => {
    const keys = (await listConnections(observer)).map((r) => r.connectionKey);
    return keys.includes("alive") && keys.includes("doomed");
  });
  await until("each('hello') answers from BOTH live members", async () => {
    const fans: unknown[] = await observer.invoke("itx.connections.each('hello')");
    return fans.includes("hello-from-alive") && fans.includes("hello-from-doomed");
  });

  wsDead.close(); // one member dies
  await until(
    "'doomed' left the currently-connected list",
    async () => !(await listConnections(observer)).some((r) => r.connectionKey === "doomed"),
  );
  const fans = await until("each('hello') = exactly the alive answer", async () => {
    const f: unknown[] = await observer.invoke("itx.connections.each('hello')");
    return f.length === 1 && f[0] === "hello-from-alive" ? f : undefined;
  });
  expect(fans).toEqual(["hello-from-alive"]);
});

test("anonymous subscribe callbacks file NO session facts (their durable trace is the mount)", async () => {
  const ctx = c("anon");
  const observer = await harness.itx(ctx);
  const received: unknown[] = [];
  await observer.subscribe({ target: (events: unknown) => void received.push(events) });
  await observer.invokeCapability({
    path: ["stream", "append"],
    args: [{ type: "mark", payload: { n: 1 } }],
  });
  await until("the parked subscriber was actually delivered to", () => received.length > 0);
  const list = await listConnections(observer);
  expect(list.length).toBeGreaterThanOrEqual(1);
  expect(list.every((r) => r.connectionKey === undefined)).toBe(true);
  // The durable log carries no itx-connection facts at all for an anonymous attach: opened/
  // closed are ephemeral, and session facts exist only for keyed connections.
  expect(await connectionFacts(observer)).toEqual([]);
});

// BUG: the same-key replace invariant has a hole the width of the pager-open round trip.
//   attach() scans `#stubs.all()` (records DERIVED from OPEN pager sockets) to drop the
//   predecessor — but a concurrent connect's transport only becomes visible when its relay
//   opens the pager WebSocket, one full round trip AFTER its attach returned. Concurrent
//   attaches therefore never see each other, nothing reconciles afterwards, and ALL of them
//   stay attached under the one key.
// EXPECTED: "Reconnect under the same key replaces the predecessor transport (same logical
//   client)" — at any settled moment exactly ONE live transport carries the key.
// ACTUAL: four concurrent connects under "solo" leave ≥2 (typically all 4) transports in the
//   currently-connected list indefinitely (10s poll deadline, and they persist beyond it —
//   nothing ever reaps a live duplicate).
// WHY IT MATTERS: invoke-by-key (`connections.get('solo')`) picks by socket-scan order among
//   duplicates — which transport answers is arbitrary and sticky; each() double-answers per
//   duplicate; and when one duplicate later closes cleanly it is keyFinal=false (a sibling
//   still carries the key), when the LAST one closes it clean-ends a session other transports
//   thought they shared — the exact storm the attach-time replace was built to prevent.
test.fails("concurrent connects under one connectionKey collapse to ONE live transport", async () => {
  const ctx = c("race");
  const observer = await harness.itx(ctx);
  // Four sessions dial in at once under one key. The directory's own contract: "reconnect under
  // the same key REPLACES the predecessor transport" — at any settled moment ONE transport
  // carries the key (invoke-by-key would otherwise be ambiguous forever).
  const sessions = [1, 2, 3, 4].map(() => harness.session(ctx));
  await Promise.all(
    sessions.map((s, i) => s.connect({ connectionKey: "solo", capabilities: new Tools(`r${i}`) })),
  );
  await until(
    "exactly one 'solo' transport in the currently-connected list",
    async () =>
      (await listConnections(observer)).filter((r) => r.connectionKey === "solo").length === 1,
    10_000,
  );
});

// ── speculative (not runnable from outside the DO, or wall-clock infeasible) ──

test.todo(
  "attach without ever opening the pager leaks the pending record forever — attachItxConnection is only reachable over Workers RPC, so the client-side rig cannot spell it; needs a DO-level harness",
);
test.todo(
  "a connectionKey that equals another connection's numeric connectionId makes find() ambiguous (connectionKey === key || stubKey === key scans in socket order) — needs a deterministic offset rig to force the collision",
);
test.todo(
  "≥15min of absence settles a dirty session with 'endedNoLaterThan' at the NEXT attach — wall-clock infeasible here (ITX_CONNECTION_SESSION_ABSENCE_MS is a const, no injectable clock)",
);
