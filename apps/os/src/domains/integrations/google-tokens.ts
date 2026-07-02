// Google OAuth token storage + refresh on the next engine.
//
// Tokens live as AES-GCM ciphertext (SECRET_ENCRYPTION_KEY) inside events on
// the per-project `/integrations/google` stream — the "ciphertext in stream
// events" storage home. The stream only carries connect/disconnect/refresh
// facts, so folding it per Gmail call is cheap. Refresh needs raw token
// material (the refresh token goes in a form body, which the secret
// substitution pipeline does not cover), which is why Google does not use the
// secret Durable Object path Slack uses.

import { nextEnv } from "../../env.ts";
import type { StreamEvent } from "../../types.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "../secrets/crypto.ts";
import { integrationStreamStub, readAllStreamEvents } from "./integration-streams.ts";
import {
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  GOOGLE_INTEGRATION_STREAM_PATH,
  GOOGLE_TOKEN_REFRESHED_EVENT_TYPE,
  readRecord,
  readString,
} from "./utils.ts";
import type { AppConfig } from "~/config.ts";

const GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

type EncryptedMaterial = { algorithm: "AES-GCM-SHA256"; ciphertext: string; iv: string };

export type GoogleTokenState = {
  connected: boolean;
  email?: string;
  encryptedAccessToken?: EncryptedMaterial;
  encryptedRefreshToken?: EncryptedMaterial;
  expiresAt?: string;
  googleUserId?: string;
  name?: string;
  picture?: string;
  scopes?: string[];
};

export function foldGoogleTokenState(events: readonly StreamEvent[]): GoogleTokenState {
  let state: GoogleTokenState = { connected: false };
  for (const event of events) {
    const payload = readRecord(event.payload) ?? {};
    switch (event.type) {
      case GOOGLE_CONNECTED_EVENT_TYPE:
        state = {
          connected: true,
          email: readString(payload.email),
          encryptedAccessToken: readEncrypted(payload.encryptedAccessToken),
          encryptedRefreshToken: readEncrypted(payload.encryptedRefreshToken),
          expiresAt: readString(payload.expiresAt),
          googleUserId: readString(payload.googleUserId),
          name: readString(payload.name),
          picture: readString(payload.picture),
          scopes: readStringArray(payload.scopes),
        };
        break;
      case GOOGLE_TOKEN_REFRESHED_EVENT_TYPE:
        if (!state.connected) break;
        state = {
          ...state,
          encryptedAccessToken:
            readEncrypted(payload.encryptedAccessToken) ?? state.encryptedAccessToken,
          encryptedRefreshToken:
            readEncrypted(payload.encryptedRefreshToken) ?? state.encryptedRefreshToken,
          expiresAt: readString(payload.expiresAt) ?? state.expiresAt,
          scopes: readStringArray(payload.scopes) ?? state.scopes,
        };
        break;
      case GOOGLE_DISCONNECTED_EVENT_TYPE:
        state = { connected: false };
        break;
      default:
        break;
    }
  }
  return state;
}

export async function readGoogleTokenState(projectId: string): Promise<GoogleTokenState> {
  return foldGoogleTokenState(await readAllStreamEvents(projectId, GOOGLE_INTEGRATION_STREAM_PATH));
}

/**
 * Current (fresh) Google access token for the project, refreshing through the
 * OAuth token endpoint and recording the rotated ciphertext when the stored
 * one is within the refresh skew of expiry. Mirrors legacy
 * getFreshGoogleAccessToken semantics.
 */
export async function getFreshGoogleAccessToken(input: {
  config: AppConfig;
  projectId: string;
}): Promise<string> {
  const state = await readGoogleTokenState(input.projectId);
  if (!state.connected || state.encryptedAccessToken === undefined) {
    throw new Error("GmailCapability requires a connected Google account for this project.");
  }

  const accessToken = await decryptSecretMaterial(
    state.encryptedAccessToken,
    nextEnv.SECRET_ENCRYPTION_KEY,
  );
  if (
    !state.expiresAt ||
    Date.parse(state.expiresAt) > Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS
  ) {
    return accessToken;
  }

  if (state.encryptedRefreshToken === undefined) {
    throw new Error(
      "Google access token expired and no refresh token is stored. Reconnect Google.",
    );
  }
  const refreshToken = await decryptSecretMaterial(
    state.encryptedRefreshToken,
    nextEnv.SECRET_ENCRYPTION_KEY,
  );

  const google = input.config.integrations.google;
  if (!google) throw new Error("Google integration runtime config is not configured.");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: google.oauthClientId,
      client_secret: google.oauthClientSecret.exposeSecret(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };
  if (!tokenResponse.ok || !tokenData.access_token) {
    const reason = tokenData.error_description ?? tokenData.error ?? "google_token_refresh_failed";
    throw new Error(`Google access token refresh failed: ${reason}`);
  }

  await integrationStreamStub(input.projectId, GOOGLE_INTEGRATION_STREAM_PATH).append({
    type: GOOGLE_TOKEN_REFRESHED_EVENT_TYPE,
    payload: {
      encryptedAccessToken: await encryptSecretMaterial(
        tokenData.access_token,
        nextEnv.SECRET_ENCRYPTION_KEY,
      ),
      ...(tokenData.refresh_token
        ? {
            encryptedRefreshToken: await encryptSecretMaterial(
              tokenData.refresh_token,
              nextEnv.SECRET_ENCRYPTION_KEY,
            ),
          }
        : {}),
      expiresAt:
        typeof tokenData.expires_in === "number"
          ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
          : state.expiresAt,
      ...(tokenData.scope ? { scopes: tokenData.scope.split(" ") } : {}),
    },
  });

  return tokenData.access_token;
}

function readEncrypted(value: unknown): EncryptedMaterial | undefined {
  const record = readRecord(value);
  if (
    record?.algorithm === "AES-GCM-SHA256" &&
    typeof record.ciphertext === "string" &&
    typeof record.iv === "string"
  ) {
    return { algorithm: "AES-GCM-SHA256", ciphertext: record.ciphertext, iv: record.iv };
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}
