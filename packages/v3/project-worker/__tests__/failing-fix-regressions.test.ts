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

// (Deleted with the rpcStubs migration: the "reap guard — a connection named by TWO mounts
// survives revoking one; the last revoke reaps it" case asserted reap-on-mount-revoke, the very
// mechanism the migration removed. A stub's lifecycle is now owned by its ProvidedStub handle, not
// by the mounts naming it — revoking a mount does NOT touch the stub — so there is nothing to
// assert here. It also read back an itx.connections.get('<connId>') target expression, a surface
// that no longer exists.)
