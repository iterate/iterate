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
  it("reads the AppConfig service token and auth origin", () => {
    const env = SeedOAuthClientsEnv.parse({
      AUTH_SEED_OAUTH_CLIENTS: clientsJson,
      APP_CONFIG_SERVICE_AUTH_TOKEN: "app-config-token",
      APP_CONFIG_AUTH_APP_ORIGIN: "https://auth.example.com",
    });

    assert.equal(env.serviceAuthToken, "app-config-token");
    assert.equal(env.authAppOrigin, "https://auth.example.com");
  });

  it("requires an AppConfig service token", () => {
    assert.throws(
      () =>
        SeedOAuthClientsEnv.parse({
          AUTH_SEED_OAUTH_CLIENTS: clientsJson,
          APP_CONFIG_AUTH_APP_ORIGIN: "https://auth.example.com",
        }),
      /APP_CONFIG_SERVICE_AUTH_TOKEN is required/,
    );
  });
});
