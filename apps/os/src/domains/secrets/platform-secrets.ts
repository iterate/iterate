import { type AppConfig } from "../../config.ts";
import {
  GITHUB_CONNECTION_EGRESS_URLS,
  GOOGLE_CONNECTION_EGRESS_URLS,
} from "../integrations/utils.ts";
import { type PlatformCredsRef } from "./types.ts";
import {
  SecretSubstitutionError,
  substitutePlatformHeaders,
  type PlatformReference,
} from "./utils.ts";

/**
 * Known platform credentials: deployment-owned secrets resolved from typed
 * AppConfig by ordinary trusted code. There is no Durable Object and no
 * synthetic path namespace behind these (the old virtual `/secrets/platform/**`
 * model is gone) — a platform credential is a config value plus, where
 * untrusted code can cause it to be sent somewhere, an allowed-origin pin.
 *
 * Three consumers:
 * - `substitutePlatformApiKeyReferences` — the project egress door substitutes
 *   `getSecret({ platform: "<configPath>" })` header references for
 *   Iterate-owned API keys, each pinned to its provider origins.
 * - `resolvePlatformClientCreds` — the Secret DO's `oauth-refresh-token`
 *   strategy resolves a built-in integration's OAuth client credential.
 * - `resolvePlatformGithubAppKey` — the Secret DO's `github-app-installation`
 *   strategy resolves the first-party GitHub App private key.
 *
 * Platform credential bytes are handled ONLY by trusted platform code (this
 * module, the door, the Secret DO's strategies); they are never stored in
 * project material and there is no lane that reveals them to a caller.
 */

/** Iterate-owned API keys substitutable into project egress. Adding one is
 * adding a config key + a row here. The `origins` pin is enforced against the
 * request's terminal destination no matter who composed the request. */
const PLATFORM_API_KEYS: Record<
  string,
  { origins: readonly string[]; value: (config: AppConfig) => string | undefined }
> = {
  "integrations.exa.apiKey": {
    // api.exa.ai is the REST API; mcp.exa.ai is Exa's hosted MCP server, which
    // the built-in itx.mcp.exa client authenticates against with this key.
    origins: ["https://api.exa.ai", "https://mcp.exa.ai"],
    value: (config) => config.integrations.exa?.apiKey.exposeSecret(),
  },
  "integrations.parallel.apiKey": {
    origins: ["https://api.parallel.ai"],
    value: (config) => config.integrations.parallel?.apiKey.exposeSecret(),
  },
};

/**
 * OAuth client credentials resolvable by the `oauth-refresh-token` strategy.
 * Both the exchange endpoint and the secret's complete egress policy are
 * provider-pinned. The second check matters because the resulting access token
 * is project material: a hostile refresh configuration must not mint one into
 * a secret that can subsequently send it to an attacker origin.
 */
const PLATFORM_CLIENT_CREDS: Record<
  string,
  {
    creds: (config: AppConfig) => { clientId: string; clientSecret: string } | undefined;
    egressOrigins: (config: AppConfig) => readonly string[];
    tokenOrigins: (config: AppConfig) => readonly string[];
  }
> = {
  "integrations.google": {
    creds: (config) =>
      config.integrations.google && {
        clientId: config.integrations.google.oauthClientId,
        clientSecret: config.integrations.google.oauthClientSecret.exposeSecret(),
      },
    tokenOrigins: () => ["https://oauth2.googleapis.com"],
    egressOrigins: () => GOOGLE_CONNECTION_EGRESS_URLS,
  },
  // The e2e third party (apps/dummy-petshop). Its origin varies by deployment,
  // so typed config carries the deployment-matched base URL.
  "integrations.petshop": {
    creds: (config) =>
      config.integrations.petshop && {
        clientId: config.integrations.petshop.oauthClientId,
        clientSecret: config.integrations.petshop.oauthClientSecret.exposeSecret(),
      },
    tokenOrigins: petshopOrigins,
    egressOrigins: petshopOrigins,
  },
};

function petshopOrigins(config: AppConfig): readonly string[] {
  if (config.integrations.petshop === undefined) return [];
  if (config.integrations.petshop.baseUrl !== undefined) {
    return [new URL(config.integrations.petshop.baseUrl).origin];
  }
  if (config.baseUrl === undefined) return [];
  const provider = new URL(config.baseUrl);
  provider.hostname = provider.hostname.replace(/^os\./, "dummy-petshop.");
  return [provider.origin];
}

/**
 * Substitute `getSecret({ platform: ... })` API-key references into a request.
 * Called by the project egress door for requests that reference no project
 * secret. Throws SecretSubstitutionError on unknown paths, unconfigured keys,
 * or a destination outside the credential's origin pin — before the
 * substituted Request is built, so no partial substitution escapes.
 */
export function substitutePlatformApiKeyReferences(input: {
  config: AppConfig;
  request: Request;
}): Request {
  return substitutePlatformHeaders(input.request, (reference) => {
    assertPlatformApiKeyReferencesAllowed([reference], input.request.url);
    const { platform } = reference;
    const entry = PLATFORM_API_KEYS[platform];
    if (entry === undefined) throw new SecretSubstitutionError("secret_not_found");
    const value = entry.value(input.config);
    if (value === undefined) throw new SecretSubstitutionError("secret_not_found");
    return value;
  });
}

/** Re-authorize every referenced platform API key against one redirect hop. */
export function assertPlatformApiKeyReferencesAllowed(
  references: PlatformReference[],
  url: string,
): void {
  const origin = new URL(url).origin;
  for (const { platform } of references) {
    const entry = PLATFORM_API_KEYS[platform];
    if (entry === undefined) throw new SecretSubstitutionError("secret_not_found");
    if (!entry.origins.includes(origin)) {
      throw new SecretSubstitutionError("secret_not_allowed_for_origin");
    }
  }
}

/** Resolve a built-in integration's OAuth client credential for a refresh
 * grant against `tokenEndpoint`. Enforces the credential's own origin pin. */
export function resolvePlatformClientCreds(input: {
  config: AppConfig;
  ref: PlatformCredsRef;
  secretEgressUrls: readonly string[];
  tokenEndpoint: string;
}): { clientId: string; clientSecret: string } {
  const entry = PLATFORM_CLIENT_CREDS[input.ref.platform];
  if (entry === undefined) throw new SecretSubstitutionError("secret_not_found");
  const creds = entry.creds(input.config);
  if (creds === undefined) throw new SecretSubstitutionError("secret_not_found");
  assertOriginsAllowed([input.tokenEndpoint], entry.tokenOrigins(input.config));
  assertOriginsAllowed(input.secretEgressUrls, entry.egressOrigins(input.config));
  return creds;
}

/** Resolve the first-party GitHub App private key for an installation-token
 * mint against `apiBase`. Only the real GitHub API origin is allowed; a
 * bring-your-own-App connection keeps its key in material instead. */
export function resolvePlatformGithubAppKey(input: {
  apiBase: string;
  appId: string;
  config: AppConfig;
  ref: PlatformCredsRef;
  secretEgressUrls: readonly string[];
}): string {
  if (input.ref.platform !== "integrations.github") {
    throw new SecretSubstitutionError("secret_not_found");
  }
  const github = input.config.integrations.github;
  if (github === undefined) throw new SecretSubstitutionError("secret_not_found");
  const privateKey = github.privateKey?.exposeSecret();
  if (privateKey === undefined || github.appId === undefined) {
    throw new SecretSubstitutionError("secret_not_found");
  }
  if (input.appId !== github.appId) {
    throw new SecretSubstitutionError("secret_not_allowed_for_origin");
  }
  assertOriginsAllowed([input.apiBase], ["https://api.github.com"]);
  assertOriginsAllowed(input.secretEgressUrls, GITHUB_CONNECTION_EGRESS_URLS);
  return privateKey;
}

function assertOriginsAllowed(urls: readonly string[], allowedOrigins: readonly string[]): void {
  try {
    for (const url of urls) {
      if (!allowedOrigins.includes(new URL(url).origin)) {
        throw new SecretSubstitutionError("secret_not_allowed_for_origin");
      }
    }
  } catch (error) {
    if (error instanceof SecretSubstitutionError) throw error;
    throw new SecretSubstitutionError("secret_not_allowed_for_origin");
  }
}
