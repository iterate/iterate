/**
 * The GraphQL session-login endpoint (the username/password → session-token
 * archetype): one more way to authenticate against petshop's ONE pets API,
 * alongside OAuth, the legacy JSON login, MCP, and the WebSocket gateways. Some real-world vendors authenticate exactly like
 * this — a GraphQL `NewSession` mutation trading email+password for a
 * short-lived bearer with no refresh grant — and the OS side carries a named
 * refresh strategy speaking this wire shape; this endpoint is what that strategy
 * is exercised against end to end.
 *
 * - `NewSession` — login. Any username, password "correct-horse" (the same
 *   fixture password as /api/legacy-login) → a session token that lives
 *   {@link GRAPHQL_SESSION_TTL_SECONDS}s. A wrong password answers HTTP 200
 *   with a GraphQL-style `failures` array (type `AUTHENTICATION_FAILED`).
 * - The session token is the shop's own access token (oauth-provider.ts) of
 *   the client `graphql-session-login` (`/api/me`'s `clientId`), its account
 *   the username: `POST /__test-controls/expire-tokens` with
 *   `{ clientId: "graphql-session-login", account: username }` ends that
 *   account's sessions and no other's (why: state.ts `accessTokenEpochs`).
 * - Anything else on the GraphQL endpoint is a loud `errors` answer: it
 *   logs you in; the API it unlocks is `/api/*`.
 */
import { LOGIN_PASSWORD, petshopOauth } from "./oauth-provider.ts";
import type { ShopDeps } from "./state.ts";

/** How long a GraphQL-minted session lives: the pets API's ordinary two
 * minutes (state.ts DEFAULT_ACCESS_TTL_SECONDS). A session must outlive the
 * gap between its mint and its first use, in which a secret's Durable Object
 * appends its `secret/refreshed` fact and which a loaded e2e run stretches; a
 * test forces its 401 through expire-tokens instead. */
export const GRAPHQL_SESSION_TTL_SECONDS = 120;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function mintSession(variables: Record<string, unknown>, deps: ShopDeps): Promise<Response> {
  const input = (variables.input ?? {}) as Record<string, unknown>;
  const username = typeof input.username === "string" ? input.username : "";
  if (!username || input.password !== LOGIN_PASSWORD) {
    // Vendors with this login style answer a bad login with a failures array
    // in a 200 — a client (and the OS strategy) must read the body, not just
    // the status.
    return json({
      data: {
        generateSession: {
          __typename: "SetSessionPayload",
          accessToken: null,
          refreshToken: null,
          customerId: null,
          customerOrderId: null,
          customerOrderState: null,
          defaultBranchId: null,
          expiresIn: null,
          failures: [{ type: "AUTHENTICATION_FAILED", message: "incorrect username or password" }],
        },
      },
    });
  }
  const accessToken = await petshopOauth(deps).accessToken(
    "graphql-session-login",
    { sub: username },
    GRAPHQL_SESSION_TTL_SECONDS,
  );
  return json({
    data: {
      generateSession: {
        __typename: "SetSessionPayload",
        accessToken,
        // No refresh grant in this auth style — re-login is the refresh — so
        // the refreshToken is a decoy.
        refreshToken: "re-login-is-the-refresh",
        customerId: `customer-${username}`,
        customerOrderId: `order-${username}`,
        customerOrderState: "PENDING",
        defaultBranchId: "branch-petshop",
        expiresIn: GRAPHQL_SESSION_TTL_SECONDS,
        failures: null,
      },
    },
  });
}

/**
 * The GraphQL login endpoint. `NewSession` is the ONLY operation — this endpoint
 * authenticates; the API it unlocks is `/api/*`. Anything else answers a
 * GraphQL-style `errors` body so a drifted client fails loudly rather than
 * quietly getting an empty `data`.
 */
export async function handleGraphqlLogin(request: Request, deps: ShopDeps): Promise<Response> {
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query : "";
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const operation = query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/)?.[1];
  if (!operation) {
    return json({ errors: [{ message: "operation name required" }] }, 400);
  }
  if (operation === "NewSession") return mintSession(variables, deps);
  return json({
    errors: [
      {
        message: `unsupported operation ${JSON.stringify(operation)} — this endpoint only logs in (NewSession); the API is /api/*`,
      },
    ],
  });
}
