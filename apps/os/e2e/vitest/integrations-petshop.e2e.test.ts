// The integrations & secrets model, proven end to end against the deployed
// dummy-petshop (apps/dummy-petshop) — the userspace lane of design §3
// "Petshop ×2" / R5. One project runs TWO instances of the same integration,
// each with its OWN OAuth client, each with a connection, and each connection
// secret hosts the SAME refresh worker (only the app-secret path differs).
//
// What this proves that unit tests can't:
//   1. A jailed secret worker actually loads and overrides the secret's fetch
//      (S2 runtime) against a real deployment.
//   2. A consumer request substitutes the access token and reaches petshop.
//   3. On a real 401 (backdoor-forced token expiry) the worker refreshes
//      itself — POSTing the refresh token with the app credential as a Basic
//      HEADER placeholder that CHAINS to the app secret (S1 chaining), the
//      worker never holding the client secret — and the retry succeeds.
//   4. hmac() verifies a real petshop-signed webhook without revealing the key.
//   5. describe() never leaks material; uses land on the audit trail.
//
// Requires a deployed OS (APP_CONFIG_BASE_URL) and a reachable dummy-petshop
// (PETSHOP_BASE_URL, or derived). See petshop-support.ts.

import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";
import {
  PETSHOP_DEFAULT_CLIENT,
  petshopAuthorize,
  petshopBaseUrl,
  petshopExchangeCode,
  petshopExpireTokens,
  petshopFireWebhook,
  petshopMintClient,
  petshopRotateSigningSecret,
  petshopWorkerRef,
} from "./petshop-support.ts";

const RUN = crypto.randomUUID().slice(0, 8);
const REDIRECT_URI = "https://example.com/callback";

/** Read a petshop JSON API through the OS egress door with an access-token
 * placeholder — the request routes to the connection secret, whose worker
 * substitutes the token (and refreshes on 401) before it reaches petshop. */
async function callThroughConnection(
  project: any,
  connectionPath: string,
  path: string,
): Promise<{ status: number; body: any }> {
  const response = await project.egress.fetch(
    new Request(`${petshopBaseUrl()}${path}`, {
      headers: {
        authorization: `Bearer getSecret({ path: "${connectionPath}", field: "accessToken" })`,
      },
    }),
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Opt-in: this suite talks to a deployed dummy-petshop, which only exists at
// slots where it was deployed (preview_3 today). Point PETSHOP_BASE_URL at one
// to run it; otherwise it skips, so the shared CI e2e lane (whose preview slot
// has no petshop) stays green. Proven live against preview_3.
describe.skipIf(!process.env.PETSHOP_BASE_URL)("dummy-petshop integration", () => {
  test("two OAuth clients, two connections: connect, call, forced-expiry refresh, webhook verify", async () => {
    const petshop = petshopBaseUrl();
    // Instance A uses the seeded client; instance B a freshly minted one — the
    // two-client proof (R5). Both are project-owned (userspace) app secrets.
    const clientB = await petshopMintClient();
    const instances = [
      { ...PETSHOP_DEFAULT_CLIENT, slug: `petshop-home-${RUN}`, connection: "jonas" },
      { ...clientB, slug: `petshop-work-${RUN}`, connection: "ops" },
    ];

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug: `petshop-${RUN}` });
    await project.__describe();

    for (const instance of instances) {
      const appPath = `/secrets/integrations/${instance.slug}`;
      const connectionPath = `${appPath}/${instance.connection}`;

      // App-tier secret: the OAuth client credential as base64(id:secret) for
      // Basic client auth, pinned to petshop. Userspace holds its OWN client.
      using appSecret = project.secrets.get(appPath);
      await appSecret.update({
        egress: { urls: [petshop] },
        material: {
          basicAuth: Buffer.from(`${instance.clientId}:${instance.clientSecret}`).toString(
            "base64",
          ),
          clientId: instance.clientId,
        },
      });
      await waitForCondition(async () => (await appSecret.describe()).hasMaterial, {
        description: `${instance.slug} app secret to fold`,
      });

      // The OAuth round trip — the project backend (this test) holds the client
      // secret at connect time and exchanges the code.
      const code = await petshopAuthorize({
        clientId: instance.clientId,
        redirectUri: REDIRECT_URI,
      });
      const tokens = await petshopExchangeCode({
        clientId: instance.clientId,
        clientSecret: instance.clientSecret,
        code,
        redirectUri: REDIRECT_URI,
      });

      // Connection secret: the tokens + the refresh worker. Installing the
      // worker is the trust event (design §2.2).
      using connectionSecret = project.secrets.get(connectionPath);
      await connectionSecret.update({
        egress: { urls: [petshop] },
        material: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
        worker: petshopWorkerRef({ appSecretPath: appPath, tokenUrl: `${petshop}/oauth/token` }),
      });
      await waitForCondition(async () => (await connectionSecret.describe()).hasWorker, {
        description: `${instance.slug}/${instance.connection} worker to install`,
      });

      // Authed call through the worker: token substituted, petshop sees it.
      const me = await callThroughConnection(project, connectionPath, "/api/me");
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ clientId: instance.clientId });

      // Force a real 401 (epoch bump) and call again: the worker must refresh
      // itself — chaining the app credential — and retry to a 200.
      await petshopExpireTokens();
      const afterExpiry = await callThroughConnection(project, connectionPath, "/api/me");
      expect(afterExpiry.status).toBe(200);
      expect(afterExpiry.body).toMatchObject({ clientId: instance.clientId });

      // Confinement: the worker only ever held placeholders; describe() leaks
      // no token; the use is audited.
      const described = await connectionSecret.describe();
      expect(JSON.stringify(described)).not.toContain(tokens.access_token);
      expect(described.hasMaterial).toBe(true);
      await waitForCondition(async () => (await connectionSecret.describe()).audit.usedCount >= 1, {
        description: `${instance.slug}/${instance.connection} usage audit to fold`,
      });
    }

    // Webhook verification (R6) via hmac(), against a REAL petshop signature.
    const homeAppPath = `/secrets/integrations/${instances[0]!.slug}`;
    const { webhookSigningSecret } = await petshopRotateSigningSecret();
    using homeAppSecret = project.secrets.get(homeAppPath);
    const verifyToken = `petshop-verify-${RUN}`;
    await homeAppSecret.update({
      material: {
        basicAuth: Buffer.from(`${instances[0]!.clientId}:${instances[0]!.clientSecret}`).toString(
          "base64",
        ),
        clientId: instances[0]!.clientId,
        webhookSecret: webhookSigningSecret,
        verifyToken,
      },
    });
    const fired = await petshopFireWebhook({
      url: `${petshop}/__webhook-sink`,
      event: { pet: "biscuit" },
    });
    const digest = await homeAppSecret.hmac({
      algo: "sha256",
      field: "webhookSecret",
      payload: fired.payload,
    });
    // The secret computed the same signature petshop signed with — without ever
    // exposing the key. Cross-check against a local computation too.
    expect(`sha256=${digest}`).toBe(fired.signature);
    expect(`sha256=${digest}`).toBe(
      `sha256=${createHmac("sha256", webhookSigningSecret).update(fired.payload).digest("hex")}`,
    );

    // matches(): constant-time compare of a caller value against a field (the
    // URL-token verification shape) — right token true, wrong token false.
    expect(await homeAppSecret.matches({ field: "verifyToken", value: verifyToken })).toBe(true);
    expect(await homeAppSecret.matches({ field: "verifyToken", value: "wrong" })).toBe(false);
  });

  // The first-party lane (design §4, R4): the EXACT SAME refresh worker, but its
  // app credential comes from a virtual platform secret backed by deployment
  // config (APP_CONFIG_INTEGRATIONS__PETSHOP) — no project app-secret DO, no
  // platform bytes ever in the jail. Only `appSecretPath` differs from the
  // userspace lane above. Requires the OS deployment's config to carry the
  // petshop client (the seeded default client).
  test("first-party lane: app credential resolves from a platform secret, same worker", async () => {
    const petshop = petshopBaseUrl();
    const slug = `petshop-firstparty-${RUN}`;
    const connectionPath = `/secrets/integrations/${slug}/acme`;
    // The platform secret is virtual — resolved from AppConfig, never a DO.
    const appSecretPath = "/secrets/platform/integrations/petshop";
    const { clientId, clientSecret } = PETSHOP_DEFAULT_CLIENT;

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug: `petshop-fp-${RUN}` });
    await project.__describe();

    const code = await petshopAuthorize({ clientId, redirectUri: REDIRECT_URI });
    const tokens = await petshopExchangeCode({
      clientId,
      clientSecret,
      code,
      redirectUri: REDIRECT_URI,
    });

    using connectionSecret = project.secrets.get(connectionPath);
    await connectionSecret.update({
      egress: { urls: [petshop] },
      material: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
      worker: petshopWorkerRef({ appSecretPath, tokenUrl: `${petshop}/oauth/token` }),
    });
    await waitForCondition(async () => (await connectionSecret.describe()).hasWorker, {
      description: "first-party connection worker to install",
    });

    const me = await callThroughConnection(project, connectionPath, "/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ clientId });

    // Force a 401 and prove the worker refreshes using the PLATFORM app
    // credential (base64 client auth composed by the platform resolver from
    // deployment config) — the jail never holds it.
    await petshopExpireTokens();
    const afterExpiry = await callThroughConnection(project, connectionPath, "/api/me");
    expect(afterExpiry.status).toBe(200);
    expect(afterExpiry.body).toMatchObject({ clientId });
  });
});
