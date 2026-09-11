import { DurableObject } from "cloudflare:workers";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded logout request, no live capabilities.
import { newHttpBatchRpcSession } from "capnweb";
import { z } from "zod";
import { authorizationCodeRequest } from "./client/oauth.ts";
import { OAuthScopes } from "./oauth-scopes.ts";
import { isLocalOrigin } from "./lib.ts";
import type { SessionRpcTarget } from "./session.ts";

const TokenResponse = z.object({
  token_type: z
    .string()
    .transform((type) => type.toLowerCase())
    .pipe(z.literal("bearer")),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string(),
});
export type BrowserHost = { origin: string; issuer: string; resource: string; scopes: string[] };
type Base = BrowserHost & { clientId: string; next: string; until: number };
type Pending = Base & { phase: "pending"; state: string; verifier: string };
type Active = Base & {
  phase: "active";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};
type StoredSession = Pending | Active;

/** Each app binds this same class. Token exchange and logout use the issuer's
 * public protocol, so separately deployed apps need no platform bindings.
 * The input gate serializes refresh and logout across tabs. */
export class BrowserSession extends DurableObject {
  begin(host: BrowserHost, next: string) {
    return this.#serial(async () => {
      if (await this.ctx.storage.get("session")) throw new Error("Browser session already exists");
      const origin = new URL(host.origin);
      const local = isLocalOrigin(host.origin);
      if (origin.protocol !== "https:" && !local) throw new Error("Browser login requires HTTPS");
      let clientId = `${host.origin}/.auth/client.json`;
      if (local) {
        const response = await fetch(`${host.issuer}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: origin.host,
            redirect_uris: [`${host.origin}/.auth/callback`],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Local client registration failed (${response.status})`);
        clientId = z
          .object({ client_id: z.string().min(1) })
          .parse(await response.json()).client_id;
      }
      const { url, state, verifier } = await authorizationCodeRequest({
        issuer: host.issuer,
        clientId,
        redirectUri: `${host.origin}/.auth/callback`,
        resources: [host.resource],
        scopes: host.scopes,
      });
      const data: Pending = {
        ...host,
        next,
        clientId,
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
    return this.#serial(async () => {
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
        await this.#clear();
        return { error: "Authorization was declined." };
      }
      const stored = await this.#exchange(data, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: `${data.origin}/.auth/callback`,
        code_verifier: data.verifier,
      });
      if (!stored) return { error: "Sign-in could not complete. Start sign-in again." };
      return { next: data.next };
    });
  }

  bearer() {
    return this.#serial(() => this.#bearer());
  }
  async scopes() {
    const data = await this.ctx.storage.get<StoredSession>("session");
    return data?.phase === "active" ? data.scopes : [];
  }
  /** A verified 401 means this local credential no longer grants access. */
  discard() {
    return this.#serial(() => this.#clear());
  }

  end() {
    return this.#serial(async () => {
      const token = await this.#bearer();
      const data = await this.ctx.storage.get<StoredSession>("session");
      if (token && data) {
        // Probe classifies a revoked/expired credential without interpreting RPC error text.
        const probe = await fetch(
          new Request(data.resource, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: "",
            signal: AbortSignal.timeout(10_000),
          }),
        );
        await probe.body?.cancel();
        if (probe.status !== 401) {
          if (!probe.ok)
            throw new Error(`Sign-out could not reach Iterate (${probe.status}). Try again.`);
          // eslint-disable-next-line iterate/no-capnweb-http-batch -- A bounded logout command returns no live capabilities.
          using api = newHttpBatchRpcSession<SessionRpcTarget>(
            new Request(data.resource, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(10_000),
            }),
          );
          await api.logout();
        }
      }
      // Network failures preserve the session and are shown to the caller.
      // Successful logout has written the issuer's durable revocation marker.
      await this.#clear();
    });
  }

  async alarm() {
    // Pending flows expire in ten minutes; active grants have the same absolute
    // thirty-day lifetime at the issuer. No refresh token survives this bound.
    await this.#clear();
  }
  async #bearer() {
    const data = await this.ctx.storage.get<StoredSession>("session");
    if (!data || data.phase !== "active") return null;
    if (data.until <= Date.now()) {
      await this.#clear();
      return null;
    }
    if (data.expiresAt > Date.now() + 30_000) return data.accessToken;
    return (
      (
        await this.#exchange(data, {
          grant_type: "refresh_token",
          refresh_token: data.refreshToken,
        })
      )?.accessToken ?? null
    );
  }
  async #exchange(data: StoredSession, fields: Record<string, string>) {
    const started = Date.now();
    const response = await fetch(`${data.issuer}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ ...fields, client_id: data.clientId, resource: data.resource }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const refusal = z
        .object({ error: z.string() })
        .safeParse(await response.json().catch(() => null));
      if (response.status === 400 && refusal.success && refusal.data.error === "invalid_grant") {
        await this.#clear();
        return null;
      }
      throw new Error(`Iterate token exchange failed (${response.status}). Try again.`);
    }
    const tokens = TokenResponse.parse(await response.json());
    const { origin, issuer, resource, clientId, next } = data;
    const stored: Active = {
      origin,
      issuer,
      resource,
      clientId,
      next,
      phase: "active",
      scopes: OAuthScopes.parse(tokens.scope.split(" ").filter(Boolean)),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: started + tokens.expires_in * 1000,
      until: data.phase === "pending" ? started + 30 * 24 * 3600_000 : data.until,
    };
    await this.ctx.storage.put("session", stored);
    await this.ctx.storage.setAlarm(stored.until);
    return stored;
  }
  /** An operation failure must not reset the DO or fail other tabs' requests. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    return this.ctx
      .blockConcurrencyWhile(() =>
        work().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      )
      .then((result) => {
        if ("error" in result) throw result.error;
        return result.value;
      });
  }

  async #clear() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
