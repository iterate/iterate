/**
 * dummy-petshop — a deliberately fake third-party service ("the pet shop")
 * for exercising Iterate's integrations & secrets system end to end
 * (apps/os/e2e/support/petshop.ts is the OS side's client): ONE pets API
 * behind many authentication schemes — its own OAuth 2.0 provider, a legacy
 * email+password login, a GraphQL session login, a Tesco-shaped form login, MCP,
 * OpenAPI and capnweb surfaces, two WebSocket gateways — plus Slack-, Google-,
 * Cloudflare- and GitHub-shaped fakes at those services' own paths, and a
 * backdoor for the tests. GET / documents the whole surface.
 *
 * The worker is stateless: durable state is one JSON blob in the
 * PetshopStateDurableObject (durable-object.ts), and every code and token is a
 * sealed AES-GCM blob (seal.ts).
 */
import dedent from "dedent";
import { z } from "zod";
import { openAccessToken } from "./authorization-server.ts";
import { handleCapnwebRequest } from "./capnweb.ts";
import { handleCloudflareRequest } from "./cloudflare.ts";
import { handleGatewayRequest } from "./gateway.ts";
import {
  handleGithubRequest,
  handleGithubTestControls,
  INSTALLATION_TOKEN,
  INSTALLATION_TOKEN_TTL_SECONDS,
  type InstallationGrant,
} from "./github.ts";
import { handleGoogleRequest } from "./google.ts";
import {
  GRAPHQL_SESSION_CLIENT_ID,
  GRAPHQL_SESSION_TTL_SECONDS,
  type GraphqlLoginDeps,
  graphqlSessionAccountClientId,
  graphqlSessionFromBearer,
  handleGraphqlLogin,
} from "./graphql-login.ts";
import { handleMcpRequest } from "./mcp.ts";
import { handleOauthProviderRequest, LOGIN_PASSWORD, petshopOauth } from "./oauth-provider.ts";
import { handlePetsApiRequest, petshopOpenApiDocument } from "./openapi.ts";
import { type Pet, seedPets } from "./pets.ts";
import { nowSeconds } from "./seal.ts";
import { handleSlackRequest, handleSlackTestControls } from "./slack.ts";
import {
  accessTokenEpochFor,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_APP_ID,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_INSTALLATION_ID,
  type ShopDeps,
} from "./state.ts";
import { PetshopStateDurableObject } from "./durable-object.ts";
import { handleTescoLogin, TESCO_ACCESS_TTL_SECONDS } from "./tesco-login.ts";

export { PetshopStateDurableObject };

/** Bindings the worker runs with (vite.config.ts). */
export interface Env {
  PETSHOP_STATE: DurableObjectNamespace<PetshopStateDurableObject>;
  /** Seals every code/token; 32 bytes base64. A worker secret, set once; deploys keep it. */
  PETSHOP_SEAL_KEY: string;
}

// The index doubles as endpoint documentation, so anyone poking a deployed
// instance sees the whole surface without opening the repo.
const INDEX = dedent`
  🐾 dummy-petshop — a fake third party for integrations & secrets e2e

  GET  /.well-known/oauth-authorization-server   RFC 8414 — authorize/token/register endpoints, PKCE S256
  POST /oauth/register      RFC 7591 registration → a client pinned to its redirect_uris; token_endpoint_auth_method "none" ⇒ public (no secret, PKCE)
  GET  /oauth/authorize     ?client_id&redirect_uri&state[&code_challenge][&user=x] — consent at once: 302 redirect_uri?code=…&state=…
  POST /oauth/token         grant_type=authorization_code | refresh_token; HTTP Basic or client_secret in the form, client_id alone for a public client (PKCE required)
  POST /api/legacy-login    {email, password} → {accessToken, expiresInSeconds}; any email, password "${LOGIN_PASSWORD}"
  POST /graphql             GraphQL session login: NewSession (any username, password "${LOGIN_PASSWORD}")
                            → a ${GRAPHQL_SESSION_TTL_SECONDS}s session token, a bearer on /api/*; no refresh grant — logging in again is the refresh
  GET  /api/tesco/login     the Tesco-shaped two-step login, step one → {csrf} + Set-Cookie tesco_login (binds the token)
  POST /api/tesco/login     form email, password, _csrf with that cookie → {access_token, expires_in: ${TESCO_ACCESS_TTL_SECONDS}}; any email,
                            password "${LOGIN_PASSWORD}"; a bearer on /api/*; expire-tokens {clientId: "tesco-login:<email>"} revokes it
  GET  /api/me              bearer whoami: {sub, clientId, tokenExpiresInSeconds}; +{installationId, appId} for an installation token
  GET  /api/pets            the account's (entirely fictional) pets

  GET  /openapi.json        OpenAPI 3.1 doc for the typed pets API (listPets/getPet/createPet); bearer-protected
  GET|POST /api/v2/*        those procedures, REST-shaped
  GET|POST /mcp             MCP server (streamable HTTP): tools list_pets, get_pet, create_pet; bearer-protected
  POST /capnweb             capnweb HTTP batch: the same pets API as ONE RPC object; bearer-protected
  GET  /capnweb               (websocket) — the same capnweb API as a session; the bearer rides the UPGRADE
  GET  /gateway               (websocket) — token in the first {op:identify, token} FRAME (Discord shape)
  GET  /gateway-header        (websocket) — token in the Authorization: Bearer UPGRADE header (OpenAI-Realtime shape)

  GET  /oauth/v2/authorize · POST /api/oauth.v2.access | auth.test | chat.postMessage | auth.revoke
                            a Slack-shaped fake at Slack's own paths (slack.ts): consent at once, &team=<id> picks the workspace
  GET  /.well-known/openid-configuration · /oauth2/v3/certs · /o/oauth2/v2/auth · POST /token | /revoke · GET /oauth2/v2/userinfo | /gmail/v1/users/me/profile
                            a Google-shaped fake (google.ts), an OpenID provider too: consent at once, &email=<e> (or login_hint) picks the account
  GET  /cloudflare/.well-known/openid-configuration · /cloudflare/oauth2/auth · POST /cloudflare/oauth2/token · GET /client/v4/user
                            a Cloudflare-shaped fake (cloudflare.ts): its OpenID issuer under /cloudflare, &email=<e> picks the account
  GET  /apps/<slug>/installations/new · /login/oauth/authorize · POST /login/oauth/access_token · /app/installations/<id>/access_tokens
  GET  /user | /user/emails | /user/installations | /user/memberships/orgs/<org> | /installation/repositories
  GET  /repos/<o>/<r>/pulls/<n>/files · POST /repos/<o>/<r>/check-runs · GET /repos/<o>/<r>/commits/<sha>/check-runs
                            a GitHub-shaped fake at GitHub's own paths (github.ts); an App JWT (RS256, iss=appId) mints a
                            ${INSTALLATION_TOKEN_TTL_SECONDS}s installation token, a bearer on /api/* too

  POST /__backdoor/clients                 → mint {clientId, clientSecret}
  POST /__backdoor/expire-tokens           {clientId} → that client's outstanding access tokens answer 401
                                           ("graphql-session-login:<username>": one account's GraphQL sessions)
  POST /__backdoor/revoke-refresh-token    {refreshToken} → that refresh token stops working
  POST /__backdoor/fail-token-endpoint     {clientId, times} → that client's next N token calls answer 500
  POST /__backdoor/apps                    {publicKeyPem, installationId?, appId?, webhookSecret?, appSlug?, callbackUrl?, account?, users?, oauthClientId?}
                                           → register or replace a GitHub App installation (its public key only)
  POST /__backdoor/apps/fire-webhook       {installationId?, url, event?, badSignature?, deliveryId?, eventName?} → deliver a webhook signed
                                           x-hub-signature-256 with the installation's webhookSecret
  POST /__backdoor/github/pulls · GET /__backdoor/github/check-runs?installation=   seed a pull request, read the check runs
  GET  /__backdoor/slack/messages?team=<id>      what chat.postMessage recorded for that workspace
  POST /__backdoor/slack/fire-webhook      {url, signingSecret, event, badSignature?} → POST it signed like Slack (x-slack-signature v0)

  Seeded client: ${DEFAULT_CLIENT_ID} / ${DEFAULT_CLIENT_SECRET} · access tokens live ${DEFAULT_ACCESS_TTL_SECONDS}s ·
  seeded GitHub App ${DEFAULT_APP_ID}, installation ${DEFAULT_INSTALLATION_ID} (no key until POST /__backdoor/apps)
`;

/** The GraphQL login's view of the shop: the sealing key, and the two revocation epochs a session
 *  of `username` is bound to — the endpoint's (`graphql-session-login`) and the account's. */
const graphqlLoginDeps = (deps: ShopDeps): GraphqlLoginDeps => ({
  sealKey: deps.sealKey,
  getAccessTokenEpochs: (username) =>
    deps.state.getState().then((state) => ({
      epoch: accessTokenEpochFor(state, GRAPHQL_SESSION_CLIENT_ID),
      accountEpoch: accessTokenEpochFor(state, graphqlSessionAccountClientId(username)),
    })),
});

/** The request's bearer as a live grant on the pets API — the shop's own access token (OAuth, the
 *  legacy, Tesco and GraphQL logins) or a GitHub installation token — or null. */
async function accessGrant(
  request: Request,
  deps: ShopDeps,
): Promise<{
  sub: string;
  clientId: string;
  exp: number;
  installation?: InstallationGrant;
} | null> {
  const token = /^bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!token) return null;
  const access = await petshopOauth(deps).openAccessToken(token);
  if (access) return { sub: access.grant.sub, clientId: access.clientId, exp: access.exp };
  const installation = await openAccessToken<InstallationGrant>(deps, INSTALLATION_TOKEN, token);
  if (installation)
    return {
      sub: `installation:${installation.grant.installationId}`,
      clientId: installation.clientId,
      exp: installation.exp,
      installation: installation.grant,
    };
  const session = await graphqlSessionFromBearer(token, graphqlLoginDeps(deps));
  if (session) return { sub: session.sub, clientId: GRAPHQL_SESSION_CLIENT_ID, exp: session.exp };
  return null;
}

const ExpireTokens = z.object({ clientId: z.string().min(1) });
const RevokeRefreshToken = z.object({ refreshToken: z.string() });
const FailTokenEndpoint = z.object({ clientId: z.string().min(1), times: z.int().nonnegative() });

/** The tests' controls of the shop's own provider, then the fakes' (slack.ts, github.ts). */
async function backdoor(key: string, request: Request, deps: ShopDeps): Promise<Response> {
  const body = () => request.json().catch(() => null);
  const invalid = (error_description: string) =>
    Response.json({ error: "invalid_request", error_description }, { status: 400 });
  if (key === "POST /__backdoor/clients")
    return Response.json(await deps.state.createClient({}), { status: 201 });
  if (key === "POST /__backdoor/expire-tokens") {
    const input = ExpireTokens.safeParse(await body());
    if (!input.success)
      return invalid("clientId is required so expiry cannot affect unrelated tests");
    const { clientId } = input.data;
    return Response.json({
      clientId,
      accessTokenEpoch: await deps.state.expireAccessTokens(clientId),
    });
  }
  if (key === "POST /__backdoor/revoke-refresh-token") {
    const input = RevokeRefreshToken.safeParse(await body());
    if (!input.success || !(await petshopOauth(deps).revokeRefreshToken(input.data.refreshToken)))
      return invalid("refreshToken must be a refresh token of the shop's own provider");
    return Response.json({ revoked: true });
  }
  if (key === "POST /__backdoor/fail-token-endpoint") {
    const input = FailTokenEndpoint.safeParse(await body());
    if (!input.success)
      return invalid(
        "clientId (so failures cannot affect unrelated tests) and times, a non-negative integer, are required",
      );
    await deps.state.setTokenEndpointFailures(input.data.clientId, input.data.times);
    return Response.json({
      clientId: input.data.clientId,
      tokenEndpointFailuresRemaining: input.data.times,
    });
  }
  return (
    (await handleSlackTestControls(request, deps)) ??
    (await handleGithubTestControls(request, deps)) ??
    Response.json({ error: "not_found" }, { status: 404 })
  );
}

/** What the routes need: the shop's state and sealing key, and the account's (fictional) pet
 *  catalogue, shared by GET /api/pets, the OpenAPI procedures, capnweb and the MCP tools. */
type PetshopDeps = ShopDeps & { pets: Pet[] };

async function handlePetshopRequest(request: Request, deps: PetshopDeps): Promise<Response> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /")
    return new Response(INDEX, { headers: { "content-type": "text/plain; charset=utf-8" } });
  if (url.pathname.startsWith("/__backdoor/")) return backdoor(key, request, deps);
  const answered =
    (await handleOauthProviderRequest(request, deps)) ??
    (await handleSlackRequest(request, deps)) ??
    (await handleGoogleRequest(request, deps)) ??
    (await handleCloudflareRequest(request, deps)) ??
    (await handleGithubRequest(request, deps)) ??
    (await handleTescoLogin(request, deps)) ??
    (await handleGatewayRequest(request, deps));
  if (answered) return answered;
  if (key === "POST /graphql") return handleGraphqlLogin(request, graphqlLoginDeps(deps));
  // Everything below is the pets API, behind the bearer.
  const isPetsApi =
    key === "GET /api/me" ||
    key === "GET /api/pets" ||
    key === "GET /openapi.json" ||
    url.pathname.startsWith("/api/v2") ||
    url.pathname === "/mcp" ||
    url.pathname === "/capnweb";
  if (!isPetsApi) return Response.json({ error: "not_found" }, { status: 404 });
  const grant = await accessGrant(request, deps);
  if (!grant) return Response.json({ error: "invalid_token" }, { status: 401 });
  const context = { owner: grant.sub, pets: deps.pets };
  if (key === "GET /api/me")
    return Response.json({
      sub: grant.sub,
      clientId: grant.clientId,
      tokenExpiresInSeconds: grant.exp - nowSeconds(),
      // an installation token names its installation, so the OS side can assert which it minted
      ...grant.installation,
    });
  if (key === "GET /api/pets") return Response.json({ owner: grant.sub, pets: deps.pets });
  if (key === "GET /openapi.json") return Response.json(await petshopOpenApiDocument(url.origin));
  if (url.pathname === "/mcp") return handleMcpRequest(request, context);
  if (url.pathname === "/capnweb") return handleCapnwebRequest(request, context);
  return (
    (await handlePetsApiRequest(request, context)) ??
    Response.json({ error: "not_found" }, { status: 404 })
  );
}

// Seeded once per isolate, so createPet mutations last the isolate's lifetime.
const petCatalogue = seedPets();

/** A call to the state Durable Object that the platform failed: workerd stamps it `retryable` (the
 *  transport was cut), `overloaded`, or `durableObjectReset` (a deploy or a storage failure reset
 *  the object under the call). */
const isDurableObjectFailure = (error: unknown): error is Error =>
  error instanceof Error &&
  ["retryable", "overloaded", "durableObjectReset"].some(
    (flag) => Reflect.get(error, flag) === true,
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handlePetshopRequest(request, {
        state: env.PETSHOP_STATE.get(env.PETSHOP_STATE.idFromName("global")),
        sealKey: env.PETSHOP_SEAL_KEY,
        pets: petCatalogue,
      });
    } catch (error) {
      if (!isDurableObjectFailure(error)) throw error;
      // The caller gets the platform's message instead of Cloudflare's error page, and the shop's
      // log names the call it failed.
      console.error({
        event: "petshop.state-failed",
        request: `${request.method} ${new URL(request.url).pathname}`,
        message: error.message,
      });
      return Response.json(
        { error: "temporarily_unavailable", error_description: error.message },
        { status: 503 },
      );
    }
  },
};
