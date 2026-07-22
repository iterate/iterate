// Waitrose access for itx: the vendored wire shapes of the reverse-engineered
// Android app against `https://www.waitrose.com`, pared down to the
// operations the integration uses — shopping context, trolley reads and
// writes (GraphQL), and product search (REST).
//
// Sessions are handled by the SECRET SYSTEM, not by this client: the
// connection secret at `/secrets/integrations/waitrose/<connection>/session`
// holds the account's `username`/`password` and is configured with the
// `waitrose-session` refresh strategy, so the secret's own Durable Object
// re-runs the vendor's NewSession login mutation (its copy lives with the
// strategy in secrets/secret-durable-object.ts) whenever the stored session
// is missing (first use) or a request answers 401 (Waitrose has no refresh grant —
// re-login IS the refresh). This client only ever sends a `getSecret(...)`
// placeholder as its bearer; project egress substitutes the real token en
// route, so no isolate outside the Secret DO ever holds credentials.

import { itxEnv } from "../../env.ts";
import { projectStub } from "../projects/egress.ts";
import { withStreamContext, type StreamContext } from "../projects/stream-context.ts";
import { waitroseSessionSecretPath } from "./utils.ts";

/** The real Waitrose origin. */
const WAITROSE_BASE_URL = "https://www.waitrose.com";

/** The live GraphQL endpoint's path — appended to the base URL verbatim. */
const WAITROSE_GRAPHQL_PATH = "/api/graphql-prod/graph/live";

/** The product search/browse REST base — same origin, same bearer. */
const WAITROSE_SEARCH_PATH = "/api/content-prod/v2/cms/publish/productcontent";

/** Waitrose's edge answers UA-less requests with HTTP 520; the Android app's
 * UA is the known-good request shape. Sent on every call, mint included (the
 * `waitrose-session` strategy carries the same value). */
const WAITROSE_USER_AGENT = "Waitrose/3.9.1 (Android)";

const GET_SHOPPING_CONTEXT_QUERY =
  "query GetShoppingContext { shoppingContext { customerId customerOrderId customerOrderState defaultBranchId } }";

// The app's GetTrolley VERBATIM (fragments and all): Waitrose's GraphQL
// gateway answers hand-slimmed selections with HTTP 400 — only the known
// app query shapes pass. $orderId is required (ID!).
const GET_TROLLEY_QUERY =
  "query GetTrolley($orderId: ID!) { getTrolley(orderId: $orderId) { checkoutReadiness { __typename ...CheckoutReadiness } products { __typename ...TrolleyProduct } slotChangeable trolley { __typename ...TrolleyResponse } instantCheckout failures { __typename ...TrolleyFailure } } }  fragment CheckoutReadiness on CheckoutReadiness { slotTypeValid }  fragment TrolleyProductCategory on TrolleyProductCategory { id name }  fragment TrolleyPrice on Price { amount currencyCode }  fragment Quantity on Quantity { amount uom }  fragment QuantityPrice on QuantityPrice { price { __typename ...TrolleyPrice } quantity { __typename ...Quantity } }  fragment Hfss on Hfss { status }  fragment ProductImage on ProductImage { extraLarge large medium small }  fragment Group on Group { name }  fragment TrolleyProductPromotion on TrolleyProductPromotion { groups { __typename ...Group } myWaitrosePromotion promotionDescription promotionExpiryDate promotionId promotionTypeCode promotionUnitPrice { __typename ...TrolleyPrice } promotionalPricePerUnit discount { type } hidden }  fragment AvailableDate on AvailableDate { startDate endDate }  fragment Restriction on Restriction { availableDates { __typename ...AvailableDate } }  fragment ProductReview on ProductReview { averageRating reviewCount }  fragment ProductServings on ProductServings { max min }  fragment ProductWeight on ProductWeight { uoms }  fragment TrolleyProduct on TrolleyProduct { categories { __typename ...TrolleyProductCategory } currentSaleUnitPrice { __typename ...QuantityPrice } defaultQuantity { __typename ...Quantity } displayPrice displayPriceEstimated displayPriceQualifier formattedPriceRange formattedWeightRange hfss { __typename ...Hfss } id leadTime lineNumber maxPersonalisedMessageLength name brandName productImageUrls { __typename ...ProductImage } productType promotions { __typename ...TrolleyProductPromotion } restriction { __typename ...Restriction } reviews { __typename ...ProductReview } servings { __typename ...ProductServings } substitutionsProhibited size thumbnail weights { __typename ...ProductWeight } depositCharge { __typename ...TrolleyPrice } }  fragment SlotOptionDatesType on SlotOptionDatesType { date type }  fragment Conflict on Conflict { productId lineNumber messages priority outOfStock resolutionActions prohibitedActions itemId type slotOptionDates { __typename ...SlotOptionDatesType } }  fragment TrolleyItem on TrolleyItem { canSubstitute lineNumber noteToShopper personalisedMessage quantity { __typename ...Quantity } reservedQuantity totalPrice { __typename ...TrolleyPrice } triggeredPromotions trolleyItemId untriggeredPromotions }  fragment TrolleyItemCounts on TrolleyItemCounts { hardConflicts noConflicts softConflicts }  fragment TrolleyTotals on TrolleyTotals { collectionMinimumOrderValue { __typename ...TrolleyPrice } deliveryCharge { __typename ...TrolleyPrice } deliveryMinimumOrderValue { __typename ...TrolleyPrice } itemTotalEstimatedCost { __typename ...TrolleyPrice } minimumSpendThresholdMet savingsFromOffers { __typename ...TrolleyPrice } savingsFromMyWaitrose { __typename ...TrolleyPrice } totalDepositCharge { __typename ...TrolleyPrice } totalEstimatedCost { __typename ...TrolleyPrice } trolleyItemCounts { __typename ...TrolleyItemCounts } }  fragment TrolleyResponse on TrolleyResponse { amendingOrder conflicts { __typename ...Conflict } orderId trolleyItems { __typename ...TrolleyItem } trolleyTotals { __typename ...TrolleyTotals } }  fragment TrolleyFailure on TrolleyFailure { message type }";

// The app's UpdateTrolleyItems VERBATIM — same 400-on-slimmed-queries rule.
const UPDATE_TROLLEY_ITEMS_MUTATION =
  "mutation UpdateTrolleyItems($trolleyItemsInput: [TrolleyItemInput!], $orderId: ID!) { updateTrolleyItems(trolleyItems: $trolleyItemsInput, orderId: $orderId) { products { __typename ...TrolleyProduct } trolley { __typename ...TrolleyResponse } instantCheckout failures { __typename ...TrolleyFailure } } }  fragment TrolleyProductCategory on TrolleyProductCategory { id name }  fragment TrolleyPrice on Price { amount currencyCode }  fragment Quantity on Quantity { amount uom }  fragment QuantityPrice on QuantityPrice { price { __typename ...TrolleyPrice } quantity { __typename ...Quantity } }  fragment Hfss on Hfss { status }  fragment ProductImage on ProductImage { extraLarge large medium small }  fragment Group on Group { name }  fragment TrolleyProductPromotion on TrolleyProductPromotion { groups { __typename ...Group } myWaitrosePromotion promotionDescription promotionExpiryDate promotionId promotionTypeCode promotionUnitPrice { __typename ...TrolleyPrice } promotionalPricePerUnit discount { type } hidden }  fragment AvailableDate on AvailableDate { startDate endDate }  fragment Restriction on Restriction { availableDates { __typename ...AvailableDate } }  fragment ProductReview on ProductReview { averageRating reviewCount }  fragment ProductServings on ProductServings { max min }  fragment ProductWeight on ProductWeight { uoms }  fragment TrolleyProduct on TrolleyProduct { categories { __typename ...TrolleyProductCategory } currentSaleUnitPrice { __typename ...QuantityPrice } defaultQuantity { __typename ...Quantity } displayPrice displayPriceEstimated displayPriceQualifier formattedPriceRange formattedWeightRange hfss { __typename ...Hfss } id leadTime lineNumber maxPersonalisedMessageLength name brandName productImageUrls { __typename ...ProductImage } productType promotions { __typename ...TrolleyProductPromotion } restriction { __typename ...Restriction } reviews { __typename ...ProductReview } servings { __typename ...ProductServings } substitutionsProhibited size thumbnail weights { __typename ...ProductWeight } depositCharge { __typename ...TrolleyPrice } }  fragment SlotOptionDatesType on SlotOptionDatesType { date type }  fragment Conflict on Conflict { productId lineNumber messages priority outOfStock resolutionActions prohibitedActions itemId type slotOptionDates { __typename ...SlotOptionDatesType } }  fragment TrolleyItem on TrolleyItem { canSubstitute lineNumber noteToShopper personalisedMessage quantity { __typename ...Quantity } reservedQuantity totalPrice { __typename ...TrolleyPrice } triggeredPromotions trolleyItemId untriggeredPromotions }  fragment TrolleyItemCounts on TrolleyItemCounts { hardConflicts noConflicts softConflicts }  fragment TrolleyTotals on TrolleyTotals { collectionMinimumOrderValue { __typename ...TrolleyPrice } deliveryCharge { __typename ...TrolleyPrice } deliveryMinimumOrderValue { __typename ...TrolleyPrice } itemTotalEstimatedCost { __typename ...TrolleyPrice } minimumSpendThresholdMet savingsFromOffers { __typename ...TrolleyPrice } savingsFromMyWaitrose { __typename ...TrolleyPrice } totalDepositCharge { __typename ...TrolleyPrice } totalEstimatedCost { __typename ...TrolleyPrice } trolleyItemCounts { __typename ...TrolleyItemCounts } }  fragment TrolleyResponse on TrolleyResponse { amendingOrder conflicts { __typename ...Conflict } orderId trolleyItems { __typename ...TrolleyItem } trolleyTotals { __typename ...TrolleyTotals } }  fragment TrolleyFailure on TrolleyFailure { message type }";

/** What `GetShoppingContext` reports: the account's customer id and its
 * current (pending) order. `customerOrderId` is what the trolley belongs to. */
type WaitroseShoppingContext = {
  customerId: string;
  customerOrderId: string;
  customerOrderState: string;
  defaultBranchId: string;
};

/** How to drive the Waitrose built-in: a named connection, then a client
 * method. The single source of truth for the dispatch guard (rpc-targets). */
export const WAITROSE_CALL_GRAMMAR =
  'Use itx.integrations.waitrose.get(connection?).<method>, for example itx.integrations.waitrose.get("mum").searchProducts("oat milk", { size: 5 }).';

/** A search hit, trimmed to what picking-something-to-buy needs. `lineNumber`
 * is the id `addToTrolley` takes. */
type WaitroseSearchProduct = {
  displayPrice?: string;
  lineNumber: string;
  name: string;
  size?: string;
};

/**
 * A connection-scoped Waitrose client. `authorization` is the full header
 * value — by convention a `Bearer getSecret(...)` placeholder, never a real
 * token; `fetcher` is where requests go (the project egress door for the
 * built-in). A 401 normally never reaches this code (the secret's Durable
 * Object re-logins and retries en route); one that does means the re-login
 * itself was refused, e.g. a wrong password in the connection secret's
 * material.
 */
function waitroseClient(options: {
  authorization: string;
  baseUrl?: string;
  fetcher?: (request: Request) => Promise<Response>;
}) {
  const { authorization } = options;
  const doFetch = options.fetcher ?? ((request: Request) => fetch(request));
  const origin = (options.baseUrl ?? WAITROSE_BASE_URL).replace(/\/+$/, "");
  const url = `${origin}${WAITROSE_GRAPHQL_PATH}`;
  async function call<T>(input: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<T> {
    const response = await doFetch(
      new Request(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization,
          "content-type": "application/json",
          "user-agent": WAITROSE_USER_AGENT,
        },
        body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
      }),
    );
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

  // One trolley line per item: quantity 0 removes the line; `uom` "C62"
  // means "each".
  async function updateTrolleyItems(
    items: Array<{
      canSubstitute?: boolean;
      lineNumber: string;
      noteToShopper?: string;
      quantity: { amount: number; uom: string };
    }>,
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
      // GetTrolley's $orderId is non-null: resolve the pending order when the
      // caller doesn't know it (the common case for agents).
      const id = orderId ?? (await shoppingContext()).customerOrderId;
      const data = await call<{ getTrolley: Record<string, unknown> }>({
        query: GET_TROLLEY_QUERY,
        variables: { orderId: id },
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
      const response = await doFetch(
        new Request(`${origin}${WAITROSE_SEARCH_PATH}/search/-1?clientType=WEB_APP`, {
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
        }),
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

/**
 * The Waitrose client for one named connection whose transport rides the
 * project egress door — the session token stays in its Secret DO (a
 * `getSecret(...)` placeholder in the Authorization header, substituted
 * downstream; the `waitrose-session` strategy mints on first use and
 * re-logins on 401). The itx caller surface
 * `itx.integrations.waitrose.get("<connection>")` replays the caller's method
 * path straight onto this instance.
 */
export function connectionWaitroseClient(input: {
  connection: string;
  projectId: string;
  streamContext: StreamContext;
}): ReturnType<typeof waitroseClient> {
  const stub = projectStub(itxEnv.PROJECT, input.projectId);
  return waitroseClient({
    authorization: `Bearer getSecret("${waitroseSessionSecretPath(input.connection)}", { field: "accessToken" })`,
    fetcher: (request) => stub.fetch(withStreamContext(request, input.streamContext)),
  });
}
