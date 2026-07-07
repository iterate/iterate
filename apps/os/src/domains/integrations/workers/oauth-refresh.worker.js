// The OAuth refresh secret worker (design §2.2/§3) — the whole "refresh
// machinery" cooked down to a jailed dynamic worker that OVERRIDES the secret's
// fetch(). ONE file serves every OAuth-refresh integration (Google first-party,
// petshop userspace, any bring-your-own-client): it differs only in two values,
// passed as `ctx.props` at install (design's "same file, only the app path
// differs" made literal). Proven live against dummy-petshop.
//
// Shape: read own material, let the pinned substituting outbound swap the
// access-token placeholder into the consumer request; on a 401, refresh once
// and retry. The refresh POST carries the app-tier client credential as a
// `Basic getSecret(...)` HEADER placeholder — substituted en route at the
// jailed outbound under the app secret's own pin — so this worker NEVER holds
// the client secret (ADR 0005). It reads its OWN material (the refresh token),
// which is legal in-jail: the isolate can only reach the secret's pinned hosts.
//
// This is a dynamic-worker source (loaded via WorkerLoader, bundle:false), not
// OS code — hence a plain .js imported `?raw`, kept out of the OS tsconfig.
import { WorkerEntrypoint } from "cloudflare:workers";

export default class OAuthRefreshWorker extends WorkerEntrypoint {
  async fetch(request) {
    // env.SECRET.fetch is the default substituting egress (also our
    // globalOutbound): it swaps the accessToken placeholder + pins the host.
    const response = await this.env.SECRET.fetch(request);
    if (response.status !== 401) return response;
    await this.#refresh();
    return await this.env.SECRET.fetch(request);
  }

  async #refresh() {
    const { appSecretPath, tokenUrl } = this.ctx.props;
    const material = await this.env.SECRET.read();
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // App-tier client credential as a header placeholder: substituted en
        // route under the app secret's own pin, never held here.
        authorization: 'Basic getSecret("' + appSecretPath + '", "basicAuth")',
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: material.refreshToken,
      }).toString(),
    });
    if (!response.ok) throw new Error("oauth refresh failed: " + response.status);
    const tokens = await response.json();
    await this.env.SECRET.update({
      material: {
        ...material,
        accessToken: tokens.access_token,
        // Providers usually omit refresh_token on refresh; keep the old one.
        refreshToken: tokens.refresh_token ?? material.refreshToken,
      },
    });
  }
}
