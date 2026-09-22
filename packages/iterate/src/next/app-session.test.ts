// Real PKCE/token code with an in-memory DurableObject store and a controlled OAuth token endpoint.
// Preview smoke verifies the same flow against the deployed issuer and actual DurableObjects.
import { afterEach, expect, test, vi } from "vitest";
import { BrowserSession } from "./app-session.ts";

function fixture() {
  const values = new Map<string, unknown>();
  const session = new BrowserSession(
    {
      storage: {
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
        setAlarm: async () => {},
        deleteAll: async () => {
          values.clear();
        },
        deleteAlarm: async () => {},
      },
      blockConcurrencyWhile: async <T>(work: () => Promise<T>) => work(),
    } as unknown as DurableObjectState,
    {},
  );
  return { session };
}

afterEach(() => vi.unstubAllGlobals());

test("a device's client id is used at authorization, code exchange and refresh, and its branding survives activation", async () => {
  const { session } = fixture();
  const client = {
    id: "https://kit.example/devices/satellite1/clients/unit.json",
    name: "Satellite1",
    logoUri: "https://kit.example/vendors/futureproofhomes.png",
  };
  const authorize = new URL(
    await session.begin(
      {
        origin: "https://kit.example",
        issuer: "https://issuer.example",
        resource: "https://issuer.example/api",
        scopes: ["iterate", "account"],
        client,
      },
      "/devices/satellite1/firmware/latest",
    ),
  );
  expect(authorize.searchParams.get("client_id")).toBe(client.id);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(await session.client()).toBeUndefined();
  const requests: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(new URLSearchParams(init.body as string));
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: requests.length === 1 ? 0 : 3600,
      });
    }),
  );
  const callback = new URLSearchParams({
    code: "code",
    state: authorize.searchParams.get("state")!,
    iss: "https://issuer.example",
  });
  expect(await session.complete(callback.toString())).toEqual({
    next: "/devices/satellite1/firmware/latest",
  });
  expect(await session.client()).toEqual(client);
  expect(await session.bearer()).toBe("access");
  expect(requests.map((request) => [request.get("client_id"), request.get("grant_type")])).toEqual([
    [client.id, "authorization_code"],
    [client.id, "refresh_token"],
  ]);
  expect(await session.client()).toEqual(client);
  await session.discard();
  expect(await session.client()).toBeUndefined();
});

test("ordinary app sessions retain their existing origin client", async () => {
  const { session } = fixture();
  const url = new URL(
    await session.begin(
      {
        origin: "https://notes.example",
        issuer: "https://issuer.example",
        resource: "https://issuer.example/api",
        scopes: ["iterate"],
      },
      "/",
    ),
  );
  expect(url.searchParams.get("client_id")).toBe("https://notes.example/.auth/client.json");
});
