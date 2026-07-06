import { type AppConfig } from "../../config.ts";
import { SecretSubstitutionError } from "./utils.ts";

/**
 * Virtual, env-backed platform secrets (design §4). A `/secrets/platform/**`
 * reference resolves from deployment AppConfig — no Durable Object, no storage,
 * no per-project provisioning: adding one is adding a config key. They
 * participate ONLY as header-substitution hops in a chain (never the entry
 * secret, never readable/updatable, never handed into a jail), which is how a
 * first-party integration's app-tier OAuth client credentials reach a secret
 * worker's refresh request without any project ever holding platform bytes
 * (ADR 0005). Their host pin is the entry secret's pin for now — a per-provider
 * platform pin is future work (this is an internal tool; see the design's
 * "Future work").
 */

const PLATFORM_PREFIX = "/secrets/platform/";

export function isPlatformSecretPath(path: string): boolean {
  return path.startsWith(PLATFORM_PREFIX);
}

/** The substituted string a platform secret owes each requested field; `""` is
 * the whole-material placeholder (unused for platform secrets — they are
 * structured). */
type ResolvedFields = Record<string, string>;

/**
 * Resolve the requested fields of a `/secrets/platform/integrations/<slug>`
 * reference from AppConfig. Exposes `clientId`, `clientSecret`, and the
 * convenience `basicAuth` (base64 of `clientId:clientSecret`, RFC 6749 §2.3.1
 * HTTP Basic client authentication — the required-to-support form, so a refresh
 * worker rides the app credential in an `Authorization: Basic …` header).
 */
export function resolvePlatformSecretReference(input: {
  config: AppConfig;
  fields: string[];
  path: string;
}): ResolvedFields {
  const creds = platformIntegrationCredentials(input.config, input.path);
  if (creds === null) throw new SecretSubstitutionError("secret_not_found");
  const table: Record<string, string> = {
    basicAuth: btoa(`${creds.clientId}:${creds.clientSecret}`),
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  };
  const resolved: ResolvedFields = {};
  for (const field of input.fields) {
    const value = table[field];
    if (value === undefined) throw new SecretSubstitutionError("secret_reference_field_not_found");
    resolved[field] = value;
  }
  return resolved;
}

function platformIntegrationCredentials(
  config: AppConfig,
  path: string,
): { clientId: string; clientSecret: string } | null {
  const match = /^\/secrets\/platform\/integrations\/([a-z0-9-]+)$/.exec(path);
  if (match === null) return null;
  // integrations is a fixed-key object in config; index dynamically by slug.
  const creds = (config.integrations as Record<string, unknown>)[match[1]!] as
    | { oauthClientId: string; oauthClientSecret: { exposeSecret(): string } }
    | undefined;
  if (creds?.oauthClientId === undefined) return null;
  return { clientId: creds.oauthClientId, clientSecret: creds.oauthClientSecret.exposeSecret() };
}
