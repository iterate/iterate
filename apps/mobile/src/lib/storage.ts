import * as SecureStore from "expo-secure-store";

// Keychain-backed storage. Only small, durable things live here: the server
// URL, the OAuth client registration, and the refresh token. Access tokens are
// 30-minute JWTs with fat claims — they stay in memory (see auth.ts).

const SERVER_KEY = "iterate.server";

export async function getServerBaseUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_KEY);
}

export async function setServerBaseUrl(baseUrl: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_KEY, baseUrl);
}

/** Persisted per OS server, so switching servers keeps each sign-in intact. */
export type StoredAuth = {
  issuer: string;
  clientId: string;
  refreshToken: string;
};

function authKey(baseUrl: string) {
  // Keychain keys must be alphanumeric-ish; hostnames are the unique part.
  return `iterate.auth.${baseUrl.replace(/[^a-zA-Z0-9]+/g, "_")}`;
}

export async function getStoredAuth(baseUrl: string): Promise<StoredAuth | null> {
  const raw = await SecureStore.getItemAsync(authKey(baseUrl));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

export async function setStoredAuth(baseUrl: string, auth: StoredAuth): Promise<void> {
  await SecureStore.setItemAsync(authKey(baseUrl), JSON.stringify(auth));
}

export async function clearStoredAuth(baseUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(authKey(baseUrl));
}
