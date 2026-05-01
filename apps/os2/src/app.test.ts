import { describe, expect, it } from "vitest";
import { AppConfig } from "./app.ts";

const baseConfig = {
  eventsBaseUrl: "https://events.iterate.com",
  clerk: {
    publishableKey: "pk_test_example",
    secretKey: "sk_test_example",
    jwtKey: "jwt-key",
  },
  mcpProofSecret: "proof-secret",
};

describe("AppConfig", () => {
  it("defaults MCP resource scopes to Clerk user data scopes only", () => {
    expect(AppConfig.parse(baseConfig).clerk.mcpOauthScopes).toEqual(["email", "profile"]);
  });

  it("rejects openid as an MCP resource scope", () => {
    expect(() =>
      AppConfig.parse({
        ...baseConfig,
        clerk: {
          ...baseConfig.clerk,
          mcpOauthScopes: ["openid", "email", "profile"],
        },
      }),
    ).toThrow();
  });
});
