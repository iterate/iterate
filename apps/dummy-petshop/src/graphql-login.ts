/**
 * The GraphQL session-login door (design R8, the username/password →
 * session-token archetype): one more way to authenticate against petshop's
 * ONE pets API, alongside OAuth, the legacy JSON login, MCP, and the
 * WebSocket gateways. Some real-world vendors authenticate exactly like
 * this — a GraphQL `NewSession` mutation trading email+password for a
 * short-lived bearer with no refresh grant — and the OS side carries a named
 * refresh strategy speaking this wire shape; this door is what that strategy
 * is exercised against end to end.
 *
 * - `NewSession` — login. Any username, password "correct-horse" (the same
 *   fixture password as /api/legacy-login) → a sealed session token that
 *   lives ~{@link GRAPHQL_SESSION_TTL_SECONDS}s, so a cached token hits real
 *   re-mint fast. A wrong password answers HTTP 200 with a GraphQL-style
 *   `failures` array (type `AUTHENTICATION_FAILED`).
 * - Anything else on the GraphQL door is a loud `errors` answer: the door
 *   logs you in; the API it unlocks is `/api/*`.
 */
import { nowSeconds, seal, unseal } from "./seal.ts";

/** How long a GraphQL-minted session lives. Deliberately ~3 seconds: short
 * enough that an e2e proves re-mint-on-401 without a backdoor call, long
 * enough for the mint → first-use round trip. */
export const GRAPHQL_SESSION_TTL_SECONDS = 3;

/** The fixture login password (any username works) — same convention as
 * petshop's legacy-login endpoint. */
export const GRAPHQL_LOGIN_PASSWORD = "correct-horse";

/** What the door needs from the shop: the sealing key and a per-call read of
 * the GraphQL login client's revocation epoch, so targeted expiry invalidates
 * its outstanding sessions exactly like every other petshop token. */
export interface GraphqlLoginDeps {
  sealKey: string;
  getAccessTokenEpoch(): Promise<number>;
}

/** Sealed GraphQL-minted session token: expiring and epoch-bound like an
 * OAuth access token; {@link graphqlSessionFromBearer} lets the pets API
 * accept it as a bearer grant. */
export interface GraphqlSessionPayload {
  t: "graphql-session";
  /** The login username — the grant's subject on the pets API. */
  sub: string;
  epoch: number;
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
  if (!username || input.password !== GRAPHQL_LOGIN_PASSWORD) {
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
    epoch: await deps.getAccessTokenEpoch(),
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
 * pets API accepts this door's sessions as grants (worker.ts accessGrant).
 */
export async function graphqlSessionFromBearer(
  token: string,
  deps: GraphqlLoginDeps,
): Promise<GraphqlSessionPayload | null> {
  const session = await unseal<GraphqlSessionPayload>(token, deps.sealKey);
  if (!session || session.t !== "graphql-session") return null;
  if (session.exp < nowSeconds()) return null;
  if (session.epoch !== (await deps.getAccessTokenEpoch())) return null;
  return session;
}

/**
 * The GraphQL login door. `NewSession` is the ONLY operation — this door
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
        message: `unsupported operation ${JSON.stringify(operation)} — this door only logs in (NewSession); the API is /api/*`,
      },
    ],
  });
}
