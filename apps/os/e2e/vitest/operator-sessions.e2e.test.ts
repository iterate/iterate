// Engine e2e for the operator-session surface: issue → redeem, fetch-only.
//
// PR #2000 deleted runtime-smoke.test.ts, which was the only automated
// exercise of these routes; docs/smoke-testing.md kept the manual curl recipe.
// This suite pins the same contract against the deployed slot. Source of
// truth: handleOperatorSessionRequest in apps/os/src/auth/operator-session.ts —
// issuance is admin-bearer-gated, redemption is origin-bound (foreign Origin
// → 403 and NO cookie; same-origin → the HttpOnly SameSite=Strict cookie).
//
// Tests run concurrently in CI, so each redemption test issues its own grant.

import { expect, test } from "vitest";
import { adminSecret, buildUrl } from "./test-helpers.ts";

const SESSION_COOKIE = "iterate-operator-session";

test("anonymous operator-session issuance is rejected with 401", async () => {
  const response = await fetch(buildUrl({ path: "/api/operator-sessions" }), {
    body: JSON.stringify({ kind: "admin", operatorId: "e2e" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response).toMatchObject({ status: 401 });
  expect(response.headers.getSetCookie()).toEqual([]);
});

test("admin-bearer issuance returns a signed grant and its redeem URL", async () => {
  const grant = await issueAdminGrant("e2e");
  expect(grant).toMatchObject({ kind: "admin" });
  // <base64url payload>.<base64url signature> — the shape verifyOperatorGrant splits.
  expect(grant.token).toMatch(/^[\w-]+\.[\w-]+$/);
  // The browser URL carries the token in the FRAGMENT (never the query), on
  // the issuing origin's redeem route.
  const browserUrl = new URL(grant.browserUrl);
  expect(browserUrl).toMatchObject({
    origin: new URL(buildUrl({ path: "/" })).origin,
    pathname: "/api/operator-sessions/redeem",
    search: "",
  });
  expect(new URLSearchParams(browserUrl.hash.slice(1)).get("token")).toBe(grant.token);
});

test("redeeming from a foreign Origin is a 403 that sets no cookie", async () => {
  const grant = await issueAdminGrant("e2e-foreign-origin");
  const response = await redeem(grant.token, "https://attacker.example");
  expect(response).toMatchObject({ status: 403 });
  // The exact origin-gate body, not a token-validity 401: the grant itself is
  // good, the cross-origin caller is what gets rejected.
  expect(await response.text()).toBe("Forbidden origin");
  expect(response.headers.getSetCookie()).toEqual([]);
});

test("same-origin redemption installs the HttpOnly SameSite=Strict session cookie", async () => {
  const grant = await issueAdminGrant("e2e-same-origin");
  const redeemUrl = new URL(buildUrl({ path: "/api/operator-sessions/redeem" }));
  const response = await redeem(grant.token, redeemUrl.origin);
  expect(response).toMatchObject({ status: 200 });
  // Admin grants default returnTo to /admin (createOperatorSessionResponse).
  expect(await response.json()).toEqual({ ok: true, returnTo: "/admin" });

  const sessionCookie = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  expect(sessionCookie).toBeDefined();
  const [pair, ...attributes] = sessionCookie!.split("; ");
  // The cookie value is the signed grant itself; rotation of the admin secret
  // is what invalidates it.
  expect(pair).toBe(`${SESSION_COOKIE}=${grant.token}`);
  expect(attributes).toContain("Path=/");
  expect(attributes).toContain("HttpOnly");
  expect(attributes).toContain("SameSite=Strict");
  const maxAge = attributes.find((attribute) => attribute.startsWith("Max-Age="));
  expect(Number(maxAge?.slice("Max-Age=".length))).toBeGreaterThan(0);
  // Secure rides only on https deployments (local dev serves plain http).
  expect(attributes.includes("Secure")).toBe(redeemUrl.protocol === "https:");
});

async function issueAdminGrant(operatorId: string) {
  const response = await fetch(buildUrl({ path: "/api/operator-sessions" }), {
    body: JSON.stringify({ kind: "admin", operatorId }),
    headers: {
      authorization: `Bearer ${adminSecret()}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(response).toMatchObject({ status: 200 });
  return (await response.json()) as { browserUrl: string; kind: string; token: string };
}

/** The redeem POST exactly as the redeem page's script sends it: the signed
 * token as a text/plain body, with the supplied Origin. */
function redeem(token: string, origin: string) {
  return fetch(buildUrl({ path: "/api/operator-sessions/redeem" }), {
    body: token,
    headers: { "content-type": "text/plain", origin },
    method: "POST",
  });
}
