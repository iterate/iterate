// __tests__/failing-fix-regressions.test.ts — the bug hunt's SECOND-ORDER pass, HARNESS lane:
// attack the recent fixes (git since bc6aee3cf) for holes they OPENED, end-to-end against the
// REAL worker (wrangler createTestHarness — capnweb over WebSocket at /api, local KV + DOs).
// Owned exclusively by the fix-regression agent. Every test asserts CORRECT behavior; a
// `test.fails` is a VERIFIED (by running) new/latent defect with BUG/EXPECTED/ACTUAL/WHY. A
// plain `test` is a regression guard proving a fix holds at the edge (the wiring the unit lane
// cannot see). Run: pnpm exec vitest run --project harness __tests__/failing-fix-regressions.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readAll = async (itx: any): Promise<any[]> =>
  (await itx.invokeCapability({ path: ["stream", "read"], args: [0, 500] })).events;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const doState = async (ctx: string): Promise<any> =>
  (await fetch(new URL(`/state?ctx=${ctx}`, harness.url))).json();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Charset gate at the EDGE (Phase 0 / defect 38). Idea (1): the gate is wired in worker.ts
// (canonicalName) and ProjectSession — verify it does NOT reject a legitimate ctx, and DOES
// reject a breach char, end-to-end.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("charset gate: a legitimate ctx (hyphen, underscore, uppercase, digits) is served, not rejected", async () => {
  const itx = await harness.itx("prj_FixReg-1_A");
  // A probe → whoami round-trip proves the ctx addressed the right project (and parsed cleanly).
  await itx.provide({ path: "itx.probe", target: "itx.whoami" });
  const who = await itx.invokeCapability({ path: ["probe"], args: [] });
  expect(who).toMatchObject({ projectId: "prj_FixReg-1_A" });
});

test("charset gate: a ':' in the ctx is rejected at the edge (no DO is addressed)", async () => {
  // worker.ts host() runs canonicalName(ctx) for /state and /cap — a ':' throws there, before any
  // DO is addressed. Probe the HTTP door (clean status, no WebSocket teardown noise): a healthy
  // ctx answers /state 200; the breach ctx errors out (the gate fired in the edge handler).
  const ok = await fetch(new URL(`/state?ctx=prj_fixreg_ok`, harness.url));
  expect(ok.status).toBe(200);
  const bad = await fetch(new URL(`/state?ctx=${encodeURIComponent("prj_x:evil")}`, harness.url));
  expect(bad.status).toBeGreaterThanOrEqual(500);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Unsubscribe-close over-reap guard (Phase E / defect 31). The existing lifecycle test covers a
// SINGLE mount reaped cleanly. Idea (6): a connection named by TWO mounts — revoking ONE must
// NOT close it; only revoking the LAST mount reaps the transport.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("reap guard: a connection named by TWO mounts survives revoking one; the last revoke reaps it", async () => {
  const ctx = "prj_fixreg_tworef";
  const itx = await harness.itx(ctx);
  const base = await doState(ctx);

  // Park ONE live callback and mount it at itx.cb1 (one anonymous connection, one mount).
  await itx.provideCapability({ path: ["cb1"], capability: () => "alive" });
  const afterPark = await doState(ctx);
  expect(afterPark.stubs).toBe(base.stubs + 1);

  // Add a SECOND mount naming the SAME parked connection (read its target off the log).
  const provided = (await readAll(itx)).find(
    (e) =>
      e.type === "events.iterate.com/capability-table/capability-provided" &&
      e.payload?.path === "itx.cb1",
  );
  const target: string = provided.payload.target; // itx.connections.get('<connId>')
  expect(target).toMatch(/^itx\.connections\.get\('/);
  await itx.provide({ path: "itx.cb2", target });
  expect(await itx.invokeCapability({ path: ["cb2"], args: [] })).toBe("alive");

  // Revoke the FIRST mount. The connection is named elsewhere (cb2) → it must NOT be reaped.
  await itx.revoke({ path: "itx.cb1" });
  await settle(600);
  const afterFirst = await doState(ctx);
  expect(afterFirst.stubs).toBe(base.stubs + 1); // still alive — cb2 still names it
  expect(await itx.invokeCapability({ path: ["cb2"], args: [] })).toBe("alive"); // still delivers

  // Revoke the LAST mount naming it → NOW the anonymous transport is reaped.
  await itx.revoke({ path: "itx.cb2" });
  await settle(600);
  const afterLast = await doState(ctx);
  expect(afterLast.stubs).toBe(base.stubs); // transport died with its last naming mount
});
