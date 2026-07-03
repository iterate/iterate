import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SeedOAuthClientsEnv } from "./seed-oauth-clients.ts";

const clientsJson = JSON.stringify([
  {
    clientId: "client-id",
    clientSecret: "client-secret-with-enough-length",
    clientName: "Test client",
    redirectURIs: ["https://example.com/callback"],
  },
]);

describe("SeedOAuthClientsEnv", () => {
  it("prefers AppConfig service token and auth origin over legacy env vars", () => {
    const env = SeedOAuthClientsEnv.parse({
      AUTH_SEED_OAUTH_CLIENTS: clientsJson,
      APP_CONFIG_SERVICE_AUTH_TOKEN: "app-config-token",
      SERVICE_AUTH_TOKEN: "legacy-token",
      APP_CONFIG_AUTH_APP_ORIGIN: "https://auth.example.com",
      VITE_AUTH_APP_ORIGIN: "https://legacy-auth.example.com",
    });

    assert.equal(env.SERVICE_AUTH_TOKEN, "app-config-token");
    assert.equal(env.VITE_AUTH_APP_ORIGIN, "https://auth.example.com");
  });

  it("falls back to legacy service token and auth origin", () => {
    const env = SeedOAuthClientsEnv.parse({
      AUTH_SEED_OAUTH_CLIENTS: clientsJson,
      SERVICE_AUTH_TOKEN: "legacy-token",
      VITE_AUTH_APP_ORIGIN: "https://legacy-auth.example.com",
    });

    assert.equal(env.SERVICE_AUTH_TOKEN, "legacy-token");
    assert.equal(env.VITE_AUTH_APP_ORIGIN, "https://legacy-auth.example.com");
  });

  it("requires a service token from AppConfig or legacy env vars", () => {
    assert.throws(
      () =>
        SeedOAuthClientsEnv.parse({
          AUTH_SEED_OAUTH_CLIENTS: clientsJson,
          VITE_AUTH_APP_ORIGIN: "https://legacy-auth.example.com",
        }),
      /APP_CONFIG_SERVICE_AUTH_TOKEN or SERVICE_AUTH_TOKEN is required/,
    );
  });
});
