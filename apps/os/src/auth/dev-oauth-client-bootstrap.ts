import { createAuthContractClient } from "@iterate-com/auth-contract";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;
const DEV_TARGET_PREFIX = "dev_";
const DEV_STAGE_PATTERN = /^dev[-_](.+)$/;
const DEV_AUTH_ORIGIN = "https://auth.iterate-dev.com";

type LocalDevOAuthClientBootstrap = {
  authOrigin: string;
  existingClientId: string | undefined;
  existingClientSecret: string | undefined;
  redirectURI: string;
  serviceToken: string;
  target: string;
};

export function resolveDevAuthClientSyncTarget(env: Record<string, string | undefined>) {
  const stage = env.ALCHEMY_STAGE?.trim().toLowerCase();
  if (!stage) return null;

  const match = DEV_STAGE_PATTERN.exec(stage);
  const user = match?.[1]?.replaceAll("-", "_");
  return user ? `${DEV_TARGET_PREFIX}${user}` : null;
}

export function resolveLocalDevOAuthClientBootstrap(
  env: Record<string, string | undefined>,
): LocalDevOAuthClientBootstrap | null {
  const target = resolveDevAuthClientSyncTarget(env);
  if (!target) return null;

  const authIssuer = env.APP_CONFIG_ITERATE_AUTH__ISSUER ?? env.ITERATE_OAUTH_ISSUER;
  const baseUrl = env.APP_CONFIG_BASE_URL;
  const serviceToken = env.APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN ?? env.ITERATE_AUTH_SERVICE_TOKEN;

  if (
    !authIssuer ||
    !baseUrl ||
    !serviceToken ||
    !URL.canParse(authIssuer) ||
    !URL.canParse(baseUrl)
  ) {
    return null;
  }

  const authOrigin = new URL(authIssuer).origin;
  if (authOrigin !== DEV_AUTH_ORIGIN && !isLoopbackOrigin(authOrigin)) return null;

  return {
    authOrigin,
    existingClientId:
      env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID ?? env.ITERATE_OAUTH_CLIENT_ID ?? undefined,
    existingClientSecret:
      env.APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET ?? env.ITERATE_OAUTH_CLIENT_SECRET ?? undefined,
    redirectURI: `${baseUrl.replace(/\/+$/, "")}/api/iterate-auth/callback`,
    serviceToken,
    target,
  };
}

export async function ensureLocalDevOAuthClient(env: Record<string, string | undefined>) {
  const bootstrap = resolveLocalDevOAuthClientBootstrap(env);
  if (!bootstrap) return;

  const authClient = createAuthContractClient({
    baseUrl: bootstrap.authOrigin,
    serviceToken: bootstrap.serviceToken,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const client = await authClient.internal.oauth.ensureClient({
        referenceId: `os:${bootstrap.target}:web`,
        clientName: `OS ${bootstrap.target} web`,
        redirectURIs: [bootstrap.redirectURI],
        existingClientId: bootstrap.existingClientId,
        existingClientSecret: bootstrap.existingClientSecret,
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
          `Failed to bootstrap local OAuth client for ${bootstrap.target} against ${bootstrap.authOrigin}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  throw new Error(`Failed to bootstrap local OAuth client for ${bootstrap.target}`, {
    cause: lastError,
  });
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
