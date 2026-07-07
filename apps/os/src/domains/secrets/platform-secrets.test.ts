// Unit tests for the virtual platform-secret resolver (design §4). No DO, no
// storage: it reads first-party OAuth client credentials straight out of
// AppConfig so a first-party integration's refresh worker can ride the app
// credential in a header placeholder (ADR 0005).

import { describe, expect, test } from "vitest";
import type { AppConfig } from "../../config.ts";
import {
  assertPlatformApiSecretReferencesAllowed,
  isPlatformSecretPath,
  resolvePlatformSecretReference,
  substitutePlatformSecretReferences,
} from "./platform-secrets.ts";
import { SecretSubstitutionError } from "./utils.ts";

const config = {
  openAiApiKey: { exposeSecret: () => "openai-platform-key" },
  integrations: {
    exa: {
      apiKey: { exposeSecret: () => "exa-platform-key" },
    },
    parallel: {
      apiKey: { exposeSecret: () => "parallel-platform-key" },
    },
    petshop: {
      oauthClientId: "petshop-default",
      oauthClientSecret: { exposeSecret: () => "petshop-default-secret" },
    },
    github: {
      appId: "12345",
      oauthClientId: "gh-client",
      oauthClientSecret: { exposeSecret: () => "gh-secret" },
      privateKey: {
        exposeSecret: () => "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
      },
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

  test("API-key platform integrations expose apiKey and whole-material fields", () => {
    const resolved = resolvePlatformSecretReference({
      config,
      fields: ["", "apiKey"],
      path: "/secrets/platform/integrations/parallel",
    });
    expect(resolved[""]).toBe("parallel-platform-key");
    expect(resolved.apiKey).toBe("parallel-platform-key");
  });

  test("OpenAI exposes the deployment API key", () => {
    const resolved = resolvePlatformSecretReference({
      config,
      fields: ["apiKey"],
      path: "/secrets/platform/openai",
    });
    expect(resolved.apiKey).toBe("openai-platform-key");
  });

  test("direct platform-key egress substitutes only for allowlisted provider origins", () => {
    const request = new Request("https://api.parallel.ai/v1/tasks/runs", {
      headers: {
        "x-api-key": 'getSecret("/secrets/platform/integrations/parallel", "apiKey")',
      },
    });

    const substituted = substitutePlatformSecretReferences({ config, request });

    expect(substituted.headers.get("x-api-key")).toBe("parallel-platform-key");
  });

  test("direct platform-key egress rejects the wrong origin", () => {
    const request = new Request("https://example.com/v1/tasks/runs", {
      headers: {
        "x-api-key": 'getSecret("/secrets/platform/integrations/parallel", "apiKey")',
      },
    });

    expect(() => substitutePlatformSecretReferences({ config, request })).toThrow(
      SecretSubstitutionError,
    );
  });

  test("chained platform API-key references keep their provider-origin pin", () => {
    expect(() =>
      assertPlatformApiSecretReferencesAllowed({
        fields: ["apiKey"],
        path: "/secrets/platform/integrations/parallel",
        url: "https://example.com/v1/tasks/runs",
      }),
    ).toThrow(SecretSubstitutionError);

    expect(() =>
      assertPlatformApiSecretReferencesAllowed({
        fields: ["clientSecret"],
        path: "/secrets/platform/integrations/petshop",
        url: "https://example.com/oauth/token",
      }),
    ).not.toThrow();
  });

  test("first-party GitHub App exposes privateKey (to sign with) + appId", () => {
    // The installation-token worker calls env.APP.sign({ field: "privateKey" }),
    // which resolves the PEM here — signed with, never revealed (ADR 0006).
    const resolved = resolvePlatformSecretReference({
      config,
      fields: ["privateKey", "appId"],
      path: "/secrets/platform/integrations/github",
    });
    expect(resolved.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(resolved.appId).toBe("12345");
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
