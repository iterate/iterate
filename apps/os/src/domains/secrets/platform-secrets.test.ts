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

  test("openAiApiKey resolves toward the OpenAI origin", () => {
    const request = new Request("https://api.openai.com/v1/responses", {
      headers: { authorization: 'Bearer getSecret({ platform: "openAiApiKey" })' },
    });

    const substituted = substitutePlatformApiKeyReferences({ config, request });

    expect(substituted.headers.get("authorization")).toBe("Bearer openai-platform-key");
  });
});

describe("resolvePlatformClientCreds", () => {
  test("google creds resolve only toward Google's token endpoint", () => {
    const creds = resolvePlatformClientCreds(
      config,
      { platform: "integrations.google" },
      "https://oauth2.googleapis.com/token",
    );
    expect(creds).toEqual({ clientId: "google-client", clientSecret: "google-secret" });

    expect(() =>
      resolvePlatformClientCreds(
        config,
        { platform: "integrations.google" },
        "https://attacker.example/token",
      ),
    ).toThrow(SecretSubstitutionError);
  });

  test("petshop creds have no registry origin pin (the secret's own egress pin is the boundary)", () => {
    const creds = resolvePlatformClientCreds(
      config,
      { platform: "integrations.petshop" },
      "https://dummy-petshop.iterate-preview-3.com/oauth/token",
    );
    expect(creds).toEqual({
      clientId: "petshop-default",
      clientSecret: "petshop-default-secret",
    });
  });

  test("unknown or unconfigured refs throw secret_not_found", () => {
    expect(() =>
      resolvePlatformClientCreds(
        config,
        { platform: "integrations.unconfigured" },
        "https://example.com/token",
      ),
    ).toThrow(SecretSubstitutionError);
  });
});

describe("resolvePlatformGithubAppKey", () => {
  test("the first-party App key resolves only toward the real GitHub API", () => {
    const resolved = resolvePlatformGithubAppKey(
      config,
      { platform: "integrations.github" },
      "https://api.github.com",
    );
    expect(resolved.privateKey).toContain("BEGIN PRIVATE KEY");

    expect(() =>
      resolvePlatformGithubAppKey(
        config,
        { platform: "integrations.github" },
        "https://dummy-petshop.example.com",
      ),
    ).toThrow(SecretSubstitutionError);
  });

  test("only the github config path resolves an App key", () => {
    expect(() =>
      resolvePlatformGithubAppKey(
        config,
        { platform: "integrations.google" },
        "https://api.github.com",
      ),
    ).toThrow(SecretSubstitutionError);
  });
});
