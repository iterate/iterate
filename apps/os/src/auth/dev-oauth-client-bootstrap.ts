import { createAuthContractClient } from "@iterate-com/auth-contract";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;
const DEV_STAGE_PREFIX = "dev-";
const DEV_TARGET_PREFIX = "dev_";
const DEV_HOST_PREFIX = "os.iterate-dev-";
const DEV_HOST_SUFFIX = ".com";

export function resolveDevAuthClientSyncTarget(env: Record<string, string | undefined>) {
  const baseUrl = env.APP_CONFIG_BASE_URL?.trim();
  if (baseUrl && URL.canParse(baseUrl)) {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname.startsWith(DEV_HOST_PREFIX) && hostname.endsWith(DEV_HOST_SUFFIX)) {
      const user = hostname.slice(DEV_HOST_PREFIX.length, -DEV_HOST_SUFFIX.length);
      if (user.length > 0) {
        return `${DEV_TARGET_PREFIX}${user}`;
      }
    }
  }

  const stage = env.ALCHEMY_STAGE?.trim().toLowerCase();
  if (stage?.startsWith(DEV_STAGE_PREFIX)) {
    const user = stage.slice(DEV_STAGE_PREFIX.length);
    if (user.length > 0) {
      return `${DEV_TARGET_PREFIX}${user}`;
    }
  }

  return null;
}

export async function ensureLocalDevOAuthClient(env: Record<string, string | undefined>) {
  const target = resolveDevAuthClientSyncTarget(env);
  if (!target) return;

  const authIssuer = env.APP_CONFIG_ITERATE_AUTH__ISSUER ?? env.ITERATE_OAUTH_ISSUER;
  const baseUrl = env.APP_CONFIG_BASE_URL?.trim();
  const serviceToken = env.APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN ?? env.ITERATE_AUTH_SERVICE_TOKEN;

  if (
    !authIssuer ||
    !baseUrl ||
    !serviceToken ||
    !URL.canParse(authIssuer) ||
    !URL.canParse(baseUrl)
  ) {
    return;
  }

  const authOrigin = new URL(authIssuer).origin;
  if (!isLoopbackOrigin(authOrigin)) {
    return;
  }

  const authClient = createAuthContractClient({ baseUrl: authOrigin, serviceToken });
  const redirectURI = `${baseUrl.replace(/\/+$/, "")}/api/iterate-auth/callback`;
  const existingClientId =
    env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID ?? env.ITERATE_OAUTH_CLIENT_ID ?? undefined;
  const existingClientSecret =
    env.APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET ?? env.ITERATE_OAUTH_CLIENT_SECRET ?? undefined;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const client = await authClient.internal.oauth.ensureClient({
        referenceId: `os:${target}:web`,
        clientName: `OS ${target} web`,
        redirectURIs: [redirectURI],
        existingClientId,
        existingClientSecret,
        rotateClientSecret: false,
      });

      env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID = client.clientId;
      env.APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET = client.clientSecret;
      env.ITERATE_OAUTH_CLIENT_ID = client.clientId;
      env.ITERATE_OAUTH_CLIENT_SECRET = client.clientSecret;
      return;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryableBootstrapError(error)) {
        throw new Error(
          `Failed to bootstrap local OAuth client for ${target} against ${authOrigin}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  throw new Error(`Failed to bootstrap local OAuth client for ${target}`, { cause: lastError });
}

function isLoopbackOrigin(origin: string) {
  const hostname = new URL(origin).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function isRetryableBootstrapError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("ecconnrefused") ||
    message.includes("connect") ||
    message.includes("socket") ||
    message.includes("timed out")
  );
}
