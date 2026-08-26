// failing-wave2-sweep.test.ts — BUG-HUNT WAVE 2, harness lane: the wave-1 DEFECT SHAPES hunted
// in the surfaces wave 1 didn't reach — the built-ins views (prefixed kv, secrets, contexts),
// processor enablement (both doors), and the connected live-state delivery lane — against the
// REAL worker (wrangler createTestHarness → local workerd, real DOs, real KV).
//
// Every test asserts CORRECT behavior. `test.fails` marks behavior VERIFIED BROKEN by running
// this file (each carries BUG/EXPECTED/ACTUAL/WHY IT MATTERS + its SHAPE). Plain `test` cases
// pass and pin behavior that is already correct. `test.todo` names suspected defects this lane
// cannot verify (and the blocker). The Worker Loader is DEAD in this lane (DEFECTS.md defect
// 28) — loader-dependent cases live as unit tests or todos in src/wave2-sweep.failing.test.ts.
// Run: pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-wave2-sweep.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
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

/* eslint-disable @typescript-eslint/no-explicit-any */
const append = (itx: any, ...events: unknown[]) =>
  itx.invokeCapability({ path: ["stream", "append"], args: events });
const kvPut = (itx: any, k: string, v: string) =>
  itx.invokeCapability({ path: ["kv", "put"], args: [k, v] });
const kvGet = (itx: any, k: string) => itx.invokeCapability({ path: ["kv", "get"], args: [k] });

const LIVE_STATE_CHANGED = "events.iterate.com/live-state/changed";

// ═══════════ 1. prefixed-kv isolation — the ":"-joined key composition (S3) ═══════════

test.fails("projects whose ids nest under the ':' delimiter still get DISJOINT kv namespaces", async () => {
  // BUG: built-ins.ts scopes the shared ITX_KV with `${projectId}:` and plain concatenation
  //      (`prefix + k`), and NOTHING rejects ":" in a projectId (the edge accepts any `?ctx=`;
  //      DurableObjectNameCodec.parse takes everything before ".iterate" verbatim). So project
  //      "prj_w2kv" writing key "x:leak" and project "prj_w2kv:x" reading key "leak" address the
  //      SAME physical key "prj_w2kv:x:leak".
  // EXPECTED: "the prefix IS the isolation" (built-ins.ts) — two distinct projectIds can never
  //      observe each other's kv, whatever their spelling.
  // ACTUAL: project "prj_w2kv:x" reads project "prj_w2kv"'s value verbatim (and its writes
  //      overwrite them — the collision is bidirectional).
  // WHY IT MATTERS (SHAPE S3 — unescaped-delimiter composition, the same family as the stateful
  //      cacheKey collision in the unit sweep): kv is a per-project trust boundary backed by ONE
  //      shared namespace; the prefix is the entire wall. The secrets store has the identical
  //      seam (`secret:${projectId}:${name}` — see the next test). Fix shape: reject ":" in
  //      projectIds at the name codec, or escape the prefix seam.
  const a = await harness.itx("prj_w2kv");
  const b = await harness.itx("prj_w2kv:x");
  expect(await kvPut(a, "x:leak", "A-private")).toMatchObject({ ok: true });
  expect(await kvGet(b, "leak")).toBeNull(); // ← reads "A-private" across the project wall
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
      await itx.invokeCapability({ path: ["secrets", "set"], args: ["api:key", "v-unreachable"] });
    })(),
  ).rejects.toThrow(); // ← resolves {ok: true} — the dead write is accepted
});

// ═══════════ 3. connected live-state lane — payload-less change event (S6) ═══════════

// FIXED (defect 44): #deliverToConnectedSubscriptions guards the payload with ?.key.
test("a payload-less live-state/changed event never rejects an append that already committed", async () => {
  // BUG: stream-durable-object.ts #deliverToConnectedSubscriptions (live-state branch) reads
  //      `(e.payload as { key?: string }).key` with no guard. `payload` is OPTIONAL on every
  //      event (core/events.ts eventInputShape), and any client may append the live-state type
  //      bare. The TypeError throws SYNCHRONOUSLY out of the delivery loop — which append()
  //      calls AFTER the log transaction committed — so the RPC rejects while the event stands.
  // EXPECTED: append resolves (the commit happened); a malformed change payload degrades to a
  //      skipped/logged delivery, exactly like the event-mode lane's caught .catch().
  // ACTUAL (verified): append rejects "TypeError: Cannot read properties of undefined (reading
  //      'key')" AFTER the commit point — the stream head has already advanced past the event's
  //      offset (a durable event's row would stand identically). The caller retries (no
  //      idempotency key on an ephemeral) and every retry re-fails the same way while offsets
  //      keep burning; every subscription row AFTER the live-state row in the loop is starved of
  //      that batch's delivery too.
  // WHY IT MATTERS (SHAPE S6, wave-1 defect-8's delivery-lane twin): a commit-then-reject is a
  //      lie in the ONE place clients decide between "safe to retry" and "already happened" —
  //      and userspace can trip it with a single hand-appended bare event.
  const itx = await harness.itx("prj_w2ls");
  const seen: unknown[] = [];
  await itx.subscribe({
    name: "watch",
    liveState: { key: "avatar" },
    target: (payload: unknown) => void seen.push(payload),
  });
  // The lane itself works: a WELL-FORMED change payload for the watched key is delivered.
  await append(itx, {
    type: LIVE_STATE_CHANGED,
    ephemeral: true,
    payload: { key: "avatar", from: 0, to: 1, patch: {} },
  });
  await until("well-formed change delivered", () => seen.length >= 1);
  // The bug: a BARE change event (no payload) must still commit-and-resolve.
  const [bare] = await append(itx, { type: LIVE_STATE_CHANGED, ephemeral: true });
  expect(bare.offset).toBeGreaterThan(0); // ← the await above rejects: TypeError on undefined payload
});

// ═══════════ 4+5. enableProcessor — success receipts for processors that can never run (S1) ═══════════

test("enableProcessor rejects a slug the mount grammar re-segments (a dotted slug)", async () => {
  // BUG: enableProcessor(slug) builds the mount path by string interpolation
  //      (`itx.subscribers.${slug}`) — a dotted slug ("a.b") parses into FOUR segments, so the
  //      committed mount is itx.subscribers.a.b, which #facetEntries (a 3-segment subscriber
  //      mount) never matches. The verb then happily materializes and configures an ORPHAN facet
  //      ("proc:a.b") that no drive, snapshot, or alarm will ever reach, and returns {ok: true}.
  // EXPECTED: a slug that cannot round-trip as ONE path segment is rejected at the door (the
  //      space spelling already is — parseCapabilityPath throws on "itx.subscribers.a b" — the
  //      dot spelling silently re-segments instead: two spellings, two behaviors).
  // ACTUAL: {ok: true}; facetSnapshot("a.b") then rejects NO_FACET; the processor never runs.
  // WHY IT MATTERS (SHAPE S1, with an S5 seam — the slug is embedded in a parsed grammar in one
  //      door and compared as an opaque string in the others): an ok-receipt for a processor
  //      that never observes a single event is the silent version of the exact failure
  //      enableProcessor exists to make loud.
  const itx = await harness.itx("prj_w2dot");
  await expect(
    (async () => {
      await itx.enableProcessor("a.b");
    })(),
  ).rejects.toThrow(); // ← resolves {ok: true}; the orphan facet proc:a.b is configured and dead
});

test("enableProcessor rejects a slug that names NO built-in (and carries no source ref)", async () => {
  // BUG: enableProcessor(slug) with no ref never checks the slug against the built-in facet map
  //      (FACET_PROCESSORS in processor-facet.ts: tally, subscription-forwarder). The mount
  //      commits, the ProcessorFacet materializes and stores its identity, and {ok: true} comes
  //      back — but the facet's first touch throws `no built-in processor "<slug>"` from #p().
  // EXPECTED: the enable verb fails loudly at the door — the set of built-ins is static and
  //      known to the parent's worker (the same map the facet will consult).
  // ACTUAL: {ok: true}; from then on EVERY commit's drive rejects inside the fire-and-forget
  //      chain and is swallowed by reportIssue (SHAPE S2 — the error exists only as a log line),
  //      while snapshot/waitUntilProcessed reject for any caller who checks.
  // WHY IT MATTERS (SHAPE S1 + S2): the receipt says enabled; the log says nothing (to the
  //      caller); the facet burns an error per commit forever — the exact "misbehaving processor
  //      with no remedy" the disableProcessor docstring says this family exists to prevent.
  const itx = await harness.itx("prj_w2ghost");
  await expect(
    (async () => {
      await itx.enableProcessor("no-such-builtin");
    })(),
  ).rejects.toThrow(); // ← resolves {ok: true}; every later commit burns a swallowed facet error
});

// ═══════════ 6. the two enablement doors diverge — mounts are NOT the whole registry (S5) ═══════════

test("a processor enabled by its MOUNT alone (the documented event-sourced door) serves snapshot", async () => {
  // BUG: stream-durable-object.ts documents "enablement IS a mount ... the mounts ARE the
  //      registry" (#facetEntries), and the capability-provided payload schema carries the
  //      processor policy for exactly this door. But only the enableProcessor VERB calls
  //      facet.configure(); a mount provided directly (provideCapability at a facet-target
  //      itx.subscribers.<slug> — an ordinary, documented client verb) creates a registry entry
  //      whose facet was never configured: every drive and every snapshot throws "not configured".
  // EXPECTED: the two doors agree — a facet-target mount at itx.subscribers.tally is sufficient for
  //      the tally facet to run (the parent HAS the full identity: its own name, projectId, path,
  //      the mount's slug and props — it can configure on first materialization).
  // ACTUAL: provide succeeds, the drive errors are swallowed per commit (S2), and
  //      facetSnapshot("tally") rejects "not configured (call configure() first)".
  // WHY IT MATTERS (SHAPE S5 — one rule, two implementations drifting; the same class as the
  //      wave-1 consumes-filter split): the log-replay story ("rebuild is cursor-driven",
  //      "re-enabling rebuilds from the log") quietly depends on the OTHER door having run once
  //      — an event-sourced world that cannot actually be rebuilt from its events.
  const itx = await harness.itx("prj_w2mount");
  await itx.provide({ path: "itx.subscribers.tally", target: "itx.facets.get('tally')" });
  await append(itx, { type: "seed" });
  const snap = await itx.facetSnapshot("tally"); // ← rejects: ProcessorFacet: not configured
  expect(snap.state).toHaveProperty("counts");
});

// ═══════════ 7. kv list — the first KV page presented as the whole truth (S7) ═══════════

test.fails("kv list returns EVERY key, not silently the first 1000", async () => {
  // BUG: built-ins.ts prefixedKv.keys() does ONE `kv().list({ prefix })` and maps `.keys` —
  //      ignoring `list_complete`/`cursor`. Cloudflare KV caps a list page at 1000 keys, so key
  //      1001 onward silently vanishes from every list() answer.
  // EXPECTED: list() answers with all keys under the prefix (paginate on the cursor), or at
  //      minimum surfaces truncation instead of presenting page 1 as everything.
  // ACTUAL: exactly 1000 names come back for 1001 stored keys — no error, no marker.
  // WHY IT MATTERS (SHAPE S7 — a claim wider than what was checked, the read-side twin of
  //      wave-1 defect 9): callers doing sweep/GC/inventory over kv treat the answer as
  //      exhaustive; the 1001st key is invisible AND unaffected by any cleanup based on the
  //      listing, which is how orphans become permanent.
  const itx = await harness.itx("prj_w2list");
  const total = 1001;
  const names = Array.from({ length: total }, (_, i) => `k${String(i).padStart(4, "0")}`);
  for (let i = 0; i < names.length; i += 100) {
    await Promise.all(names.slice(i, i + 100).map((n) => kvPut(itx, n, "1")));
  }
  const listed = await itx.invokeCapability({ path: ["kv", "list"], args: [] });
  expect(listed.keys).toHaveLength(total); // ← 1000
}, 60_000);

// ═══════════ 8. contexts view — path normalization pins ═══════════

test("contexts.get('x') and contexts.get('/x') are the SAME sibling stream", async () => {
  // Pins the one-DO-per-logical-context rule: the codec's normalizePath runs on every sibling
  // resolution, so the slash-less spelling cannot mint a shadow twin of the same context.
  const itx = await harness.itx("prj_w2ctx");
  await itx.invoke("itx.contexts.get('x').append({type:'ping-x'})");
  const page = await itx.invoke("itx.contexts.get('/x').read(0, 50)");
  expect(page.events.map((e: any) => e.type)).toContain("ping-x");
});

test("contexts.get('') resolves to THIS context (self) and answers rather than wedging", async () => {
  // The root's own path is "/" but contexts.get('') normalizes to "/" AFTER the own-path
  // fast-path check (built-ins deps.context: `p === path ? own : getByName(...)`), so the empty
  // spelling reaches SELF through a Workers-RPC self-stub instead of the in-process closure.
  // Pin: the self-call answers (workerd delivers self-RPC re-entrantly) and lands in the SAME
  // log — if this ever deadlocks or splits the log, the fast-path comparison must normalize
  // BEFORE comparing.
  const itx = await harness.itx("prj_w2self");
  const raced = await Promise.race([
    itx.invoke("itx.contexts.get('').append({type:'self-ping'})"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("self-context call wedged >10s (self-RPC deadlock)")),
        10_000,
      ),
    ),
  ]);
  expect((raced as any[])[0].type).toBe("self-ping");
  const page = await itx.invokeCapability({ path: ["stream", "read"], args: [0, 50] });
  expect(page.events.map((e: any) => e.type)).toContain("self-ping");
});

// ═══════════ 9. suspected, unverifiable at harness speed (the 60s alarm cadence) ═══════════

test.todo(
  "S3 — quiesce vs live traffic: alarm()'s resurrection pass restores #lastActivityMs to its " +
    "pre-await value AFTER awaiting every facet snapshot (stream-durable-object.ts alarm), " +
    "erasing any #noteActivity that landed DURING the await — the very next check then either " +
    "aborts every facet despite fresh traffic or re-arms the alarm at a target already in the " +
    "past (armNoLaterThan(lastActivity+60s) with a stale lastActivity → an immediate-fire alarm " +
    "loop). Unverifiable here: needs two real 60s alarm cycles with traffic injected inside the " +
    "resurrection await window.",
);

test.todo(
  "S5 — #facetWorkInFlight counts ONLY append-path drives: the alarm's own forwarder pump " +
    "(void #facet(...).pumpSubscriptionDeliveries()) and every facetInvoke call run OUTSIDE the " +
    "counter, so the quiesce branch can abort `proc:subscription-forwarder` MID-PUMP — exactly " +
    "the 'aborting mid-reduce is the stall' the same function's comment forbids causing. " +
    "Unverifiable here: requires landing the quiesce check inside a pump's delivery window, " +
    "60s+ per attempt and timing-dependent.",
);

test.todo(
  "S1 — disableProcessor's 'DELETE its facet — storage included' depends on ctx.facets.delete " +
    "existing (it falls back to abort(), which KEEPS storage); on runtimes without facets.delete " +
    "a disable→re-enable resumes from the old facet storage instead of a clean rebuild. " +
    "Unverifiable observationally: tally's reduce is deterministic from the log, so stale " +
    "storage and a clean rebuild produce identical snapshots — needs a processor with " +
    "effect-side storage, i.e. a userspace ref, and the loader is dead here (DEFECTS.md 28).",
);
