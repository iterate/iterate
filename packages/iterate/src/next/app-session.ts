import { DurableObject } from "cloudflare:workers";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded logout request, no live capabilities.
import { newHttpBatchRpcSession } from "capnweb";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { authorizationCodeRequest } from "./client/oauth.ts";
import { OAuthScopes } from "./oauth-scopes.ts";
import { isLocalOrigin } from "./lib.ts";
import type { IterateApi } from "./api.ts";

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

  /** The issuer's redirect back to `/.auth/callback`, its query string. oauth4webapi validates it
   *  (the state matches this browser's pending flow, the `iss` matches the issuer, no `error`), then
   *  exchanges the code for tokens. */
  complete(callbackQuery: string) {
    return this.#serial(async () => {
      const data = await this.ctx.storage.get<StoredSession>("session");
      if (!data || data.phase !== "pending" || data.until <= Date.now())
        return {
          error: "This sign-in expired or does not match this browser. Start sign-in again.",
        };
      const as: oauth.AuthorizationServer = {
        issuer: data.issuer,
        token_endpoint: `${data.issuer}/oauth/token`,
        authorization_response_iss_parameter_supported: true,
      };
      const client: oauth.Client = { client_id: data.clientId };
      let callback: URLSearchParams;
      try {
        callback = oauth.validateAuthResponse(
          as,
          client,
          new URLSearchParams(callbackQuery),
          data.state,
        );
      } catch (error) {
        // A provider `error=` (the person declined) ends the flow; a state/iss mismatch leaves the
        // pending flow to be retried from a genuine browser.
        if (error instanceof oauth.AuthorizationResponseError) {
          await this.#clear();
          return { error: "Authorization was declined." };
        }
        return {
          error: "This sign-in expired or does not match this browser. Start sign-in again.",
        };
      }
      const started = Date.now();
      let tokens: oauth.TokenEndpointResponse;
      try {
        const response = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          oauth.None(),
          callback,
          `${data.origin}/.auth/callback`,
          data.verifier,
          this.#tokenOptions(data),
        );
        tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
      } catch (error) {
        await this.#endOnDeadGrant(error);
        return { error: "Sign-in could not complete. Start sign-in again." };
      }
      await this.#activate(data, tokens, started);
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
          using api = newHttpBatchRpcSession<IterateApi>(
            new Request(data.resource, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(10_000),
            }),
          );
          // `authenticate(...)` returns a SessionRpcTarget STUB — its own RPC result to dispose (the
          // capnweb README's `using authedApi = api.authenticate(...)`); disposing only `api` leaves
          // it dangling and workerd warns the result was never disposed.
          using session = api.authenticate({ type: "from-server-cookie" });
          await session.logout();
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
    const as: oauth.AuthorizationServer = {
      issuer: data.issuer,
      token_endpoint: `${data.issuer}/oauth/token`,
    };
    const client: oauth.Client = { client_id: data.clientId };
    const started = Date.now();
    let tokens: oauth.TokenEndpointResponse;
    try {
      const response = await oauth.refreshTokenGrantRequest(
        as,
        client,
        oauth.None(),
        data.refreshToken,
        this.#tokenOptions(data),
      );
      tokens = await oauth.processRefreshTokenResponse(as, client, response);
    } catch (error) {
      await this.#endOnDeadGrant(error);
      return null;
    }
    return (await this.#activate(data, tokens, started)).accessToken;
  }

  /** The token request's shared options: the audience (RFC 8707 resource), a bounded timeout, and —
   *  only for a local http issuer — oauth4webapi's opt-out of its HTTPS-only default. */
  #tokenOptions(data: StoredSession): oauth.TokenEndpointRequestOptions {
    const options: oauth.TokenEndpointRequestOptions = {
      additionalParameters: { resource: data.resource },
      signal: AbortSignal.timeout(10_000),
    };
    if (isLocalOrigin(data.issuer)) options[oauth.allowInsecureRequests] = true;
    return options;
  }

  /** Write the active session from a token response. A refresh reuses the prior refresh token when
   *  the issuer does not rotate it. */
  async #activate(
    data: StoredSession,
    tokens: oauth.TokenEndpointResponse,
    started: number,
  ): Promise<Active> {
    const refreshToken =
      tokens.refresh_token || (data.phase === "active" ? data.refreshToken : undefined);
    if (!refreshToken) throw new Error("Iterate returned no refresh token.");
    const { origin, issuer, resource, clientId, next } = data;
    const stored: Active = {
      origin,
      issuer,
      resource,
      clientId,
      next,
      phase: "active",
      // An omitted (or empty) `scope` means unchanged (RFC 6749 §5.1) — keep what the grant already
      // holds rather than silently narrow to `iterate`.
      scopes: tokens.scope
        ? OAuthScopes.parse(tokens.scope.split(" ").filter(Boolean))
        : data.scopes,
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: started + (tokens.expires_in ?? 0) * 1000,
      until: data.phase === "pending" ? started + 30 * 24 * 3600_000 : data.until,
    };
    await this.ctx.storage.put("session", stored);
    await this.ctx.storage.setAlarm(stored.until);
    return stored;
  }

  /** A dead code or refresh token (`invalid_grant`) ends the session; other failures are transient. */
  async #endOnDeadGrant(error: unknown): Promise<void> {
    if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
      await this.#clear();
      return;
    }
    throw error instanceof oauth.ResponseBodyError
      ? new Error(`Iterate token exchange failed (${error.status}). Try again.`)
      : error;
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
