// Google connection metadata — a newest-first fold over the connection journal
// for display/status (email, name, picture, googleUserId, scopes). v6 keeps the
// tokens in the connection secret (write-only, refreshed by the shared OAuth
// refresh worker — google-worker via oauth-refresh.worker.js), so there is NO
// token state here: this file replaced the old google-tokens.ts, which stored
// tokens as ciphertext journal events and refreshed in-process.

import { streamEventsNewestFirst } from "./integration-streams.ts";
import {
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  integrationConnectionStreamPath,
  readRecord,
  readString,
} from "./utils.ts";

/** Display/status view of one Google connection, folded from its journal. */
type GoogleConnectionState = {
  connected: boolean;
  email?: string;
  googleUserId?: string;
  name?: string;
  picture?: string;
  scopes?: string[];
};

/**
 * Fold the connection journal newest-first: the most recent lifecycle fact
 * wins — a disconnected fact means not connected; a connected fact yields the
 * display metadata. Stops at the first lifecycle fact (everything older is
 * superseded).
 */
export async function readGoogleConnectionState(
  projectId: string,
  connection: string,
): Promise<GoogleConnectionState> {
  const path = integrationConnectionStreamPath("google", connection);
  for await (const event of streamEventsNewestFirst(projectId, path)) {
    const payload = readRecord(event.payload) ?? {};
    if (event.type === GOOGLE_DISCONNECTED_EVENT_TYPE) return { connected: false };
    if (event.type === GOOGLE_CONNECTED_EVENT_TYPE) {
      return {
        connected: true,
        email: readString(payload.email),
        googleUserId: readString(payload.googleUserId),
        name: readString(payload.name),
        picture: readString(payload.picture),
        scopes: Array.isArray(payload.scopes)
          ? payload.scopes.filter((s): s is string => typeof s === "string")
          : undefined,
      };
    }
  }
  return { connected: false };
}
