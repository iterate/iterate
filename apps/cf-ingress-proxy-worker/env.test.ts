import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { parseWorkerEnv } from "./env.ts";

describe("parseWorkerEnv", () => {
  test("applies non-secret defaults and sanitizes prefix", () => {
    const parsed = parseWorkerEnv({
      DB: env.DB,
      INGRESS_PROXY_API_TOKEN: "token",
      TYPEID_PREFIX: "prd_",
    });

    expect(parsed.TYPEID_PREFIX).toBe("prd");
  });

  test("throws when required token is missing", () => {
    expect(() =>
      parseWorkerEnv({
        DB: env.DB,
        INGRESS_PROXY_API_TOKEN: "",
      }),
    ).toThrow("INGRESS_PROXY_API_TOKEN is required");
  });

  test("uses default TYPEID_PREFIX when omitted", () => {
    const parsed = parseWorkerEnv({
      DB: env.DB,
      INGRESS_PROXY_API_TOKEN: "token",
    });

    expect(parsed.TYPEID_PREFIX).toBe("ipr");
  });
});
