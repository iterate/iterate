// Google OAuth token storage + refresh on itx.
//
// Tokens live as AES-GCM ciphertext (SECRET_ENCRYPTION_KEY) inside events on
// the per-project, per-connection `/integrations/google/{connection}` stream —
// the "ciphertext in stream events" storage home. Refresh needs raw token
// material (the refresh token goes in a form body, which the secret
// substitution pipeline does not cover), which is why Google does not use the
// secret Durable Object path Slack uses.
//
// The journal grows by one token-refreshed event per refresh forever, and the
// state is read on EVERY Gmail call — so the fold runs newest-first over a
// tail read (see readGoogleTokenState) instead of replaying the whole journal.

import { itxEnv } from "../../env.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "../secrets/crypto.ts";
import { integrationStreamStub, streamEventsNewestFirst } from "./integration-streams.ts";
import {
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  GOOGLE_TOKEN_REFRESHED_EVENT_TYPE,
  integrationConnectionStreamPath,
  readRecord,
  readString,
} from "./utils.ts";
import type { AppConfig } from "~/config.ts";

const GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

type EncryptedMaterial = { algorithm: "AES-GCM-SHA256"; ciphertext: string; iv: string };

type GoogleTokenState = {
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

/**
 * Token state is a newest-first fold over the journal tail: refreshes layer
 * onto the most recent connected fact, so the scan stops at the first
 * connected/disconnected event — everything older is superseded. The generator
 * iterates page boundaries transparently, so refresh fields accumulated in
 * newer pages carry until the lifecycle fact is found, however far back it
 * sits.
 */
export async function readGoogleTokenState(
  projectId: string,
  connection: string,
): Promise<GoogleTokenState> {
  let encryptedAccessToken: EncryptedMaterial | undefined;
  let encryptedRefreshToken: EncryptedMaterial | undefined;
  let expiresAt: string | undefined;
  let scopes: string[] | undefined;
  const path = integrationConnectionStreamPath("google", connection);
  for await (const event of streamEventsNewestFirst(projectId, path)) {
    const payload = readRecord(event.payload) ?? {};
    switch (event.type) {
      case GOOGLE_DISCONNECTED_EVENT_TYPE:
        return { connected: false };
      case GOOGLE_TOKEN_REFRESHED_EVENT_TYPE:
        // Newest wins: only fill fields no newer refresh already supplied.
        encryptedAccessToken ??= readEncrypted(payload.encryptedAccessToken);
        encryptedRefreshToken ??= readEncrypted(payload.encryptedRefreshToken);
        expiresAt ??= readString(payload.expiresAt);
        scopes ??= readStringArray(payload.scopes);
        break;
      case GOOGLE_CONNECTED_EVENT_TYPE:
        return {
          connected: true,
          email: readString(payload.email),
          encryptedAccessToken: encryptedAccessToken ?? readEncrypted(payload.encryptedAccessToken),
          encryptedRefreshToken:
            encryptedRefreshToken ?? readEncrypted(payload.encryptedRefreshToken),
          expiresAt: expiresAt ?? readString(payload.expiresAt),
          googleUserId: readString(payload.googleUserId),
          name: readString(payload.name),
          picture: readString(payload.picture),
          scopes: scopes ?? readStringArray(payload.scopes),
        };
      default:
        break;
    }
  }
  return { connected: false };
}

/**
 * Current (fresh) Google access token for one named connection of the project,
 * refreshing through the OAuth token endpoint and recording the rotated
 * ciphertext when the stored one is within the refresh skew of expiry.
 */
export async function getFreshGoogleAccessToken(input: {
  config: AppConfig;
  connection: string;
  projectId: string;
}): Promise<string> {
  const state = await readGoogleTokenState(input.projectId, input.connection);
  if (!state.connected || state.encryptedAccessToken === undefined) {
    throw new Error(
      `google connection "${input.connection}" is not connected for this project. Use itx.integrations.list() to see connections, or connect Google from the dashboard.`,
    );
  }

  const accessToken = await decryptSecretMaterial(
    state.encryptedAccessToken,
    itxEnv.SECRET_ENCRYPTION_KEY,
  );
  if (
    !state.expiresAt ||
    Date.parse(state.expiresAt) > Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS
  ) {
    return accessToken;
  }

  if (state.encryptedRefreshToken === undefined) {
    throw new Error(
      `google connection "${input.connection}": access token expired and no refresh token is stored. Reconnect Google.`,
    );
  }
  const refreshToken = await decryptSecretMaterial(
    state.encryptedRefreshToken,
    itxEnv.SECRET_ENCRYPTION_KEY,
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

  await integrationStreamStub(
    input.projectId,
    integrationConnectionStreamPath("google", input.connection),
  ).append({
    type: GOOGLE_TOKEN_REFRESHED_EVENT_TYPE,
    payload: {
      encryptedAccessToken: await encryptSecretMaterial(
        tokenData.access_token,
        itxEnv.SECRET_ENCRYPTION_KEY,
      ),
      ...(tokenData.refresh_token
        ? {
            encryptedRefreshToken: await encryptSecretMaterial(
              tokenData.refresh_token,
              itxEnv.SECRET_ENCRYPTION_KEY,
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
