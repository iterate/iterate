// __tests__/failing-connections.test.ts — the live RPC-STUB registry (src/rpc-stub-directory.ts +
// src/core/hibernatable-rpc-stub.ts + src/core/itx-surface.ts). The registry is LIVE-ONLY: presence
// is `itx.rpcStubs.list()`, a stub lives while its transport is open and disappears when it closes.
// There is no durable session history any more (the connection-session facts + the reap-on-
// mount-revoke behaviour were deleted with `session.connect`/`provideCapability`/`itx.connections`).
// A live capability is now `itx.rpcStubs.provide(stub, { key })`, addressed as
// `itx.rpcStubs.get(key)` and named at a path by mounting `itx.rpcStubs.get('<key>')`.
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

/** Presence: the keys currently held by this context (`[{ key, description? }]`). */
const listStubs = (itx: any): Promise<any[]> => itx.invokeCapability("itx.rpcStubs.list()");

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

test("calling a stub key that never existed rejects with code CONNECTION_OFFLINE", async () => {
  const itx = await harness.itx(c("offline"));
  const err = await rejectionOf(
    itx.invokeCapability("itx.rpcStubs.get('never-existed').hello()"),
    10_000,
    "invoke on a never-provided key",
  );
  // The code must survive the DO → edge → capnweb hops (core/errors.ts contract).
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
});

test("stub pager upgrade with an unknown transportId is refused with 409 (attach first)", async () => {
  // Two-phase attach: the pager door must 409 an id it never minted, so a relay that outlived
  // a DO restart re-attaches instead of silently pairing a socket to nothing.
  const res = await fetch(`http://${harness.url.host}/state?ctx=${c("pager409")}`, {
    headers: { "x-itx-stub-pager": "424242" },
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain("attach first");
});

test("same-key re-provide replaces the incumbent while online; a mount naming the key survives and follows the survivor", async () => {
  const ctx = c("replace");
  const observer = await harness.itx(ctx);
  // First live provider under key 'dup'.
  const s1 = harness.session(ctx);
  await s1.get().rpcStubs.provide(new Tools("one"), { key: "dup", description: "first transport" });
  await until("first 'dup' transport listed", async () =>
    (await listStubs(observer)).some((r) => r.key === "dup"),
  );
  // A mount that names the KEY (not a transport) — it must survive a replace and keep resolving.
  await observer.provide({ path: "itx.dupTool", target: "itx.rpcStubs.get('dup')" });
  expect(await observer.invokeCapability(["itx", "dupTool", ["hello"]])).toBe("hello-from-one");

  // Second LIVE session, same key → the newest transport wins (the concurrent-replace path in
  // rpc-stub-directory.fetch drops the predecessor with reason "replaced", keyFinal=false, so no
  // mount naming the key is auto-revoked).
  const s2 = harness.session(ctx);
  await s2
    .get()
    .rpcStubs.provide(new Tools("two"), { key: "dup", description: "second transport" });
  await until("exactly one 'dup' transport, now serving 'two'", async () => {
    const dups = (await listStubs(observer)).filter((r) => r.key === "dup");
    if (dups.length !== 1) return undefined;
    try {
      return (await observer.invokeCapability(["itx", "dupTool", ["hello"]])) === "hello-from-two"
        ? "ok"
        : undefined;
    } catch {
      return undefined;
    }
  });
  // The key mount was never auto-revoked by the replace ("replaced" is never key-final).
  expect(await observer.invokeCapability(["itx", "dupTool", ["hello"]])).toBe("hello-from-two");
});

test("disposing a client session removes its stubs promptly and auto-revokes its live-cap mounts", async () => {
  const ctx = c("dispose");
  const observer = await harness.itx(ctx);
  const sA = harness.session(ctx);
  const itxA = sA.get();
  // Provide a live capability under a key and name it at a path.
  await itxA.rpcStubs.provide(new Tools("ghost"), { key: "ghost" });
  await observer.provide({ path: "itx.ghosttool", target: "itx.rpcStubs.get('ghost')" });
  expect(await observer.invokeCapability(["itx", "ghosttool", ["hello"]])).toBe("hello-from-ghost");
  await until("the provided stub listed", async () =>
    (await listStubs(observer)).some((r) => r.key === "ghost"),
  );

  (sA as any)[Symbol.dispose]?.(); // the client session ends — every relay must die with it

  await until(
    "the session's stub left the registry",
    async () => (await listStubs(observer)).length === 0,
  );
  await until("live-cap mount auto-revoked (default-deny restored)", async () => {
    try {
      await observer.invokeCapability(["itx", "ghosttool", ["hello"]]);
      return undefined;
    } catch (e) {
      return codeOf(e) === "NO_CAPABILITY_MATCH";
    }
  });
  // The stale key is now simply offline — coded, not a hang.
  const err = await rejectionOf(
    observer.invokeCapability("itx.rpcStubs.get('ghost').hello()"),
    10_000,
    "invoke on the disposed session's key",
  );
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
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
  await sA.get().rpcStubs.provide(hangTools, { key: "hanger" });
  await until("'hanger' listed", async () =>
    (await listStubs(observer)).some((r) => r.key === "hanger"),
  );
  expect(await observer.invokeCapability("itx.rpcStubs.get('hanger').hello()")).toBe("hang-tools");

  const inFlight: Promise<unknown> = observer.invokeCapability("itx.rpcStubs.get('hanger').hang()");
  inFlight.catch(() => undefined); // settled later via rejectionOf — never an unhandled rejection
  await until("hang() reached the provider", () => hangTools.hangStarted);

  wsA.close(); // the provider dies with the call in flight

  const err = await rejectionOf(inFlight, 20_000, "in-flight invoke on a dying provider");
  expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
});

// Fan-out is NOT a built-in: the caller lists stubs and maps over them, owning the allSettled. This
// pins that the list()+get(key) pattern drops dead members AND a parked subscriber with no matching
// method — the exact coverage the old `each` had.
test("fan-out via rpcStubs.list() + map drops dead members and the no-hello subscriber", async () => {
  const ctx = c("each");
  const observer = await harness.itx(ctx);
  const sAlive = harness.session(ctx);
  await sAlive.get().rpcStubs.provide(new Tools("alive"), { key: "alive" });
  const { session: sDead, ws: wsDead } = rawSession(ctx);
  await sDead.get().rpcStubs.provide(new Tools("doomed"), { key: "doomed" });
  // A parked subscriber (its own generated key) with NO hello() — the caller's allSettled drops it.
  await observer.subscribe({ target: () => undefined });

  /** fan-out = list() → map get(key).hello() → allSettled (dead / no-hello members drop out). */
  const fanOut = async (): Promise<unknown[]> => {
    const rows = await listStubs(observer);
    const settled = await Promise.allSettled(
      rows.map((r) => observer.invokeCapability(`itx.rpcStubs.get('${r.key}').hello()`)),
    );
    return settled
      .filter((s): s is PromiseFulfilledResult<unknown> => s.status === "fulfilled")
      .map((s) => s.value);
  };

  await until("both keyed providers answer the fan-out", async () => {
    const fans = await fanOut();
    return fans.includes("hello-from-alive") && fans.includes("hello-from-doomed");
  });

  wsDead.close(); // one member dies
  await until(
    "'doomed' left the registry",
    async () => !(await listStubs(observer)).some((r) => r.key === "doomed"),
  );
  const fans = await until("fan-out = exactly the alive answer", async () => {
    const f = await fanOut();
    return f.length === 1 && f[0] === "hello-from-alive" ? f : undefined;
  });
  expect(fans).toEqual(["hello-from-alive"]);
});

// Concurrent provides under one key collapse to ONE live transport. attach() (before a pager opens)
// can only drop predecessors already visible in #stubs.all(); the reconciliation happens when each
// pager opens (rpc-stub-directory.fetch drops every OTHER same-key transport then), so at any settled
// moment exactly one transport carries the key.
test("concurrent provides under one key collapse to ONE live transport", async () => {
  const ctx = c("race");
  const observer = await harness.itx(ctx);
  const sessions = [1, 2, 3, 4].map(() => harness.session(ctx));
  await Promise.all(
    sessions.map((s, i) => s.get().rpcStubs.provide(new Tools(`r${i}`), { key: "solo" })),
  );
  await until(
    "exactly one 'solo' transport in the registry",
    async () => (await listStubs(observer)).filter((r) => r.key === "solo").length === 1,
    10_000,
  );
});

// ── speculative (not runnable from outside the DO, or wall-clock infeasible) ──

test.todo(
  "attach without ever opening the pager leaks the pending record forever — rpcStubAttach is only reachable over Workers RPC, so the client-side rig cannot spell it; needs a DO-level harness",
);
test.todo(
  "a client key that equals another stub's transportId UUID makes find() ambiguous (connectionKey === key || stubKey === key scans in all() order) — needs a deterministic transportId rig to force the collision",
);
