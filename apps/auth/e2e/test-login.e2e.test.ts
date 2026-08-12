/**
 * Live e2e for /test-login — the one-click sign-in for fixed-test-OTP
 * deployments (apps/auth/src/server/test-login.ts). Runs in the same lane as
 * the OAuth exchange suite:
 *
 *   doppler run --project auth --config preview_3 -- \
 *     env AUTH_BASE_URL=https://auth.iterate-preview-3.com pnpm test:e2e
 *
 * What it proves against the deployed worker: a single unauthenticated GET
 * creates the test user through the real sign-up path, seeds an organization
 * and project (so the OAuth authorize that follows never parks on
 * /project-access), sets a genuine better-auth session cookie, and redirects
 * to the validated return_to. Repeat visits reuse everything. Production
 * cannot run this suite by design — the fixed test OTP is off there and the
 * route 404s.
 */
import { expect, test } from "vitest";
import { createAuthContractClient } from "@iterate-com/auth-contract";
import { createCloudflareWorkerVersionOverrideFetch } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";

function requireAuthBaseUrl(): string {
  const value = process.env.AUTH_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      "AUTH_BASE_URL is required for auth e2e tests. Point it at a deployed auth worker " +
        "(https://auth.iterate-preview-N.com) or a local `pnpm dev` (http://localhost:7101).",
    );
  }
  return value.replace(/\/+$/, "");
}

function requireServiceToken(): string {
  const value = process.env.APP_CONFIG_SERVICE_AUTH_TOKEN?.trim();
  if (!value) {
    throw new Error(
      "APP_CONFIG_SERVICE_AUTH_TOKEN is required: it authenticates the internal.* oRPC " +
        "procedures used to verify seeding. Run under the target's auth Doppler config, e.g. " +
        "`doppler run --project auth --config preview_3 -- env AUTH_BASE_URL=… pnpm test:e2e`.",
    );
  }
  return value;
}

const baseUrl = requireAuthBaseUrl();
const authFetch = createCloudflareWorkerVersionOverrideFetch(
  globalThis.fetch.bind(globalThis),
  process.env,
);

const runId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const email = `test-login-${runId}+test@nustom.com`.toLowerCase();
const projectSlug = `test-login-${runId}`;

function testLoginUrl(params: Record<string, string>) {
  const url = new URL("/test-login", baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

test("one GET signs the test user in and seeds their org + project", async () => {
  const response = await authFetch(
    testLoginUrl({ email, project: projectSlug, return_to: "/after-test-login" }),
    { redirect: "manual" },
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/after-test-login");
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  expect(cookie).toContain("session_token");

  // The cookie is a genuine better-auth session for the test user.
  const session = await authFetch(`${baseUrl}/api/auth/get-session`, { headers: { cookie } });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ user: { email } });

  // The org + project exist with the user as owner — the precondition for the
  // OAuth flow completing without the /project-access interstitial.
  const serviceClient = createAuthContractClient({
    baseUrl,
    fetch: authFetch,
    serviceToken: requireServiceToken(),
  });
  const snapshot = await serviceClient.internal.project.seedSnapshot({ projectSlug });
  expect(snapshot).toMatchObject({
    project: { slug: projectSlug },
    organization: { name: projectSlug },
  });
  expect(snapshot.members).toMatchObject([{ role: "owner", user: { email } }]);
});

test("repeat visits sign in again without duplicating anything", async () => {
  const first = await authFetch(testLoginUrl({ email, project: projectSlug }), {
    redirect: "manual",
  });
  expect(first.status).toBe(302);

  const serviceClient = createAuthContractClient({
    baseUrl,
    fetch: authFetch,
    serviceToken: requireServiceToken(),
  });
  const snapshot = await serviceClient.internal.project.seedSnapshot({ projectSlug });
  // Still exactly one membership; the org from the first visit was reused.
  expect(snapshot.members).toHaveLength(1);
});

test("rejects addresses the fixed OTP itself would reject", async () => {
  const response = await authFetch(testLoginUrl({ email: `real-person-${runId}@nustom.com` }), {
    redirect: "manual",
  });
  expect(response.status).toBe(400);
});

test("allows an absolute return_to at a seeded relying party origin", async () => {
  // Seed a relying party exactly the way each deploy does
  // (apps/auth/scripts/seed-oauth-clients.ts → internal.oauth.setClient):
  // referenceId is what marks the client as deployment-seeded, and only
  // seeded clients' redirect-URI origins are valid return_to targets. This is
  // the arm the PR-comment login link rides (return_to = the os login URL).
  const rpOrigin = `https://rp-${runId}.example`;
  const serviceClient = createAuthContractClient({
    baseUrl,
    fetch: authFetch,
    serviceToken: requireServiceToken(),
  });
  await serviceClient.internal.oauth.setClient({
    clientId: `test-login-rp-${runId}`,
    clientSecret: crypto.randomUUID(),
    clientName: `test-login e2e RP ${runId}`,
    redirectURIs: [`${rpOrigin}/api/iterate-auth/callback`],
    referenceId: `e2e:test-login:${runId}`,
    skipConsent: true,
  });

  const returnTo = `${rpOrigin}/api/iterate-auth/login`;
  const response = await authFetch(testLoginUrl({ email, return_to: returnTo }), {
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(returnTo);
});

test("rejects a return_to outside the seeded relying parties", async () => {
  // Dynamically-registered clients (open registration) must never widen the
  // allowlist — only Doppler-seeded clients (referenceId set) count.
  const response = await authFetch(
    testLoginUrl({ email, return_to: "https://evil.example/phish" }),
    { redirect: "manual" },
  );
  expect(response.status).toBe(400);
});
