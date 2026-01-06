import type { CloudflareEnv } from "../../env.ts";

export type InvalidateMessage = {
  type: "INVALIDATE";
  invalidateInfo: {
    type: "ALL" | "SPECIFIC";
    queryKeys?: string[];
  };
};

export type NotifyMessage = {
  type: "NOTIFY";
  notificationType: "success" | "error" | "info" | "warning";
  message: string;
  extra?: Record<string, unknown>;
};

export type WebSocketMessage = InvalidateMessage | NotifyMessage;

/**
 * Send an invalidation message to all connected clients in an organization
 */
export async function invalidateOrganizationQueries(
  env: CloudflareEnv,
  organizationId: string,
  message: InvalidateMessage,
): Promise<void> {
  const id = env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = env.ORGANIZATION_WEBSOCKET.get(id);
  await stub.broadcast(JSON.stringify(message));
}

/**
 * Send a notification message to all connected clients in an organization
 */
export async function notifyOrganization(
  env: CloudflareEnv,
  organizationId: string,
  type: "success" | "error" | "info" | "warning",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const id = env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = env.ORGANIZATION_WEBSOCKET.get(id);
  await stub.broadcast(
    JSON.stringify({
      type: "NOTIFY",
      notificationType: type,
      message,
      extra,
    } satisfies NotifyMessage),
  );
}
