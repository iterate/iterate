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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Charset gate at the EDGE (Phase 0 / defect 38). Idea (1): the gate is wired in worker.ts
// (canonicalName) and ProjectSession — verify it does NOT reject a legitimate ctx, and DOES
// reject a breach char, end-to-end.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("charset gate: a legitimate ctx (hyphen, underscore, uppercase, digits) is served, not rejected", async () => {
  const itx = await harness.itx("prj_FixReg-1_A");
  // A probe → whoami round-trip proves the ctx addressed the right project (and parsed cleanly).
  await itx.provide("itx.probe", "itx.whoami");
  const who = await itx.invokeCapability(["itx", ["probe"]]);
  expect(who).toMatchObject({ projectId: "prj_FixReg-1_A" });
});

test("charset gate: a ':' in the ctx is rejected at the edge (no DO is addressed)", async () => {
  // worker.ts host() runs canonicalName(ctx) for the /cap door — a ':' throws THERE, before any DO
  // is addressed. A healthy ctx answers (its session resolves hostState); the breach ctx errors out
  // of the HTTP door with a 5xx (the gate fired in the edge handler, before egress).
  const good = await harness.itx("prj_fixreg_ok");
  expect(typeof (await good.hostState()).incarnation).toBe("number");
  const bad = await fetch(
    new URL(`/cap?ctx=${encodeURIComponent("prj_x:evil")}&cap=whoami`, harness.url),
  );
  expect(bad.status).toBeGreaterThanOrEqual(500);
});

// (Deleted across the connections → rpcStubs → path-identity migrations: the "reap guard — a
// connection named by TWO mounts survives revoking one; the last revoke reaps it" case can no
// longer be spelled. There is no shared stub registry for two mounts to name: a live stub's
// identity IS its one mount path (`itx.provide(path, stub)`, at most one live row per path), and
// `itx.revoke(path)` tears that stub's transport down with the mount — reap-on-revoke is
// definitionally 1:1, with no cross-mount refcount to guard. It also read back an
// itx.connections.get('<connId>') target expression, a surface that no longer exists.)
