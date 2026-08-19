// src/boundary-egress.failing.test.ts — BUG HUNT WAVE 3, unit lane: the pure-unit egress/secrets
// cases (the DO-terminal cases live in __tests__/failing-boundary-egress.test.ts). Every test
// asserts CORRECT behavior; a `test.fails` marks a VERIFIED divergence (BUG/EXPECTED/ACTUAL/WHY);
// plain `test` cases PIN behavior that is already correct. No production code is touched.
//
// The hunt's secrets/egress hypotheses, adjudicated here:
//   (3) "does secrets.set validate but the egress READ grammar accept a DIFFERENT charset?" —
//       NO. The two charsets are identical; the earlier charset fix aligned them. Pinned below.
//   (2) "a placeholder in the URL?" — the DO's ONLY substitution step (substituteHeaderSecrets)
//       is header-only, so a project secret placed in the egress URL is forwarded UNSUBSTITUTED:
//       the credential never reaches the destination and its {{secret:project:NAME}} placeholder
//       (the name) leaks. That is the one VERIFIED unit-level fail here.

import { expect, test } from "vitest";
import { substituteHeaderSecrets } from "@v3/shared/egress";

// The two grammars, transcribed from the source under test (kept as literals so a future drift in
// EITHER regex trips this file — neither is exported):
//   • built-ins.ts secrets.set NAME gate .................. /^[A-Za-z0-9._-]+$/
//   • shared/egress.ts SECRET_TOKEN name capture group .... [a-zA-Z0-9._-]+
const SECRETS_SET_NAME = /^[A-Za-z0-9._-]+$/;
const EGRESS_TOKEN_NAME = /^[a-zA-Z0-9._-]+$/; // the token's ([a-zA-Z0-9._-]+) group, anchored

// ═══════════════ 1. CHARSET PARITY — hypothesis (3) disproven (PIN) ═══════════════

test("every secret NAME set() accepts is exactly one the egress token grammar can read (and vice versa)", () => {
  // If set() accepted a name the token could not capture, that secret would be write-only forever;
  // if the token captured a name set() rejects, a name could never have been stored to match. The
  // charsets must be identical — this pins that they are (the ":" cross-project vector is closed on
  // BOTH sides: neither grammar admits it).
  const settable = ["A", "z", "0", "a.b", "a_b", "a-b", "MiXeD.9_-", "..", "__", "--", "x9"];
  const rejected = ["a:b", "a b", "a/b", "a{b", "a}b", "a}}b", "", "a\tb", "naïve", "a\nb"];
  for (const n of settable) {
    expect(SECRETS_SET_NAME.test(n), `set() should accept ${JSON.stringify(n)}`).toBe(true);
    expect(EGRESS_TOKEN_NAME.test(n), `token should read ${JSON.stringify(n)}`).toBe(true);
  }
  for (const n of rejected) {
    expect(SECRETS_SET_NAME.test(n), `set() should reject ${JSON.stringify(n)}`).toBe(false);
    expect(EGRESS_TOKEN_NAME.test(n), `token should reject ${JSON.stringify(n)}`).toBe(false);
  }
});

test("the store key secret:<projectId>:<name> decomposes unambiguously — no cross-project secret cell", () => {
  // projectId is gated `[A-Za-z0-9_-]` (durable-object-names.ts) and the secret NAME `[A-Za-z0-9._-]`
  // (secrets.set) — NEITHER admits ":". So `secret:${projectId}:${name}` always splits at the same
  // two colons: project A can never address project B's cell by smuggling a ":" (DEFECTS.md 38/39,
  // pinned closed here as the invariant the egress READ depends on).
  const PROJECT_ID = /^[A-Za-z0-9_-]+$/;
  for (const pid of ["prj_a", "prj-b", "PRJ0"]) expect(PROJECT_ID.test(pid)).toBe(true);
  expect(PROJECT_ID.test("prj:evil")).toBe(false); // a ":" in the projectId is refused at parse
  expect(SECRETS_SET_NAME.test("evil:name")).toBe(false); // and in the secret name at set()
});

test("an accepted name actually substitutes through the egress token grammar (behavioral parity)", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { authorization: "Bearer {{secret:project:api.key_v-2}}" },
  });
  const out = await substituteHeaderSecrets(request, "project", (name) =>
    name === "api.key_v-2" ? "REAL" : null,
  );
  expect(out.headers.get("authorization")).toBe("Bearer REAL");
});

// ═══════════════ 2. THE SUBSTITUTER IS HEADER-ONLY — the mechanism (PINS) ═══════════════

test("a missing project token is left INTACT (correct for a chain door — the DO makes it a leak)", () => {
  // The function's documented contract: leave an unresolved token for the next door down. Correct
  // in isolation — but the DO egress terminal is the LAST project-scope door, so "leave intact"
  // becomes "forward the literal placeholder downstream" (the S4 terminal leak, covered as a todo
  // in the harness file). Pinned here so the mechanism is unambiguous.
  return substituteHeaderSecrets(
    new Request("https://api.example.com/", {
      headers: { authorization: "Bearer {{secret:project:absent}}" },
    }),
    "project",
    () => null,
  ).then((out) => {
    expect(out.headers.get("authorization")).toBe("Bearer {{secret:project:absent}}");
  });
});

test("a substituted value is never rescanned (no token injection through a secret value)", async () => {
  const out = await substituteHeaderSecrets(
    new Request("https://api.example.com/", { headers: { "x-a": "{{secret:project:outer}}" } }),
    "project",
    (name) => (name === "outer" ? "{{secret:project:inner}}" : "LEAKED"),
  );
  expect(out.headers.get("x-a")).toBe("{{secret:project:inner}}"); // literal, not re-resolved
});

test.fails("the egress terminal's substitution never leaks a PRESENT project secret placed in the URL", async () => {
  // BUG: the DO egress terminal (stream-durable-object.ts fetch) substitutes secrets with
  //   `substituteHeaderSecrets(request, "project", …)`, which rebuilds ONLY Headers — the URL and
  //   body are never scanned. A project that spells its credential in the URL (a common shape:
  //   `?access_token={{secret:project:token}}`) has an EXISTING secret that is nonetheless never
  //   applied: the request goes out with the literal placeholder in its URL.
  // EXPECTED (security invariant the terminal must uphold): no {{secret:project:NAME}} placeholder
  //   for an existing secret survives the terminal's substitution — wherever it appears — so the
  //   value reaches the destination and the name never does.
  // ACTUAL (verified): the returned request's URL still contains the literal placeholder; the
  //   real value ("REAL") is nowhere in the outbound request.
  // WHY IT MATTERS (⚠ correctness + info leak; distinct from the ledger's S4 which is a MISSING
  //   header secret): the credential silently doesn't work AND the secret's NAME is leaked to the
  //   destination. The fix belongs at the DO terminal — substitute URL (+ body) too, or fail loud
  //   on any surviving `{{secret:project:…}}` — not in this header-only helper.
  const request = new Request("https://api.example.com/data?access_token={{secret:project:token}}");
  const out = await substituteHeaderSecrets(request, "project", (name) =>
    name === "token" ? "REAL" : null,
  );
  expect(out.url).not.toContain("{{secret:project:"); // ← the placeholder (name) survives in the URL
  expect(out.url).toContain("REAL");
});
