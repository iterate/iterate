// __tests__/failing-connections-deep.test.ts — the live-transport table, resource-lifecycle EDGES
// beyond failing-connections.test.ts (src/rpc-stub-directory.ts + src/core/hibernatable-rpc-stub.ts +
// src/core/itx-surface.ts). A live stub's lifetime is coupled to its MOUNT PATH: `itx.revoke(path)`
// (or `unsubscribe`, or session end) tears the row AND the transport; an unexpectedly-dropped
// transport auto-revokes the row (the reverse coupling). So this file hunts:
//   • subscribe → unsubscribe disposes the parked stub (its live row leaves the table),
//   • a provide/revoke/subscribe/unsubscribe/disconnect STORM returns the DO to baseline,
//   • re-provide at one path replaces ONLY that path's transport and leaves a separate live stub
//     (even mid-invoke) untouched.
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

/** PRESENCE — the capability table's live rows (event-driven): dotted path strings. */
const livePaths = async (itx: any): Promise<string[]> => {
  const snap: any = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  return (snap.state.mounts as any[])
    .filter((m) => m.live)
    .map((m) => (m.path as string[]).join("."));
};

/** PRESENCE by count — live table rows (the event-sourced fact a parked stub leaves behind; the
 *  raw transport socket counters are the DO-only `transportState()`, off this capnweb lane and
 *  pinned in __workers-tests__ where the DO stub is in hand). */
const liveRowCount = async (ctx: string): Promise<number> =>
  (await livePaths(await harness.itx(ctx))).length;

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

test("subscribe → unsubscribe disposes the parked stub — its live row leaves the table", async () => {
  const ctx = c("unsub-leak");
  const observer = await harness.itx(ctx);
  expect(await liveRowCount(ctx)).toBe(0); // baseline: nothing parked

  const sub = await observer.subscribe({ target: () => undefined });
  await until(
    "the parked subscriber's live row landed",
    async () => (await liveRowCount(ctx)) === 1,
  );

  await observer.unsubscribe({ name: sub.name });

  // unsubscribe revokes the subscriber row AND tears its transport (path-coupled), so presence
  // (the table) returns to zero — the event-sourced spelling of "nothing left parked".
  await until("the parked subscriber row revoked on unsubscribe", async () => {
    return (await liveRowCount(ctx)) === 0;
  });
});

test("storm of provide/mount/revoke/subscribe/unsubscribe/disconnect returns the DO to baseline (no leaked stubs)", async () => {
  const ctx = c("storm");
  const observer = await harness.itx(ctx);
  expect(await liveRowCount(ctx)).toBe(0);

  for (let i = 0; i < 6; i++) {
    // (a) subscribe then unsubscribe — the parked-stub disposal path.
    const sub = await observer.subscribe({ target: () => undefined });
    await observer.unsubscribe({ name: sub.name });
    // (b) provide a live cap at a path, then revoke the path — ONE door in, one door out
    //     (the revoke tears the row AND its transport).
    await observer.provide(`itx.cap${i}`, new Tools(`s${i}`));
    await observer.revoke(`itx.cap${i}`);
    // (c) a live provide from a fresh session then a clean disconnect (dispose the client session).
    const s = harness.session(ctx);
    await s.get().provide(`itx.k${i}`, new Tools(`k${i}`));
    (s as any)[Symbol.dispose]?.();
  }

  // Every live row the storm mounted is gone — each revoke/unsubscribe/disconnect tore its
  // transport AND popped its row (auto-revoke is an async append; poll).
  await until(
    "presence (the table) back to baseline",
    async () => (await livePaths(observer)).length === 0,
  );
});

test("re-provide at one path replaces ONLY that path and leaves a separate live stub (even mid-invoke) untouched", async () => {
  const ctx = c("reconnect-midinvoke");
  const observer = await harness.itx(ctx);
  const hangTools = new HangTools();
  const sA = harness.session(ctx);
  const itxA = sA.get();
  await itxA.provide("itx.rk", new Tools("rk1"));
  // A SEPARATE live stub at its OWN path from the same session.
  await itxA.provide("itx.slow", hangTools);
  await until("both live rows present", async () => {
    const paths = await livePaths(observer);
    return paths.includes("itx.rk") && paths.includes("itx.slow");
  });

  // Put the separate stub MID-INVOKE (a call that never returns) across the reconnect.
  const hanging: Promise<unknown> = observer.invokeCapability("itx.slow.hang()");
  hanging.catch(() => undefined);
  await until("hang() reached the separate stub", () => hangTools.hangStarted);

  // Re-provide at the SAME path itx.rk → replaces ONLY that path's transport (never itx.slow).
  const sB = harness.session(ctx);
  await sB.get().provide("itx.rk", new Tools("rk2"));
  await until("itx.rk now resolves to the NEW transport", async () => {
    try {
      return (await observer.invokeCapability("itx.rk.hello()")) === "hello-from-rk2";
    } catch {
      return false;
    }
  });

  // The separate itx.slow stub must be UNTOUCHED by the replace: still its own single live row,
  // still resolvable, and its in-flight call still pending (not collaterally severed).
  const paths = await livePaths(observer);
  expect(paths.filter((path) => path === "itx.slow").length).toBe(1);
  expect(await observer.invokeCapability("itx.slow.hello()")).toBe("hang-tools");
  const raced = await Promise.race([
    hanging.then(() => "settled").catch(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 1500)),
  ]);
  expect(raced).toBe("pending"); // the separate stub survived the reconnect
});
