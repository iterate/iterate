// failing-wave2-sweep.test.ts — BUG-HUNT WAVE 2, harness lane: the wave-1 DEFECT SHAPES hunted
// in the surfaces wave 1 didn't reach — the built-ins views (prefixed kv, secrets, contexts),
// processor enablement (both doors), and live-state deltas delivered as EVENTS — against the
// REAL worker (wrangler createTestHarness → local workerd, real DOs, real KV).
//
// Every test asserts CORRECT behavior. `test.fails` marks behavior VERIFIED BROKEN by running
// this file (each carries BUG/EXPECTED/ACTUAL/WHY IT MATTERS + its SHAPE). Plain `test` cases
// pass and pin behavior that is already correct. `test.todo` names suspected defects this lane
// cannot verify (and the blocker). The Worker Loader is DEAD in this lane (DEFECTS.md defect
// 28) — loader-dependent cases live as unit tests or todos in src/wave2-sweep.failing.test.ts.
// Run: pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-wave2-sweep.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { processorNames, subscriptions } from "../e2e/support/client.ts";
import { seedSources } from "../e2e/support/sources.ts";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

async function until<T>(
  label: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 20_000,
  pollMs = 50,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`until(${label}): timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const append = (itx: any, ...events: unknown[]) =>
  itx.invokeCapability(["itx", ["append", ...events]]);
const kvPut = (itx: any, k: string, v: string) =>
  itx.invokeCapability(["itx", "kv", ["put", k, v]]);

// ═══════════ 1. prefixed-kv isolation — the ":"-joined key composition (S3) ═══════════

// FIXED (defect 38): a ":" in a projectId is rejected at DurableObjectNameCodec.parse, so the
// kv/secret isolation wall can never be spelled around.
test("a projectId containing ':' is REJECTED (the kv/secret isolation wall holds)", async () => {
  // BUG (was): built-ins.ts scopes the shared ITX_KV with `${projectId}:` and plain concatenation,
  //      and NOTHING rejected ":" in a projectId — so project "prj_w2kv" writing key "x:leak" and
  //      project "prj_w2kv:x" reading key "leak" addressed the SAME physical key.
  // FIX: DurableObjectNameCodec.parse gates the projectId to [A-Za-z0-9_-] — the ONE place every
  //      DO name is parsed, so the ":"-nested project can never be materialized at all, and the
  //      prefix ("the prefix IS the isolation") stays the whole wall.
  const a = await harness.itx("prj_w2kv");
  expect(await kvPut(a, "x:leak", "A-private")).toMatchObject({ ok: true });
  // "prj_w2kv:x" cannot exist: the DO refuses the invalid name at parse, so the session never
  // materializes (surfaces as a failed connection) — the leak is unspellable. (Wrapped in a native
  // promise — capnweb proxy rejections probe vacuously otherwise.)
  await expect(
    (async () => {
      const b = await harness.itx("prj_w2kv:x");
      await b.invokeCapability(["itx", "kv", ["get", "leak"]]); // never reached
    })(),
  ).rejects.toThrow();
});

// ═══════════ 2. secrets.set — success for a name the ONLY read path can never spell (S1) ═══════════

// FIXED (defect 39): secrets.set validates the name against the egress token charset.
test("secrets.set rejects a name the egress substitution grammar cannot express", async () => {
  // BUG: built-ins.ts secrets.set stores `secret:${projectId}:${name}` for ANY name, but the
  //      store is WRITE-ONLY by design — "values come back out ONLY as {{secret:NAME}}
  //      substitution at the egress terminal" — and that terminal's token grammar is
  //      /\{\{secret:(project|platform):([a-zA-Z0-9._-]+)\}\}/ (@v3/shared/egress). A name
  //      outside [a-zA-Z0-9._-] (a colon, a space, a unicode letter) can NEVER match a token.
  // EXPECTED: set() is loud about an unusable name — accepting it is returning ok for a write
  //      that no code path can ever read.
  // ACTUAL: {ok: true}; the value is stored and permanently unreachable.
  // WHY IT MATTERS (SHAPE S1, plus the S3 twin): beyond the dead write, a colon name is a
  //      cross-project WRITE primitive — project "prj_a" setting name "b:c" writes
  //      "secret:prj_a:b:c", the exact key project "prj_a:b" reads for ITS secret "c" at egress
  //      substitution time. One charset check at set() (mirror the token regex) closes both.
  const itx = await harness.itx("prj_w2sec");
  // (Wrapped in a native promise — `expect(rpcPromise).rejects` probes properties on the capnweb
  // proxy, whose pipelined children reject vacuously and fake a pass.)
  await expect(
    (async () => {
      await itx.invokeCapability(["itx", "secrets", ["set", "api:key", "v-unreachable"]]);
    })(),
  ).rejects.toThrow(); // ← resolves {ok: true} — the dead write is accepted
});

// ═══════════ 3. live-state deltas as EVENTS — payload-less change event (S6) ═══════════

// FIXED (defect 44): live state is not a MODE any more — the DO never reads `payload.key`. A tab
// subscribes `consumes: ["events.iterate.com/live-state/changed"]` and receives every key's deltas
// as EVENTS in the ordinary `(events, range)` batch; the client filters `payload.key` itself.
test("a payload-less live-state/changed event never rejects an append that already committed", async () => {
  // BUG (was): the connected live-state branch read `(e.payload as { key?: string }).key` with no
  //      guard; a bare event threw SYNCHRONOUSLY out of the post-commit delivery loop, so append
  //      REJECTED after the commit point and starved every later row of that batch.
  // EXPECTED: append resolves (the commit happened); a malformed delta is the SUBSCRIBER's to skip.
  // WHY IT MATTERS (SHAPE S6, wave-1 defect-8's delivery-lane twin): a commit-then-reject is a
  //      lie in the ONE place clients decide between "safe to retry" and "already happened" —
  //      and userspace can trip it with a single hand-appended bare event.
  const itx = await harness.itx("prj_w2ls");
  const seen: unknown[] = [];
  await itx.subscribe({
    name: "watch",
    consumes: ["events.iterate.com/live-state/changed"],
    target: (events: { payload?: { key?: string } }[]) => {
      for (const e of events)
        if (e.payload?.key === "avatar") seen.push(JSON.parse(JSON.stringify(e.payload)));
    },
  });
  // The lane itself works: a WELL-FORMED change payload for the watched key is delivered.
  await append(itx, {
    type: "events.iterate.com/live-state/changed",
    ephemeral: true,
    payload: { key: "avatar", from: 0, to: 1, patch: [] },
  });
  await until("well-formed change delivered", () => seen.length >= 1);
  // The bug: a BARE change event (no payload) must still commit-and-resolve.
  const [bare] = await append(itx, {
    type: "events.iterate.com/live-state/changed",
    ephemeral: true,
  });
  expect(bare.offset).toBeGreaterThan(0);
  expect(seen).toHaveLength(1); // the bare event reached the tab as an event and was filtered there
});

// ═══════════ 4+5. enableProcessor — refused at the door, never a dead row (S1) ═══════════

test("enableProcessor rejects a name that is not ONE segment (a dotted name)", async () => {
  // A processor's name is its facet name, its subscription name, its `.get(name)` name — ONE
  // segment ([A-Za-z0-9_-]+). "a.b" is refused at the door (SubscriptionName) instead of being
  // re-segmented by a path grammar into an orphan no delivery would ever reach (WAS-BUG S1/S5:
  // two spellings, two behaviors, an ok-receipt for a processor that never ran).
  const itx = await harness.itx("prj_w2dot");
  await seedSources(itx, ["tally"]);
  await expect(
    (async () => {
      await itx.enableProcessor("a.b", {
        source: "itx.kv.get('src/tally.js')",
        className: "Tally",
      });
    })(),
  ).rejects.toThrow(/one segment/);
  expect(await subscriptions(itx)).toEqual([]); // nothing landed
});

test("enableProcessor REQUIRES a source ref — there are no built-in processors to name", async () => {
  // Every processor is userspace code loaded from a source (`{ source, className }`); a bare
  // `enableProcessor(name)` has nothing to host and rejects (WAS-BUG S1+S2: a built-in map lookup
  // that never happened at the door and burned a swallowed facet error per commit forever).
  const itx = await harness.itx("prj_w2ghost");
  await expect(
    (async () => {
      await itx.enableProcessor("no-such-builtin");
    })(),
  ).rejects.toThrow();
  expect(await subscriptions(itx)).toEqual([]);
});

// ═══════════ 6. the two enablement doors AGREE — the row IS the registry (S5) ═══════════

test("a processor enabled by its RAW EVENT alone (the documented event-sourced door) serves snapshot", async () => {
  // WAS-BUG (S5): enablement had two implementations — the event-sourced mount and a configure()
  //      side channel only the verb ran — so a mount provided directly was half-enabled: listed,
  //      erroring on every commit, snapshot rejecting "not configured". NOW there is ONE door: the
  //      `subscription-configured` event whose target is the facet's `processEventBatch`;
  //      `enableProcessor` is sugar over it and identity rides `ctx.props` at materialization —
  //      rebuild-from-log is true.
  const itx = await harness.itx("prj_w2mount");
  await seedSources(itx, ["tally"]);
  await append(itx, {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "tally",
      target:
        "itx.load(\"itx.kv.get('src/tally.js')\").getDurableObjectClass('Tally').get('tally').processEventBatch",
    },
  });
  const [seed] = await append(itx, { type: "seed" });
  const snap: any = await until("tally materialized and reduced the seed", async () => {
    const s: any = await itx
      .invokeCapability("itx.facets.get('tally').snapshot()")
      .catch(() => undefined); // NO_FACET for the instant before the first push materializes it
    return s && s.offset >= seed.offset && s;
  });
  expect(snap.state.counts).toMatchObject({ seed: 1 });
  expect(await processorNames(itx)).toEqual(["tally"]);
});

// ═══════════ 7. kv list — the first KV page presented as the whole truth (S7) ═══════════

test("kv list returns EVERY key, not silently the first 1000", async () => {
  // FIXED (was S7, a claim wider than what was checked): built-ins.ts prefixedKv.keys() now
  //   paginates on the `cursor` until `list_complete` instead of doing ONE `kv().list({ prefix })`.
  //   Cloudflare KV caps a list page at 1000 keys, so the single-page version presented page 1 as
  //   the whole truth and key 1001+ silently vanished — permanent orphans for any sweep/GC/inventory
  //   caller. Draining every page makes list() exhaustive again.
  const itx = await harness.itx("prj_w2list");
  const total = 1001;
  const names = Array.from({ length: total }, (_, i) => `k${String(i).padStart(4, "0")}`);
  for (let i = 0; i < names.length; i += 100) {
    await Promise.all(names.slice(i, i + 100).map((n) => kvPut(itx, n, "1")));
  }
  const listed = await itx.invokeCapability(["itx", "kv", ["list"]]);
  expect(listed.keys).toHaveLength(total); // ← 1000
}, 60_000);

// ═══════════ 8. contexts view — path normalization pins ═══════════

test("cd('x') and cd('/x') are the SAME sibling stream", async () => {
  // Pins the one-DO-per-logical-context rule: the codec's normalizePath runs on every sibling
  // resolution, so the slash-less spelling cannot mint a shadow twin of the same context.
  const itx = await harness.itx("prj_w2ctx");
  await itx.invokeCapability("itx.cd('x').append({type:'ping-x'})");
  const page = await itx.invokeCapability("itx.cd('/x').read(0, 50)");
  expect(page.events.map((e: any) => e.type)).toContain("ping-x");
});

test("cd('') resolves to THIS context (self) and answers rather than wedging", async () => {
  // The root's own path is "/" but cd('') normalizes to "/" AFTER the own-path
  // fast-path check (built-ins deps.context: `p === path ? own : getByName(...)`), so the empty
  // spelling reaches SELF through a Workers-RPC self-stub instead of the in-process closure.
  // Pin: the self-call answers (workerd delivers self-RPC re-entrantly) and lands in the SAME
  // log — if this ever deadlocks or splits the log, the fast-path comparison must normalize
  // BEFORE comparing.
  const itx = await harness.itx("prj_w2self");
  const raced = await Promise.race([
    itx.invokeCapability("itx.cd('').append({type:'self-ping'})"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("self-context call wedged >10s (self-RPC deadlock)")),
        10_000,
      ),
    ),
  ]);
  expect((raced as any[])[0].type).toBe("self-ping");
  const page = await itx.invokeCapability(["itx", ["read", 0, 50]]);
  expect(page.events.map((e: any) => e.type)).toContain("self-ping");
});

// The former section-9 test.todo block (quiesce/alarm suspicions) is gone: its items were stale
// (the #lastActivityMs capture-restore was already removed) or fixed at the root (alarm() awaits
// the cursor pump before the quiesce check; disableProcessor deletes the facet, storage included).
