// The GitHub-App installation lane of the integrations model, proven end to
// end against the deployed dummy-petshop's GitHub-App stand-in. A GitHub App
// acts *as an installation* by minting a short-lived installation token: sign
// an App JWT with the App's RS256 private key, POST it to
// /app/installations/{id}/access_tokens, use the returned token as a bearer.
//
// What this proves that unit tests can't:
//   1. The Secret DO's github-app-installation strategy mints on first use —
//      trusted DO code signs the App JWT with the key from the secret's own
//      material and stores the returned installation token. No worker, no jail.
//   2. A real deployment verifies that signature (petshop holds only the PUBLIC
//      key) and issues an installation token the secret then substitutes.
//   3. On a real 401 (backdoor epoch bump invalidates the installation token)
//      the strategy re-mints and the retry succeeds.
//   4. describe() never leaks the private key; uses land on the audit trail.
//
// This is the USERSPACE "bring-your-own App" shape: the App private key lives
// in the connection secret's material (`privateKey: "material"`). The
// first-party lane is structurally identical — `privateKey: { platform:
// "integrations.github" }` resolves the deployment's App key from typed config
// instead — so proving one proves both.
//
// Requires a deployed OS (APP_CONFIG_BASE_URL) and a reachable dummy-petshop
// (PETSHOP_BASE_URL, or derived). See petshop-support.ts.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";
import { petshopBaseUrl, petshopExpireTokens, petshopRegisterApp } from "./petshop-support.ts";

const RUN = crypto.randomUUID().slice(0, 8);

/** Call a petshop installation-scoped API through the OS egress door with an
 * access-token placeholder: the request routes to the connection secret, whose
 * strategy mints the installation token (and re-mints on 401) before
 * substituting it and reaching petshop. */
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
  test("bring-your-own App: mint installation token in the Secret DO, act as the installation, re-mint on expiry", async () => {
    const petshop = petshopBaseUrl();
    const appId = `gh-app-${RUN}`;
    const installationId = `gh-inst-${RUN}`;

    // The App keypair. Its PRIVATE half (PKCS#8 PEM) goes into the connection
    // secret's material and is only ever signed with inside the DO; its PUBLIC
    // half (SPKI PEM) is all petshop holds, to verify the App JWTs.
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

    const connectionPath = `/secrets/integrations/mygithub-${RUN}/acme`;

    // Connection secret: the App private key in material, the installation to
    // act as in the strategy config (the installation id is public). Egress is
    // pinned to petshop (the mint POST and the API call both go there).
    // Configuring `refresh` is the trust event.
    using connectionSecret = project.secrets.get(connectionPath);
    await connectionSecret.update({
      egress: { urls: [petshop] },
      material: { privateKey },
      refresh: {
        kind: "github-app-installation",
        apiBase: petshop,
        appId,
        installationId,
        privateKey: "material",
      },
    });
    await waitForCondition(
      async () => (await connectionSecret.describe()).refresh === "github-app-installation",
      { description: "github installation strategy to fold" },
    );

    // First authed call: no token yet → the strategy signs an App JWT with the
    // key from material → petshop verifies it against the public key → mints an
    // installation token → the secret substitutes it. petshop names which
    // installation we're acting as.
    const me = await callThroughConnection(project, connectionPath, "/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ installationId, appId });

    // Force a real 401 (epoch bump invalidates the installation token) and call
    // again: the strategy must re-mint (sign a fresh JWT) and retry to a 200.
    await petshopExpireTokens();
    const afterExpiry = await callThroughConnection(project, connectionPath, "/api/me");
    expect(afterExpiry.status).toBe(200);
    expect(afterExpiry.body).toMatchObject({ installationId, appId });

    // Confinement: the App private key never left the secret; describe() leaks
    // neither the key nor a minted token. Egress uses land on the audit trail.
    const described = await connectionSecret.describe();
    expect(JSON.stringify(described)).not.toContain("BEGIN PRIVATE KEY");
    expect(described.hasMaterial).toBe(true);
    expect(described.refresh).toBe("github-app-installation");
    await waitForCondition(async () => (await connectionSecret.describe()).audit.usedCount >= 1, {
      description: "github connection egress use to audit",
    });
  });
});
