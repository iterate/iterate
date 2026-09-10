import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "./control-plane.ts";
import { authorizationCodeRequest, exchangeToken, oauthHelpers, revokeGrant } from "./oauth.ts";

const TokenResponse = z.object({
  token_type: z.literal("bearer"),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});

export type BrowserHost = {
  origin: string;
  issuer: string;
  resource: string;
  projectId: string | null;
};
type Base = BrowserHost & { clientId: string; next: string; localClient: boolean };
type Pending = Base & {
  phase: "pending";
  state: string;
  verifier: string;
  until: number;
};
type Active = Base & {
  phase: "active";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  grantId: string;
  until: number;
};
type Ended = Base & { phase: "ended"; reason: string };
type StoredSession = Pending | Active | Ended;

/** One browser login owns one provider grant. The DO's input gate serializes all
 * token operations, including refresh racing with logout. Tokens never leave the platform. */
export class BrowserSession extends DurableObject<Env> {
  begin(host: BrowserHost, next: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get("session")) throw new Error("Browser session already exists");
      const hostUrl = new URL(host.origin);
      const localClient =
        hostUrl.protocol === "http:" &&
        (hostUrl.hostname === "localhost" ||
          hostUrl.hostname.endsWith(".localhost") ||
          hostUrl.hostname === "127.0.0.1");
      if (hostUrl.protocol !== "https:" && !localClient)
        throw new Error("Browser login requires HTTPS");
      // CIMD requires public HTTPS. A local-only client fixture still uses the
      // identical code/PKCE flow, and is deleted when this DO's session ends.
      const clientId = localClient
        ? (
            await oauthHelpers(this.env).createClient({
              clientName: new URL(host.origin).host,
              redirectUris: [`${host.origin}/.auth/callback`],
              tokenEndpointAuthMethod: "none",
              grantTypes: ["authorization_code", "refresh_token"],
              responseTypes: ["code"],
            })
          ).clientId
        : `${host.origin}/.auth/client.json`;
      const { url, state, verifier } = await authorizationCodeRequest({
        issuer: host.issuer,
        clientId,
        redirectUri: `${host.origin}/.auth/callback`,
        resources: [host.resource],
      });
      const data: Pending = {
        ...host,
        next,
        clientId,
        localClient,
        phase: "pending",
        state,
        verifier,
        until: Date.now() + 10 * 60_000,
      };
      await this.ctx.storage.put("session", data);
      await this.ctx.storage.setAlarm(data.until);
      return url.href;
    });
  }

  complete(input: { state: string; issuer: string; code: string; error: string }) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const data = await this.ctx.storage.get<StoredSession>("session");
      if (
        !data ||
        data.phase !== "pending" ||
        data.until <= Date.now() ||
        data.state !== input.state ||
        data.issuer !== input.issuer
      )
        return {
          error: "This sign-in expired or does not match this browser. Start sign-in again.",
        };
      if (input.error || !input.code) {
        await this.#end(data, "Authorization declined");
        return { error: "Authorization was declined." };
      }
      const response = await this.#exchange(data, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: `${data.origin}/.auth/callback`,
        code_verifier: data.verifier,
      });
      if (!response.ok) {
        await this.#end(data, `Code exchange refused (${response.status})`);
        return { error: "Sign-in could not complete. Start sign-in again." };
      }
      await this.#saveTokens(data, response);
      return { next: data.next };
    });
  }

  bearer() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const data = await this.ctx.storage.get<StoredSession>("session");
      if (!data || !("accessToken" in data)) return null;
      if (data.until <= Date.now()) {
        await this.#end(data, "Session expired");
        return null;
      }
      // The provider retains the refresh token we used until we use a newer one.
      // If a response or storage write is lost, this stored pair is safe to retry.
      if (data.expiresAt > Date.now() + 30_000) return data.accessToken;
      const response = await this.#exchange(data, {
        grant_type: "refresh_token",
        refresh_token: data.refreshToken,
      });
      if (!response.ok) {
        await this.#end(data, `Refresh refused (${response.status})`);
        return null;
      }
      return (await this.#saveTokens(data, response)).accessToken;
    });
  }

  end() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const data = await this.ctx.storage.get<StoredSession>("session");
      if (!data || data.phase === "ended") return { cleanupPending: false };
      return this.#end(data, "Signed out");
    });
  }

  async alarm() {
    const data = await this.ctx.storage.get<StoredSession>("session");
    if (!data) return;
    if (data.phase !== "ended") await this.#end(data, "Session expired");
    if (data.localClient) await oauthHelpers(this.env).deleteClient(data.clientId);
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async #end(data: Pending | Active, reason: string) {
    const result =
      "grantId" in data ? await revokeGrant(this.env, data) : { cleanupPending: false };
    const { origin, issuer, resource, projectId, clientId, localClient, next } = data;
    await this.ctx.storage.put("session", {
      origin,
      issuer,
      resource,
      projectId,
      clientId,
      localClient,
      next,
      phase: "ended",
      reason,
    } satisfies Ended);
    await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000);
    return result;
  }

  #exchange(data: Base, fields: Record<string, string>) {
    const request = new Request(`${data.issuer}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ ...fields, client_id: data.clientId, resource: data.resource }),
    });
    // The provider's token endpoint does not use ExecutionContext. DO state also
    // supplies waitUntil; this is an in-process dispatch, never a network self-fetch.
    return exchangeToken(request, this.env, this.ctx as unknown as ExecutionContext);
  }

  async #saveTokens(data: Pending | Active, response: Response) {
    const tokens = TokenResponse.parse(await response.json());
    const summary = await oauthHelpers(this.env).unwrapToken<unknown>(tokens.access_token);
    if (!summary) throw new Error("The newly issued browser token could not be resolved");
    const { origin, issuer, resource, projectId, clientId, localClient, next } = data;
    const stored: Active = {
      origin,
      issuer,
      resource,
      projectId,
      clientId,
      localClient,
      next,
      phase: "active",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: summary.expiresAt * 1000,
      userId: summary.userId,
      grantId: summary.grantId,
      until: data.phase === "pending" ? Date.now() + 30 * 24 * 3600_000 : data.until,
    };
    await this.ctx.storage.put("session", stored);
    await this.ctx.storage.setAlarm(stored.until);
    return stored;
  }
}
