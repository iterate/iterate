import type { CloudflareEnv } from "../../env.ts";

export type InvalidateInfo =
  | { type: "ALL" }
  | { type: "QUERY_KEY"; queryKeys: unknown[] }
  | { type: "TRPC_QUERY"; paths: string[] };

export type PushControllerEvent =
  | { type: "INVALIDATE"; invalidateInfo: InvalidateInfo }
  | {
      type: "NOTIFICATION";
      notificationType: "success" | "error" | "info" | "warning";
      message: string;
      extraToastArgs?: Record<string, unknown>;
    }
  | { type: "CUSTOM"; payload: unknown };

export async function invalidateOrganizationQueries(
  env: CloudflareEnv,
  organizationId: string,
  event: PushControllerEvent,
): Promise<void> {
  const id = env.ORGANIZATION_WEBSOCKET.idFromName(organizationId);
  const stub = env.ORGANIZATION_WEBSOCKET.get(id);

  await stub.fetch(new URL("https://internal/invalidate").toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

export async function notifyOrganization(
  env: CloudflareEnv,
  organizationId: string,
  type: "success" | "error" | "info" | "warning",
  message: string,
  extraArgs?: Record<string, unknown>,
): Promise<void> {
  await invalidateOrganizationQueries(env, organizationId, {
    type: "NOTIFICATION",
    notificationType: type,
    message,
    extraToastArgs: extraArgs,
  });
}
