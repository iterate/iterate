// The GitHub App installation-token secret worker (design §9 P4, ADR 0006). A
// GitHub App acts as an installation by minting a short-lived installation
// token: sign an App JWT with the App's RS256 private key, POST it to
// /app/installations/{id}/access_tokens, use the returned token as the bearer.
//
// The private key NEVER enters this jail. The worker signs via
// `env.APP.sign()` — a compute-only stub over the app-tier secret (project
// secret for a bring-your-own-App integration, or a platform secret for the
// first-party App) that returns a signature, never the key (same attenuation
// as hmac; ADR 0006). So a platform private key is safe to use here.
//
// Shape mirrors the OAuth refresh worker, but "refresh" is "mint via signed
// JWT" instead of a refresh_token grant. `ctx.props`: appId (the App's id, the
// JWT `iss` — public), apiBase (GitHub API origin — real or the petshop
// stand-in), and appSecretPath (which app secret env.APP signs with).
import { WorkerEntrypoint } from "cloudflare:workers";

function base64Url(input) {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default class GithubInstallWorker extends WorkerEntrypoint {
  async fetch(request) {
    // No token yet (first use after connect) → mint before the first call.
    const material = await this.env.SECRET.read();
    if (material.accessToken === undefined) await this.#mint();
    // env.SECRET.fetch substitutes the accessToken placeholder + pins the host.
    const response = await this.env.SECRET.fetch(request);
    if (response.status !== 401) return response;
    await this.#mint();
    return await this.env.SECRET.fetch(request);
  }

  async #mint() {
    const { apiBase, appId } = this.ctx.props;
    const material = await this.env.SECRET.read();
    // GitHub App JWT: RS256 over header.payload, iss = appId, <=10min TTL.
    const now = Math.floor(Date.now() / 1000);
    const signingInput =
      base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
      "." +
      base64Url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }));
    // env.APP.sign signs with the App private key WITHOUT returning it.
    const signature = await this.env.APP.sign({
      algo: "RS256",
      field: "privateKey",
      payload: signingInput,
    });
    const jwt = signingInput + "." + signature;
    const response = await fetch(
      apiBase + "/app/installations/" + material.installationId + "/access_tokens",
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer " + jwt,
          "user-agent": "iterate-os",
        },
      },
    );
    if (!response.ok) throw new Error("github installation token mint failed: " + response.status);
    const data = await response.json();
    await this.env.SECRET.update({ material: { ...material, accessToken: data.token } });
  }
}
