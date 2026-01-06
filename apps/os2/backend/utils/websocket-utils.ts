import type { CloudflareEnv } from "../../env.ts";
import type { PushControllerEvent } from "../durable-objects/organization-websocket.ts";
import { logger } from "../tag-logger.ts";

export async function invalidateOrganizationQueries(
  env: CloudflareEnv,
  organizationId: string,
  invalidateInfo: PushControllerEvent & { type: "INVALIDATE" },
): Promise<void> {
  const id = env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = env.ORGANIZATION_WEBSOCKET.get(id);

  const response = await stub.fetch(
    new Request("http://internal/invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(invalidateInfo),
    }),
  );

  if (!response.ok) {
    logger.error("Failed to send invalidation:", await response.text());
  }
}

export async function notifyOrganization(
  env: CloudflareEnv,
  organizationId: string,
  notificationType: "success" | "error" | "info" | "warning",
  message: string,
  extraToastArgs?: Record<string, unknown>,
): Promise<void> {
  const id = env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = env.ORGANIZATION_WEBSOCKET.get(id);

  const response = await stub.fetch(
    new Request("http://internal/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "NOTIFICATION",
        notificationType,
        message,
        extraToastArgs,
      }),
    }),
  );

  if (!response.ok) {
    logger.error("Failed to send notification:", await response.text());
  }
}

export async function broadcastToOrganization(
  env: CloudflareEnv,
  organizationId: string,
  payload: unknown,
): Promise<void> {
  const id = env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = env.ORGANIZATION_WEBSOCKET.get(id);

  const response = await stub.fetch(
    new Request("http://internal/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "CUSTOM",
        payload,
      }),
    }),
  );

  if (!response.ok) {
    logger.error("Failed to broadcast message:", await response.text());
  }
}
