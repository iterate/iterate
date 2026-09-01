// __tests__/failing-appsos-mined.test.ts — BUG HUNT WAVE 2, harness lane: apps/os-proven
// behavioral contracts mined ADJACENT to the wave-1 families in DEFECTS.md (never duplicating
// those 41), adapted against the REAL worker (wrangler createTestHarness — capnweb over
// WebSocket at /api, local KV + Durable Objects). Every test asserts the CORRECT behavior; a
// `test.fails` documents a genuine divergence (BUG/EXPECTED/ACTUAL/WHY IT MATTERS + apps/os
// source file:line). A plain `test` is a passing PARITY LOCK. One boot per file; unique ctx per
// test. Run: pnpm exec vitest run --config vitest.harness.config.ts __tests__/failing-appsos-mined.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

// ── tiny verbs over the real client surface (the smoke test's voice) ──

const append = (itx: any, ...events: unknown[]): Promise<any[]> =>
  itx.invokeCapability(["itx", ["append", ...events]]);

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

/** Await a promise that MUST reject; hand back the error for inspection. */
async function rejection(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("expected the call to reject — it fulfilled");
}

/** A subscriber callback recording every delivery (deep-cloned — capnweb payloads must not be
 *  read after the callback's turn). */
function collector() {
  const invocations: { events: any[] }[] = [];
  return {
    fn: (events: any[]) => {
      invocations.push(JSON.parse(JSON.stringify({ events })));
    },
    offsets: () => invocations.flatMap((i) => i.events.map((e) => e.offset as number)),
  };
}

// ─────────────────────────────── EVENT INPUT ENVELOPE ───────────────────────────────

// PARITY LOCK, restored (apps/os pins `ephemeral: z.literal(true)` — "`ephemeral: false` is a loud
// input error, not a silent synonym for omitting the flag"). Enforcement lived only in
// capnweb-validate's TS-type boundary until that was removed 2026-08-20; the append door's runtime
// guard now rejects any non-`true` ephemeral itself.
test("ephemeral: false is a LOUD input error at the append door, and commits nothing", async () => {
  const itx = await harness.itx("prj_am_ephfalse");
  const err = await rejection(append(itx, { type: "sneaky", ephemeral: false as unknown as true }));
  expect(err.message).toMatch(/ephemeral must be literal true or absent/);
  // nothing committed — the log has no durable "sneaky" row
  const page = await itx.invokeCapability(["itx", ["read", 0, 50]]);
  expect(page.events.map((e: { type: string }) => e.type)).not.toContain("sneaky");
});

// ─────────────────────────── PLATFORM-AUTHORED IDEMPOTENCY KEYS ───────────────────────────

test("FIXED (defect 34/46 at the root): squatting capability-table/revoke: is harmless — revoke is keyless", async () => {
  // BUG: CapabilityTableProcessor.revoke appends its revoked event with a FIXED idempotency key
  //   `capability-table/revoke:${providedAtOffset}` (capability-table-processor.ts:229) to make
  //   a double-revoke idempotent. Nothing reserves that key namespace: a public `stream.append`
  //   may commit ANY event under it first. When the system later revokes that offset, the
  //   append hits an IDEMPOTENCY_CONFLICT (same key, different body) and revocation THROWS — the
  //   capability can never be taken away.
  // EXPECTED: platform-authored idempotency keys are unforgeable from public appends. apps/os
  //   fences exactly this — public appends carrying an `iterate-internal` idempotency-key family
  //   are rejected: "iterate-internal idempotency keys are platform-authored"
  //   (apps/os/src/domains/streams/core-processor.test.ts:952, and stream-delivery-utils.ts's
  //   INTERNAL_STREAM_IDEMPOTENCY_PREFIX). Revoke here must still succeed and drop the mount.
  // ACTUAL: revoke rejects with IDEMPOTENCY_CONFLICT; the capability stays live forever.
  // WHY IT MATTERS: ☠ authority loss. A client (or a compromised one) can permanently pin a
  //   granted capability — including a live connection's auto-revoke on disconnect — by
  //   pre-committing one benign event under the revoke key. Losing the ability to REVOKE is the
  //   worst failure a capability system can have.
  const itx = await harness.itx("prj_am_forge");
  const { providedAtOffset } = await itx.provide("itx.probe", "itx.whoami");
  expect(await itx.invokeCapability(["itx", ["probe"]])).toMatchObject({
    projectId: "prj_am_forge",
  });
  // Forge the platform's revoke key with a benign public event.
  await append(itx, {
    type: "hostile-noise",
    payload: { squatting: true },
    idempotencyKey: `capability-table/revoke:${providedAtOffset}`,
  });
  // Verified ACTUAL: revoke throws IDEMPOTENCY_CONFLICT ("capability-table/revoke:N already
  // names a different event at offset …") — tolerate it so the pinned assertion below is the
  // authority loss itself, not the throw.
  await itx.revoke({ providedAtOffset }).catch(() => undefined);
  // EXPECTED: the capability is gone. ACTUAL: it still resolves — the mount can never be revoked.
  const err = await rejection(itx.invokeCapability(["itx", ["probe"]]));
  expect(err.message).toMatch(/no capability matches/);
});

// ─────────────────────────────── IDEMPOTENCY EQUALITY AT THE COMMIT POINT ───────────────────────────────

test("an idempotent retry with reordered payload keys dedupes to the same offset", async () => {
  // PARITY LOCK: the commit-point dedupe compares bodies key-order-insensitively (jsonEqual,
  //   core/events.ts; apps/os idempotency.ts "Object key ORDER is insignificant").
  const itx = await harness.itx("prj_am_keyorder");
  const [a] = await append(itx, {
    type: "j",
    payload: { x: 1, y: { p: 2, q: 3 } },
    idempotencyKey: "ko",
  });
  const [b] = await append(itx, {
    type: "j",
    payload: { y: { q: 3, p: 2 }, x: 1 },
    idempotencyKey: "ko",
  });
  expect(b.offset).toBe(a.offset);
});

test("an idempotent retry whose METADATA differs is a loud conflict (metadata is part of identity)", async () => {
  // PARITY LOCK: sameIdempotentEvent compares type + payload + METADATA. A key reused with the
  //   same payload but different metadata is a different event → IDEMPOTENCY_CONFLICT.
  const itx = await harness.itx("prj_am_meta");
  await append(itx, {
    type: "j",
    payload: { x: 1 },
    metadata: { trace: "a" },
    idempotencyKey: "mc",
  });
  const err = await rejection(
    append(itx, { type: "j", payload: { x: 1 }, metadata: { trace: "b" }, idempotencyKey: "mc" }),
  );
  expect(err.message).toMatch(/already names a different event/);
});

// ─────────────────────────────── ERROR GRAMMAR (codes survive the hop) ───────────────────────────────

test("a default-deny miss carries code NO_CAPABILITY_MATCH across the /api hop", async () => {
  // PARITY LOCK (the error-grammar doctrine, core/errors.ts): classify by machine-readable
  //   `code`, never message/name/instanceof — own props survive DO→relay→client. apps/os shares
  //   the workshop plain-Error + `code` shape.
  const itx = await harness.itx("prj_am_code_miss");
  const err = await rejection(itx.invokeCapability(["itx", "nope", ["thing"]]));
  expect(err.code).toBe("NO_CAPABILITY_MATCH");
  expect(err.message).toMatch(/no capability matches/);
});

test("a paused-stream refusal carries code STREAM_PAUSED across the /api hop", async () => {
  // PARITY LOCK: enforcement refusals ride the same coded channel end to end.
  const itx = await harness.itx("prj_am_code_pause");
  await append(itx, { type: "events.iterate.com/stream/paused", payload: { reason: "operator" } });
  const err = await rejection(append(itx, { type: "mark", payload: { n: 1 } }));
  expect(err.code).toBe("STREAM_PAUSED");
  expect(err.message).toContain("stream paused");
});

// ─────────────────────────────── STORAGE LAZINESS (Kenton #6101 doctrine) ───────────────────────────────

test("probing the core snapshot mints no storage — a virgin ctx reports incarnation 0, first append makes it 1", async () => {
  // PARITY LOCK: a read/probe must never be the write that mints backing storage (workerd
  //   auto-deletes empty objects; the Kenton PR #6101 doctrine in core/stream.ts). If the probe
  //   minted storage, the incarnation would already be bumped and the first append would land on
  //   incarnation 2. The probe is the CORE REDUCE's snapshot (runtime state IS reduced state —
  //   hostState() died in C5): `incarnation` folds from the stream/woken wake record, absent on a
  //   virgin stream (no append ⇒ no woken), and the inline snapshot reads reduced state only.
  //   The other half of the doctrine — the probe must not ARM THE QUIET-CLOCK ALARM either — is
  //   pinned where storage.getAlarm() is reachable: __workers-tests__/do-doors.test.ts.
  const ctx = "prj_am_lazy";
  const itx = await harness.itx(ctx);
  const coreState = async (): Promise<any> =>
    ((await itx.invokeCapability("itx.facets.get('core').snapshot()")) as any).state;
  // Connecting + probing is pure read: no append yet, so no storage minted, incarnation still 0.
  const first = await coreState();
  expect(first.incarnation ?? 0).toBe(0);
  await append(itx, { type: "mark", payload: { n: 1 } });
  const second = await coreState();
  expect(second.incarnation).toBe(1);
});

// ─────────────────────────────── PROVIDE DOOR CANONICALIZATION ───────────────────────────────

test("a NON-CANONICAL subscribers spelling through the raw provide door still lands a LANED row (durable lane)", async () => {
  // The ghost-subscription pin: provideCapability canonicalizes ONCE at the top, so the lane is
  // stamped from the same spelling the reduce stores. Pre-fix, " itx.subscribers.x" dodged the
  // raw-string `startsWith` lane check but reduced to the canonical path — a laneless subscriber
  // row that NO fan-out lane serves and resumeSubscription cannot heal: a silently-dead
  // subscription with a success receipt. (The connected-lane ghost is pinned in
  // __workers-tests__/do-doors.test.ts, where the DO door is callable raw.)
  const itx = await harness.itx("prj_am_ghostlane");
  await itx.provide(" itx.subscribers.ghost", "itx.whoami", {
    delivery: { consumes: ["mark"] },
  });
  const snap = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  const row = (snap.state.mounts as { path: string[]; lane?: string }[]).find(
    (m) => m.path.join(".") === "itx.subscribers.ghost",
  );
  expect(row).toBeDefined(); // stored CANONICAL
  expect(row!.lane).toBe("durable"); // an absent-facet expression target = the forwarder's lane
});

// ─────────────────────────────── SUBSCRIBE SUGAR ───────────────────────────────

test("concurrent anonymous subscribes get unique names and never shadow each other", async () => {
  // PARITY LOCK (itx-surface subscribe: "concurrent anonymous subscribes must never shadow each
  //   other"): each unnamed subscribe mints a unique `sub-<uuid>` name, so both deliver.
  const itx = await harness.itx("prj_am_anon");
  const a = collector();
  const b = collector();
  const s1 = await itx.subscribe({ consumes: ["ping"], target: a.fn });
  const s2 = await itx.subscribe({ consumes: ["ping"], target: b.fn });
  expect(s1.name).not.toBe(s2.name);
  const [ping] = await append(itx, { type: "ping" });
  await until(
    "both anonymous subscribers received the event",
    () => a.offsets().includes(ping.offset) && b.offsets().includes(ping.offset),
  );
});

test("an inline core slug (core / capability-table) can be neither enabled nor disabled as a facet", async () => {
  // PARITY LOCK: the inline reduce-only cores are always-on, never facets — an authority
  //   boundary (contrast apps/os "hosted processor subscriptions cannot be removed",
  //   core-processor.test.ts:495).
  const itx = await harness.itx("prj_am_inline");
  await expect(itx.enableProcessor("core")).rejects.toThrow(/inline core/);
  await expect(itx.disableProcessor("capability-table")).rejects.toThrow(/inline core/);
});

// ─────────────────────────────── GUARANTEE DELIBERATELY NOT GIVEN (parity) ───────────────────────────────

test.fails("configuring a subscription verifies the receiver end-to-end", async () => {
  // GUARANTEE NOT GIVEN (parity, not a bug): like apps/os, configure appends the mount and
  //   returns without probing the receiver — "the receiver learns about the subscription when
  //   its first copy arrives". A subscription toward an unusable absent target succeeds at
  //   configure and only fails LATER, at delivery, burning its retry ladder before a durable
  //   halt audit fact.
  // EXPECTED (the un-given guarantee): subscribe rejects at configure time when the target is
  //   unusable. apps/os documents the exact non-guarantee as a `test.fails` —
  //   guarantees-not-given.test.ts:344 "configuring a copy subscription verifies the receiver
  //   end-to-end".
  // ACTUAL: subscribe resolves; the forwarder later delivers to `itx.does-not-exist`, hits
  //   NO_CAPABILITY_MATCH, and halts after the (here 1-attempt) ladder.
  // WHY IT MATTERS: documents that the clean room inherits apps/os's deliberate late-failure
  //   trade — a fat-fingered target is loud but LATE (halt audit + resume verb), never rejected
  //   at the call site. FIX: n/a — deliberate; this test pins the boundary for future changes.
  const itx = await harness.itx("prj_am_configverify");
  await expect(
    itx.subscribe({
      name: "unusable",
      consumes: ["mark"],
      target: "itx.does-not-exist",
      maxAttempts: 1,
    }),
  ).rejects.toThrow(/verif|unusable|receiver|no capability/i);
});
