import type { CloudflareEnv } from "../../env.ts";

export async function broadcastInvalidation(env: CloudflareEnv): Promise<void> {
  const id = env.REALTIME_PUSHER.idFromName("global");
  const stub = env.REALTIME_PUSHER.get(id);
  const response = await stub.fetch(new Request("http://internal/invalidate", { method: "POST" }));

  if (!response.ok) {
    throw new Error(`Failed to broadcast invalidation: ${response.status}`);
  }

  await response.json();
}
