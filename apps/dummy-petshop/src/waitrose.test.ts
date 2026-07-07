/**
 * Unit tests for the Waitrose-shaped GraphQL fixture (waitrose.ts), run in
 * plain Node through the whole HTTP surface like worker.test.ts: the real
 * route handler and the real PetshopStateDurableObject over an in-memory
 * storage fake.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { seedPets } from "./pets.ts";
import { randomSealKey } from "./seal.ts";
import { PetshopStateDurableObject } from "./state.ts";
import { WAITROSE_PASSWORD, WAITROSE_SESSION_TTL_SECONDS } from "./waitrose.ts";
import { handlePetshopRequest, type PetshopDeps } from "./worker.ts";

/** One shop "environment": the app over the real state class and an in-memory storage fake. */
type Shop = (path: string, init?: RequestInit) => Promise<Response>;

function makeShop(): Shop {
  const blobs = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(blobs.get(key)),
    put: async (key: string, value: unknown) => void blobs.set(key, structuredClone(value)),
  };
  const deps: PetshopDeps = {
    state: new PetshopStateDurableObject({ storage } as unknown as DurableObjectState, {}),
    sealKey: randomSealKey(),
    pets: seedPets(),
  };
  return (path, init) =>
    handlePetshopRequest(new Request(`https://petshop.example${path}`, init), deps);
}

function graphql(
  shop: Shop,
  input: { query: string; variables?: Record<string, unknown>; token?: string; path?: string },
): Promise<Response> {
  return shop(input.path ?? "/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
  });
}

/** Log in with the fixture password and return the session payload. */
async function login(shop: Shop, username = "jonas@example.com", password = WAITROSE_PASSWORD) {
  const response = await graphql(shop, {
    query:
      "mutation NewSession($input: SessionInput) { generateSession(session: $input) { accessToken } }",
    variables: { input: { username, password, clientId: "ANDROID_APP" } },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { generateSession: Record<string, unknown> } };
  return body.data.generateSession;
}

afterEach(() => vi.useRealTimers());

describe("waitrose-shaped graphql fixture", () => {
  test("NewSession mints a session with deterministic shopping-context ids", async () => {
    const shop = makeShop();
    const session = await login(shop, "family@example.com");
    expect(session.failures).toBeNull();
    expect(session.accessToken).toEqual(expect.any(String));
    expect(session).toMatchObject({
      customerId: "customer-family@example.com",
      customerOrderId: "order-family@example.com",
      expiresIn: WAITROSE_SESSION_TTL_SECONDS,
    });
  });

  test("a wrong password is HTTP 200 with an AUTHENTICATION_FAILED failure, like the real API", async () => {
    const shop = makeShop();
    const session = await login(shop, "family@example.com", "wrong-horse");
    expect(session.accessToken).toBeNull();
    expect(session.failures).toEqual([
      { type: "AUTHENTICATION_FAILED", message: "incorrect username or password" },
    ]);
  });

  test("queries want the bearer: valid token works, absent/expired/epoch-revoked are flat 401s", async () => {
    const shop = makeShop();
    vi.useFakeTimers({ now: Date.now() });
    const token = (await login(shop)).accessToken as string;
    const contextQuery = "query GetShoppingContext { shoppingContext { customerId } }";

    const noToken = await graphql(shop, { query: contextQuery });
    expect(noToken.status).toBe(401);

    const authed = await graphql(shop, { query: contextQuery, token });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({
      data: {
        shoppingContext: {
          customerId: "customer-jonas@example.com",
          customerOrderId: "order-jonas@example.com",
          customerOrderState: "PENDING",
          defaultBranchId: "branch-petshop",
        },
      },
    });

    // Past the ~3s TTL the token is dead — the OS strategy's cue to re-login.
    vi.advanceTimersByTime((WAITROSE_SESSION_TTL_SECONDS + 1) * 1000);
    expect((await graphql(shop, { query: contextQuery, token })).status).toBe(401);

    // A fresh token dies instantly on an epoch bump (backdoor token expiry).
    const fresh = (await login(shop)).accessToken as string;
    await shop("/__backdoor/expire-tokens", { method: "POST" });
    expect((await graphql(shop, { query: contextQuery, token: fresh })).status).toBe(401);
  });

  test("GetTrolley answers for the requested order id, on both the canonical and live-alias paths", async () => {
    const shop = makeShop();
    const token = (await login(shop)).accessToken as string;
    for (const path of ["/graphql", "/api/graphql-prod/graph/live"]) {
      const response = await graphql(shop, {
        path,
        query: "query GetTrolley($orderId: ID!) { getTrolley { trolley { orderId } } }",
        variables: { orderId: "order-jonas@example.com" },
        token,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { getTrolley: any } };
      expect(body.data.getTrolley.trolley.orderId).toBe("order-jonas@example.com");
      expect(body.data.getTrolley.trolley.trolleyItems).toHaveLength(1);
      expect(body.data.getTrolley.failures).toBeNull();
    }
  });

  test("an unsupported operation fails loudly with a GraphQL errors body", async () => {
    const shop = makeShop();
    const token = (await login(shop)).accessToken as string;
    const response = await graphql(shop, {
      query: "query GetCampaigns { campaigns { id } }",
      token,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      errors: [{ message: 'unsupported operation "GetCampaigns"' }],
    });
  });
});
