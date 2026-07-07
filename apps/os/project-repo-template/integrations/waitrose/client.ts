/**
 * Vendored Waitrose client — the wire shapes of the reverse-engineered
 * Android app against `https://www.waitrose.com`, pared down to the
 * operations this integration uses: shopping context, trolley reads and
 * writes (GraphQL), and product search (REST).
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

/** The real Waitrose origin. Override `baseUrl` only for test stand-ins. */
export const WAITROSE_BASE_URL = "https://www.waitrose.com";

/** The live GraphQL endpoint's path — appended to the base URL verbatim, so a
 * stand-in only has to swap the origin. */
export const WAITROSE_GRAPHQL_PATH = "/api/graphql-prod/graph/live";

/** The product search/browse REST base — same origin, same bearer. */
export const WAITROSE_SEARCH_PATH = "/api/content-prod/v2/cms/publish/productcontent";

/** Waitrose's edge answers UA-less requests with HTTP 520; the Android app's
 * UA is the known-good request shape. Sent on every call, mint included (the
 * platform's waitrose-session strategy carries the same value). */
export const WAITROSE_USER_AGENT = "Waitrose/3.9.1 (Android)";

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

const UPDATE_TROLLEY_ITEMS_MUTATION =
  "mutation UpdateTrolleyItems($trolleyItemsInput: [TrolleyItemInput!], $orderId: ID!) { updateTrolleyItems(trolleyItems: $trolleyItemsInput, orderId: $orderId) { trolley { orderId trolleyItems { lineNumber quantity { amount uom } totalPrice { amount currencyCode } trolleyItemId } trolleyTotals { itemTotalEstimatedCost { amount currencyCode } totalEstimatedCost { amount currencyCode } } } failures { type message } } }";

/** What `GetShoppingContext` reports: the account's customer id and its
 * current (pending) order. `customerOrderId` is what the trolley belongs to. */
export type WaitroseShoppingContext = {
  customerId: string;
  customerOrderId: string;
  customerOrderState: string;
  defaultBranchId: string;
};

/** One trolley line for `updateTrolleyItems`: quantity 0 removes the line.
 * `uom` "C62" means "each". */
export type WaitroseTrolleyItemInput = {
  canSubstitute?: boolean;
  lineNumber: string;
  noteToShopper?: string;
  quantity: { amount: number; uom: string };
};

/** A search hit, trimmed to what picking-something-to-buy needs. `lineNumber`
 * is the id `addToTrolley` takes. */
export type WaitroseSearchProduct = {
  displayPrice?: string;
  lineNumber: string;
  name: string;
  size?: string;
};

/**
 * A connection-scoped Waitrose client. `authorization` is the full header
 * value — by convention a `Bearer getSecret(...)` placeholder, never a real
 * token. A 401 normally never reaches this code (the secret's Durable Object
 * re-logins and retries en route); one that does means the re-login itself was
 * refused, e.g. a wrong password in the connection secret's material.
 */
export function waitroseClient(options: { authorization: string; baseUrl?: string }) {
  const { authorization } = options;
  const origin = (options.baseUrl ?? WAITROSE_BASE_URL).replace(/\/+$/, "");
  const url = `${origin}${WAITROSE_GRAPHQL_PATH}`;
  async function call<T>(input: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json",
        "user-agent": WAITROSE_USER_AGENT,
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

  async function shoppingContext(): Promise<WaitroseShoppingContext> {
    const data = await call<{ shoppingContext: WaitroseShoppingContext }>({
      query: GET_SHOPPING_CONTEXT_QUERY,
    });
    return data.shoppingContext;
  }

  async function updateTrolleyItems(
    items: WaitroseTrolleyItemInput[],
    orderId?: string,
  ): Promise<Record<string, unknown>> {
    // The trolley belongs to the account's pending order; resolve it when the
    // caller doesn't know it (the common case for agents).
    const id = orderId ?? (await shoppingContext()).customerOrderId;
    const data = await call<{ updateTrolleyItems: Record<string, unknown> }>({
      query: UPDATE_TROLLEY_ITEMS_MUTATION,
      variables: { orderId: id, trolleyItemsInput: items },
    });
    return data.updateTrolleyItems;
  }

  return {
    /** The account's current shopping context (customer + pending order ids). */
    shoppingContext,
    /** The trolley for one order; omit `orderId` for the context's pending order. */
    async trolley(orderId?: string): Promise<Record<string, unknown>> {
      const data = await call<{ getTrolley: Record<string, unknown> }>({
        query: GET_TROLLEY_QUERY,
        variables: orderId === undefined ? {} : { orderId },
      });
      return data.getTrolley;
    },
    /**
     * Search the product catalogue. Returns trimmed hits whose `lineNumber`
     * feeds `addToTrolley`. Search runs as the anonymous customer ("-1") —
     * results don't need the account — and deliberately sends NO branchId:
     * as of mid-2026 the API returns zero results when branchId is included.
     */
    async searchProducts(
      searchTerm: string,
      options: { size?: number; sortBy?: string; start?: number } = {},
    ): Promise<{ products: WaitroseSearchProduct[]; totalMatches: number }> {
      const response = await fetch(
        `${origin}${WAITROSE_SEARCH_PATH}/search/-1?clientType=WEB_APP`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization,
            "content-type": "application/json",
            "user-agent": WAITROSE_USER_AGENT,
          },
          body: JSON.stringify({
            customerSearchRequest: {
              queryParams: {
                searchTerm,
                size: options.size ?? 10,
                sortBy: options.sortBy ?? "RELEVANCE",
                start: options.start ?? 0,
              },
            },
          }),
        },
      );
      if (!response.ok) throw new Error(`waitrose search answered HTTP ${response.status}`);
      const raw = (await response.json()) as {
        componentsAndProducts?: Array<{ searchProduct?: Record<string, unknown> }>;
        totalMatches?: number;
      };
      const products = (raw.componentsAndProducts ?? [])
        .map((entry) => entry.searchProduct)
        .filter((product): product is Record<string, unknown> => product !== undefined)
        .map((product) => ({
          displayPrice: product.displayPrice as string | undefined,
          lineNumber: String(product.lineNumber),
          name: String(product.name),
          size: product.size as string | undefined,
        }));
      return { products, totalMatches: raw.totalMatches ?? products.length };
    },
    /** Add one product (by search-result `lineNumber`); quantity in "each". */
    addToTrolley(lineNumber: string, quantity = 1): Promise<Record<string, unknown>> {
      return updateTrolleyItems([{ lineNumber, quantity: { amount: quantity, uom: "C62" } }]);
    },
    /** Remove a line entirely (quantity 0). */
    removeFromTrolley(lineNumber: string): Promise<Record<string, unknown>> {
      return updateTrolleyItems([{ lineNumber, quantity: { amount: 0, uom: "C62" } }]);
    },
    /** Batch add/update/remove; the low-level verb the helpers above wrap. */
    updateTrolleyItems,
  };
}
