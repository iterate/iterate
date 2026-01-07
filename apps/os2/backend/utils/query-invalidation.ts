import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";

export async function broadcastInvalidation(env: CloudflareEnv): Promise<void> {
  const id = env.REALTIME_PUSHER.idFromName("global");
  const stub = env.REALTIME_PUSHER.get(id);
  const response = await stub.fetch(new Request("http://internal/invalidate", { method: "POST" }));

  if (!response.ok) {
    throw new Error(`Failed to broadcast invalidation: ${response.status}`);
  }

  const result = (await response.json()) as { success: boolean; sent: number; failed: number };
  logger.info(`Broadcast invalidation: sent=${result.sent}, failed=${result.failed}`);
}
