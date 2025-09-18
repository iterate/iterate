import type { CloudflareEnv } from "../../env.ts";
import type { PushControllerEvent } from "../durable-objects/organization-websocket.ts";

/**
 * Send an invalidation message to all connected WebSocket clients for an organization
 */
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
    console.error("Failed to send invalidation:", await response.text());
  }
}

/**
 * Send a notification to all connected WebSocket clients for an organization
 */
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
    console.error("Failed to send notification:", await response.text());
  }
}

/**
 * Broadcast a custom message to all connected WebSocket clients for an organization
 */
export async function broadcastToOrganization(
  env: CloudflareEnv,
  organizationId: string,
  payload: any,
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
    console.error("Failed to broadcast message:", await response.text());
  }
}

/**
 * Get statistics about WebSocket connections for an organization
 */
export async function getOrganizationWebSocketStats(
  env: CloudflareEnv,
  organizationId: string,
): Promise<any> {
  const id = env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = env.ORGANIZATION_WEBSOCKET.get(id);

  const response = await stub.fetch(
    new Request("http://internal/stats", {
      method: "GET",
    }),
  );

  if (!response.ok) {
    console.error("Failed to get stats:", await response.text());
    return null;
  }

  return response.json();
}
