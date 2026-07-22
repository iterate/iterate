import type { StreamEvent } from "./itx-api.generated.ts";

export type IterateProjectApp<Env> = {
  processEvent(event: StreamEvent, env: Env): Promise<void>;
};

export async function dispatchProjectApps<Env>(
  apps: IterateProjectApp<Env>[],
  event: StreamEvent,
  env: Env,
): Promise<void> {
  for (const app of apps) await app.processEvent(event, env);
}
