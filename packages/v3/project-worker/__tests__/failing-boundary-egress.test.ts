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
//     proves the SAME ☠ authority loss is still reachable through `itx.contexts.get(path).append`
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

const readAll = async (itx: any): Promise<any[]> =>
  (await itx.invokeCapability({ path: ["stream", "read"], args: [0, 500] })).events;

/** Await a promise that MUST reject; hand back the error for inspection. */
async function rejection(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("expected the call to reject — it fulfilled");
}

/** Append through the CONTEXTS door: `itx.contexts.get(path).append(event)` — a full expression
 *  (the dotted `invokeCapability` sugar cannot spell the mid-path `get(path)` call). This lands on
 *  DO.append DIRECTLY (own context ⇒ ownContext.append closure; sibling ⇒ getByName stub.append),
 *  which is the door the `stream` built-in's reserved-key fence never guards. */
const contextsAppend = (itx: any, path: string, event: unknown): Promise<any[]> =>
  itx.invoke(["itx", "contexts", ["get", path], ["append", event]]) as Promise<any[]>;

// ═══════════════════ 1. DEFECT-34 FENCE BYPASS — the ☠ authority loss, reopened ═══════════════════

test.skip("the reserved-key fence was REMOVED — revoke is keyless now, so there is nothing to squat (defect 46 root fix)", async () => {
  // The partial fix works where it was installed: built-ins.ts `stream.append` rejects a public
  // append carrying a `capability-table/`-prefixed idempotencyKey ("platform-reserved namespace").
  // This lock exists so the bypass below is unmistakably a MISSING fence on a SECOND door, not the
  // absence of the fix altogether.
  const itx = await harness.itx("prj_be_fence_ok");
  const err = await rejection(
    streamAppend(itx, { type: "noise", idempotencyKey: "capability-table/revoke:1" }),
  );
  expect(err.message).toMatch(/platform-reserved|reserved namespace/i);
});

test("FIXED (defect 46): a capability cannot be pinned unrevocable by squatting its revoke key through the CONTEXTS append door", async () => {
  // BUG: DEFECTS.md defect 34's fix reserves the `capability-table/` idempotencyKey namespace in
  //   the `stream` BUILT-IN's append (built-ins.ts stream.append), NOT in
  //   StreamDurableObject.append. But `itx.contexts.get('/').append(...)` resolves the `contexts`
  //   built-in, and for the OWN path returns `ownContext.append = (...e) => this.append(...e)` —
  //   i.e. DO.append, which has NO fence. So the exact forge defect 34 closed on one door is wide
  //   open on another.
  // EXPECTED: platform-authored idempotency keys are unforgeable from EVERY public append door
  //   (the fence belongs at THE append door — DO.append — as the ledger's fix note says, not at
  //   one of the several capabilities that reach it). Revoke must still drop the mount.
  // ACTUAL (verified): the squat commits (offset 2); `itx.revoke({providedAtOffset})` then throws
  //   IDEMPOTENCY_CONFLICT ("capability-table/revoke:1 already names a different event at offset
  //   2") and the capability STILL resolves — it can never be revoked.
  // WHY IT MATTERS (☠ authority loss, NOT a dup of defect 34): a client can permanently pin any
  //   granted capability — including a live connection's auto-revoke-on-disconnect — with one
  //   benign append through a door the fix forgot. Losing REVOKE is the worst failure a capability
  //   system can have; the ledger records defect 34 as fixed, but the fix is bypassable.
  const itx = await harness.itx("prj_be_fence_bypass");
  const { providedAtOffset } = await itx.provide({ path: "itx.probe", target: "itx.whoami" });
  expect(await itx.invokeCapability({ path: ["probe"], args: [] })).toMatchObject({
    projectId: "prj_be_fence_bypass",
  });
  // Squat the reserved revoke key through the UNFENCED contexts/own-context append door.
  const [squatted] = await contextsAppend(itx, "/", {
    type: "hostile-noise",
    payload: { squatting: true },
    idempotencyKey: `capability-table/revoke:${providedAtOffset}`,
  });
  expect(squatted.offset).toBeGreaterThan(0); // the squat lands (the bypass — DO.append is unfenced)
  // Verified ACTUAL: revoke throws IDEMPOTENCY_CONFLICT — tolerate it so the pinned assertion is
  // the authority loss itself, not the throw.
  await itx.revoke({ providedAtOffset }).catch(() => undefined);
  // EXPECTED: gone. ACTUAL: still resolves — the mount can never be revoked.
  const err = await rejection(itx.invokeCapability({ path: ["probe"], args: [] }));
  expect(err.message).toMatch(/no capability matches/);
});

test.fails("DO.append rejects a public reserved-namespace idempotencyKey on a SIBLING context too", async () => {
  // POLICY FORK (deferred, not a no-brainer): this wants a `capability-table/` namespace fence at
  //   the ONE append door. But the shipped strategy is KEYLESS REVOKE (defect 46) — revoke uses no
  //   deterministic idempotencyKey, so squatting `capability-table/revoke:N` is HARMLESS (the
  //   passing test below + the `test.skip` above pin that: "the fence was REMOVED, nothing to
  //   squat"). Adding the fence re-introduces the door the codebase deliberately closed and
  //   contradicts those tests. Reserve the choice for Jonas: defense-in-depth fence vs keyless.
  const itx = await harness.itx("prj_be_fence_sibling");
  const err = await rejection(
    contextsAppend(itx, "/agents/bot", {
      type: "sib-noise",
      idempotencyKey: "capability-table/revoke:99",
    }),
  );
  expect(err.message).toMatch(/platform-reserved|reserved namespace/i);
});

// ═══════════════════ 2. THE ENVELOPE BOUNDARY — runtime guard only (validate removed) ═══════════════════

test("boundary: the runtime typeless guard still rejects a non-string type; ephemeral:false now commits (no TS-type boundary)", async () => {
  // capnweb-validate was removed (2026-08-20): there is no TS-type allow-list on the RPC boundary
  // anymore. What remains is the ONE explicit runtime guard in StreamDurableObject.append — a
  // non-string / blank `type` is rejected loudly. Everything the TS type used to police coarsely
  // (ephemeral: literal `true`, etc.) is no longer checked here; an envelope refinement would be a
  // runtime StreamEventInput.parse() at the door (see the two test.fails below for that consolidation).
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

test.fails("stream.append does not let a client STAMP a forged processor provenance (source is runner-only)", async () => {
  // BUG: `source` (StreamEventInput.source — "Provenance: which processor (while processing what)
  //   appended this. Stamped by the runner.") is a PUBLIC typed field, and nothing on the append
  //   path strips a client-supplied value (no boundary parse — validate removed). The runner overwrites
  //   `input.source` only for PROCESSOR-emitted events (core/processor.ts:431); a direct client
  //   append has no runner, so the forged provenance is stored verbatim.
  // EXPECTED: a client cannot author `source` — a plain `stream.append` produces an event whose
  //   `source` is absent (only a processor stamps provenance).
  // ACTUAL (verified): the committed event carries the client's forged
  //   `source.processor.slug = "FORGED"` + `whileProcessing`, indistinguishable in the log from a
  //   genuine processor emission.
  // WHY IT MATTERS (⚠ audit integrity): the event log is the system's load-bearing audit trail.
  //   Forgeable provenance lets any client fabricate "processor X emitted this while processing
  //   offset N" facts. (Same TS-type-only boundary also lets excess keys ride through unstripped —
  //   the z.strictObject excess-rejection is lost; cross-ref the Family-I strict-vs-passthrough
  //   note, here confirmed on the append envelope.)
  const itx = await harness.itx("prj_be_forgesrc");
  const [committed] = await streamAppend(itx, {
    type: "looks-derived",
    source: {
      processor: { slug: "FORGED", version: "9.9.9", whileProcessing: { offset: 1, type: "seed" } },
    },
  });
  expect(committed.source).toBeUndefined();
});

// ═══════════════════ 3. EGRESS / SECRETS — unverifiable in this lane (documented) ═══════════════════

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

test.todo(
  "CONNECTIONKEY / CONNECTIONID SHARED LOOKUP NAMESPACE: ItxConnectionDirectory.find(key) matches " +
    "`r.connectionKey === key || r.stubKey === key`, and connectionId = String(connectedAtOffset) " +
    "(a small integer string) while connectionKey is client-chosen and UNVALIDATED (attach() takes " +
    "it verbatim). A client that reads a victim's connectionId from itx.connections.list() and then " +
    "connect({connectionKey: '<that id>'}) collides the two namespaces: onFinalClose's auto-revoke " +
    "(`conn.key === connectionKey` when keyFinal) then revokes the VICTIM's identity mount when the " +
    "attacker's keyed connection closes clean. Intra-context integrity (⚠). Not verified here — " +
    "needs two live-callback connections + a clean keyFinal close through the relay.",
);
