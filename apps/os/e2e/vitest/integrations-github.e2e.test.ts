// The GitHub-App installation lane of the integrations model (design §9 P4,
// ADR 0006), proven end to end against the deployed dummy-petshop's GitHub-App
// stand-in. A GitHub App acts *as an installation* by minting a short-lived
// installation token: sign an App JWT with the App's RS256 private key, POST it
// to /app/installations/{id}/access_tokens, use the returned token as a bearer.
//
// What this proves that unit tests can't:
//   1. The installation-token worker (github-install.worker.js) loads in the
//      jail and mints on first use — the private key NEVER enters the jail; the
//      worker signs the App JWT via env.APP.sign, a compute-only stub over the
//      app-tier secret that returns a signature, never the key.
//   2. A real deployment verifies that signature (petshop holds only the PUBLIC
//      key) and issues an installation token the worker then rides as a bearer.
//   3. On a real 401 (backdoor epoch bump invalidates the installation token)
//      the worker re-mints itself and the retry succeeds.
//   4. describe() never leaks the private key; the sign use is audited.
//
// This is the USERSPACE "bring-your-own App" shape: the App private key lives in
// a project app-secret (env.APP routes to that Secret DO). The first-party lane
// is structurally identical — appSecretPath is the virtual platform secret
// /secrets/platform/integrations/github instead — so proving one proves both.
//
// Requires a deployed OS (APP_CONFIG_BASE_URL) and a reachable dummy-petshop
// (PETSHOP_BASE_URL, or derived). See petshop-support.ts.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { githubInstallWorkerRef } from "../../src/domains/integrations/workers/github-install.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";
import { petshopBaseUrl, petshopExpireTokens, petshopRegisterApp } from "./petshop-support.ts";

const RUN = crypto.randomUUID().slice(0, 8);

/** Call a petshop installation-scoped API through the OS egress door with an
 * access-token placeholder: the request routes to the connection secret, whose
 * worker mints the installation token (and re-mints on 401) before substituting
 * it and reaching petshop. */
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

// Opt-in: talks to a deployed dummy-petshop (see integrations-petshop.e2e.test).
describe.skipIf(!process.env.PETSHOP_BASE_URL)("GitHub App installation lane", () => {
  test("bring-your-own App: sign JWT in-jail, mint installation token, act as the installation, re-mint on expiry", async () => {
    const petshop = petshopBaseUrl();
    const appId = `gh-app-${RUN}`;
    const installationId = `gh-inst-${RUN}`;

    // The App keypair. Its PRIVATE half (PKCS#8 PEM) goes into the project app
    // secret and is only ever signed with; its PUBLIC half (SPKI PEM) is all
    // petshop holds, to verify the App JWTs.
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await petshopRegisterApp({ appId, installationId, publicKeyPem: publicKey });

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({ slug: `github-${RUN}` });
    await project.__describe();

    const appPath = `/secrets/integrations/mygithub-${RUN}`;
    const connectionPath = `${appPath}/acme`;

    // App-tier secret: the App private key. No egress — it is never fetched
    // through, only signed with (sign() is compute; ADR 0006). env.APP over this
    // path exposes sign/hmac/matches and nothing else.
    using appSecret = project.secrets.get(appPath);
    await appSecret.update({ material: { privateKey } });
    await waitForCondition(async () => (await appSecret.describe()).hasMaterial, {
      description: "github app secret to fold",
    });

    // Connection secret: which installation to act as + the installation-token
    // worker. Egress is pinned to petshop (the worker's mint POST and the API
    // call both go there). Installing the worker is the trust event (§2.2).
    using connectionSecret = project.secrets.get(connectionPath);
    await connectionSecret.update({
      egress: { urls: [petshop] },
      material: { installationId },
      worker: githubInstallWorkerRef({ apiBase: petshop, appId, appSecretPath: appPath }),
    });
    await waitForCondition(async () => (await connectionSecret.describe()).hasWorker, {
      description: "github installation worker to install",
    });

    // First authed call: no token yet → the worker signs an App JWT with the
    // project app key (env.APP.sign, in-jail) → petshop verifies it against the
    // public key → mints an installation token → the worker rides it. petshop
    // names which installation we're acting as.
    const me = await callThroughConnection(project, connectionPath, "/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ installationId, appId });

    // Force a real 401 (epoch bump invalidates the installation token) and call
    // again: the worker must re-mint (sign a fresh JWT) and retry to a 200.
    await petshopExpireTokens();
    const afterExpiry = await callThroughConnection(project, connectionPath, "/api/me");
    expect(afterExpiry.status).toBe(200);
    expect(afterExpiry.body).toMatchObject({ installationId, appId });

    // Confinement: the App private key never left the app secret; neither the
    // app secret's nor the connection secret's describe() leaks the key or a
    // minted token. The connection's egress uses land on its audit trail.
    const describedApp = await appSecret.describe();
    const describedConn = await connectionSecret.describe();
    expect(JSON.stringify(describedApp)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(describedConn)).not.toContain("BEGIN PRIVATE KEY");
    expect(describedApp.hasMaterial).toBe(true);
    expect(describedConn.hasWorker).toBe(true);
    await waitForCondition(async () => (await connectionSecret.describe()).audit.usedCount >= 1, {
      description: "github connection egress use to audit",
    });
  });
});
