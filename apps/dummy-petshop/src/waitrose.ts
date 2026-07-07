/**
 * The Waitrose-shaped GraphQL fixture (design R8, the username/password →
 * session-token archetype): petshop's stand-in for
 * `https://www.waitrose.com/api/graphql-prod/graph/live`, exactly the three
 * operations the OS side's `waitrose-session` refresh strategy and the seeded
 * project-repo template integration exercise end to end:
 *
 * - `NewSession`  — login. Any username, password "correct-horse" (the same
 *   fixture password as /api/legacy-login) → a sealed session token that
 *   lives ~{@link WAITROSE_SESSION_TTL_SECONDS}s, so a cached token hits real
 *   re-mint fast. A wrong password answers HTTP 200 with a GraphQL-style
 *   `failures` array (type `AUTHENTICATION_FAILED`), like the real API.
 * - `GetShoppingContext` — bearer-protected; the customer/order ids derive
 *   deterministically from the login username.
 * - `GetTrolley` — bearer-protected; a small fixed trolley for the given
 *   (or context-default) order id.
 *
 * Any invalid/expired/epoch-revoked bearer is a flat HTTP 401 — that status is
 * what triggers the OS Secret DO's re-login. Tokens minted here are their own
 * sealed type: a Waitrose session is not a pet-API bearer (and vice versa),
 * matching how unrelated the two services would be in reality.
 */
import { nowSeconds, seal, unseal } from "./seal.ts";

/** How long a Waitrose fixture session lives. Deliberately ~3 seconds: short
 * enough that an e2e proves re-mint-on-401 without a backdoor call, long
 * enough for the mint → first-use round trip. */
export const WAITROSE_SESSION_TTL_SECONDS = 3;

/** The fixture login password (any username works) — same convention as
 * petshop's legacy-login endpoint. */
export const WAITROSE_PASSWORD = "correct-horse";

/** What the fixture needs from the shop: the sealing key and a per-call read
 * of the access-token epoch, so `POST /__backdoor/expire-tokens` invalidates
 * outstanding Waitrose sessions exactly like every other petshop token. */
export interface WaitroseGraphqlDeps {
  sealKey: string;
  getAccessTokenEpoch(): Promise<number>;
}

/** Sealed Waitrose session token: expiring and epoch-bound like an OAuth
 * access token, but a distinct type — only this GraphQL surface accepts it. */
interface WaitroseSessionPayload {
  t: "waitrose-session";
  /** The login username; every id in the fixture data derives from it. */
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

/** The ids `GetShoppingContext` reports for a username — deterministic so a
 * spec can predict the order id a fresh login shops against. */
function shoppingContextFor(username: string) {
  return {
    customerId: `customer-${username}`,
    customerOrderId: `order-${username}`,
    customerOrderState: "PENDING",
    defaultBranchId: "branch-petshop",
  };
}

async function mintSession(
  variables: Record<string, unknown>,
  deps: WaitroseGraphqlDeps,
): Promise<Response> {
  const input = (variables.input ?? {}) as Record<string, unknown>;
  const username = typeof input.username === "string" ? input.username : "";
  if (!username || input.password !== WAITROSE_PASSWORD) {
    // The real API answers a bad login with HTTP 200 and a failures array —
    // the client (and the OS strategy) must read the body, not the status.
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
  const payload: WaitroseSessionPayload = {
    t: "waitrose-session",
    sub: username,
    epoch: await deps.getAccessTokenEpoch(),
    exp: nowSeconds() + WAITROSE_SESSION_TTL_SECONDS,
  };
  const context = shoppingContextFor(username);
  return json({
    data: {
      generateSession: {
        __typename: "SetSessionPayload",
        accessToken: await seal(payload, deps.sealKey),
        // Waitrose has no refresh grant — re-login is the refresh — so the
        // refreshToken is a decoy, exactly as useless as the real one.
        refreshToken: "re-login-is-the-refresh",
        ...context,
        expiresIn: WAITROSE_SESSION_TTL_SECONDS,
        failures: null,
      },
    },
  });
}

/** Resolve the request's bearer to a live Waitrose session, or null. */
async function sessionFromRequest(
  request: Request,
  deps: WaitroseGraphqlDeps,
): Promise<WaitroseSessionPayload | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!/^bearer /i.test(header)) return null;
  const session = await unseal<WaitroseSessionPayload>(header.slice(7).trim(), deps.sealKey);
  if (!session || session.t !== "waitrose-session") return null;
  if (session.exp < nowSeconds()) return null;
  if (session.epoch !== (await deps.getAccessTokenEpoch())) return null;
  return session;
}

/** A small fixed trolley, shaped like the app's `GetTrolley` response (the
 * fragments the vendored client selects), petshop-flavored contents. */
function trolleyFor(orderId: string) {
  const price = (amount: number) => ({ amount, currencyCode: "GBP" });
  return {
    checkoutReadiness: { slotTypeValid: true },
    products: [
      {
        __typename: "TrolleyProduct",
        id: "petshop-kibble-2kg",
        lineNumber: "088211",
        name: "Essential Kibble 2kg",
        brandName: "Pawtrose",
        displayPrice: "£3.50",
        size: "2kg",
        thumbnail: "https://petshop.example/kibble.jpg",
        productType: "G",
      },
    ],
    slotChangeable: true,
    trolley: {
      amendingOrder: false,
      conflicts: [],
      orderId,
      trolleyItems: [
        {
          canSubstitute: true,
          lineNumber: "088211",
          noteToShopper: null,
          personalisedMessage: null,
          quantity: { amount: 1, uom: "C62" },
          reservedQuantity: 1,
          totalPrice: price(3.5),
          triggeredPromotions: [],
          trolleyItemId: 1,
          untriggeredPromotions: [],
        },
      ],
      trolleyTotals: {
        deliveryCharge: null,
        itemTotalEstimatedCost: price(3.5),
        minimumSpendThresholdMet: true,
        savingsFromMyWaitrose: null,
        savingsFromOffers: null,
        totalEstimatedCost: price(3.5),
        trolleyItemCounts: { hardConflicts: 0, noConflicts: 1, softConflicts: 0 },
      },
    },
    instantCheckout: false,
    failures: null,
  };
}

/**
 * The one GraphQL door. Operations are matched by their (mandatory) operation
 * name — the three the fixture serves are exactly the three the OS side needs;
 * anything else is a GraphQL-style `errors` answer so a drifted client fails
 * loudly rather than quietly getting an empty `data`.
 */
export async function handleWaitroseGraphql(
  request: Request,
  deps: WaitroseGraphqlDeps,
): Promise<Response> {
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query : "";
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const operation = query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/)?.[1];
  if (!operation) {
    return json({ errors: [{ message: "operation name required" }] }, 400);
  }

  if (operation === "NewSession") return mintSession(variables, deps);

  const session = await sessionFromRequest(request, deps);
  // The 401 (not a GraphQL error body) is load-bearing: it is what the OS
  // Secret DO's waitrose-session strategy re-logins on.
  if (!session) return json({ error: "invalid_token" }, 401);

  if (operation === "GetShoppingContext") {
    return json({ data: { shoppingContext: shoppingContextFor(session.sub) } });
  }
  if (operation === "GetTrolley") {
    const orderId =
      typeof variables.orderId === "string" && variables.orderId
        ? variables.orderId
        : shoppingContextFor(session.sub).customerOrderId;
    return json({ data: { getTrolley: trolleyFor(orderId) } });
  }
  return json({ errors: [{ message: `unsupported operation ${JSON.stringify(operation)}` }] });
}
