// Unit tests for the known platform-credential registry. No DO, no storage,
// no synthetic paths: platform credentials are typed AppConfig values plus an
// allowed-origin pin, resolved by ordinary trusted code.

import { describe, expect, test } from "vitest";
import type { AppConfig } from "../../config.ts";
import {
  resolvePlatformClientCreds,
  resolvePlatformGithubAppKey,
  substitutePlatformApiKeyReferences,
} from "./platform-secrets.ts";
import { SecretSubstitutionError } from "./utils.ts";

const config = {
  baseUrl: "https://os.iterate-preview-3.com",
  openAiApiKey: { exposeSecret: () => "openai-platform-key" },
  integrations: {
    exa: {
      apiKey: { exposeSecret: () => "exa-platform-key" },
    },
    parallel: {
      apiKey: { exposeSecret: () => "parallel-platform-key" },
    },
    petshop: {
      baseUrl: "https://dummy-petshop.iterate-preview-3.com",
      oauthClientId: "petshop-default",
      oauthClientSecret: { exposeSecret: () => "petshop-default-secret" },
    },
    google: {
      oauthClientId: "google-client",
      oauthClientSecret: { exposeSecret: () => "google-secret" },
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

describe("substitutePlatformApiKeyReferences", () => {
  test("substitutes a known key toward its allowlisted provider origin", () => {
    const request = new Request("https://api.parallel.ai/v1/tasks/runs", {
      headers: { "x-api-key": 'getSecret({ platform: "integrations.parallel.apiKey" })' },
    });

    const substituted = substitutePlatformApiKeyReferences({ config, request });

    expect(substituted.headers.get("x-api-key")).toBe("parallel-platform-key");
  });

  test("rejects the wrong origin", () => {
    const request = new Request("https://example.com/v1/tasks/runs", {
      headers: { "x-api-key": 'getSecret({ platform: "integrations.parallel.apiKey" })' },
    });

    expect(() => substitutePlatformApiKeyReferences({ config, request })).toThrow(
      SecretSubstitutionError,
    );
  });

  test("rejects unknown config paths — the registry is a closed allowlist", () => {
    const request = new Request("https://api.parallel.ai/v1/tasks/runs", {
      headers: { "x-api-key": 'getSecret({ platform: "authForge.masterKey" })' },
    });

    expect(() => substitutePlatformApiKeyReferences({ config, request })).toThrow(
      SecretSubstitutionError,
    );
  });

  test("does not expose the internal agent OpenAI key through project egress", () => {
    const request = new Request("https://api.openai.com/v1/responses", {
      headers: { authorization: 'Bearer getSecret({ platform: "openAiApiKey" })' },
    });

    expect(() => substitutePlatformApiKeyReferences({ config, request })).toThrow(
      SecretSubstitutionError,
    );
  });
});

describe("resolvePlatformClientCreds", () => {
  test("google creds resolve only toward Google's token endpoint", () => {
    const creds = resolvePlatformClientCreds({
      config,
      ref: { platform: "integrations.google" },
      secretEgressUrls: ["https://oauth2.googleapis.com", "https://gmail.googleapis.com"],
      tokenEndpoint: "https://oauth2.googleapis.com/token",
    });
    expect(creds).toEqual({ clientId: "google-client", clientSecret: "google-secret" });

    expect(() =>
      resolvePlatformClientCreds({
        config,
        ref: { platform: "integrations.google" },
        secretEgressUrls: ["https://gmail.googleapis.com"],
        tokenEndpoint: "https://attacker.example/token",
      }),
    ).toThrow(SecretSubstitutionError);

    expect(() =>
      resolvePlatformClientCreds({
        config,
        ref: { platform: "integrations.google" },
        secretEgressUrls: ["https://gmail.googleapis.com", "https://attacker.example"],
        tokenEndpoint: "https://oauth2.googleapis.com/token",
      }),
    ).toThrow(SecretSubstitutionError);
  });

  test("petshop creds and resulting tokens stay on the configured deployment origin", () => {
    const creds = resolvePlatformClientCreds({
      config,
      ref: { platform: "integrations.petshop" },
      secretEgressUrls: ["https://dummy-petshop.iterate-preview-3.com/api"],
      tokenEndpoint: "https://dummy-petshop.iterate-preview-3.com/oauth/token",
    });
    expect(creds).toEqual({
      clientId: "petshop-default",
      clientSecret: "petshop-default-secret",
    });

    for (const input of [
      {
        secretEgressUrls: ["https://dummy-petshop.iterate-preview-3.com/api"],
        tokenEndpoint: "https://attacker.example/token",
      },
      {
        secretEgressUrls: [
          "https://dummy-petshop.iterate-preview-3.com/api",
          "https://attacker.example",
        ],
        tokenEndpoint: "https://dummy-petshop.iterate-preview-3.com/oauth/token",
      },
    ]) {
      expect(() =>
        resolvePlatformClientCreds({
          config,
          ref: { platform: "integrations.petshop" },
          ...input,
        }),
      ).toThrow(SecretSubstitutionError);
    }
  });

  test("petshop derives its deployment sibling origin when no override is configured", () => {
    const withoutOverride = {
      ...config,
      integrations: {
        ...config.integrations,
        petshop: { ...config.integrations.petshop, baseUrl: undefined },
      },
    } as unknown as AppConfig;

    expect(
      resolvePlatformClientCreds({
        config: withoutOverride,
        ref: { platform: "integrations.petshop" },
        secretEgressUrls: ["https://dummy-petshop.iterate-preview-3.com/api"],
        tokenEndpoint: "https://dummy-petshop.iterate-preview-3.com/oauth/token",
      }),
    ).toEqual({
      clientId: "petshop-default",
      clientSecret: "petshop-default-secret",
    });
  });

  test("unknown or unconfigured refs throw secret_not_found", () => {
    expect(() =>
      resolvePlatformClientCreds({
        config,
        ref: { platform: "integrations.unconfigured" },
        secretEgressUrls: ["https://example.com"],
        tokenEndpoint: "https://example.com/token",
      }),
    ).toThrow(SecretSubstitutionError);
  });
});

describe("resolvePlatformGithubAppKey", () => {
  test("the first-party App key resolves only toward the real GitHub API", () => {
    const privateKey = resolvePlatformGithubAppKey({
      apiBase: "https://api.github.com",
      appId: "12345",
      config,
      ref: { platform: "integrations.github" },
      secretEgressUrls: ["https://api.github.com", "https://github.com"],
    });
    expect(privateKey).toContain("BEGIN PRIVATE KEY");

    expect(() =>
      resolvePlatformGithubAppKey({
        apiBase: "https://dummy-petshop.example.com",
        appId: "12345",
        config,
        ref: { platform: "integrations.github" },
        secretEgressUrls: ["https://api.github.com"],
      }),
    ).toThrow(SecretSubstitutionError);
  });

  test("the caller-supplied App id and egress must match the configured App", () => {
    expect(() =>
      resolvePlatformGithubAppKey({
        apiBase: "https://api.github.com",
        appId: "attacker-app",
        config,
        ref: { platform: "integrations.github" },
        secretEgressUrls: ["https://api.github.com"],
      }),
    ).toThrow(SecretSubstitutionError);

    expect(() =>
      resolvePlatformGithubAppKey({
        apiBase: "https://api.github.com",
        appId: "12345",
        config,
        ref: { platform: "integrations.github" },
        secretEgressUrls: ["https://api.github.com", "https://attacker.example"],
      }),
    ).toThrow(SecretSubstitutionError);
  });

  test("only the github config path resolves an App key", () => {
    expect(() =>
      resolvePlatformGithubAppKey({
        apiBase: "https://api.github.com",
        appId: "12345",
        config,
        ref: { platform: "integrations.google" },
        secretEgressUrls: ["https://api.github.com"],
      }),
    ).toThrow(SecretSubstitutionError);
  });
});
