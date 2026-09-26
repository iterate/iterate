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
 *   fixture password as /api/legacy-login) → a sealed session token that
 *   lives {@link GRAPHQL_SESSION_TTL_SECONDS}s. A wrong password answers HTTP
 *   200 with a GraphQL-style `failures` array (type `AUTHENTICATION_FAILED`).
 * - Revocation is per endpoint AND per account: `POST /__backdoor/expire-tokens`
 *   with `{ clientId: "graphql-session-login" }` kills every session, with
 *   `{ clientId: graphqlSessionAccountClientId(username) }` only that
 *   account's — what a test that forces a 401 wants, since this ONE shop
 *   serves every concurrent CI run.
 * - Anything else on the GraphQL endpoint is a loud `errors` answer: it
 *   logs you in; the API it unlocks is `/api/*`.
 */
import { LOGIN_PASSWORD } from "./oauth-provider.ts";
import { nowSeconds, seal, unseal } from "./seal.ts";

/** How long a GraphQL-minted session lives: the pets API's ordinary two
 * minutes (state.ts DEFAULT_ACCESS_TTL_SECONDS). It was 3 s, which a session
 * could outlive between its mint and its first use: a secret's Durable Object
 * appends its `secret/refreshed` fact between the two, and under a loaded e2e
 * run that took longer, so a just-minted session answered 401 (PR #2940
 * 8324a3cc). A test forces its 401 through the backdoor instead. */
export const GRAPHQL_SESSION_TTL_SECONDS = 120;

/** The client every GraphQL-minted session belongs to (`/api/me`'s `clientId`)
 * — its revocation epoch is the whole endpoint's. */
export const GRAPHQL_SESSION_CLIENT_ID = "graphql-session-login";

/** The revocation key of ONE account's GraphQL sessions: expire-tokens with
 * it bumps that account's epoch and no one else's. */
export const graphqlSessionAccountClientId = (username: string) =>
  `${GRAPHQL_SESSION_CLIENT_ID}:${username}`;

/** What the endpoint needs from the shop: the sealing key and a per-call read of
 * the revocation epochs a session of `username` is bound to — the endpoint's and
 * the account's — so targeted expiry invalidates outstanding sessions exactly
 * like every other petshop token. */
export interface GraphqlLoginDeps {
  sealKey: string;
  getAccessTokenEpochs(username: string): Promise<{ epoch: number; accountEpoch: number }>;
}

/** Sealed GraphQL-minted session token: expiring and epoch-bound like an
 * OAuth access token; {@link graphqlSessionFromBearer} lets the pets API
 * accept it as a bearer grant. */
export interface GraphqlSessionPayload {
  t: "graphql-session";
  /** The login username — the grant's subject on the pets API. */
  sub: string;
  /** The endpoint's revocation epoch at mint. */
  epoch: number;
  /** The account's revocation epoch at mint. */
  accountEpoch: number;
  exp: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function mintSession(
  variables: Record<string, unknown>,
  deps: GraphqlLoginDeps,
): Promise<Response> {
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
  const payload: GraphqlSessionPayload = {
    t: "graphql-session",
    sub: username,
    ...(await deps.getAccessTokenEpochs(username)),
    exp: nowSeconds() + GRAPHQL_SESSION_TTL_SECONDS,
  };
  return json({
    data: {
      generateSession: {
        __typename: "SetSessionPayload",
        accessToken: await seal(payload, deps.sealKey),
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
 * Resolve a bearer token to a live GraphQL-minted session, or null — how the
 * pets API accepts this endpoint's sessions as grants (worker.ts accessGrant).
 */
export async function graphqlSessionFromBearer(
  token: string,
  deps: GraphqlLoginDeps,
): Promise<GraphqlSessionPayload | null> {
  const session = await unseal<GraphqlSessionPayload>(token, deps.sealKey);
  if (!session || session.t !== "graphql-session") return null;
  if (session.exp < nowSeconds()) return null;
  const { epoch, accountEpoch } = await deps.getAccessTokenEpochs(session.sub);
  if (session.epoch !== epoch || session.accountEpoch !== accountEpoch) return null;
  return session;
}

/**
 * The GraphQL login endpoint. `NewSession` is the ONLY operation — this endpoint
 * authenticates; the API it unlocks is `/api/*`. Anything else answers a
 * GraphQL-style `errors` body so a drifted client fails loudly rather than
 * quietly getting an empty `data`.
 */
export async function handleGraphqlLogin(
  request: Request,
  deps: GraphqlLoginDeps,
): Promise<Response> {
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
