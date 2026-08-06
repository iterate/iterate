import { z } from "zod";

const AUTH_ISSUER = "https://auth.iterate.com/api/auth";
const CLIENT_ID = "kOlPgrOieTduTzepGDCODpHDeLIZJDyo";
const OS_RESOURCE = "https://os.iterate.com";
const TOKEN_STORAGE_KEY = "iterateOAuthTokens";

const TokenSet = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.number(),
  refreshToken: z.string().min(1).optional(),
});
const SignInResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  refresh_token: z.string().min(1).optional(),
});

export async function isSignedIn() {
  return Boolean(await readTokens());
}

export async function requestSignIn() {
  const response = SignInResponse.parse(
    await chrome.runtime.sendMessage({ type: "iterate:sign-in" }),
  );
  if (!response.ok) throw new Error(response.error);
}

export async function signIn() {
  const redirectUri = chrome.identity.getRedirectURL();
  const state = randomBase64Url(24);
  const verifier = randomBase64Url(48);
  const challenge = await sha256Base64Url(verifier);
  const authorizeUrl = new URL(`${AUTH_ISSUER}/oauth2/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access project",
    resource: OS_RESOURCE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
  }).toString();

  const callback = await chrome.identity.launchWebAuthFlow({
    interactive: true,
    url: authorizeUrl.toString(),
  });
  if (!callback) throw new Error("OAuth did not return a callback URL.");

  const callbackUrl = new URL(callback);
  const oauthError = callbackUrl.searchParams.get("error");
  if (oauthError) {
    throw new Error(callbackUrl.searchParams.get("error_description") ?? oauthError);
  }
  if (callbackUrl.searchParams.get("state") !== state) {
    throw new Error("OAuth state did not match.");
  }
  const code = callbackUrl.searchParams.get("code");
  if (!code) throw new Error("OAuth callback contained no authorization code.");

  await exchangeTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: OS_RESOURCE,
    }),
  );
}

export async function signOut() {
  await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
}

export async function getAccessToken(forceRefresh = false) {
  const tokens = await readTokens();
  if (!tokens) throw new Error("Sign in to Iterate first.");
  if (!forceRefresh && tokens.accessTokenExpiresAt > Date.now() + 30_000) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) {
    await signOut();
    throw new Error("Your Iterate session expired. Sign in again.");
  }

  try {
    return await exchangeTokens(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: tokens.refreshToken,
        resource: OS_RESOURCE,
      }),
      tokens.refreshToken,
    );
  } catch (error) {
    await signOut();
    throw error;
  }
}

async function exchangeTokens(body: URLSearchParams, currentRefreshToken?: string) {
  const response = await fetch(`${AUTH_ISSUER}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed (${response.status}): ${await response.text()}`);
  }
  const result = TokenResponse.parse(await response.json());
  const tokens = {
    accessToken: result.access_token,
    accessTokenExpiresAt: Date.now() + (result.expires_in ?? 300) * 1_000,
    refreshToken: result.refresh_token ?? currentRefreshToken,
  };
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: tokens });
  return tokens.accessToken;
}

async function readTokens() {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const tokens = TokenSet.safeParse(stored[TOKEN_STORAGE_KEY]);
  return tokens.success ? tokens.data : undefined;
}

function randomBase64Url(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
