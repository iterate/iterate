// __tests__/failing-boundary-egress.test.ts — BUG HUNT WAVE 3, harness lane: the append input
// BOUNDARY + the egress/secrets paths, against the REAL worker (wrangler createTestHarness —
// capnweb over WebSocket at /api, local KV + Durable Objects). Every test asserts CORRECT
// behavior; a `test.fails` documents a genuine, VERIFIED divergence (BUG/EXPECTED/ACTUAL/WHY);
// plain `test` cases are passing PARITY LOCKS. One boot per file; unique ctx per test.
//
// Scope (never duplicating DEFECTS.md families A–K):
//   • THE FENCE IS ON THE WRONG DOOR — DEFECTS.md defect 34's fix (reject public appends carrying
//     a `capability-table/` idempotencyKey) was placed in the `stream` BUILT-IN's append wrapper,
//     NOT in IterateContextDurableObject.append (the real commit door). The existing defect-34 lock
//     (failing-appsos-mined.test.ts:90) only exercises the fenced `stream.append` door; this file
//     proves the SAME ☠ authority loss is still reachable through `itx.cd(path).append`
//     (own context AND siblings), which reach DO.append directly and bypass the fence.
//   • THE ENVELOPE BOUNDARY IS A SMALL SET OF RUNTIME GUARDS — capnweb-validate was removed
//     (2026-08-20), so the append-input checks are IterateContextDurableObject.append's own: the typeless
//     guard (non-string / blank `type` → loud reject) and the `ephemeral` literal-true guard.
//     The remaining zod refinements the schema promises (`strictObject` excess-key rejection,
//     runner-only `source`) are NOT enforced at the door — a runtime StreamEventInput.parse() would.
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
  itx.invokeCapability(["itx", ["append", ...events]]);

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

test("boundary: the runtime guards reject a non-string type AND a non-literal-true ephemeral", async () => {
  // capnweb-validate was removed (2026-08-20): there is no TS-type allow-list on the RPC boundary
  // anymore. What remains are the explicit runtime guards in IterateContextDurableObject.append — a
  // non-string / blank `type` is rejected loudly, and (since the append-door tightening) so is an
  // `ephemeral` that is present but not literal `true` (the schema's `z.literal(true)` contract,
  // now actually enforced at the commit door instead of silently committing a durable event).
  const itx = await harness.itx("prj_be_typed");
  // a numeric type is still refused — the typeless guard checks typeof, not just emptiness.
  expect((await rejection(streamAppend(itx, { type: 12345 }))).message).toMatch(/non-empty type/i);
  // ephemeral: false is a loud input error again — the door enforces literal true or absent.
  expect(
    (await rejection(streamAppend(itx, { type: "eph-false", ephemeral: false }))).message,
  ).toMatch(/ephemeral must be literal true or absent/i);
});

test("stream.append rejects an empty or whitespace-only event type", async () => {
  // FIXED (⚠, boundary bypass): the append door's runtime guard is `typeof type !== "string" ||
  //   type.trim() === ""` (IterateContextDurableObject.append) — it covers the schema's `.trim().min(1)`
  //   contract, so a "" or "   " type is a loud input error instead of committing a typeless,
  //   un-routable log entry. (This is the SOLE enforcement — capnweb-validate was removed.)
  const itx = await harness.itx("prj_be_emptytype");
  expect((await rejection(streamAppend(itx, { type: "" }))).message).toMatch(/non-empty type/i);
  expect((await rejection(streamAppend(itx, { type: "   " }))).message).toMatch(/non-empty type/i);
});

// (Removed 2026-08-28: the "forged processor provenance" test. A client stamping its own `source`
// is not a concern under the trusted-client model — we do not police intra-project forgery. See
// feedback_trusted_clients_radical_simplicity.)

// ═══════════════════ EGRESS / SECRETS — the terminal now FAILS LOUD (S4 fixed) ═══════════════════
//
// FIXED (☠ S4, terminal leak): the DO's egress terminal (#egress in stream-durable-object.ts) is
// the LAST door that owns the project scope — a `{{secret:project:NAME}}` token that survives
// substitution means no such secret is stored, and forwarding it would leak the secret's NAME to
// the external destination and send a garbage credential in its place. The door now scans the
// substituted request (URL first, then every header) and answers 502 BEFORE the FALLBACK terminal.
// `platform`-scope tokens are not this door's business — the next door down owns those.
//
// Driving it (this file had no egress driver before): the only route into the terminal is /cap
// WITHOUT ?cap (no `x-itx-cap` header is set, no stub-pager header) — the DO's fetch falls through
// to #egress. In solo, FALLBACK=DummyControlPlane does a bare `fetch(request)` on the same /cap
// URL — the defect-28 self-loop — so a request that PASSES the door is unbounded and unobservable.
// The 502 cases below never reach FALLBACK, which is exactly what makes them observable: the
// prompt, name-bearing 502 IS the proof the request never left (the FALLBACK terminal is the sole
// exit, and had the door forwarded, the response would come back only after the loop churned).

/** Hit the DO's egress terminal: /cap with a unique ctx, NO ?cap, plus test query/headers.
 *  (WHATWG URL serialization keeps `{{`/`}}` literal in the query — verified — so a URL token
 *  arrives at the door byte-identical.) */
const egress = (ctx: string, query: string, headers?: Record<string, string>) =>
  fetch(new URL(`/cap?ctx=${ctx}${query}`, harness.url), { headers });

test("egress: a missing project secret in a HEADER is a loud 502 naming the header and the token", async () => {
  const res = await egress("prj_eg_header", "", {
    "x-hunt-auth": "Bearer {{secret:project:GHOST}}",
  });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain("{{secret:project:GHOST}}"); // the token is named to US, not the destination
  expect(body).toContain('header "x-hunt-auth"'); // …and WHERE it sat, so the caller can fix it
});

test("egress: a missing project secret in the URL query is a loud 502 naming the URL", async () => {
  // The pre-fix gap: substituteHeaderSecrets rebuilds ONLY headers, so a URL token was never even
  // scanned (pinned at unit level in src/boundary-egress.failing.test.ts). The door now sweeps the
  // substituted request's URL too — checked FIRST, before the header sweep.
  const res = await egress("prj_eg_url", "&access_token={{secret:project:GHOST}}");
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toMatch(/no stored project secret/);
  expect(body).toContain("{{secret:project:GHOST}}");
  expect(body).toContain("in the request URL");
});

test("egress: a platform-scope token does NOT trip our door (the next door owns platform scope)", async () => {
  // A platform-only request would pass the door into the solo self-loop (unbounded — defect 28),
  // so "forwarded untouched" is not observable here. What IS observable: the door checks the URL
  // BEFORE the headers, so a platform token in the URL alongside an unresolved project token in a
  // header is a discriminator — if the door wrongly matched platform scope, the 502 would name the
  // URL token; instead it names the header's project token, proving the platform token sailed past.
  const res = await egress("prj_eg_platform", "&pass={{secret:platform:X}}", {
    "x-hunt-auth": "{{secret:project:GHOST}}",
  });
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toContain('header "x-hunt-auth"'); // the PROJECT token, in the header, tripped it
  expect(body).not.toContain("in the request URL"); // the URL's platform token did NOT
  expect(body).not.toContain("platform"); // and the platform token is nowhere in the refusal
});

// (Deleted with the rpcStubs migration: the "connectionKey / connectionId shared lookup namespace"
// todo described an attack on the removed connection directory — connect({connectionKey}), the
// dual connectionId/connectionKey namespace, and onFinalClose auto-revoke by connectionKey. The
// rpcStubs registry keys stubs by a single client-chosen `key` (list() returns [{key}]); there is
// no connectionId offset-string to collide with, so the defect is structurally gone. It was also a
// malicious-client concern, which the trusted-client model does not defend against.)
