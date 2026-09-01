// __tests__/failing-connections.test.ts — the live-transport table (src/context/rpc-stub-directory.ts +
// src/context/hibernatable-rpc-stub.ts + src/iterate-context.ts). A live capability is
// `itx.provide(path, stub)` — SUGAR over two axioms with two lifetimes: the STUB is PARKED in the
// `itx.rpcStubs` built-in (the physical registry, keyed by the canonical path; it lives until its
// session ends, `rpcStubs.close`, or `itx.revoke(path)` from the session that parked it), and an
// ORDINARY mount event `path ⇒ itx.rpcStubs.get('<path>')` names it (pure data; it lives until an
// explicit revoke). It is called as `itx.<path>.method(...)`.
// PRESENCE is physical: `itx.rpcStubs.list()` — the keys with an open transport RIGHT NOW. The
// mount never claims liveness and NOTHING auto-revokes it: a dead provider leaves its mount in
// the table answering CONNECTION_OFFLINE until someone revokes it or the provider re-parks under
// the same key. Re-providing the same path replaces the transport (the old pager closes
// "replaced") and appends NOTHING — the provide door is idempotent for an identical mount.
// (The raw socket census is the DO-only `transportState()` verb — off this capnweb lane.)
// Run:
//   pnpm exec vitest run --project harness __tests__/failing-connections.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

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
function rawSession(): { session: any; ws: WebSocket } {
  const ws = new WebSocket(`ws://${harness.url.host}/api`);
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

/** The machine-readable error channel (lib/errors.ts): classify by code, never by message. */
const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e ? String((e as any).code) : undefined;

/** PRESENCE — the keys with an open transport right now (`itx.rpcStubs.list()`, the physical
 *  registry). Shrinks the moment a provider dies; never consults the capability table. */
const presence = async (itx: any): Promise<string[]> => (await itx.rpcStubs.list()) as string[];

/** THE LIVE MOUNTS — capability-table rows whose target names the registry
 *  (`itx.rpcStubs.get('<key>')`; a parsed Expression in the snapshot). Pure data: this set does
 *  NOT shrink when a provider dies — only on an explicit revoke/unsubscribe. */
const isLiveMount = (m: any): boolean =>
  Array.isArray(m.target) &&
  m.target[0] === "itx" &&
  m.target[1] === "rpcStubs" &&
  Array.isArray(m.target[2]) &&
  m.target[2][0] === "get";
const liveMountPaths = async (itx: any): Promise<string[]> => {
  const snap: any = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  return (snap.state.mounts as any[])
    .filter(isLiveMount)
    .map((m) => (m.path as string[]).join("."));
};

/** How many `capability-provided` events the durable log holds at `path` — the "reconnect is
 *  ZERO events" instrument (the mount is data; re-parking the stub writes nothing). */
const providedEventsAt = async (itx: any, path: string): Promise<number> => {
  const { events } = (await itx.read(0, 500)) as { events: any[] };
  return events.filter(
    (e) =>
      e.type === "events.iterate.com/capability-table/capability-provided" &&
      e.payload?.path === path,
  ).length;
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

test("calling a path that was never provided rejects with code NO_CAPABILITY_MATCH (default-deny)", async () => {
  // ERROR-CONTRACT SHIFT (the unification): a never-provided path is indistinguishable from any
  // other unmounted capability — default-deny. CONNECTION_OFFLINE narrows to "mount exists,
  // transport gone" (pinned by the dispose + mid-invoke tests below).
  const itx = await harness.itx(c("offline"));
  const err = await rejectionOf(
    itx.invokeCapability("itx.neverExisted.hello()"),
    10_000,
    "invoke on a never-provided path",
  );
  // The code must survive the DO → edge → capnweb hops (lib/errors.ts contract).
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
});

test("stub pager upgrade with an unknown transportId is refused with 409 (attach first)", async () => {
  // Two-phase attach: the pager door must 409 an id it never minted, so a relay that outlived
  // a DO restart re-attaches instead of silently pairing a socket to nothing.
  // /cap forwards to the DO's fetch, whose door walk checks the pager header FIRST — so the `cap`
  // the route insists on is never consulted; the pager header short-circuits before the cap lane.
  const res = await fetch(
    `http://${harness.url.host}/cap?context=${c("pager409")}&cap=itx.whoami`,
    { headers: { "x-itx-stub-pager": "424242" } },
  );
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("attach first");
});

test("same-path re-provide replaces the transport while online and appends NOTHING — the path follows the survivor", async () => {
  const ctx = c("replace");
  const observer = await harness.itx(ctx);
  // First live provider at path itx.dupTool.
  const s1 = harness.session();
  await s1.authenticate().projects.get(ctx).provide("itx.dupTool", new Tools("one"));
  await until("first itx.dupTool transport present", async () =>
    (await presence(observer)).includes("itx.dupTool"),
  );
  expect(await observer.invokeCapability(["itx", "dupTool", ["hello"]])).toBe("hello-from-one");
  const providedBefore = await providedEventsAt(observer, "itx.dupTool");
  expect(providedBefore).toBe(1);

  // Second LIVE session, same path → the newest transport wins (when its pager opens,
  // rpc-stub-directory.fetch drops every OTHER same-path transport with reason "replaced"), and
  // the provide door, finding an IDENTICAL winner already at the path (same target
  // `itx.rpcStubs.get('itx.dupTool')`, same policies), answers with that mount's identity and
  // appends nothing. One transport, one row, zero new events — at every point in the swap.
  const s2 = harness.session();
  await s2.authenticate().projects.get(ctx).provide("itx.dupTool", new Tools("two"));
  await until("itx.dupTool serves 'two' over exactly one transport", async () => {
    if ((await presence(observer)).filter((k) => k === "itx.dupTool").length !== 1)
      return undefined;
    try {
      return (await observer.invokeCapability(["itx", "dupTool", ["hello"]])) === "hello-from-two"
        ? "ok"
        : undefined;
    } catch {
      return undefined;
    }
  });
  // RECONNECT IS ZERO EVENTS: the log did not grow, the table still holds ONE mount at the path,
  // and the registry lists the key once — the path simply follows the survivor.
  expect(await providedEventsAt(observer, "itx.dupTool")).toBe(providedBefore);
  expect((await liveMountPaths(observer)).filter((p) => p === "itx.dupTool")).toHaveLength(1);
  expect((await presence(observer)).filter((k) => k === "itx.dupTool")).toHaveLength(1);
  expect(await observer.invokeCapability(["itx", "dupTool", ["hello"]])).toBe("hello-from-two");
});

test("disposing a client session drops its stubs promptly (presence) — its mounts STAY and answer CONNECTION_OFFLINE until revoked", async () => {
  const ctx = c("dispose");
  const observer = await harness.itx(ctx);
  const sA = harness.session();
  const itxA = sA.authenticate().projects.get(ctx);
  // ONE door: the provide parks the stub under the path AND mounts `itx.rpcStubs.get('itx.ghosttool')`.
  await itxA.provide("itx.ghosttool", new Tools("ghost"));
  expect(await observer.invokeCapability(["itx", "ghosttool", ["hello"]])).toBe("hello-from-ghost");
  await until("the transport present", async () =>
    (await presence(observer)).includes("itx.ghosttool"),
  );

  (sA as any)[Symbol.dispose]?.(); // the client session ends — every relay it parked dies with it

  // PRESENCE is physical and shrinks at once: the relay's dispose closes the pager, the DO drops
  // the transport, and the registry stops listing the key.
  await until(
    "the stub gone from presence",
    async () => !(await presence(observer)).includes("itx.ghosttool"),
  );
  // THE MOUNT IS DATA and stays: nothing auto-revokes a row because a socket dropped. Calls at
  // the path answer CONNECTION_OFFLINE (mounted-but-offline), not default-deny — and keep doing so.
  expect(await liveMountPaths(observer)).toContain("itx.ghosttool");
  for (const attempt of [1, 2]) {
    const err = await rejectionOf(
      observer.invokeCapability(["itx", "ghosttool", ["hello"]]),
      10_000,
      `call #${attempt} on the orphaned mount`,
    );
    expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
  }
  // The one exit is an EXPLICIT revoke — from ANY session (the observer never parked the stub, so
  // its `rpcStubs.close` half is a local no-op; the mount pops) — after which the path is
  // default-deny again.
  await observer.revoke("itx.ghosttool");
  expect(await liveMountPaths(observer)).not.toContain("itx.ghosttool");
  const err = await rejectionOf(
    observer.invokeCapability(["itx", "ghosttool", ["hello"]]),
    10_000,
    "call after the explicit revoke",
  );
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
});

// An in-flight invoke on a provider that dies mid-call must reject with the CODED offline error —
// the same condition, same code, whether the stub died before or during the call. The relay
// re-codes the provider's raw dying-transport error to CONNECTION_OFFLINE LOCALLY so the CODE (never
// a message) crosses the Workers-RPC hop back to the caller (lib/errors.ts: classify by code).
test("killing the provider session mid-invoke rejects the in-flight call promptly with code CONNECTION_OFFLINE — and the mount stays offline", async () => {
  const ctx = c("midinvoke");
  const observer = await harness.itx(ctx);
  const hangTools = new HangTools();
  const { session: sA, ws: wsA } = rawSession();
  await sA.authenticate().projects.get(ctx).provide("itx.hanger", hangTools);
  await until("itx.hanger transport present", async () =>
    (await presence(observer)).includes("itx.hanger"),
  );
  expect(await observer.invokeCapability("itx.hanger.hello()")).toBe("hang-tools");

  const inFlight: Promise<unknown> = observer.invokeCapability("itx.hanger.hang()");
  inFlight.catch(() => undefined); // settled later via rejectionOf — never an unhandled rejection
  await until("hang() reached the provider", () => hangTools.hangStarted);

  wsA.close(); // the provider dies with the call in flight

  // CONNECTION_OFFLINE is the mounted-but-offline code: the mount existed when the call went out;
  // the transport died under it. (A NEVER-provided path is NO_CAPABILITY_MATCH — first test.)
  const err = await rejectionOf(inFlight, 20_000, "in-flight invoke on a dying provider");
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
  // ...and it STAYS offline: the transport left presence, the mount is still in the table
  // (nothing auto-revokes it), and a fresh call answers the same code.
  await until(
    "the dead transport left presence",
    async () => !(await presence(observer)).includes("itx.hanger"),
  );
  expect(await liveMountPaths(observer)).toContain("itx.hanger");
  const again = await rejectionOf(
    observer.invokeCapability("itx.hanger.hello()"),
    10_000,
    "a fresh call on the orphaned mount",
  );
  expect(codeOf(again)).toBe("CONNECTION_OFFLINE");
});

// Fan-out is NOT a built-in: the caller reads the table's live mounts and maps over their paths,
// owning the allSettled. This pins that the snapshot+dotted-call pattern drops dead members AND a
// parked subscriber with no matching method — the exact coverage the old `each` had. A dead
// member is NOT removed from the table for the caller (nothing auto-revokes a mount): it stays
// listed and its call REJECTS with CONNECTION_OFFLINE, which the allSettled drops. (Fanning out
// over `itx.rpcStubs.list()` instead would skip it up front — presence is the physical set.)
test("fan-out via the table's live mounts + map drops dead members (CONNECTION_OFFLINE); a live subscriber is not a mount and never enters the fan-out", async () => {
  const ctx = c("each");
  const observer = await harness.itx(ctx);
  const sAlive = harness.session();
  await sAlive.authenticate().projects.get(ctx).provide("itx.alive", new Tools("alive"));
  const { session: sDead, ws: wsDead } = rawSession();
  await sDead.authenticate().projects.get(ctx).provide("itx.doomed", new Tools("doomed"));
  // A parked live SUBSCRIBER: physically present (its stub under itx.subscriptions.<name>) but a
  // row of the SUBSCRIPTIONS table, not a capability mount — the fan-out over live mounts never
  // sees it, so a callback with no hello() cannot pollute the census.
  const sub = await observer.subscribe({ target: () => undefined });
  await until("the subscriber is present", async () =>
    (await presence(observer)).includes(`itx.subscriptions.${sub.name}`),
  );
  expect(await liveMountPaths(observer)).not.toContain(`itx.subscriptions.${sub.name}`);

  /** fan-out = live mounts → map itx.<path>.hello() → allSettled; answers + rejection codes by path. */
  const fanOut = async (): Promise<{
    answers: unknown[];
    dropped: Record<string, string | undefined>;
  }> => {
    const paths = await liveMountPaths(observer);
    const settled = await Promise.allSettled(
      paths.map((path) => observer.invokeCapability(`${path}.hello()`)),
    );
    const answers: unknown[] = [];
    const dropped: Record<string, string | undefined> = {};
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") answers.push(s.value);
      else dropped[paths[i]] = codeOf(s.reason);
    });
    return { answers, dropped };
  };

  await until("both live providers answer the fan-out", async () => {
    const { answers } = await fanOut();
    return answers.includes("hello-from-alive") && answers.includes("hello-from-doomed");
  });

  wsDead.close(); // one member dies — its transport goes; its MOUNT stays
  await until(
    "itx.doomed left presence",
    async () => !(await presence(observer)).includes("itx.doomed"),
  );
  expect(await liveMountPaths(observer)).toContain("itx.doomed"); // still in the table (data)
  const { answers, dropped } = await until("fan-out = exactly the alive answer", async () => {
    const f = await fanOut();
    return f.answers.length === 1 && f.answers[0] === "hello-from-alive" ? f : undefined;
  });
  expect(answers).toEqual(["hello-from-alive"]);
  expect(dropped["itx.doomed"]).toBe("CONNECTION_OFFLINE"); // dropped BY the offline rejection
});

// Concurrent provides at one path collapse to ONE live transport. attach() (before a pager opens)
// can only drop predecessors already visible in #stubs.all(); the reconciliation happens when
// each pager opens (rpc-stub-directory.fetch drops every OTHER same-path transport then, reason
// "replaced"), so at any settled moment exactly one transport carries the key. The TABLE is a
// pure shadow stack behind an IDEMPOTENT door: in the common case the later provides find the
// first one's identical winner and append nothing (one row), but two provides racing through the
// door's check before either appends may BOTH land — a harmless shadow of identical rows (same
// target `itx.rpcStubs.get('itx.solo')`), the winner serving. So the pin is: one transport, ≥ 1
// rows all naming the same target, and the path resolving to the survivor.
test("concurrent provides at one path collapse to ONE live transport; the table holds ≥1 identical rows and the survivor serves", async () => {
  const ctx = c("race");
  const observer = await harness.itx(ctx);
  const sessions = [1, 2, 3, 4].map(() => harness.session());
  await Promise.all(
    sessions.map((s, i) =>
      s
        .authenticate()
        .projects.get(ctx)
        .provide("itx.solo", new Tools(`r${i}`)),
    ),
  );
  await until(
    "the surviving transport serves itx.solo",
    async () => {
      const out = await observer.invokeCapability("itx.solo.hello()");
      return typeof out === "string" && out.startsWith("hello-from-");
    },
    10_000,
  );
  // ONE transport: the registry lists the key exactly once.
  expect((await presence(observer)).filter((k) => k === "itx.solo")).toHaveLength(1);
  // ≥ 1 rows at the path, every one of them the SAME pure-data mount.
  const snap: any = await observer.invokeCapability(
    "itx.facets.get('capability-table').snapshot()",
  );
  const rows = (snap.state.mounts as any[]).filter((m) => m.path.join(".") === "itx.solo");
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(new Set(rows.map((m) => JSON.stringify(m.target)))).toEqual(
    new Set([JSON.stringify(["itx", "rpcStubs", ["get", "itx.solo"]])]),
  );
});

// The attach-without-pager leak is FIXED (lazy 10s sweep) and pinned DO-level, where rpcStubAttach
// is reachable: __workers-tests__/rpc-stub-sweep.test.ts.
