import type { DB } from "../db/client.ts";
import type { OAuthTokenRefreshEventTypes } from "../outbox/event-types.ts";
import { internalOutboxClient } from "../outbox/internal-client.ts";
import { logger } from "../tag-logger.ts";

export type OAuthTokenRefreshedPayload = OAuthTokenRefreshEventTypes["oauth:token:refreshed"];
export type OAuthTokenFailedPayload = OAuthTokenRefreshEventTypes["oauth:token:failed"];

export async function emitOAuthTokenRefreshed(
  db: DB,
  payload: OAuthTokenRefreshedPayload,
): Promise<void> {
  await internalOutboxClient.send(
    { transaction: db, parent: db },
    "oauth:token:refreshed",
    payload,
  );
}

export async function emitOAuthTokenFailed(
  db: DB,
  payload: OAuthTokenFailedPayload,
): Promise<void> {
  await internalOutboxClient.send({ transaction: db, parent: db }, "oauth:token:failed", payload);
}

export async function handleOAuthTokenRefreshed(
  payload: OAuthTokenRefreshedPayload,
): Promise<void> {
  logger.info("OAuth token refreshed", payload);
}

export async function handleOAuthTokenFailed(payload: OAuthTokenFailedPayload): Promise<void> {
  logger.warn("OAuth token refresh failed", payload);
}
