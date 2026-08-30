// __tests__/failing-connections-deep.test.ts — the live RPC-STUB registry, resource-lifecycle EDGES
// beyond failing-connections.test.ts (src/rpc-stub-directory.ts + src/core/hibernatable-rpc-stub.ts +
// src/core/itx-surface.ts). A stub's lifetime is owned by its ProvidedStub handle (or, for a
// subscribe, by `unsubscribe`; or by session end). Revoking a MOUNT never touches the stub; the only
// stub→mount coupling is the REVERSE — an unexpectedly-dropped stub auto-revokes ITS mounts. So this
// file hunts:
//   • subscribe → unsubscribe disposes the parked stub (/state.stubs returns to zero),
//   • a connect/provide/revoke/subscribe/unsubscribe/disconnect STORM returns /state to baseline,
//   • reconnect-same-key replaces ONLY that key and leaves a separate keyed stub (even mid-invoke)
//     untouched.
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

/** Presence: the keys currently held by this context (`[{ key, description? }]`). */
const listStubs = (itx: any): Promise<any[]> => itx.invokeCapability("itx.rpcStubs.list()");

/** The DO's read-only /state door (never mints storage): the rpc-stub registry's live counters
 *  ride at the top level — `stubs` (attached pager sockets), `pagedIn`, `dormant`. */
async function streamState(ctx: string): Promise<any> {
  const res = await fetch(`http://${harness.url.host}/state?ctx=${ctx}`);
  return await res.json();
}
const stubCount = async (ctx: string): Promise<number> => (await streamState(ctx)).stubs;

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

test("subscribe → unsubscribe disposes the parked stub — /state.stubs returns to zero", async () => {
  const ctx = c("unsub-leak");
  const observer = await harness.itx(ctx);
  expect(await stubCount(ctx)).toBe(0); // baseline: nothing attached

  const sub = await observer.subscribe({ target: () => undefined });
  await until("the parked subscriber's stub is attached", async () => (await stubCount(ctx)) === 1);

  await observer.unsubscribe({ name: sub.name });

  // unsubscribe revokes the subscriber mount AND disposes the internally-held ProvidedStub, so the
  // parked stub goes offline and the registry returns to zero (and dormant — nothing paged in).
  await until("the parked subscriber stub disposed on unsubscribe", async () => {
    const s = await streamState(ctx);
    return s.stubs === 0 && s.dormant === true;
  });
  expect((await listStubs(observer)).length).toBe(0);
});

test("storm of provide/mount/revoke/subscribe/unsubscribe/disconnect returns the DO to baseline (no leaked stubs)", async () => {
  const ctx = c("storm");
  const observer = await harness.itx(ctx);
  expect(await stubCount(ctx)).toBe(0);

  for (let i = 0; i < 6; i++) {
    // (a) subscribe then unsubscribe — the parked-stub disposal path.
    const sub = await observer.subscribe({ target: () => undefined });
    await observer.unsubscribe({ name: sub.name });
    // (b) provide a live cap under a key, name it at a path, then revoke the mount AND dispose the
    //     stub via its handle.
    const key = crypto.randomUUID();
    const prov = await observer.rpcStubs.provide(new Tools(`s${i}`), { key });
    await observer.provide({ path: `itx.cap${i}`, target: `itx.rpcStubs.get('${key}')` });
    await observer.revoke({ path: `itx.cap${i}` });
    await prov.revoke();
    // (c) a keyed provide from a fresh session then a clean disconnect (dispose the client session).
    const s = harness.session(ctx);
    await s.get().rpcStubs.provide(new Tools(`k${i}`), { key: `k${i}` });
    (s as any)[Symbol.dispose]?.();
  }

  // Every transport opened by the storm is gone; the registry is back to zero and dormant.
  await until("the storm left NO leaked stubs", async () => {
    const st = await streamState(ctx);
    return st.stubs === 0 && st.dormant === true;
  });
  expect((await listStubs(observer)).length).toBe(0);
});

test("reconnect under the same key replaces ONLY that key and leaves a separate keyed stub (even mid-invoke) untouched", async () => {
  const ctx = c("reconnect-midinvoke");
  const observer = await harness.itx(ctx);
  const hangTools = new HangTools();
  const sA = harness.session(ctx);
  const itxA = sA.get();
  await itxA.rpcStubs.provide(new Tools("rk1"), { key: "rk" });
  // A SEPARATE stub under its OWN key from the same session.
  await itxA.rpcStubs.provide(hangTools, { key: "slow" });
  await until("both the keyed stub and the separate stub are listed", async () => {
    const list = await listStubs(observer);
    return list.some((r) => r.key === "rk") && list.some((r) => r.key === "slow");
  });

  // Put the separate stub MID-INVOKE (a call that never returns) across the reconnect.
  const hanging: Promise<unknown> = observer.invokeCapability("itx.rpcStubs.get('slow').hang()");
  hanging.catch(() => undefined);
  await until("hang() reached the separate stub", () => hangTools.hangStarted);

  // Reconnect under the SAME key 'rk' → replaces ONLY that key's transport (never the 'slow' stub).
  const sB = harness.session(ctx);
  await sB.get().rpcStubs.provide(new Tools("rk2"), { key: "rk" });
  await until("the key 'rk' now resolves to the NEW transport", async () => {
    try {
      return (
        (await observer.invokeCapability("itx.rpcStubs.get('rk').hello()")) === "hello-from-rk2"
      );
    } catch {
      return false;
    }
  });

  // The separate 'slow' stub must be UNTOUCHED by the key replace: still the only other key, still
  // resolvable, and its in-flight call still pending (not collaterally severed).
  const keys = (await listStubs(observer)).map((r) => r.key);
  expect(keys.filter((k) => k === "slow").length).toBe(1);
  expect(await observer.invokeCapability("itx.rpcStubs.get('slow').hello()")).toBe("hang-tools");
  const raced = await Promise.race([
    hanging.then(() => "settled").catch(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 1500)),
  ]);
  expect(raced).toBe("pending"); // the separate stub survived the reconnect
});
