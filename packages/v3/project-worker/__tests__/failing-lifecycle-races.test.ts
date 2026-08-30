// __tests__/failing-lifecycle-races.test.ts — BUG HUNT wave 2: LIFECYCLE RACES.
//   • the capability table's shadow stack under CONCURRENT provide/revoke;
//   • facet-processor enablement lineage (enable × 2 sessions, the enable-vs-configure race,
//     the half-enabled provide door, re-enable-warm, disable mid-drive);
//   • append-during-drive reentrancy (a subscription whose target appends back into the stream);
//   • connection-registry hygiene under subscribe/unsubscribe churn;
//   • the waitUntilProcessed barrier against a future offset.
//
// Every test asserts CORRECT behavior. `test.fails` marks behavior VERIFIED BROKEN by running
// against the real worker (wrangler createTestHarness) — each carries BUG/EXPECTED/ACTUAL/WHY.
// The harness cannot boot the Worker Loader (DEFECTS.md defect 28), so everything here rides
// the BUILT-IN processors (tally, subscription-forwarder); loader cases are test.todo.
// Run: pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-lifecycle-races.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

// ── the shared idioms: until-loops with hard deadlines, a delivery collector, append sugar ──

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
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Range = { scannedAfterOffset: number; scannedThroughOffset: number };
type Invocation = { events: any[]; range: Range };

function collector() {
  const invocations: Invocation[] = [];
  const fn = (events: any[], range: Range) => {
    invocations.push(JSON.parse(JSON.stringify({ events, range })));
  };
  return {
    fn,
    invocations,
    offsets: () => invocations.flatMap((i) => i.events.map((e) => e.offset as number)),
    types: () => invocations.flatMap((i) => i.events.map((e) => e.type as string)),
  };
}

const append = (itx: any, ...events: unknown[]) =>
  itx.invokeCapability({ path: ["stream", "append"], args: events });
const readAll = async (itx: any): Promise<any[]> =>
  (await itx.invokeCapability({ path: ["stream", "read"], args: [0, 500] })).events;
const readHead = async (itx: any): Promise<number> =>
  (await itx.invokeCapability({ path: ["stream", "read"], args: [0, 500] }))
    .scannedThroughOffset as number;
const doState = async (ctx: string): Promise<any> =>
  (await fetch(new URL(`/state?ctx=${ctx}`, harness.url))).json();

/** Expected tally counts = groupBy(type) over the DURABLE log (tally consumes "*", durable only). */
const durableCountsByType = (events: any[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
};

const logsText = () => JSON.stringify(harness.logs());
const countMatches = (text: string, re: RegExp) => (text.match(re) ?? []).length;

const HALTED = "events.iterate.com/stream/subscription-delivery-halted";

// Provisions/handles retained for the whole file so nothing client-side disposes a parked
// callback while a test still needs it.
const keep: unknown[] = [];

// ─────────────────────────── 1. concurrent provide/revoke, one path ───────────────────────────

test("shadow stack: 10 concurrent provides on ONE path end deterministic (newest offset answers), a full concurrent revoke sweep restores default-deny, and the table is not wedged", async () => {
  const itx = await harness.itx("prj_lr_race");
  // ten distinguishable live capabilities to alias at the contested path
  for (let i = 0; i < 10; i++) {
    const key = crypto.randomUUID();
    keep.push(await itx.rpcStubs.provide(() => i, { key }));
    await itx.provide({ path: `itx.probe${i}`, target: `itx.rpcStubs.get('${key}')` });
  }
  const race = () => itx.invokeCapability({ path: ["race"], args: [] });

  // wave 1: five concurrent provides at itx.race
  const wave1: { providedAtOffset: number }[] = await Promise.all(
    Array.from({ length: 5 }, (_, i) => itx.provide({ path: "itx.race", target: `itx.probe${i}` })),
  );
  const offsets1 = wave1.map((r) => r.providedAtOffset);
  expect(new Set(offsets1).size).toBe(5); // every mount got its own identity
  const winner1 = offsets1.indexOf(Math.max(...offsets1));
  expect(await race()).toBe(winner1); // the newest surviving mount answers

  // wave 2: five MORE provides racing five revokes of wave 1 — full interleave in one gather
  const ops: Promise<any>[] = [];
  for (let i = 0; i < 5; i++) {
    ops.push(itx.provide({ path: "itx.race", target: `itx.probe${5 + i}` }));
    ops.push(itx.revoke({ providedAtOffset: offsets1[i] }));
  }
  const results = await Promise.all(ops);
  const offsets2 = results.filter((r) => r && r.providedAtOffset).map((r) => r.providedAtOffset);
  expect(offsets2).toHaveLength(5);
  const winner2 = 5 + offsets2.indexOf(Math.max(...offsets2));
  expect(await race()).toBe(winner2); // wave 1 is fully gone; newest of wave 2 answers

  // the full sweep: revoke everything that remains, concurrently
  await Promise.all(offsets2.map((o) => itx.revoke({ providedAtOffset: o })));
  await expect(race()).rejects.toThrow(/no capability matches/); // default-deny restored

  // and the table is not wedged: a fresh provide works and answers
  const again = await itx.provide({ path: "itx.race", target: "itx.probe7" });
  expect(again.providedAtOffset).toBeGreaterThan(Math.max(...offsets2));
  expect(await race()).toBe(7);
});

// ─────────────────────────── 2. facet-processor enablement lineage ───────────────────────────

test("enableProcessor('tally') from two sessions concurrently: one effective lineage, exact counts, /state lists tally once", async () => {
  const ctx = "prj_lr_dualenable";
  const itxA = await harness.itx(ctx);
  const itxB = await harness.itx(ctx);
  await Promise.all([itxA.enableProcessor("tally"), itxB.enableProcessor("tally")]);

  const state = await doState(ctx);
  expect(state.facetProcessors.filter((s: string) => s === "tally")).toHaveLength(1);

  for (let i = 0; i < 3; i++) await append(itxA, { type: "seen", payload: { i } });
  const head = await readHead(itxA);
  const expected = durableCountsByType(await readAll(itxA));
  expect(expected["events.iterate.com/capability-table/capability-provided"]).toBe(2); // both enables committed a mount
  const snap = await until(
    "tally reduced the whole log exactly once",
    async () => {
      const s: any = await itxA.invoke("itx.facets.get('tally').snapshot()");
      return s.offset >= head && s;
    },
    20_000,
  );
  // no double-configure corruption: bit-exact counts (a doubled drive or a second lineage
  // would overcount; a dropped one would undercount)
  expect(snap.state.counts).toEqual(expected);
  expect(snap.state.counts.seen).toBe(3);
});

test("FIXED (defect 29): every enableProcessor drives the enablement commit into the facet BEFORE configure() lands", async () => {
  // BUG: enableProcessor first awaits provide() — whose append synchronously queues the drive
  //   chain for the just-mounted slug (#facetEntries already lists it: the inline reduce ran
  //   inside the commit) — and only THEN calls configure(). The drive's processEventBatch
  //   reaches the fresh facet first; ProcessorFacet.#p() finds no identity in kv and throws
  //   "ProcessorFacet: not configured (call configure() first)"; the batch is dropped and
  //   reportIssue logs a stream-do.facet-drive issue. Verified: EVERY quiet enable logs it.
  // EXPECTED: enabling a processor on a quiet stream is clean — zero facet errors; the facet's
  //   first delivered batch is its own enablement commit (or the parent simply skips driving
  //   a facet it has not configured yet).
  // ACTUAL: one dropped drive + one logged issue per enable; the facet heals only by gap
  //   repair at the NEXT drive/read — and gap repair is durable-only, so any NAMED EPHEMERAL
  //   events committed in batches racing the configure window are silently lost forever
  //   (undeliverable by repair, by design).
  // WHY IT MATTERS: ops logs carry an error for every routine enable (alert noise that trains
  //   humans to ignore stream-do.facet-drive); and the enable window silently drops ephemerals
  //   a processor was entitled to see — the exact silent-drop class the serialized drive chain
  //   exists to prevent (its own comment says so).
  const ctx = "prj_lr_enablerace";
  const itx = await harness.itx(ctx);
  await settle(400); // let stragglers from earlier tests flush before the baseline
  const before = countMatches(logsText(), /not configured/g);
  await itx.enableProcessor("tally");
  const head = await readHead(itx);
  await until(
    "tally at head",
    async () => ((await itx.invoke("itx.facets.get('tally').snapshot()")) as any).offset >= head,
  );
  await settle(400);
  expect(countMatches(logsText(), /not configured/g) - before).toBe(0);
});

test("FIXED (defect 30): a processor mount through the ordinary provide door is HALF-ENABLED — /state lists it, every commit errors, snapshot throws", async () => {
  // BUG: #facetEntries derives enablement purely from facet-target mounts at itx.subscribers.<slug>
  //   — which ANY provide can mint (verified: Itx.provide passes even the UNDECLARED `processor`
  //   field untouched — there is no boundary schema; a raw appended capability-provided event too).
  //   But a facet only functions after enableProcessor's SECOND, non-event-sourced leg:
  //   configure(), which stashes identity in the facet's own kv. provide alone creates the
  //   entry with no configure — a permanently broken enablement.
  // EXPECTED: the mount IS the enablement (stream-durable-object.ts's own doctrine:
  //   "enablement is event-sourced like every other attachment; the facet-processors kv
  //   registry is dead") — a provided processor mount yields a facet that answers snapshot()
  //   and consumes drives. (Or, if enableProcessor is meant to be the ONLY door, provide must
  //   REJECT processor-path mounts loudly instead of half-accepting them.)
  // ACTUAL: /state facetProcessors lists the slug as if healthy while EVERY commit burns a
  //   facet materialization + a logged stream-do.facet-drive "ProcessorFacet: not configured"
  //   and drops the batch; the facet's snapshot() throws the same. The storm runs until someone calls
  //   disableProcessor — or worse, enableProcessor(slug) "heals" it while leaving the
  //   half-mount shadowed underneath.
  // WHY IT MATTERS: the identity side-channel makes rebuild-from-log a lie — mounts replay,
  //   the configure kv does not (disableProcessor deletes facet storage; any replay/copy of the
  //   mount events onto a fresh stream = permanent per-commit error storm). And the door is
  //   client-reachable today: one provide from any session wedges a slug in loud-error mode.
  const ctx = "prj_lr_halfenable";
  const itx = await harness.itx(ctx);
  await itx.provide({ path: "itx.subscribers.tally", target: "itx.facets.get('tally')" });
  const state = await doState(ctx);
  expect(state.facetProcessors).toContain("tally"); // listed as enabled (this passes — the lie)
  await append(itx, { type: "mark" });
  const snap: any = await itx.invoke("itx.facets.get('tally').snapshot()"); // throws "not configured"
  expect(snap.state.counts.mark).toBe(1);
});

// ─────────────────────────── 3. re-enable while WARM (props lineage) ───────────────────────────

test("re-enable while WARM shadows without corrupting the reduce (no reset, no double-count)", async () => {
  const ctx = "prj_lr_reenable";
  const itx = await harness.itx(ctx);
  await itx.enableProcessor("tally");
  await append(itx, { type: "mark" });
  await append(itx, { type: "mark" });
  const head1 = await readHead(itx);
  const s1: any = await until("tally at head", async () => {
    const s: any = await itx.invoke("itx.facets.get('tally').snapshot()");
    return s.offset >= head1 && s;
  });
  expect(s1.state.counts.mark).toBe(2);

  await itx.enableProcessor("tally"); // shadow the enablement mount while the facet is warm
  await append(itx, { type: "mark" });
  const head2 = await readHead(itx);
  const expected = durableCountsByType(await readAll(itx));
  const s2: any = await until("tally at head after re-enable", async () => {
    const s: any = await itx.invoke("itx.facets.get('tally').snapshot()");
    return s.offset >= head2 && s;
  });
  expect(s2.state.counts).toEqual(expected); // exact — the shadow neither reset nor doubled
  expect(s2.state.counts.mark).toBe(3);
});

test.todo(
  "re-enable with DIFFERENT props while the facet is WARM: the newest mount's props must win for subsequent behavior — UNTESTABLE in this lane: (a) the client surface drops props entirely (Itx.enableProcessor(slug, ref) has no props parameter — src/core/itx-surface.ts — while StreamDurableObject.enableProcessor takes them; the only client spelling that carries props is the half-enabled provide door above), (b) no built-in processor's behavior or any facet door reads props back (tally and subscription-forwarder ignore them; ProcessorFacet exposes no identity read), and (c) a props-echoing USERSPACE processor needs the Worker Loader, dead in this harness (DEFECTS.md defect 28) — the pool lane is the home. CODE-VERIFIED for the ledger meanwhile: ProcessorFacet.configure() puts the new identity to kv but never invalidates the memoized #processor (src/processor-facet.ts #p()), so a WARM facet keeps reducing with the OLD props until the quiesce alarm aborts it — the newest mount's props win only after a restart nobody schedules",
);

// ─────────────────────────── 4. disableProcessor MID-DRIVE ───────────────────────────

test("disable mid-drive: appends survive, no ongoing error storm, re-enable rebuilds an exact reduce", async () => {
  const ctx = "prj_lr_middrive";
  const itx = await harness.itx(ctx);
  await itx.enableProcessor("tally");
  await append(itx, { type: "warm" }); // one drive so the facet exists and is configured
  const headWarm = await readHead(itx);
  await until(
    "tally warm",
    async () =>
      ((await itx.invoke("itx.facets.get('tally').snapshot()")) as any).offset >= headWarm,
  );

  // the burst + the disable, racing (in-flight drive chains vs facet delete)
  const burst = Array.from({ length: 10 }, (_, i) =>
    append(itx, { type: "burst", payload: { i } }),
  );
  const disabled = itx.disableProcessor("tally");
  await Promise.all([...burst, disabled]); // appends must all survive the disable

  const state = await doState(ctx);
  expect(state.facetProcessors).not.toContain("tally");
  await expect(itx.invoke("itx.facets.get('tally').snapshot()")).rejects.toThrow(
    /no facet.*"tally"/,
  );

  // post-disable traffic must not keep erroring into the dead facet: in-flight chains may log
  // a bounded burst at the disable moment, but NOTHING new may appear afterwards
  await settle(500);
  const beforeText = logsText();
  const beforeDrives = countMatches(beforeText, /facet-drive/g);
  const beforeConfigure = countMatches(beforeText, /not configured/g);
  for (let i = 0; i < 10; i++) await append(itx, { type: "post", payload: { i } });
  await settle(700);
  const afterText = logsText();
  expect(countMatches(afterText, /facet-drive/g)).toBe(beforeDrives); // no NEW drive errors
  expect(countMatches(afterText, /not configured/g)).toBe(beforeConfigure);

  // re-enable: a CLEAN reduce — exact counts over the whole durable log, nothing doubled,
  // nothing inherited from the dead lineage's chain or delivered-through watermark. (For a
  // pure reduce like tally, kept-vs-deleted facet storage converges to the same counts — the
  // exactness assertion catches double-drives and missed batches; storage deletion itself
  // needs a props/effect-sensitive USERSPACE processor, i.e. the pool lane.)
  await itx.enableProcessor("tally");
  const head = await readHead(itx);
  const expected = durableCountsByType(await readAll(itx));
  const snap: any = await until("re-enabled tally reduced the whole log", async () => {
    const s: any = await itx.invoke("itx.facets.get('tally').snapshot()");
    return s.offset >= head && s;
  });
  expect(snap.state.counts).toEqual(expected);
  expect(snap.state.counts.burst).toBe(10);
  expect(snap.state.counts.post).toBe(10);
});

test.fails("double-enable (shadow stack) then ONE disableProcessor leaves the older mount ACTIVE — the processor is NOT disabled", async () => {
  // BUG: disableProcessor(slug) → revokeCapability({ path: `itx.subscribers.<slug>` }), which
  //   revokes ONLY the newest mount at that path (revokeCapability sorts desc, takes [0], revokes
  //   one providedAtOffset). But enableProcessor appends a FRESH capability-provided mount every
  //   call — the supported "re-enable while WARM shadows" case tested above — so enabling twice
  //   leaves TWO mounts at itx.subscribers.<slug>. One disable pops the newest; the OLDER survivor
  //   is re-elected by #activeSubscriptionMounts() (newest-of-survivors) → #facetEntries() still
  //   lists the slug. disableProcessor already ran facets.delete('proc:<slug>'), so the next commit
  //   re-materializes the facet with FRESH storage and silently re-reduces the whole log from 0.
  // EXPECTED: one disableProcessor turns the processor OFF no matter how many times it was enabled —
  //   /state stops listing it and its facet address throws NO_FACET (the single-enable path does
  //   exactly this — see the "disable mid-drive" test below).
  // ACTUAL: /state STILL lists the slug; itx.facets.get(slug).snapshot() still ANSWERS; every future
  //   commit re-drives it (an effectful processor re-runs its whole effect history from offset 0 —
  //   double-fire). The only remedy is to call disableProcessor as many times as enableProcessor ran.
  // WHY IT MATTERS: the off-switch disableProcessor was added to provide (a misbehaving processor's
  //   only remedy) silently fails whenever the enablement was ever shadowed; the deleted-then-
  //   resurrected facet re-drives the entire log (double effects) and keeps burning a materialization
  //   per commit — the exact zombie the off-switch exists to kill.
  const ctx = "prj_lr_disshadow";
  const itx = await harness.itx(ctx);
  await itx.enableProcessor("tally");
  await itx.enableProcessor("tally"); // shadow the enablement mount (supported: "re-enable while WARM")
  await append(itx, { type: "mark" });
  const head = await readHead(itx);
  await until(
    "tally at head",
    async () => ((await itx.invoke("itx.facets.get('tally').snapshot()")) as any).offset >= head,
  );

  await itx.disableProcessor("tally"); // ONE disable

  const state = await doState(ctx);
  expect(state.facetProcessors).not.toContain("tally"); // RED: still contains "tally"
  await expect(itx.invoke("itx.facets.get('tally').snapshot()")).rejects.toThrow(
    /no facet.*"tally"/,
  );
});

// ─────────────────────────── 5. append-during-drive reentrancy ───────────────────────────

test("reentrancy characterized: a forwarder delivery targeting itx.stream.append neither deadlocks nor runs away — the delivery call shape is refused and the row halts loudly", async () => {
  // deliverTo PERMITS the spelling (any absent itx expression is a legal target) and the
  // delivery call is append(eventsArray, range) — whose first arg is an ARRAY. append's runtime
  // typeless guard refuses it (an array has no string `type` → "append: every event needs a
  // non-empty type"). The ladder burns maxAttempts and HALTS with that reason on the audit fact.
  // Bounded and loud — no deadlock, no runaway loop, no junk rows on the log. (This runtime guard
  // is now the SOLE gate — capnweb-validate, which used to reject the array shape by TS type, was
  // removed; the guard catches the same case with a different message.)
  const ctx = "prj_lr_reenter";
  const itx = await harness.itx(ctx);
  const ctrl = collector();
  await itx.subscribe({ name: "ctrl", consumes: ["seed"], target: ctrl.fn });
  // the absent-target subscription whose delivery APPENDS BACK into the stream it delivers from
  await itx.subscribe({
    name: "reenter",
    consumes: ["seed"],
    maxAttempts: 2,
    target: "itx.stream.append",
  });
  const [seed] = await append(itx, { type: "seed", payload: { n: 1 } });
  await until("control subscriber saw the seed", () => ctrl.offsets().includes(seed.offset));

  // no deadlock and no runaway: the head must go QUIET (stable for 2s within 15s)
  let head = await readHead(itx);
  await until(
    "head stable for 2s",
    async () => {
      await settle(2_000);
      const now = await readHead(itx);
      const stable = now === head;
      head = now;
      return stable;
    },
    15_000,
    10,
  );

  const events = await readAll(itx);
  expect(events.filter((e) => typeof e.type !== "string")).toHaveLength(0); // no junk committed
  const halts = events.filter((e) => e.type === HALTED && e.payload?.name === "reenter");
  expect(halts).toHaveLength(1); // exactly one loud audit fact
  expect(halts[0].payload.reason).toMatch(/2 delivery attempts failed/);
  expect(halts[0].payload.reason).toMatch(/non-empty type/); // the honest root cause (typeless guard)
  expect(events.length).toBeLessThan(20); // bounded, whatever branch the platform takes
  await settle(500);
  expect(ctrl.offsets().filter((o) => o === seed.offset)).toHaveLength(1); // seed seen exactly once

  // the stream stays serviceable and the forwarder is not wedged for later work
  const [post] = await append(itx, { type: "afterparty" });
  expect(post.offset).toBeGreaterThan(seed.offset);
  const headNow = await readHead(itx);
  await until(
    "forwarder cursor reaches head",
    async () =>
      ((await itx.invoke("itx.facets.get('subscription-forwarder').snapshot()")) as any).offset >=
      headNow,
  );
});

// ─────────────────────────── 6. subscribe/unsubscribe churn ───────────────────────────

test("churn 20×: no ghost deliveries; the connection registry returns to baseline after session dispose", async () => {
  const ctx = "prj_lr_churn";
  const session = harness.session(ctx);
  const itx = await session.authenticate().get();
  const baseline: any = await doState(ctx);
  const c = collector();

  for (let i = 0; i < 20; i++) {
    await itx.subscribe({ name: "churn", consumes: ["mark"], target: c.fn });
    await itx.unsubscribe({ name: "churn" });
  }

  // no ghost deliveries: every mount is revoked, so nothing may reach the callback
  await append(itx, { type: "mark", payload: { n: 1 } });
  await append(itx, { type: "mark", payload: { n: 2 } });
  await settle(800);
  expect(c.invocations).toHaveLength(0);
  const state: any = await doState(ctx);
  expect(state.subscriptionMounts).toEqual([]);

  // dispose the session: the registry must return to baseline (no leaked stubs/sockets)
  const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
  if (DISPOSE) (session as Record<symbol, () => void>)[DISPOSE]?.();
  await until(
    "stub registry back to baseline",
    async () => {
      const s: any = await doState(ctx);
      return s.stubs === baseline.stubs;
    },
    20_000,
  );
});

// (Deleted with the rpcStubs migration: the defect-31 "unsubscribe reaps the parked connection
// via the last naming mount" case asserted reap-on-mount-revoke — a mechanism the migration
// removed. A stub's lifecycle is now owned by its ProvidedStub handle (a subscribe's stub is
// disposed by unsubscribe directly, not by mount revocation), so there is nothing to assert here.
// The churn test above still guards subscribe/unsubscribe stub hygiene end-to-end.)

// ─────────────────────────── 7. waitUntilProcessed against a future offset ───────────────────────────

test("waitUntilProcessed(future offset) times out with its documented error and leaks no waiter", async () => {
  const ctx = "prj_lr_barrier";
  const itx = await harness.itx(ctx);
  await itx.enableProcessor("tally");
  await append(itx, { type: "mark" });
  const head = await readHead(itx);
  await until(
    "tally at head",
    async () => ((await itx.invoke("itx.facets.get('tally').snapshot()")) as any).offset >= head,
  );

  const t0 = Date.now();
  await expect(
    itx.invoke([
      "itx",
      "facets",
      ["get", "tally"],
      ["waitUntilProcessed", { offset: head + 50, timeoutMs: 1500 }],
    ]),
  ).rejects.toThrow(/did not reach offset/);
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeGreaterThanOrEqual(1_200); // it genuinely waited
  expect(elapsed).toBeLessThan(8_000); // and rejected at ITS deadline, not a transport one

  // a LATER append releases nothing stale: the barrier still works exactly
  const [m] = await append(itx, { type: "mark" });
  await itx.invoke([
    "itx",
    "facets",
    ["get", "tally"],
    ["waitUntilProcessed", { offset: m.offset, timeoutMs: 5000 }],
  ]);
  const snap: any = await itx.invoke("itx.facets.get('tally').snapshot()");
  expect(snap.offset).toBeGreaterThanOrEqual(m.offset);
  expect(snap.state.counts.mark).toBe(2);
});

// ─────────────────────────── 8. the resurrection pass racing live traffic ───────────────────────────

test.todo(
  "resurrection pass racing live traffic: the first alarm of an incarnation snapshot-catches-up every facet while appends land — unforceable here (the alarm arms lastActivity+60s of REAL time and every append re-arms it; the harness has no fake clock and no alarm-force door), and a 61s wall-clock wait per race attempt cannot pin the interleaving. Home: the workers pool lane (vitest-pool-workers runDurableObjectAlarm / fake timers)",
);
