import { type AppConfig } from "../../config.ts";
import {
  type ResolvedFields,
  secretReferencesFromHeaders,
  SecretSubstitutionError,
  substituteSecretHeaders,
} from "./utils.ts";

/**
 * Virtual, env-backed platform secrets (design §4). A `/secrets/platform/**`
 * reference resolves from deployment AppConfig — no Durable Object, no storage,
 * no per-project provisioning: adding one is adding a config key. They
 * participate ONLY as header-substitution hops in a chain (never the entry
 * secret, never readable/updatable, never handed into a jail), which is how a
 * first-party integration's app-tier OAuth client credentials reach a secret
 * worker's refresh request without any project ever holding platform bytes
 * (ADR 0005). A small allowlist below also exposes first-party API keys for
 * direct project egress, pinned to their provider API origins.
 */

const PLATFORM_PREFIX = "/secrets/platform/";
const PLATFORM_API_SECRET_EGRESS_ORIGINS: Record<string, readonly string[]> = {
  "/secrets/platform/integrations/exa": ["https://api.exa.ai"],
  "/secrets/platform/integrations/parallel": ["https://api.parallel.ai"],
  "/secrets/platform/openai": ["https://api.openai.com"],
};

export function isPlatformSecretPath(path: string): boolean {
  return path.startsWith(PLATFORM_PREFIX);
}

/**
 * Resolve the requested fields of a platform secret reference from AppConfig.
 *
 * `/secrets/platform/integrations/<slug>` can expose OAuth app credentials
 * (`clientId`, `clientSecret`, `basicAuth`) and/or an API key (`apiKey`, plus
 * whole-material `getSecret(path)` when the integration is API-key-only).
 * `/secrets/platform/openai` exposes the deployment OpenAI API key.
 */
export function resolvePlatformSecretReference(input: {
  config: AppConfig;
  fields: string[];
  path: string;
}): ResolvedFields {
  const table = platformSecretFields(input.config, input.path);
  if (table === null) throw new SecretSubstitutionError("secret_not_found");
  const resolved: ResolvedFields = {};
  for (const field of input.fields) {
    const value = table[field];
    if (value === undefined) throw new SecretSubstitutionError("secret_reference_field_not_found");
    resolved[field] = value;
  }
  return resolved;
}

export function substitutePlatformSecretReferences(input: {
  config: AppConfig;
  request: Request;
}): Request {
  const references = secretReferencesFromHeaders(input.request.headers);
  const origin = new URL(input.request.url).origin;
  const fieldsByPath = new Map<string, string[]>();

  for (const reference of references) {
    if (!isPlatformSecretPath(reference.path)) {
      throw new SecretSubstitutionError("secret_reference_required");
    }
    const allowedOrigins = PLATFORM_API_SECRET_EGRESS_ORIGINS[reference.path];
    if (allowedOrigins === undefined || !allowedOrigins.includes(origin)) {
      throw new SecretSubstitutionError("secret_not_allowed_for_origin");
    }
    const fields = fieldsByPath.get(reference.path) ?? [];
    fields.push(reference.field ?? "");
    fieldsByPath.set(reference.path, fields);
  }

  const values = new Map<string, string>();
  for (const [path, fields] of fieldsByPath) {
    const resolved = resolvePlatformSecretReference({ config: input.config, fields, path });
    for (const [field, value] of Object.entries(resolved)) values.set(`${path} ${field}`, value);
  }

  return substituteSecretHeaders(input.request, (reference) => {
    const value = values.get(`${reference.path} ${reference.field ?? ""}`);
    if (value === undefined) throw new SecretSubstitutionError("secret_reference_field_not_found");
    return value;
  });
}

export function assertPlatformApiSecretReferencesAllowed(input: {
  fields: string[];
  path: string;
  url: string;
}) {
  if (!input.fields.some((field) => field === "" || field === "apiKey")) return;

  const origin = new URL(input.url).origin;
  const allowedOrigins = PLATFORM_API_SECRET_EGRESS_ORIGINS[input.path];
  if (allowedOrigins === undefined || !allowedOrigins.includes(origin)) {
    throw new SecretSubstitutionError("secret_not_allowed_for_origin");
  }
}

/**
 * One field's raw material string from a platform secret, for the compute-only
 * `env.APP` binding (which runs `hmac`/`sign`/`matches` over it — ADR 0006).
 * `undefined` field selects the whole-material value (the API-key-only case).
 * Throws SecretSubstitutionError when the secret or field is absent.
 */
export function platformSecretMaterialField(
  config: AppConfig,
  path: string,
  field?: string,
): string {
  const fields = platformSecretFields(config, path);
  if (fields === null) throw new SecretSubstitutionError("secret_not_found");
  const value = fields[field ?? ""];
  if (value === undefined) throw new SecretSubstitutionError("secret_reference_field_not_found");
  return value;
}

function platformSecretFields(config: AppConfig, path: string): Record<string, string> | null {
  if (path === "/secrets/platform/openai") {
    const apiKey = config.openAiApiKey.exposeSecret();
    return { "": apiKey, apiKey };
  }

  const match = /^\/secrets\/platform\/integrations\/([a-z0-9-]+)$/.exec(path);
  if (match === null) return null;
  // integrations is a fixed-key object in config; index dynamically by slug.
  const creds = (config.integrations as Record<string, unknown>)[match[1]!] as
    | {
        apiKey?: { exposeSecret(): string };
        appId?: string;
        oauthClientId?: string;
        oauthClientSecret?: { exposeSecret(): string };
        privateKey?: { exposeSecret(): string };
      }
    | undefined;
  if (creds === undefined) return null;

  const fields: Record<string, string> = {};
  if (creds.oauthClientId !== undefined && creds.oauthClientSecret !== undefined) {
    const clientSecret = creds.oauthClientSecret.exposeSecret();
    fields.basicAuth = btoa(`${creds.oauthClientId}:${clientSecret}`);
    fields.clientId = creds.oauthClientId;
    fields.clientSecret = clientSecret;
  }
  if (creds.apiKey !== undefined) {
    const apiKey = creds.apiKey.exposeSecret();
    fields[""] = apiKey;
    fields.apiKey = apiKey;
  }
  // First-party GitHub App: `privateKey` is signed with (never revealed) via
  // env.APP.sign in the installation-token worker (ADR 0006); `appId` is the
  // public JWT issuer.
  if (creds.privateKey !== undefined) fields.privateKey = creds.privateKey.exposeSecret();
  if (creds.appId !== undefined) fields.appId = creds.appId;

  return Object.keys(fields).length > 0 ? fields : null;
}
