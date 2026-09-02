// rpc-stubs-mounts-stay-offline-until-revoked.e2e.test.ts — the live-transport table
// (src/context/rpc-stub-directory.ts + hibernatable-rpc-stub.ts + iterate-context.ts). A live
// capability is `itx.provide(path, stub)` — SUGAR over two axioms with two lifetimes: the STUB is
// PARKED in the `itx.rpcStubs` built-in (the physical registry, keyed by the canonical path; it lives
// until its session ends, `rpcStubs.close`, or `itx.revoke(path)` / `unsubscribe` from the session
// that parked it), and an ORDINARY mount event `path ⇒ itx.rpcStubs.get('<path>')` names it (pure
// data; it lives until an explicit revoke). PRESENCE is physical: `itx.rpcStubs.list()` — the keys
// with an open transport RIGHT NOW. The mount never claims liveness and NOTHING auto-revokes it: a
// dead provider leaves its mount answering CONNECTION_OFFLINE until someone revokes it or the
// provider re-parks under the same key. Re-providing the same path replaces the transport (the old
// pager closes "replaced") and appends NOTHING. A live SUBSCRIBER is the same shape one layer up —
// a stub under `itx.subscriptions.<name>` plus a row of the SUBSCRIPTIONS table, never a mount.

import { expect, test } from "vitest";
import {
  capUrl,
  codeOf,
  freshCtx,
  openItx,
  presence,
  rawSession,
  readAll,
  rejection,
  rpcStubMountPaths,
  session,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";
import { HangTools, Tools } from "./support/targets.ts";

/** How many `capability-provided` events the durable log holds at `path` — the "reconnect is
 *  ZERO events" instrument (the mount is data; re-parking the stub writes nothing). */
const providedEventsAt = async (itx: any, path: string): Promise<number> =>
  (await readAll(itx)).filter(
    (e) =>
      e.type === "events.iterate.com/capability-table/capability-provided" &&
      e.payload?.path === path,
  ).length;

test("calling a path that was never provided rejects with code NO_CAPABILITY_MATCH (default-deny)", async () => {
  // A never-provided path is indistinguishable from any other unmounted capability — default-deny.
  // CONNECTION_OFFLINE narrows to "mount exists, transport gone" (the dispose + mid-invoke tests).
  const itx = openItx(freshCtx("offline"));
  const err = await rejection(
    itx.invokeCapability("itx.neverExisted.hello()"),
    "invoke on a never-provided path",
  );
  // The code must survive the DO → edge → capnweb hops (lib/errors.ts contract).
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
});

test("stub pager upgrade with an unknown transportId is refused with 409 (attach first)", async () => {
  // Two-phase attach: the pager door must 409 an id it never minted, so a relay that outlived a DO
  // restart re-attaches instead of silently pairing a socket to nothing. /cap forwards to the DO's
  // fetch, whose door walk checks the pager header FIRST — the `cap` the route insists on is never
  // consulted.
  const res = await fetch(capUrl(freshCtx("pager409"), "itx.whoami", "http"), {
    headers: { "x-itx-stub-pager": "424242" },
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("attach first");
});

test("same-path re-provide replaces the transport while online and appends NOTHING — the path follows the survivor", async () => {
  const ctx = freshCtx("replace");
  const observer = openItx(ctx);
  // First live provider at path itx.dupTool.
  await openItx(ctx).provide("itx.dupTool", new Tools("one"));
  await until("first itx.dupTool transport present", async () =>
    (await presence(observer)).includes("itx.dupTool"),
  );
  expect(await observer.invokeCapability(["itx", "dupTool", ["hello"]])).toBe("hello-from-one");
  const providedBefore = await providedEventsAt(observer, "itx.dupTool");
  expect(providedBefore).toBe(1);

  // Second LIVE session, same path → the newest transport wins (when its pager opens,
  // rpc-stub-directory.fetch drops every OTHER same-path transport with reason "replaced"), and
  // the provide door, finding an IDENTICAL winner already at the path (same target
  // `itx.rpcStubs.get('itx.dupTool')`), answers with that mount's identity and appends nothing.
  await openItx(ctx).provide("itx.dupTool", new Tools("two"));
  await until("itx.dupTool serves 'two' over exactly one transport", async () => {
    if ((await presence(observer)).filter((k) => k === "itx.dupTool").length !== 1)
      return undefined;
    return (await observer.invokeCapability(["itx", "dupTool", ["hello"]])) === "hello-from-two"
      ? "ok"
      : undefined;
  });
  // RECONNECT IS ZERO EVENTS: the log did not grow, the table still holds ONE mount at the path,
  // and the registry lists the key once — the path simply follows the survivor.
  expect(await providedEventsAt(observer, "itx.dupTool")).toBe(providedBefore);
  expect((await rpcStubMountPaths(observer)).filter((p) => p === "itx.dupTool")).toHaveLength(1);
  expect((await presence(observer)).filter((k) => k === "itx.dupTool")).toHaveLength(1);
  expect(await observer.invokeCapability(["itx", "dupTool", ["hello"]])).toBe("hello-from-two");
});

test("disposing a client session drops its stubs promptly (presence) — its mounts STAY and answer CONNECTION_OFFLINE until revoked", async () => {
  const ctx = freshCtx("dispose");
  const observer = openItx(ctx);
  const sA = session();
  // ONE door: the provide parks the stub under the path AND mounts `itx.rpcStubs.get('itx.ghosttool')`.
  await sA.authenticate().projects.get(ctx).provide("itx.ghosttool", new Tools("ghost"));
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
  expect(await rpcStubMountPaths(observer)).toContain("itx.ghosttool");
  for (const attempt of [1, 2]) {
    const err = await rejection(
      observer.invokeCapability(["itx", "ghosttool", ["hello"]]),
      `call #${attempt} on the orphaned mount`,
    );
    expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
  }
  // The one exit is an EXPLICIT revoke — from ANY session (the observer never parked the stub, so
  // its `rpcStubs.close` half is a local no-op; the mount pops) — after which the path is
  // default-deny again.
  await observer.revoke("itx.ghosttool");
  expect(await rpcStubMountPaths(observer)).not.toContain("itx.ghosttool");
  const err = await rejection(
    observer.invokeCapability(["itx", "ghosttool", ["hello"]]),
    "call after the explicit revoke",
  );
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
});

// An in-flight invoke on a provider that dies mid-call must reject with the CODED offline error —
// the same condition, same code, whether the stub died before or during the call. The relay
// re-codes the provider's raw dying-transport error to CONNECTION_OFFLINE LOCALLY so the CODE (never
// a message) crosses the Workers-RPC hop back to the caller (lib/errors.ts: classify by code).
test("killing the provider session mid-invoke rejects the in-flight call promptly with code CONNECTION_OFFLINE — and the mount stays offline", async () => {
  const ctx = freshCtx("midinvoke");
  const observer = openItx(ctx);
  const hangTools = new HangTools();
  const { session: sA, ws: wsA } = rawSession();
  await sA.authenticate().projects.get(ctx).provide("itx.hanger", hangTools);
  await until("itx.hanger transport present", async () =>
    (await presence(observer)).includes("itx.hanger"),
  );
  expect(await observer.invokeCapability("itx.hanger.hello()")).toBe("hang-tools");

  const inFlight: Promise<unknown> = observer.invokeCapability("itx.hanger.hang()");
  inFlight.catch(() => undefined); // settled later via rejection() — never an unhandled rejection
  await until("hang() reached the provider", () => hangTools.hangStarted);

  wsA.close(); // the provider dies with the call in flight

  // CONNECTION_OFFLINE is the mounted-but-offline code: the mount existed when the call went out;
  // the transport died under it. (A NEVER-provided path is NO_CAPABILITY_MATCH — first test.)
  const err = await rejection(inFlight, "in-flight invoke on a dying provider", 20_000);
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
  // ...and it STAYS offline: the transport left presence, the mount is still in the table
  // (nothing auto-revokes it), and a fresh call answers the same code.
  await until(
    "the dead transport left presence",
    async () => !(await presence(observer)).includes("itx.hanger"),
  );
  expect(await rpcStubMountPaths(observer)).toContain("itx.hanger");
  const again = await rejection(
    observer.invokeCapability("itx.hanger.hello()"),
    "a fresh call on the orphaned mount",
  );
  expect(codeOf(again)).toBe("CONNECTION_OFFLINE");
});

// Fan-out is NOT a built-in: the caller reads the table's live mounts and maps over their paths,
// owning the allSettled. A dead member is NOT removed from the table for the caller (nothing
// auto-revokes a mount): it stays listed and its call REJECTS with CONNECTION_OFFLINE, which the
// allSettled drops. (Fanning out over `itx.rpcStubs.list()` instead would skip it up front —
// presence is the physical set.)
test("fan-out via the table's live mounts + map drops dead members (CONNECTION_OFFLINE); a live subscriber is not a mount and never enters the fan-out", async () => {
  const ctx = freshCtx("each");
  const observer = openItx(ctx);
  await openItx(ctx).provide("itx.alive", new Tools("alive"));
  const { session: sDead, ws: wsDead } = rawSession();
  await sDead.authenticate().projects.get(ctx).provide("itx.doomed", new Tools("doomed"));
  // A parked live SUBSCRIBER: physically present (its stub under itx.subscriptions.<name>) but a
  // row of the SUBSCRIPTIONS table, not a capability mount — the fan-out over live mounts never
  // sees it, so a callback with no hello() cannot pollute the census.
  const sub = await observer.subscribe({ target: () => undefined });
  await until("the subscriber is present", async () =>
    (await presence(observer)).includes(`itx.subscriptions.${sub.name}`),
  );
  expect(await rpcStubMountPaths(observer)).not.toContain(`itx.subscriptions.${sub.name}`);

  /** fan-out = live mounts → map itx.<path>.hello() → allSettled; answers + rejection codes by path. */
  const fanOut = async (): Promise<{
    answers: unknown[];
    dropped: Record<string, string | undefined>;
  }> => {
    const paths = await rpcStubMountPaths(observer);
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
  expect(await rpcStubMountPaths(observer)).toContain("itx.doomed"); // still in the table (data)
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
  const ctx = freshCtx("race");
  const observer = openItx(ctx);
  await Promise.all([1, 2, 3, 4].map((i) => openItx(ctx).provide("itx.solo", new Tools(`r${i}`))));
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
  const snap: any = await observer.invokeCapability("itx.facets.get('core').snapshot()");
  const rows = (snap.state.mounts as any[]).filter((m) => m.path.join(".") === "itx.solo");
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(new Set(rows.map((m) => JSON.stringify(m.target)))).toEqual(
    new Set([JSON.stringify(["itx", "rpcStubs", ["get", "itx.solo"]])]),
  );
});

// (The attach-without-pager leak is pinned DO-level, where rpcStubAttach is reachable:
// __workers-tests__/rpc-stub-sweep.test.ts.)

// ── the same shape one layer up: a live SUBSCRIBER's stub + row ──

test("subscribe → unsubscribe disposes the parked stub AND removes its row — presence and the subscriptions table both return to baseline", async () => {
  const observer = openItx(freshCtx("unsub-leak"));
  expect(await presence(observer)).toEqual([]); // baseline: nothing parked
  expect(await rpcStubMountPaths(observer)).toEqual([]); // and nothing mounted
  expect(await subscriptions(observer)).toEqual([]); // and no rows

  const sub = await observer.subscribe({ target: () => undefined });
  const key = `itx.subscriptions.${sub.name}`;
  await until("the parked subscriber has a transport", async () =>
    (await presence(observer)).includes(key),
  );
  // the ROW landed (awaited configure); a subscription is NOT a capability mount
  expect((await subscriptions(observer)).map((r) => r.name)).toEqual([sub.name]);
  expect(await rpcStubMountPaths(observer)).toEqual([]);

  await observer.unsubscribe(sub.name);

  // unsubscribe = remove the row (awaited — the table is clean on return) + close this session's
  // stub under it (the relay's dispose closes the pager; the DO drops the transport a beat later —
  // poll presence). Two lifetimes, one explicit exit.
  expect(await subscriptions(observer)).toEqual([]);
  expect(await rpcStubMountPaths(observer)).toEqual([]);
  await until(
    "the parked stub gone from presence",
    async () => (await presence(observer)).length === 0,
  );
});

test("storm of provide/mount/revoke/subscribe/unsubscribe/disconnect: presence returns to baseline; only the disconnected sessions' mounts remain (offline) and revoke from anywhere", async () => {
  const ctx = freshCtx("storm");
  const observer = openItx(ctx);
  expect(await presence(observer)).toEqual([]);
  expect(await rpcStubMountPaths(observer)).toEqual([]);

  for (let i = 0; i < 6; i++) {
    // (a) subscribe then unsubscribe — the parked-stub disposal path (row + stub both go).
    const sub = await observer.subscribe({ target: () => undefined });
    await observer.unsubscribe(sub.name);
    // (b) provide a live cap at a path, then revoke the path — ONE door in, one door out
    //     (revoke-by-PATH pops the mount AND closes this session's stub under it).
    await observer.provide(`itx.cap${i}`, new Tools(`s${i}`));
    await observer.revoke(`itx.cap${i}`);
    // (c) a live provide from a fresh session then a clean disconnect (dispose the client
    //     session) — NO revoke: the stub dies with its session, the mount is left behind.
    const s = session();
    await s
      .authenticate()
      .projects.get(ctx)
      .provide(`itx.k${i}`, new Tools(`k${i}`));
    (s as any)[Symbol.dispose]?.();
  }

  // PRESENCE (physical) is back to baseline: every relay the storm parked was disposed — by
  // unsubscribe, by revoke-by-path, or by session end (the pager closes are async; poll).
  await until("presence back to baseline", async () => (await presence(observer)).length === 0);
  // THE TABLE (data) keeps exactly what nobody revoked: the six (c) mounts, each mounted-but-
  // offline — nothing auto-revoked them when their sessions died, and they answer
  // CONNECTION_OFFLINE (not default-deny) for as long as they stand.
  const leftover = [0, 1, 2, 3, 4, 5].map((i) => `itx.k${i}`);
  expect([...(await rpcStubMountPaths(observer))].sort()).toEqual(leftover);
  for (const path of leftover) {
    const err = await rejection(
      observer.invokeCapability(`${path}.hello()`),
      `call on the orphaned ${path}`,
    );
    expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
  }
  // Revoking by path from a session that never parked the stub pops the mount only (its
  // `rpcStubs.close` half is a local no-op) — the explicit exit brings the table to baseline
  // too, and the paths fall back to default-deny.
  for (const path of leftover) await observer.revoke(path);
  expect(await rpcStubMountPaths(observer)).toEqual([]);
  const err = await rejection(
    observer.invokeCapability("itx.k0.hello()"),
    "call after the revoke sweep",
  );
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
});

test("re-provide at one path replaces ONLY that path's transport and leaves a separate live stub (even mid-invoke) untouched", async () => {
  const ctx = freshCtx("reconnect-midinvoke");
  const observer = openItx(ctx);
  const hangTools = new HangTools();
  const itxA = openItx(ctx);
  await itxA.provide("itx.rk", new Tools("rk1"));
  // A SEPARATE live stub at its OWN path from the same session.
  await itxA.provide("itx.slow", hangTools);
  await until("both transports present", async () => {
    const keys = await presence(observer);
    return keys.includes("itx.rk") && keys.includes("itx.slow");
  });

  // Put the separate stub MID-INVOKE (a call that never returns) across the reconnect.
  const hanging: Promise<unknown> = observer.invokeCapability("itx.slow.hang()");
  hanging.catch(() => undefined);
  await until("hang() reached the separate stub", () => hangTools.hangStarted);

  // Re-provide at the SAME path itx.rk → replaces ONLY that path's transport (never itx.slow):
  // the new pager opening drops the old itx.rk transport "replaced"; the identical mount is
  // answered by the idempotent door (nothing appended).
  await openItx(ctx).provide("itx.rk", new Tools("rk2"));
  await until("itx.rk now resolves to the NEW transport", async () => {
    try {
      return (await observer.invokeCapability("itx.rk.hello()")) === "hello-from-rk2";
    } catch {
      return false;
    }
  });
  expect((await presence(observer)).filter((k) => k === "itx.rk")).toHaveLength(1);
  expect((await rpcStubMountPaths(observer)).filter((p) => p === "itx.rk")).toHaveLength(1);

  // The separate itx.slow stub must be UNTOUCHED by the replace: still its own single transport
  // and single mount, still resolvable, and its in-flight call still pending (not collaterally
  // severed).
  expect((await presence(observer)).filter((k) => k === "itx.slow")).toHaveLength(1);
  expect((await rpcStubMountPaths(observer)).filter((p) => p === "itx.slow")).toHaveLength(1);
  expect(await observer.invokeCapability("itx.slow.hello()")).toBe("hang-tools");
  const raced = await Promise.race([
    hanging.then(() => "settled").catch(() => "settled"),
    sleep(1500).then(() => "pending"),
  ]);
  expect(raced).toBe("pending"); // the separate stub survived the reconnect
});

test("churn 20×: no ghost deliveries; presence AND the tables return to baseline after session dispose", async () => {
  const ctx = freshCtx("churn");
  const observer = openItx(ctx); // outlives the churning session
  const s = session();
  const itx = await s.authenticate().projects.get(ctx);
  const baselinePresence = (await presence(observer)).length;
  const baselineMounts = (await rpcStubMountPaths(observer)).length;
  let delivered = 0;

  for (let i = 0; i < 20; i++) {
    await itx.subscribe({
      name: "churn",
      consumes: ["mark"],
      target: (events: unknown[]) => {
        delivered += events.length;
      },
    });
    await itx.unsubscribe("churn");
  }

  // no ghost deliveries: every row is removed, so nothing may reach the callback
  await itx.append({ type: "mark", payload: { n: 1 } });
  await itx.append({ type: "mark", payload: { n: 2 } });
  await sleep(800);
  expect(delivered).toBe(0);
  expect(await subscriptions(observer)).toEqual([]);
  // a subscription never touches the CAPABILITY table (two layers, two tables)
  expect((await rpcStubMountPaths(observer)).length).toBe(baselineMounts);

  // dispose the session: PRESENCE (the physical registry) must return to baseline — every relay
  // the churn parked is gone (each unsubscribe closed its own; the pager closes are async, poll).
  (s as Partial<Disposable>)[Symbol.dispose]?.();
  await until(
    "presence back to baseline",
    async () => (await presence(observer)).length === baselinePresence,
  );
  expect((await rpcStubMountPaths(observer)).length).toBe(baselineMounts); // the dispose revoked NOTHING
  expect(await subscriptions(observer)).toEqual([]);
});
