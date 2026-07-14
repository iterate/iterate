// The integrations & secrets model, proven end to end against the deployed
// dummy-petshop (apps/dummy-petshop) — the userspace lane. One project runs
// TWO instances of the same integration, each with its OWN OAuth client, each
// with a connection whose secret is refreshed by the SHARED oauth-refresh-token
// strategy in the Secret DO's own trusted code (no worker, no jail).
//
// What this proves that unit tests can't:
//   1. A consumer request substitutes the access token and reaches petshop.
//   2. On a real 401 (backdoor-forced token expiry) the Secret DO refreshes
//      itself — an RFC 6749 refresh_token grant against the pinned token
//      endpoint, Basic client credential from the secret's own material — and
//      the retry succeeds. Material never leaves the DO except toward the pin.
//   3. describe() never leaks material; uses land on the audit trail.
//
// Requires a deployed OS (APP_CONFIG_BASE_URL) and a reachable dummy-petshop
// (PETSHOP_BASE_URL, or derived). See petshop-support.ts.

import { expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";
import {
  PETSHOP_DEFAULT_CLIENT,
  petshopAuthorize,
  petshopBaseUrl,
  petshopExchangeCode,
  petshopExpireTokens,
  petshopMintClient,
} from "./petshop-support.ts";

const RUN = crypto.randomUUID().slice(0, 8);
const REDIRECT_URI = "https://example.com/callback";

// Opt-in: this suite talks to a deployed dummy-petshop, which only exists at
// slots where it was deployed. Point PETSHOP_BASE_URL at one to run it;
// otherwise it skips, so the shared CI e2e lane (whose preview slot has no
// petshop) stays green.
test.skipIf(!process.env.PETSHOP_BASE_URL)(
  "two OAuth clients, two connections: connect, call, forced-expiry refresh",
  async () => {
    const petshop = petshopBaseUrl();
    // Instance A uses the seeded client; instance B a freshly minted one — the
    // two-client proof. Both are project-owned (userspace) clients: the client
    // credential lives IN the connection secret's material, next to the tokens
    // (bring-your-own-app connections are self-contained cells).
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
      const connectionPath = `/secrets/integrations/${instance.slug}/${instance.connection}`;

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

      // Connection secret: tokens + client credential in material, refreshed by
      // the shared strategy. Configuring `refresh` is the trust event.
      using connectionSecret = project.secrets.get(connectionPath);
      await connectionSecret.update({
        egress: { urls: [petshop] },
        material: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          clientId: instance.clientId,
          clientSecret: instance.clientSecret,
        },
        refresh: {
          kind: "oauth-refresh-token",
          tokenEndpoint: `${petshop}/oauth/token`,
          clientCreds: "material",
        },
      });
      await waitForCondition(
        async () => (await connectionSecret.__describe()).refresh === "oauth-refresh-token",
        { description: `${instance.slug}/${instance.connection} refresh strategy to fold` },
      );

      // Authed call through the secret: token substituted, petshop sees it.
      const me = await callThroughConnection(project, connectionPath, "/api/me");
      expect(me).toMatchObject({ status: 200, body: { clientId: instance.clientId } });

      // Force a real 401 (epoch bump) and call again: the Secret DO must run
      // the refresh grant against the pinned token endpoint and retry to a 200.
      await petshopExpireTokens();
      const afterExpiry = await callThroughConnection(project, connectionPath, "/api/me");
      expect(afterExpiry).toMatchObject({ status: 200, body: { clientId: instance.clientId } });

      // Confinement: describe() leaks no token; the use is audited.
      const described = await connectionSecret.__describe();
      expect(JSON.stringify(described)).not.toContain(tokens.access_token);
      expect(JSON.stringify(described)).not.toContain(instance.clientSecret);
      expect(described).toMatchObject({ hasMaterial: true });
      await waitForCondition(
        async () => (await connectionSecret.__describe()).audit.usedCount >= 1,
        {
          description: `${instance.slug}/${instance.connection} usage audit to fold`,
        },
      );
    }
  },
);

// The first-party lane: the EXACT SAME shared refresh strategy, but its
// client credential is a platform config reference (integrations.petshop —
// APP_CONFIG_INTEGRATIONS__PETSHOP) resolved from typed AppConfig by the
// Secret DO's trusted code. No project app secret, no platform bytes in
// project material. Only `clientCreds` differs from the userspace lane.
test.skipIf(!process.env.PETSHOP_BASE_URL)(
  "first-party lane: client credential resolves from platform config, same strategy",
  async () => {
    const petshop = petshopBaseUrl();
    const slug = `petshop-firstparty-${RUN}`;
    const connectionPath = `/secrets/integrations/${slug}/acme`;
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
      refresh: {
        kind: "oauth-refresh-token",
        tokenEndpoint: `${petshop}/oauth/token`,
        clientCreds: { platform: "integrations.petshop" },
      },
    });
    await waitForCondition(
      async () => (await connectionSecret.__describe()).refresh === "oauth-refresh-token",
      { description: "first-party connection refresh strategy to fold" },
    );

    const me = await callThroughConnection(project, connectionPath, "/api/me");
    expect(me).toMatchObject({ status: 200, body: { clientId } });

    // Force a 401 and prove the strategy refreshes using the PLATFORM client
    // credential resolved from deployment config — never present in material.
    await petshopExpireTokens();
    const afterExpiry = await callThroughConnection(project, connectionPath, "/api/me");
    expect(afterExpiry).toMatchObject({ status: 200, body: { clientId } });
  },
);

/** Read a petshop JSON API through the OS egress door with an access-token
 * placeholder — the request routes to the connection secret, which substitutes
 * the token (and refreshes on 401) before it reaches petshop. */
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
