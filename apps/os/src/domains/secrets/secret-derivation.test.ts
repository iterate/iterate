import { describe, expect, it } from "vitest";
import {
  deriveViaHttpExchange,
  jsonPointerGet,
  materialIsStale,
  parseSecretKeyReferences,
  substituteSecretKeyReferences,
} from "./secret-derivation.ts";

const NOW = Date.parse("2026-06-11T12:00:00.000Z");

describe("secret key references (the egress placeholder language)", () => {
  it("parses and substitutes getSecret({ key }) references", async () => {
    const text =
      "user=getSecret({ key: \"waitrose/username\" })&pw=getSecret({key:'waitrose/password'})";
    expect(parseSecretKeyReferences(text)).toEqual(["waitrose/username", "waitrose/password"]);

    const resolved: string[] = [];
    const substituted = await substituteSecretKeyReferences(text, async (key) => {
      resolved.push(key);
      return key === "waitrose/username" ? "jonas@example.com" : "hunter2";
    });
    expect(substituted).toBe("user=jonas@example.com&pw=hunter2");
    expect(resolved.sort()).toEqual(["waitrose/password", "waitrose/username"]);
  });

  it("resolves each unique key once", async () => {
    let calls = 0;
    await substituteSecretKeyReferences(
      'a=getSecret({ key: "k" }) b=getSecret({ key: "k" })',
      async () => {
        calls += 1;
        return "v";
      },
    );
    expect(calls).toBe(1);
  });
});

describe("deriveViaHttpExchange", () => {
  it("derives oauth-style material with expires_in from the response", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const derived = await deriveViaHttpExchange({
      derivation: {
        kind: "http-exchange",
        request: {
          url: "https://oauth2.googleapis.com/token",
          method: "POST",
          body: 'grant_type=refresh_token&refresh_token=getSecret({ key: "google/refresh-token" })',
        },
        extract: { materialPointer: "/access_token", expiresInPointer: "/expires_in" },
        refreshLeewaySeconds: 30,
      },
      resolveSecretKey: async () => "refresh-token-material",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return Response.json({ access_token: "ya29.fresh", expires_in: 3600 });
      }) as typeof fetch,
      nowMs: NOW,
    });

    expect(requests).toEqual([
      {
        url: "https://oauth2.googleapis.com/token",
        body: "grant_type=refresh_token&refresh_token=refresh-token-material",
      },
    ]);
    expect(derived).toEqual({
      material: "ya29.fresh",
      expiresAt: new Date(NOW + 3600 * 1000).toISOString(),
    });
  });

  it("uses the fixed ttl when the API returns no expiry (the waitrose case)", async () => {
    const derived = await deriveViaHttpExchange({
      derivation: {
        kind: "http-exchange",
        request: { url: "https://www.waitrose.com/api/graphql-prod/graph/live", method: "POST" },
        extract: { materialPointer: "/data/generateSession/accessToken", ttlSeconds: 300 },
        refreshLeewaySeconds: 30,
      },
      resolveSecretKey: async () => "unused",
      fetchImpl: (async () =>
        Response.json({ data: { generateSession: { accessToken: "session-1" } } })) as typeof fetch,
      nowMs: NOW,
    });
    expect(derived).toEqual({
      material: "session-1",
      expiresAt: new Date(NOW + 300 * 1000).toISOString(),
    });
  });

  it("fails loudly when the exchange yields no material", async () => {
    await expect(
      deriveViaHttpExchange({
        derivation: {
          kind: "http-exchange",
          request: { url: "https://example.com/token", method: "POST" },
          extract: { materialPointer: "/access_token" },
          refreshLeewaySeconds: 30,
        },
        resolveSecretKey: async () => "unused",
        fetchImpl: (async () => Response.json({ error: "invalid_grant" })) as typeof fetch,
        nowMs: NOW,
      }),
    ).rejects.toThrow(/no material/);
  });
});

describe("materialIsStale", () => {
  it("treats missing material, near-expiry, and past-expiry as stale", () => {
    const expiresAt = new Date(NOW + 60 * 1000).toISOString();
    expect(materialIsStale({ hasMaterial: false, leewaySeconds: 0, nowMs: NOW })).toBe(true);
    expect(materialIsStale({ hasMaterial: true, expiresAt, leewaySeconds: 30, nowMs: NOW })).toBe(
      false,
    );
    expect(materialIsStale({ hasMaterial: true, expiresAt, leewaySeconds: 90, nowMs: NOW })).toBe(
      true,
    );
    expect(
      materialIsStale({
        hasMaterial: true,
        expiresAt,
        leewaySeconds: 0,
        nowMs: NOW + 61 * 1000,
      }),
    ).toBe(true);
    // No expiry → never stale on its own.
    expect(materialIsStale({ hasMaterial: true, leewaySeconds: 0, nowMs: NOW })).toBe(false);
  });
});

describe("jsonPointerGet", () => {
  it("walks nested objects and arrays", () => {
    const body = { data: { generateSession: { accessToken: "t" } }, list: [{ v: 1 }] };
    expect(jsonPointerGet(body, "/data/generateSession/accessToken")).toBe("t");
    expect(jsonPointerGet(body, "/list/0/v")).toBe(1);
    expect(jsonPointerGet(body, "/missing/deep")).toBeUndefined();
  });
});
