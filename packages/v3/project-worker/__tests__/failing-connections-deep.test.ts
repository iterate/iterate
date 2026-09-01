// __tests__/failing-connections-deep.test.ts — the live-transport table, resource-lifecycle EDGES
// beyond failing-connections.test.ts (src/context/rpc-stub-directory.ts + src/context/hibernatable-rpc-stub.ts +
// src/iterate-context.ts). A live capability is TWO things with two lifetimes: the STUB, parked in
// the `itx.rpcStubs` built-in under the canonical path (physical — it lives until its session ends,
// `rpcStubs.close`, or `itx.revoke(path)` / `unsubscribe` from the session that parked it), and the
// MOUNT, an ordinary capability-table row naming it (`itx.rpcStubs.get('<path>')` — pure data; it
// lives until an explicit revoke/unsubscribe and is NEVER auto-revoked when the stub dies). So
// this file hunts:
//   • subscribe → unsubscribe disposes the parked stub AND removes its row (the explicit exit) —
//     a live subscription is a row of the SUBSCRIPTIONS table, never a capability mount,
//   • a provide/mount/revoke/subscribe/unsubscribe/disconnect STORM returns PRESENCE to baseline
//     and leaves behind exactly the disconnected sessions' mounts (offline; revocable from any
//     session, after which the table is at baseline too),
//   • re-provide at one path replaces ONLY that path's transport and leaves a separate live stub
//     (even mid-invoke) untouched.
// Run:
//   pnpm exec vitest run --project harness __tests__/failing-connections-deep.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { subscriptions } from "../e2e/support/client.ts";
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
 *  registry; the raw socket counters are the DO-only `transportState()`, off this capnweb lane
 *  and pinned in __workers-tests__ where the DO stub is in hand). */
const presence = async (itx: any): Promise<string[]> => (await itx.rpcStubs.list()) as string[];

/** THE LIVE MOUNTS — capability-table rows whose target names the registry
 *  (`itx.rpcStubs.get('<key>')`; a parsed Expression in the snapshot). Pure data: shrinks only
 *  on an explicit revoke/unsubscribe, never when a stub dies. */
const liveMountPaths = async (itx: any): Promise<string[]> => {
  const snap: any = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  return (snap.state.mounts as any[])
    .filter(
      (m) =>
        Array.isArray(m.target) &&
        m.target[0] === "itx" &&
        m.target[1] === "rpcStubs" &&
        Array.isArray(m.target[2]) &&
        m.target[2][0] === "get",
    )
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

test("subscribe → unsubscribe disposes the parked stub AND removes its row — presence and the subscriptions table both return to baseline", async () => {
  const ctx = c("unsub-leak");
  const observer = await harness.itx(ctx);
  expect(await presence(observer)).toEqual([]); // baseline: nothing parked
  expect(await liveMountPaths(observer)).toEqual([]); // and nothing mounted
  expect(await subscriptions(observer)).toEqual([]); // and no rows

  const sub = await observer.subscribe({ target: () => undefined });
  const key = `itx.subscriptions.${sub.name}`;
  await until("the parked subscriber has a transport", async () =>
    (await presence(observer)).includes(key),
  );
  // the ROW landed (awaited configure); a subscription is NOT a capability mount
  expect((await subscriptions(observer)).map((r) => r.name)).toEqual([sub.name]);
  expect(await liveMountPaths(observer)).toEqual([]);

  await observer.unsubscribe(sub.name);

  // unsubscribe = remove the row (awaited — the table is clean on return) + close this session's
  // stub under it (the relay's dispose closes the pager; the DO drops the transport a beat later —
  // poll presence). Two lifetimes, one explicit exit.
  expect(await subscriptions(observer)).toEqual([]);
  expect(await liveMountPaths(observer)).toEqual([]);
  await until(
    "the parked stub gone from presence",
    async () => (await presence(observer)).length === 0,
  );
});

test("storm of provide/mount/revoke/subscribe/unsubscribe/disconnect: presence returns to baseline; only the disconnected sessions' mounts remain (offline) and revoke from anywhere", async () => {
  const ctx = c("storm");
  const observer = await harness.itx(ctx);
  expect(await presence(observer)).toEqual([]);
  expect(await liveMountPaths(observer)).toEqual([]);

  for (let i = 0; i < 6; i++) {
    // (a) subscribe then unsubscribe — the parked-stub disposal path (mount + stub both go).
    const sub = await observer.subscribe({ target: () => undefined });
    await observer.unsubscribe(sub.name);
    // (b) provide a live cap at a path, then revoke the path — ONE door in, one door out
    //     (revoke-by-PATH pops the mount AND closes this session's stub under it).
    await observer.provide(`itx.cap${i}`, new Tools(`s${i}`));
    await observer.revoke(`itx.cap${i}`);
    // (c) a live provide from a fresh session then a clean disconnect (dispose the client
    //     session) — NO revoke: the stub dies with its session, the mount is left behind.
    const s = harness.session();
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
  expect([...(await liveMountPaths(observer))].sort()).toEqual(leftover);
  for (const path of leftover) {
    const err = await rejectionOf(
      observer.invokeCapability(`${path}.hello()`),
      10_000,
      `call on the orphaned ${path}`,
    );
    expect(codeOf(err)).toBe("CONNECTION_OFFLINE");
  }
  // Revoking by path from a session that never parked the stub pops the mount only (its
  // `rpcStubs.close` half is a local no-op) — the explicit exit brings the table to baseline
  // too, and the paths fall back to default-deny.
  for (const path of leftover) await observer.revoke(path);
  expect(await liveMountPaths(observer)).toEqual([]);
  const err = await rejectionOf(
    observer.invokeCapability("itx.k0.hello()"),
    10_000,
    "call after the revoke sweep",
  );
  expect(codeOf(err)).toBe("NO_CAPABILITY_MATCH");
});

test("re-provide at one path replaces ONLY that path's transport and leaves a separate live stub (even mid-invoke) untouched", async () => {
  const ctx = c("reconnect-midinvoke");
  const observer = await harness.itx(ctx);
  const hangTools = new HangTools();
  const sA = harness.session();
  const itxA = sA.authenticate().projects.get(ctx);
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
  const sB = harness.session();
  await sB.authenticate().projects.get(ctx).provide("itx.rk", new Tools("rk2"));
  await until("itx.rk now resolves to the NEW transport", async () => {
    try {
      return (await observer.invokeCapability("itx.rk.hello()")) === "hello-from-rk2";
    } catch {
      return false;
    }
  });
  expect((await presence(observer)).filter((k) => k === "itx.rk")).toHaveLength(1);
  expect((await liveMountPaths(observer)).filter((p) => p === "itx.rk")).toHaveLength(1);

  // The separate itx.slow stub must be UNTOUCHED by the replace: still its own single transport
  // and single mount, still resolvable, and its in-flight call still pending (not collaterally
  // severed).
  expect((await presence(observer)).filter((k) => k === "itx.slow")).toHaveLength(1);
  expect((await liveMountPaths(observer)).filter((p) => p === "itx.slow")).toHaveLength(1);
  expect(await observer.invokeCapability("itx.slow.hello()")).toBe("hang-tools");
  const raced = await Promise.race([
    hanging.then(() => "settled").catch(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 1500)),
  ]);
  expect(raced).toBe("pending"); // the separate stub survived the reconnect
});
