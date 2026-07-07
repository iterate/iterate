import { type AppConfig } from "../../config.ts";
import { type PlatformCredsRef } from "../../types.ts";
import { SecretSubstitutionError, substitutePlatformHeaders } from "./utils.ts";

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
    origins: ["https://api.exa.ai"],
    value: (config) => config.integrations.exa?.apiKey.exposeSecret(),
  },
  "integrations.parallel.apiKey": {
    origins: ["https://api.parallel.ai"],
    value: (config) => config.integrations.parallel?.apiKey.exposeSecret(),
  },
  openAiApiKey: {
    origins: ["https://api.openai.com"],
    value: (config) => config.openAiApiKey.exposeSecret(),
  },
};

/**
 * OAuth client credentials resolvable by the `oauth-refresh-token` strategy.
 * `origins` (when present) pins which token endpoints the credential may be
 * sent to, ON TOP of the secret's own egress pin — so even a hostile
 * `secret.update` configuring a platform ref can only make the DO run a normal
 * refresh against the provider's real token endpoint.
 */
const PLATFORM_CLIENT_CREDS: Record<
  string,
  {
    creds: (config: AppConfig) => { clientId: string; clientSecret: string } | undefined;
    origins?: readonly string[];
  }
> = {
  "integrations.google": {
    creds: (config) =>
      config.integrations.google && {
        clientId: config.integrations.google.oauthClientId,
        clientSecret: config.integrations.google.oauthClientSecret.exposeSecret(),
      },
    origins: ["https://oauth2.googleapis.com"],
  },
  // The e2e third party (apps/dummy-petshop). Its base URL varies per
  // deployment, so there is no registry origin pin here — the secret's own
  // egress pin (which the tokenEndpoint must fall within) is the boundary.
  "integrations.petshop": {
    creds: (config) =>
      config.integrations.petshop && {
        clientId: config.integrations.petshop.oauthClientId,
        clientSecret: config.integrations.petshop.oauthClientSecret.exposeSecret(),
      },
  },
};

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
  const origin = new URL(input.request.url).origin;
  return substitutePlatformHeaders(input.request, ({ platform }) => {
    const entry = PLATFORM_API_KEYS[platform];
    if (entry === undefined) throw new SecretSubstitutionError("secret_not_found");
    if (!entry.origins.includes(origin)) {
      throw new SecretSubstitutionError("secret_not_allowed_for_origin");
    }
    const value = entry.value(input.config);
    if (value === undefined) throw new SecretSubstitutionError("secret_not_found");
    return value;
  });
}

/** Resolve a built-in integration's OAuth client credential for a refresh
 * grant against `tokenEndpoint`. Enforces the credential's own origin pin. */
export function resolvePlatformClientCreds(
  config: AppConfig,
  ref: PlatformCredsRef,
  tokenEndpoint: string,
): { clientId: string; clientSecret: string } {
  const entry = PLATFORM_CLIENT_CREDS[ref.platform];
  if (entry === undefined) throw new SecretSubstitutionError("secret_not_found");
  const creds = entry.creds(config);
  if (creds === undefined) throw new SecretSubstitutionError("secret_not_found");
  if (entry.origins && !entry.origins.includes(new URL(tokenEndpoint).origin)) {
    throw new SecretSubstitutionError("secret_not_allowed_for_origin");
  }
  return creds;
}

/** Resolve the first-party GitHub App private key for an installation-token
 * mint against `apiBase`. Only the real GitHub API origin is allowed; a
 * bring-your-own-App connection keeps its key in material instead. */
export function resolvePlatformGithubAppKey(
  config: AppConfig,
  ref: PlatformCredsRef,
  apiBase: string,
): string {
  if (ref.platform !== "integrations.github") {
    throw new SecretSubstitutionError("secret_not_found");
  }
  const privateKey = config.integrations.github?.privateKey?.exposeSecret();
  if (privateKey === undefined) throw new SecretSubstitutionError("secret_not_found");
  if (new URL(apiBase).origin !== "https://api.github.com") {
    throw new SecretSubstitutionError("secret_not_allowed_for_origin");
  }
  return privateKey;
}
