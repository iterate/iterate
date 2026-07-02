import { expect, test } from "vitest";
import {
  resolveDevAuthClientSyncTarget,
  resolveLocalDevOAuthClientBootstrap,
} from "./dev-oauth-client-bootstrap.ts";

test("resolves personal dev stages from Doppler and Alchemy spellings", () => {
  expect(resolveDevAuthClientSyncTarget({ ALCHEMY_STAGE: "dev_misha" })).toBe("dev_misha");
  expect(resolveDevAuthClientSyncTarget({ ALCHEMY_STAGE: "dev-misha" })).toBe("dev_misha");
  expect(resolveDevAuthClientSyncTarget({ ALCHEMY_STAGE: "dev" })).toBeNull();
});

test("bootstraps Captun redirect URIs against the shared dev auth service", () => {
  expect(
    resolveLocalDevOAuthClientBootstrap({
      ALCHEMY_STAGE: "dev_misha",
      APP_CONFIG_BASE_URL: "https://misha.tunnels.iterate.com",
      APP_CONFIG_ITERATE_AUTH__ISSUER: "https://auth.iterate-dev.com/api/auth",
      ITERATE_AUTH_SERVICE_TOKEN: "service-token",
      APP_CONFIG_ITERATE_AUTH__CLIENT_ID: "os-local-dev",
      APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: "existing-secret",
    }),
  ).toMatchObject({
    authOrigin: "https://auth.iterate-dev.com",
    existingClientId: "os-local-dev",
    existingClientSecret: "existing-secret",
    redirectURI: "https://misha.tunnels.iterate.com/api/iterate-auth/callback",
    serviceToken: "service-token",
    target: "dev_misha",
  });
});

test("does not bootstrap local dev clients against production auth", () => {
  expect(
    resolveLocalDevOAuthClientBootstrap({
      ALCHEMY_STAGE: "dev_misha",
      APP_CONFIG_BASE_URL: "https://misha.tunnels.iterate.com",
      APP_CONFIG_ITERATE_AUTH__ISSUER: "https://auth.iterate.com/api/auth",
      ITERATE_AUTH_SERVICE_TOKEN: "service-token",
    }),
  ).toBeNull();
});
