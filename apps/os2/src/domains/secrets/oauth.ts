import type { Client } from "sqlfu";
import type { AppConfig } from "~/app.ts";
import {
  createOAuthState,
  deleteProjectConnection,
  deleteProjectSecret,
  getProjectConnection,
  getProjectSecret,
} from "~/domains/secrets/secrets-store.ts";

type OAuthProvider = "google" | "slack";

export function requireSlackConfig(config: AppConfig) {
  const slack = config.integrations.slack;
  if (!slack) throw new Error("Slack integration runtime config is not configured.");
  return slack;
}

export function requireGoogleConfig(config: AppConfig) {
  const google = config.integrations.google;
  if (!google) throw new Error("Google integration runtime config is not configured.");
  return google;
}

export function oauthRedirectUri(input: { baseUrl: string; provider: OAuthProvider }) {
  return `${input.baseUrl.replace(/\/$/, "")}/api/integrations/${input.provider}/callback`;
}

export function requestBaseUrl(input: { config: AppConfig; request?: Request }) {
  if (input.config.baseUrl) return input.config.baseUrl;
  if (!input.request) throw new Error("Cannot infer base URL without a request.");
  const url = new URL(input.request.url);
  return `${url.protocol}//${url.host}`;
}

export async function createSlackAuthorizationUrl(input: {
  baseUrl: string;
  callbackUrl?: string;
  config: AppConfig;
  db: Client;
  projectId: string;
  userId: string;
}) {
  const slack = requireSlackConfig(input.config);
  const state = await createOAuthState(input.db, {
    callbackUrl: input.callbackUrl,
    projectId: input.projectId,
    provider: "slack",
    userId: input.userId,
  });
  const authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
  authorizationUrl.searchParams.set("client_id", slack.oauthClientId);
  authorizationUrl.searchParams.set(
    "redirect_uri",
    oauthRedirectUri({ ...input, provider: "slack" }),
  );
  authorizationUrl.searchParams.set("scope", slack.scopes.join(","));
  authorizationUrl.searchParams.set("state", state);
  return authorizationUrl.toString();
}

export async function createGoogleAuthorizationUrl(input: {
  baseUrl: string;
  callbackUrl?: string;
  config: AppConfig;
  db: Client;
  projectId: string;
  userId: string;
}) {
  const google = requireGoogleConfig(input.config);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = await createOAuthState(input.db, {
    callbackUrl: input.callbackUrl,
    codeVerifier,
    projectId: input.projectId,
    provider: "google",
    userId: input.userId,
  });
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("client_id", google.oauthClientId);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("prompt", "consent");
  authorizationUrl.searchParams.set(
    "redirect_uri",
    oauthRedirectUri({ ...input, provider: "google" }),
  );
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", google.scopes.join(" "));
  authorizationUrl.searchParams.set("state", state);
  return authorizationUrl.toString();
}

export async function disconnectProvider(input: {
  db: Client;
  projectId: string;
  provider: OAuthProvider;
}) {
  const connection = await getProjectConnection(input.db, input);
  if (!connection) return { success: true };

  const secretKey = providerSecretKey(input.provider);
  const secret = await getProjectSecret(input.db, {
    key: secretKey,
    projectId: input.projectId,
  });
  if (secret) {
    await revokeProviderToken({
      provider: input.provider,
      token: secret.material,
    }).catch(() => null);
    await deleteProjectSecret(input.db, {
      key: secretKey,
      projectId: input.projectId,
    });
  }
  await deleteProjectConnection(input.db, input);
  return { success: true };
}

export function providerSecretKey(provider: OAuthProvider) {
  return `${provider}.access_token`;
}

async function revokeProviderToken(input: { provider: OAuthProvider; token: string }) {
  if (input.provider === "slack") {
    await fetch("https://slack.com/api/auth.revoke", {
      body: new URLSearchParams({ token: input.token }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    return;
  }

  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(input.token)}`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

function randomBase64Url(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
