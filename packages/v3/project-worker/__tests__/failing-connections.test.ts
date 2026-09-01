// __tests__/failing-connections.test.ts — the live-transport table (src/rpc-stub-directory.ts +
// src/core/hibernatable-rpc-stub.ts + src/core/itx-surface.ts). A live capability is
// `itx.provide(path, stub)` — the MOUNT PATH is the stub's identity (no keys) and it is called as
// `itx.<path>.method(...)`. PRESENCE is event-driven: the capability table's rows where `live`
// (read via the capability-table facet snapshot); the transport table holds only in-memory socket
// facts (the DO-only `transportState()` verb — off this capnweb lane). Re-providing the same path
// replaces the transport
// AND supersedes the live row in place (one live row per path); the transport's final close
// auto-revokes the row.
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

/** PRESENCE — the capability table's live rows (event-driven): dotted path strings. */
const livePaths = async (itx: any): Promise<string[]> => {
  const snap: any = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  return (snap.state.mounts as any[])
    .filter((m) => m.live)
    .map((m) => (m.path as string[]).join("."));
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
  // other unmounted capability — default-deny. CONNECTION_OFFLINE narrows to "live row exists,
  // transport gone" (pinned by the mid-invoke test below).
  const itx = await harness.itx(c("offline"));
  const err = await rejectionOf(
    itx.invokeCapability("itx.neverExisted.hello()"),
    10_000,
    "invoke on a never-provided path",
  );
  // The code must survive the DO → edge → capnweb hops (core/errors.ts contract).
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
});

test("stub pager upgrade with an unknown transportId is refused with 409 (attach first)", async () => {
  // Two-phase attach: the pager door must 409 an id it never minted, so a relay that outlived
  // a DO restart re-attaches instead of silently pairing a socket to nothing.
  // Any worker route that forwards to the DO's fetch reaches the pager door, which is checked first;
  // /cap forwards, and the pager header short-circuits before the cap/egress lanes.
  const res = await fetch(`http://${harness.url.host}/cap?ctx=${c("pager409")}`, {
    headers: { "x-itx-stub-pager": "424242" },
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("attach first");
});

test("same-path re-provide replaces the incumbent while online; the path keeps resolving and follows the survivor", async () => {
  const ctx = c("replace");
  const observer = await harness.itx(ctx);
  // First live provider at path itx.dupTool.
  const s1 = harness.session(ctx);
  await s1.get().provide("itx.dupTool", new Tools("one"));
  await until("first itx.dupTool live row present", async () =>
    (await livePaths(observer)).includes("itx.dupTool"),
  );
  expect(await observer.invokeCapability(["itx", "dupTool", ["hello"]])).toBe("hello-from-one");

  // Second LIVE session, same path → the newest transport wins (the concurrent-replace path in
  // rpc-stub-directory.fetch drops the predecessor with reason "replaced", pathFinal=false, so the
  // live row is never auto-revoked) AND the reduce supersedes the row in place — exactly ONE live
  // row at the path, at every point in the swap.
  const s2 = harness.session(ctx);
  await s2.get().provide("itx.dupTool", new Tools("two"));
  await until("exactly one live row at itx.dupTool, now serving 'two'", async () => {
    const dups = (await livePaths(observer)).filter((path) => path === "itx.dupTool");
    if (dups.length !== 1) return undefined;
    try {
      return (await observer.invokeCapability(["itx", "dupTool", ["hello"]])) === "hello-from-two"
        ? "ok"
        : undefined;
    } catch {
      return undefined;
    }
  });
  // The row was never auto-revoked by the replace ("replaced" is never path-final).
  expect(await observer.invokeCapability(["itx", "dupTool", ["hello"]])).toBe("hello-from-two");
});

test("disposing a client session removes its stubs promptly and auto-revokes its live rows", async () => {
  const ctx = c("dispose");
  const observer = await harness.itx(ctx);
  const sA = harness.session(ctx);
  const itxA = sA.get();
  // ONE door: the provide parks the stub AND mounts it — the path is the identity.
  await itxA.provide("itx.ghosttool", new Tools("ghost"));
  expect(await observer.invokeCapability(["itx", "ghosttool", ["hello"]])).toBe("hello-from-ghost");
  await until("the live row present", async () =>
    (await livePaths(observer)).includes("itx.ghosttool"),
  );

  (sA as any)[Symbol.dispose]?.(); // the client session ends — every relay must die with it

  // The transport's final close auto-revokes THE live row: presence (the table) empties and the
  // path returns to default-deny — the same fact, read twice.
  await until("the live row auto-revoked", async () => (await livePaths(observer)).length === 0);
  await until("default-deny restored at the path", async () => {
    try {
      await observer.invokeCapability(["itx", "ghosttool", ["hello"]]);
      return undefined;
    } catch (e) {
      return codeOf(e) === "NO_CAPABILITY_MATCH";
    }
  });
});

// An in-flight invoke on a provider that dies mid-call must reject with the CODED offline error —
// the same condition, same code, whether the stub died before or during the call. The relay
// re-codes the provider's raw dying-transport error to CONNECTION_OFFLINE LOCALLY so the CODE (never
// a message) crosses the Workers-RPC hop back to the caller (core/errors.ts: classify by code).
test("killing the provider session mid-invoke rejects the in-flight call promptly with code CONNECTION_OFFLINE", async () => {
  const ctx = c("midinvoke");
  const observer = await harness.itx(ctx);
  const hangTools = new HangTools();
  const { session: sA, ws: wsA } = rawSession(ctx);
  await sA.get().provide("itx.hanger", hangTools);
  await until("itx.hanger live row present", async () =>
    (await livePaths(observer)).includes("itx.hanger"),
  );
  expect(await observer.invokeCapability("itx.hanger.hello()")).toBe("hang-tools");

  const inFlight: Promise<unknown> = observer.invokeCapability("itx.hanger.hang()");
  inFlight.catch(() => undefined); // settled later via rejectionOf — never an unhandled rejection
  await until("hang() reached the provider", () => hangTools.hangStarted);

  wsA.close(); // the provider dies with the call in flight

  // CONNECTION_OFFLINE is the mounted-but-offline code: the row existed when the call went out;
  // the transport died under it. (A NEVER-provided path is NO_CAPABILITY_MATCH — first test.)
  const err = await rejectionOf(inFlight, 20_000, "in-flight invoke on a dying provider");
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
});

// Fan-out is NOT a built-in: the caller reads the live table rows and maps over their paths,
// owning the allSettled. This pins that the snapshot+dotted-call pattern drops dead members AND a
// parked subscriber with no matching method — the exact coverage the old `each` had.
test("fan-out via live table rows + map drops dead members and the no-hello subscriber", async () => {
  const ctx = c("each");
  const observer = await harness.itx(ctx);
  const sAlive = harness.session(ctx);
  await sAlive.get().provide("itx.alive", new Tools("alive"));
  const { session: sDead, ws: wsDead } = rawSession(ctx);
  await sDead.get().provide("itx.doomed", new Tools("doomed"));
  // A parked subscriber (its live row at itx.subscribers.<name>) with NO hello() — the caller's
  // allSettled drops it.
  await observer.subscribe({ target: () => undefined });

  /** fan-out = live rows → map itx.<path>.hello() → allSettled (dead / no-hello members drop). */
  const fanOut = async (): Promise<unknown[]> => {
    const paths = await livePaths(observer);
    const settled = await Promise.allSettled(
      paths.map((path) => observer.invokeCapability(`${path}.hello()`)),
    );
    return settled
      .filter((s): s is PromiseFulfilledResult<unknown> => s.status === "fulfilled")
      .map((s) => s.value);
  };

  await until("both live providers answer the fan-out", async () => {
    const fans = await fanOut();
    return fans.includes("hello-from-alive") && fans.includes("hello-from-doomed");
  });

  wsDead.close(); // one member dies
  await until(
    "itx.doomed auto-revoked out of the table",
    async () => !(await livePaths(observer)).includes("itx.doomed"),
  );
  const fans = await until("fan-out = exactly the alive answer", async () => {
    const f = await fanOut();
    return f.length === 1 && f[0] === "hello-from-alive" ? f : undefined;
  });
  expect(fans).toEqual(["hello-from-alive"]);
});

// Concurrent provides at one path collapse to ONE live transport AND one live row. attach()
// (before a pager opens) can only drop predecessors already visible in #stubs.all(); the
// reconciliation happens when each pager opens (rpc-stub-directory.fetch drops every OTHER
// same-path transport then), so at any settled moment exactly one transport carries the path —
// and the reduce's supersession keeps the table at one row throughout.
test("concurrent provides at one path collapse to ONE live transport and ONE live row", async () => {
  const ctx = c("race");
  const observer = await harness.itx(ctx);
  const sessions = [1, 2, 3, 4].map(() => harness.session(ctx));
  await Promise.all(sessions.map((s, i) => s.get().provide("itx.solo", new Tools(`r${i}`))));
  // The four provides SUPERSEDE in place (one live row per path, by reduce rule) and the winner's
  // transport serves. (The raw one-transport count is a DO-only transportState() fact — this
  // capnweb lane asserts the event-sourced presence + a live invoke through the surviving row.)
  await until(
    "the surviving transport serves itx.solo",
    async () => {
      const out = await observer.invokeCapability("itx.solo.hello()");
      return typeof out === "string" && out.startsWith("hello-from-");
    },
    10_000,
  );
  expect((await livePaths(observer)).filter((p) => p === "itx.solo")).toHaveLength(1);
});

// The attach-without-pager leak is FIXED (lazy 10s sweep) and pinned DO-level, where rpcStubAttach
// is reachable: __workers-tests__/rpc-stub-sweep.test.ts.
