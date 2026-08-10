import * as SecureStore from "./secure-store.ts";
import { lastProjectStorageKey } from "./storage-keys.ts";

// Keychain-backed storage. Only small, durable things live here: the server
// URL (+ recents), the last-opened project, the OAuth client registration,
// and the refresh token. Access tokens are 30-minute JWTs with fat claims —
// they stay in memory (see auth.ts).
//
// Ported from the voice-ios-app branch (PR #1605) apps/mobile/src/lib/storage.ts;
// recents + last-project persistence added here.

const SERVER_KEY = "iterate.server";
const RECENT_SERVERS_KEY = "iterate.recentServers";

export async function getServerBaseUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_KEY);
}

export async function setServerBaseUrl(baseUrl: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_KEY, baseUrl);
}

/** Custom base URLs the user has signed into (captun tunnels etc.), newest first. */
export async function getRecentServers(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(RECENT_SERVERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export async function addRecentServer(baseUrl: string): Promise<void> {
  const recents = [baseUrl, ...(await getRecentServers()).filter((s) => s !== baseUrl)];
  await SecureStore.setItemAsync(RECENT_SERVERS_KEY, JSON.stringify(recents.slice(0, 5)));
}

/** Last project opened on a server — the fast boot path lands on its chat list. */
export type LastProject = { id: string; slug: string };

export async function getLastProject(baseUrl: string): Promise<LastProject | null> {
  const auth = await getStoredAuth(baseUrl);
  if (!auth) return null;
  const raw = await SecureStore.getItemAsync(lastProjectStorageKey(baseUrl, auth));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastProject;
  } catch {
    return null;
  }
}

export async function setLastProject(baseUrl: string, project: LastProject): Promise<void> {
  const auth = await getStoredAuth(baseUrl);
  if (!auth) throw new Error(`Cannot remember a project without auth for ${baseUrl}.`);
  await SecureStore.setItemAsync(lastProjectStorageKey(baseUrl, auth), JSON.stringify(project));
}

export async function clearLastProject(baseUrl: string): Promise<void> {
  const auth = await getStoredAuth(baseUrl);
  if (!auth) return;
  await SecureStore.deleteItemAsync(lastProjectStorageKey(baseUrl, auth));
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

/** Per-project, device-local: this phone auto-collects screenshots into the
 * project when its Media screen opens. Deliberately device state — the
 * device is the actor (it decides to run a sync pass), so there is no
 * server-side registry to reconcile. */
export async function getMediaSyncEnabled(projectId: string): Promise<boolean> {
  return (await SecureStore.getItemAsync(`iterate.mediaSync.${projectId}`)) === "1";
}

export async function setMediaSyncEnabled(projectId: string, enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(`iterate.mediaSync.${projectId}`, enabled ? "1" : "0");
}
