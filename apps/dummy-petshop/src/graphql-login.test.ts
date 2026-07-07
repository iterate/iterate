/**
 * Unit tests for the GraphQL session-login door (graphql-login.ts), run in
 * plain Node through the whole HTTP surface like worker.test.ts: the real
 * route handler and the real PetshopStateDurableObject over an in-memory
 * storage fake.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { GRAPHQL_LOGIN_PASSWORD, GRAPHQL_SESSION_TTL_SECONDS } from "./graphql-login.ts";
import { seedPets } from "./pets.ts";
import { randomSealKey } from "./seal.ts";
import { PetshopStateDurableObject } from "./state.ts";
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
  input: { query: string; variables?: Record<string, unknown> },
): Promise<Response> {
  return shop("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
  });
}

/** Log in with the fixture password and return the session payload. */
async function login(
  shop: Shop,
  username = "jonas@example.com",
  password = GRAPHQL_LOGIN_PASSWORD,
) {
  const response = await graphql(shop, {
    query:
      "mutation NewSession($input: SessionInput) { generateSession(session: $input) { accessToken } }",
    variables: { input: { username, password, clientId: "MOBILE_APP" } },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { generateSession: Record<string, unknown> } };
  return body.data.generateSession;
}

function api(shop: Shop, path: string, token: string): Promise<Response> {
  return shop(path, { headers: { authorization: `Bearer ${token}` } });
}

afterEach(() => vi.useRealTimers());

describe("graphql session-login door", () => {
  test("NewSession mints a session with deterministic customer/order ids and no refresh grant", async () => {
    const shop = makeShop();
    const session = await login(shop, "family@example.com");
    expect(session.failures).toBeNull();
    expect(session.accessToken).toEqual(expect.any(String));
    expect(session).toMatchObject({
      customerId: "customer-family@example.com",
      customerOrderId: "order-family@example.com",
      refreshToken: "re-login-is-the-refresh",
      expiresIn: GRAPHQL_SESSION_TTL_SECONDS,
    });
  });

  test("a wrong password is HTTP 200 with an AUTHENTICATION_FAILED failure, not a 4xx", async () => {
    const shop = makeShop();
    const session = await login(shop, "family@example.com", "wrong-horse");
    expect(session.accessToken).toBeNull();
    expect(session.failures).toEqual([
      { type: "AUTHENTICATION_FAILED", message: "incorrect username or password" },
    ]);
  });

  test("the minted session is an ordinary bearer on the pets API", async () => {
    const shop = makeShop();
    const token = (await login(shop)).accessToken as string;

    expect((await shop("/api/me")).status).toBe(401);

    const me = await api(shop, "/api/me", token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      sub: "jonas@example.com",
      clientId: "graphql-session-login",
    });

    const pets = await api(shop, "/api/pets", token);
    expect(pets.status).toBe(200);
    expect(await pets.json()).toMatchObject({ owner: "jonas@example.com" });
  });

  test("sessions die at the ~3s TTL and on an epoch bump — the strategy's cues to re-login", async () => {
    const shop = makeShop();
    vi.useFakeTimers({ now: Date.now() });
    const token = (await login(shop)).accessToken as string;
    expect((await api(shop, "/api/me", token)).status).toBe(200);

    vi.advanceTimersByTime((GRAPHQL_SESSION_TTL_SECONDS + 1) * 1000);
    expect((await api(shop, "/api/me", token)).status).toBe(401);

    const fresh = (await login(shop)).accessToken as string;
    await shop("/__backdoor/expire-tokens", { method: "POST" });
    expect((await api(shop, "/api/me", fresh)).status).toBe(401);
  });

  test("any operation other than NewSession is a loud error — the door only logs in", async () => {
    const shop = makeShop();
    const response = await graphql(shop, {
      query: "query GetShoppingContext { shoppingContext { customerId } }",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0].message).toMatch(/only logs in \(NewSession\); the API is \/api\/\*/);

    const nameless = await graphql(shop, { query: "{ shoppingContext { customerId } }" });
    expect(nameless.status).toBe(400);
  });
});
