/**
 * Vendored Waitrose GraphQL client — the wire shapes of the reverse-engineered
 * Android app against `https://www.waitrose.com/api/graphql-prod/graph/live`,
 * pared down to the operations this integration uses.
 *
 * Sessions are handled by the PLATFORM, not by this client: the connection
 * secret at `/secrets/integrations/waitrose/<connection>/session` holds the
 * account's `username`/`password` and is configured with the
 * `waitrose-session` refresh strategy, so the secret's own Durable Object runs
 * {@link NEW_SESSION_MUTATION} whenever the stored session is missing (first
 * use) or a request answers 401 (Waitrose has no refresh grant — re-login IS
 * the refresh). This client only ever sends a `getSecret(...)` placeholder as
 * its bearer; project egress substitutes the real token en route, so
 * integration code never holds credentials. See ./README.md for setup.
 */

/** The real Waitrose origin. Override `baseUrl` only for test stand-ins (the
 * platform's dummy-petshop fixture serves this same GraphQL shape). */
export const WAITROSE_BASE_URL = "https://www.waitrose.com";

/** The live GraphQL endpoint's path — appended to the base URL verbatim, so a
 * stand-in only has to swap the origin. */
export const WAITROSE_GRAPHQL_PATH = "/api/graphql-prod/graph/live";

/**
 * The Android app's login mutation, verbatim — FOR REFERENCE ONLY. The
 * platform's `waitrose-session` refresh strategy carries this same string and
 * performs it inside the connection secret's Durable Object; client code never
 * logs in and never sees an accessToken.
 */
export const NEW_SESSION_MUTATION =
  "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";

const GET_SHOPPING_CONTEXT_QUERY =
  "query GetShoppingContext { shoppingContext { customerId customerOrderId customerOrderState defaultBranchId } }";

const GET_TROLLEY_QUERY =
  "query GetTrolley($orderId: ID) { getTrolley(orderId: $orderId) { checkoutReadiness { slotTypeValid } trolley { amendingOrder orderId trolleyItems { lineNumber quantity { amount uom } totalPrice { amount currencyCode } trolleyItemId } trolleyTotals { itemTotalEstimatedCost { amount currencyCode } totalEstimatedCost { amount currencyCode } trolleyItemCounts { hardConflicts noConflicts softConflicts } } } failures { type message } } }";

/** What `GetShoppingContext` reports: the account's customer id and its
 * current (pending) order. `customerOrderId` is what the trolley belongs to. */
export type WaitroseShoppingContext = {
  customerId: string;
  customerOrderId: string;
  customerOrderState: string;
  defaultBranchId: string;
};

/**
 * A connection-scoped Waitrose client. `authorization` is the full header
 * value — by convention a `Bearer getSecret(...)` placeholder, never a real
 * token. A 401 normally never reaches this code (the secret's Durable Object
 * re-logins and retries en route); one that does means the re-login itself was
 * refused, e.g. a wrong password in the connection secret's material.
 */
export function waitroseClient(options: { authorization: string; baseUrl?: string }) {
  const url = `${(options.baseUrl ?? WAITROSE_BASE_URL).replace(/\/+$/, "")}${WAITROSE_GRAPHQL_PATH}`;
  async function call<T>(input: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: options.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
    });
    if (!response.ok) throw new Error(`waitrose graphql answered HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) {
      throw new Error(
        `waitrose graphql errors: ${body.errors.map((e) => e.message ?? "unknown").join(", ")}`,
      );
    }
    if (body.data === undefined) throw new Error("waitrose graphql answered no data");
    return body.data;
  }
  return {
    /** The account's current shopping context (customer + pending order ids). */
    async shoppingContext(): Promise<WaitroseShoppingContext> {
      const data = await call<{ shoppingContext: WaitroseShoppingContext }>({
        query: GET_SHOPPING_CONTEXT_QUERY,
      });
      return data.shoppingContext;
    },
    /** The trolley for one order; omit `orderId` for the context's pending order. */
    async trolley(orderId?: string): Promise<Record<string, unknown>> {
      const data = await call<{ getTrolley: Record<string, unknown> }>({
        query: GET_TROLLEY_QUERY,
        variables: orderId === undefined ? {} : { orderId },
      });
      return data.getTrolley;
    },
  };
}
