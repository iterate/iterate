// __tests__/failing-connections-deep.test.ts — BUG HUNT (wave 2): the Phase E reap
// (commit 9c26ed27b — "unsubscribe closes the parked connection"). Every test asserts the
// CORRECT behavior of src/stream-durable-object.ts#revokeCapability's new named-elsewhere reap
// + src/core/itx-surface.ts CapabilityProvision.revoke + src/itx-connection-directory.ts, hunting
// connection-lifecycle EDGES beyond failing-connections.test.ts:
//   • a parked connection named by TWO mounts (reap must NOT close it while one survives),
//   • provideCapability revoked via the handle vs via itx.revoke-by-path (both reap once, no
//     double-drop error),
//   • reconnect-same-key must not collaterally reap a SEPARATE anonymous provision mid-invoke,
//   • a connect/provide/revoke/disconnect STORM returns /state.stubs to baseline (no leak).
// Tests marked `test.fails` are verified-failing (BUG/EXPECTED/ACTUAL/WHY inline).
// Run:
//   pnpm exec vitest run --project harness __tests__/failing-connections-deep.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

// Unique ctx per test AND per run (local DO storage may outlive one vitest invocation).
const RUN = Date.now().toString(36);
const c = (name: string) => `prj_fcd${RUN}_${name}`;

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

// ── helpers (mirrors failing-connections.test.ts) ──

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

/** The machine-readable error channel (core/errors.ts): classify by code, never by message. */
const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e ? String((e as any).code) : undefined;

const listConnections = (itx: any): Promise<any[]> => itx.invoke("itx.connections.list()");
const anonConnections = async (itx: any): Promise<any[]> =>
  (await listConnections(itx)).filter((r) => r.connectionKey === undefined);

/** The DO's read-only /state door (never mints storage): the ItxConnection registry's live
 *  counters ride at the top level — `stubs` (attached pager sockets), `dormant`. */
async function streamState(ctx: string): Promise<any> {
  const res = await fetch(`http://${harness.url.host}/state?ctx=${ctx}`);
  return await res.json();
}
const stubCount = async (ctx: string): Promise<number> => (await streamState(ctx)).stubs;

/** Is a mount at this capability path currently resolvable? (NO_CAPABILITY_MATCH = gone.) */
async function capGone(itx: any, path: string[]): Promise<boolean> {
  try {
    await itx.invokeCapability({ path, args: [] });
    return false;
  } catch (e) {
    // Either the mount was auto-revoked (NO_CAPABILITY_MATCH) or its parked connection went
    // offline (CONNECTION_OFFLINE) — both mean "this capability no longer answers".
    return codeOf(e) === "NO_CAPABILITY_MATCH" || codeOf(e) === "CONNECTION_OFFLINE";
  }
}

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

/** A provider whose method never answers — the mid-invoke rig. */
class HangTools extends RpcTarget {
  hangStarted = false;
  hello() {
    return "hang-tools";
  }
  hang() {
    this.hangStarted = true;
    return new Promise(() => {
      /* never resolves — the test races a bounded pending-check instead */
    });
  }
}

// ── the hunt ──

test("reap named-elsewhere: revoking one of two mounts naming one parked connection keeps it alive AND still delivering", async () => {
  const ctx = c("named-elsewhere");
  const observer = await harness.itx(ctx);
  const received: unknown[] = [];
  // Park an anonymous connection as a SUBSCRIBER (so we can prove liveness by delivery).
  const sub = await observer.subscribe({ target: (events: unknown) => void received.push(events) });
  const parked = await until("parked anonymous subscriber connection listed", async () => {
    const anon = await anonConnections(observer);
    return anon.length === 1 ? anon[0] : undefined;
  });
  // A SECOND mount naming the exact same parked connection by its connectionId — an alias,
  // NOT a subscription (so it delivers nothing; it only holds a naming reference).
  await observer.provide({
    path: "itx.aliascap",
    target: `itx.connections.get('${parked.connectionId}')`,
  });

  // Revoke ONLY the alias by path. revokeCapability's reap must see the subscriber mount still
  // names this connection (named-elsewhere) and therefore MUST NOT close it.
  await observer.revoke({ path: "itx.aliascap" });

  // The connection survives: still connected, still the sole anonymous transport.
  const stillAnon = await anonConnections(observer);
  expect(stillAnon.map((r) => r.connectionId)).toEqual([parked.connectionId]);
  // …and it is genuinely alive — a fresh append is delivered to the surviving subscriber mount.
  const before = received.length;
  await observer.invokeCapability({
    path: ["stream", "append"],
    args: [{ type: "mark", payload: { n: 1 } }],
  });
  await until("surviving subscriber still receives deliveries", () => received.length > before);
});

test("provideCapability + handle.revoke(): the parked connection is reaped exactly once (no double-drop error)", async () => {
  const ctx = c("handle-revoke");
  const observer = await harness.itx(ctx);
  const prov = await observer.provideCapability({
    path: ["h1"],
    capability: new Tools("h1"),
  });
  expect(await observer.invokeCapability({ path: ["h1", "hello"], args: [] })).toBe(
    "hello-from-h1",
  );
  await until(
    "the parked provision connection listed",
    async () => (await anonConnections(observer)).length === 1,
  );

  // handle.revoke() now runs BOTH the revokeCapability reap (drop #1) AND its own explicit
  // dropItxConnection (drop #2). The second drop must be an idempotent no-op — never an error.
  await expect(prov.revoke()).resolves.toBeUndefined();

  await until(
    "the parked provision connection reaped",
    async () => (await anonConnections(observer)).length === 0,
  );
  expect(await capGone(observer, ["h1", "hello"])).toBe(true);
  await until("no stub leaked after handle.revoke()", async () => (await stubCount(ctx)) === 0);
});

test("provideCapability + itx.revoke({path}): revoking by PATH (not the handle) also reaps the parked connection (defect 31)", async () => {
  const ctx = c("path-revoke");
  const observer = await harness.itx(ctx);
  await observer.provideCapability({ path: ["h2"], capability: new Tools("h2") });
  expect(await observer.invokeCapability({ path: ["h2", "hello"], args: [] })).toBe(
    "hello-from-h2",
  );
  await until(
    "the parked provision connection listed",
    async () => (await anonConnections(observer)).length === 1,
  );

  // Revoke by PATH — the generic Itx.revoke door, NOT the CapabilityProvision handle. Before the
  // Phase E fix this leaked the parked pager socket + retained stub for the session's life.
  await observer.revoke({ path: "itx.h2" });

  await until(
    "the parked connection reaped by the path-revoke reap",
    async () => (await anonConnections(observer)).length === 0,
  );
  expect(await capGone(observer, ["h2", "hello"])).toBe(true);
  await until("no stub leaked after itx.revoke({path})", async () => (await stubCount(ctx)) === 0);
});

test("subscribe → unsubscribe returns /state.stubs to zero (the unsubscribe leak, defect 31)", async () => {
  const ctx = c("unsub-leak");
  const observer = await harness.itx(ctx);
  expect(await stubCount(ctx)).toBe(0); // baseline: nothing attached

  const sub = await observer.subscribe({ target: () => undefined });
  await until("the parked subscriber's stub is attached", async () => (await stubCount(ctx)) === 1);

  await observer.unsubscribe({ name: sub.name });

  // The headline fix: unsubscribe (revoke of the subscriber mount) reaps the parked connection.
  await until("the parked subscriber stub reaped on unsubscribe", async () => {
    const s = await streamState(ctx);
    return s.stubs === 0 && s.dormant === true;
  });
  expect((await listConnections(observer)).length).toBe(0);
});

test("storm of connect/provide/revoke/subscribe/unsubscribe/disconnect returns the DO to baseline (no leaked stubs)", async () => {
  const ctx = c("storm");
  const observer = await harness.itx(ctx);
  expect(await stubCount(ctx)).toBe(0);

  for (let i = 0; i < 6; i++) {
    // (a) subscribe then unsubscribe — the parked-connection reap path.
    const sub = await observer.subscribe({ target: () => undefined });
    await observer.unsubscribe({ name: sub.name });
    // (b) provideCapability then revoke via its handle.
    const prov = await observer.provideCapability({
      path: [`cap${i}`],
      capability: new Tools(`s${i}`),
    });
    await prov.revoke();
    // (c) a keyed connect then a clean disconnect (dispose the whole client session).
    const s = harness.session(ctx);
    await s.connect({ connectionKey: `k${i}`, capabilities: new Tools(`k${i}`) });
    (s as any)[Symbol.dispose]?.();
  }

  // Every transport opened by the storm is gone; the registry is back to zero and dormant.
  await until("the storm left NO leaked stubs", async () => {
    const st = await streamState(ctx);
    return st.stubs === 0 && st.dormant === true;
  });
  expect((await listConnections(observer)).length).toBe(0);
});

test("reconnect under the same key leaves a SEPARATE anonymous provision (even mid-invoke) untouched", async () => {
  const ctx = c("reconnect-midinvoke");
  const observer = await harness.itx(ctx);
  const hangTools = new HangTools();
  const sA = harness.session(ctx);
  const itxA = await sA.connect({ connectionKey: "rk", capabilities: new Tools("rk1") });
  // An EXTRA provision from the SAME (old) transport's session → a separate anonymous connection.
  await itxA.provideCapability({ path: ["slow"], capability: hangTools });
  await until("the keyed transport and the extra anon provision are both listed", async () => {
    const list = await listConnections(observer);
    return (
      list.some((r) => r.connectionKey === "rk") && list.some((r) => r.connectionKey === undefined)
    );
  });

  // Put the extra provision MID-INVOKE (a call that never returns) across the reconnect.
  const hanging: Promise<unknown> = observer.invoke("itx.slow.hang()");
  hanging.catch(() => undefined);
  await until("hang() reached the extra provision", () => hangTools.hangStarted);

  // Reconnect under the SAME key → replaces ONLY the keyed transport (never the anon provision).
  const sB = harness.session(ctx);
  await sB.connect({ connectionKey: "rk", capabilities: new Tools("rk2") });
  await until("the key now resolves to the NEW transport", async () => {
    try {
      return (await observer.invoke("itx.connections.get('rk').hello()")) === "hello-from-rk2";
    } catch {
      return false;
    }
  });

  // The separate anonymous provision must be UNTOUCHED by the key replace: still the sole anon
  // transport, still resolvable, and its in-flight call still pending (not collaterally severed).
  const anon = await anonConnections(observer);
  expect(anon.length).toBe(1);
  expect(await observer.invokeCapability({ path: ["slow", "hello"], args: [] })).toBe("hang-tools");
  const raced = await Promise.race([
    hanging.then(() => "settled").catch(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 1500)),
  ]);
  expect(raced).toBe("pending"); // the extra provision survived the reconnect
});

// BUG: revoking a provision through its CapabilityProvision handle unconditionally drops the
//   parked connection — even when another mount still names it. The Phase E reap added a
//   named-elsewhere guard to StreamDurableObject#revokeCapability, but CapabilityProvision.revoke
//   (core/itx-surface.ts) bypasses that guard: after `await revokeCapability(...)` (whose reap
//   CORRECTLY skips because a second mount names the connection), it still calls
//   `dropItxConnection({ connectionId })` UNCONDITIONALLY — which closes the shared pager socket,
//   killing the connection out from under the surviving mount (its onFinalClose then auto-revokes
//   that mount too).
// EXPECTED: the surviving second mount keeps its parked connection alive — `itx.dual2.hello()`
//   still answers "hello-from-dual" after the first provision's handle is revoked (the exact
//   named-elsewhere invariant #revokeCapability now enforces on the path-revoke door).
// ACTUAL: `itx.dual2` no longer answers — its target connection was dropped by the handle's
//   unconditional dropItxConnection, and the auto-revoke on that close removed the mount.
// WHY IT MATTERS: the reap fix established one invariant — "don't close a parked connection any
//   mount still names" — but only on ONE of the two revoke doors. The handle door silently
//   violates it, so which door you revoke through changes whether a co-named capability survives.
test("FIXED (Finding B): revoking a provision via its handle must NOT drop a connection a second mount still names", async () => {
  const ctx = c("handle-bypasses-named-elsewhere");
  const observer = await harness.itx(ctx);
  const prov = await observer.provideCapability({
    path: ["dual"],
    capability: new Tools("dual"),
  });
  const parked = await until("the parked provision connection listed", async () => {
    const anon = await anonConnections(observer);
    return anon.length === 1 ? anon[0] : undefined;
  });
  // A SECOND mount naming the SAME parked connection.
  await observer.provide({
    path: "itx.dual2",
    target: `itx.connections.get('${parked.connectionId}')`,
  });
  expect(await observer.invokeCapability({ path: ["dual", "hello"], args: [] })).toBe(
    "hello-from-dual",
  );
  expect(await observer.invokeCapability({ path: ["dual2", "hello"], args: [] })).toBe(
    "hello-from-dual",
  );

  // Revoke the FIRST provision via its handle. #revokeCapability's reap SKIPS (dual2 still names
  // the connection), and the handle now defers to that reap — it does NOT drop the connection.
  await prov.revoke();

  // The shared connection must STAY (dual2 still names it) and keep answering; dual's own mount
  // is gone. Give the revoke a beat to settle, then assert the connection survived.
  await until("dual's mount revoked", async () => {
    try {
      await observer.invokeCapability({ path: ["dual", "hello"], args: [] });
      return false;
    } catch {
      return true; // NO_CAPABILITY_MATCH — dual's mount is gone
    }
  });
  expect((await anonConnections(observer)).length).toBe(1); // the connection survived
  expect(await observer.invokeCapability({ path: ["dual2", "hello"], args: [] })).toBe(
    "hello-from-dual",
  );
});
