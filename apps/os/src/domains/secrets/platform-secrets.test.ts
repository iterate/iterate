// Unit tests for the virtual platform-secret resolver (design §4). No DO, no
// storage: it reads first-party OAuth client credentials straight out of
// AppConfig so a first-party integration's refresh worker can ride the app
// credential in a header placeholder (ADR 0005).

import { describe, expect, test } from "vitest";
import type { AppConfig } from "../../config.ts";
import { isPlatformSecretPath, resolvePlatformSecretReference } from "./platform-secrets.ts";
import { SecretSubstitutionError } from "./utils.ts";

const config = {
  integrations: {
    petshop: {
      oauthClientId: "petshop-default",
      oauthClientSecret: { exposeSecret: () => "petshop-default-secret" },
    },
  },
} as unknown as AppConfig;

describe("isPlatformSecretPath", () => {
  test("only /secrets/platform/** paths are virtual", () => {
    expect(isPlatformSecretPath("/secrets/platform/integrations/petshop")).toBe(true);
    expect(isPlatformSecretPath("/secrets/integrations/petshop/jonas")).toBe(false);
  });
});

describe("resolvePlatformSecretReference", () => {
  test("basicAuth is base64(clientId:clientSecret); clientId is readable", () => {
    const resolved = resolvePlatformSecretReference({
      config,
      fields: ["basicAuth", "clientId"],
      path: "/secrets/platform/integrations/petshop",
    });
    expect(resolved.basicAuth).toBe(btoa("petshop-default:petshop-default-secret"));
    expect(resolved.clientId).toBe("petshop-default");
  });

  test("unknown slug throws secret_not_found", () => {
    expect(() =>
      resolvePlatformSecretReference({
        config,
        fields: ["basicAuth"],
        path: "/secrets/platform/integrations/unconfigured",
      }),
    ).toThrow(SecretSubstitutionError);
  });
});
