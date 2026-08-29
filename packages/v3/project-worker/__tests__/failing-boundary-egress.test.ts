// __tests__/failing-boundary-egress.test.ts — BUG HUNT WAVE 3, harness lane: the append input
// BOUNDARY + the egress/secrets paths, against the REAL worker (wrangler createTestHarness —
// capnweb over WebSocket at /api, local KV + Durable Objects). Every test asserts CORRECT
// behavior; a `test.fails` documents a genuine, VERIFIED divergence (BUG/EXPECTED/ACTUAL/WHY);
// plain `test` cases are passing PARITY LOCKS. One boot per file; unique ctx per test.
//
// Scope (never duplicating DEFECTS.md families A–K):
//   • THE FENCE IS ON THE WRONG DOOR — DEFECTS.md defect 34's fix (reject public appends carrying
//     a `capability-table/` idempotencyKey) was placed in the `stream` BUILT-IN's append wrapper,
//     NOT in StreamDurableObject.append (the real commit door). The existing defect-34 lock
//     (failing-appsos-mined.test.ts:90) only exercises the fenced `stream.append` door; this file
//     proves the SAME ☠ authority loss is still reachable through `itx.cd(path).append`
//     (own context AND siblings), which reach DO.append directly and bypass the fence.
//   • THE ENVELOPE BOUNDARY IS A SINGLE RUNTIME GUARD — capnweb-validate was removed (2026-08-20),
//     so the only append-input check is StreamDurableObject.append's typeless guard (non-string /
//     blank `type` → loud reject). None of the zod refinements the schema promises (`type`
//     min-length/trim beyond blank, `ephemeral` literal true, `strictObject` excess-key rejection,
//     runner-only `source`) are enforced at the door — a runtime StreamEventInput.parse() would.
//
// Run: pnpm exec vitest run --project harness __tests__/failing-boundary-egress.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

// ── tiny verbs over the real client surface (copied, per the hunt brief — not imported) ──

const streamAppend = (itx: any, ...events: unknown[]): Promise<any[]> =>
  itx.invokeCapability({ path: ["stream", "append"], args: events });

/** Await a promise that MUST reject; hand back the error for inspection. */
async function rejection(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("expected the call to reject — it fulfilled");
}

// (Removed 2026-08-28: the reserved-key "fence bypass" / revoke-squat tests. We do NOT defend
// against malicious clients — anyone with project access is trusted to coordinate key names and
// namespaces with other clients. Revoke is keyless (defect 46) and idempotent through the reduce,
// so there is nothing to squat and no namespace to fence. See feedback_trusted_clients_radical_simplicity.)

// ═══════════════════ THE ENVELOPE BOUNDARY — runtime guard only (validate removed) ═══════════════════

test("boundary: the runtime typeless guard still rejects a non-string type; ephemeral:false now commits (no TS-type boundary)", async () => {
  // capnweb-validate was removed (2026-08-20): there is no TS-type allow-list on the RPC boundary
  // anymore. What remains is the ONE explicit runtime guard in StreamDurableObject.append — a
  // non-string / blank `type` is rejected loudly. Everything the TS type used to police coarsely
  // (ephemeral: literal `true`, etc.) is no longer checked here — a deliberate, accepted looseness
  // (we trust clients; an envelope refinement would be a runtime StreamEventInput.parse() at the door).
  const itx = await harness.itx("prj_be_typed");
  // a numeric type is still refused — the typeless guard checks typeof, not just emptiness.
  expect((await rejection(streamAppend(itx, { type: 12345 }))).message).toMatch(/non-empty type/i);
  // ephemeral: false is NO LONGER a loud error — with no boundary type-check it commits as a
  // plain (non-ephemeral) durable event. Accepted coarse-grained loss of removing validate.
  const [committed] = await streamAppend(itx, { type: "eph-false", ephemeral: false });
  expect(committed.type).toBe("eph-false");
});

test("stream.append rejects an empty or whitespace-only event type", async () => {
  // FIXED (⚠, boundary bypass): the append door's runtime guard is `typeof type !== "string" ||
  //   type.trim() === ""` (StreamDurableObject.append) — it covers the schema's `.trim().min(1)`
  //   contract, so a "" or "   " type is a loud input error instead of committing a typeless,
  //   un-routable log entry. (This is the SOLE enforcement — capnweb-validate was removed.)
  const itx = await harness.itx("prj_be_emptytype");
  expect((await rejection(streamAppend(itx, { type: "" }))).message).toMatch(/non-empty type/i);
  expect((await rejection(streamAppend(itx, { type: "   " }))).message).toMatch(/non-empty type/i);
});

// (Removed 2026-08-28: the "forged processor provenance" test. A client stamping its own `source`
// is not a concern under the trusted-client model — we do not police intra-project forgery. See
// feedback_trusted_clients_radical_simplicity.)

// ═══════════════════ EGRESS / SECRETS — unverifiable in this lane (documented) ═══════════════════

test.todo(
  "S4-EGRESS TERMINAL LEAK (missing project secret) + URL/BODY GAP: the DO's egress terminal " +
    "(stream-durable-object.ts fetch) substitutes ONLY headers (substituteHeaderSecrets) and, for " +
    "a project token with no stored value, forwards the LITERAL {{secret:project:NAME}} downstream " +
    "(leaks the name + sends a garbage credential; no project-scope door exists below this one). A " +
    "token in the URL or body is NEVER substituted at all. Unverifiable in the harness: the only " +
    "route into the egress terminal is /cap WITHOUT ?cap, whose FALLBACK=DummyControlPlane does " +
    "`fetch(request)` on the same /cap URL — an unobservable self-loop (DEFECTS.md defect 28). The " +
    "present-secret-in-URL half is pinned purely in src/boundary-egress.failing.test.ts.",
);

// (Deleted with the rpcStubs migration: the "connectionKey / connectionId shared lookup namespace"
// todo described an attack on the removed connection directory — connect({connectionKey}), the
// dual connectionId/connectionKey namespace, and onFinalClose auto-revoke by connectionKey. The
// rpcStubs registry keys stubs by a single client-chosen `key` (list() returns [{key}]); there is
// no connectionId offset-string to collide with, so the defect is structurally gone. It was also a
// malicious-client concern, which the trusted-client model does not defend against.)
