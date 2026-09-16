/// <reference lib="dom" />
// The shared itx contract includes browser RequestInfo types even for its Node transport.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectItx } from "iterate/node";
import { envs } from "../../envs.ts";
import { resolveEnvContext } from "../lib/env-context.ts";

/** Leave a proven five-second heartbeat behind for the storage-cleanup experiment. */
export async function seedHeartbeat(options: { env: string; output: string }) {
  if (!/^preview_\d+$/.test(options.env)) throw new Error("Only preview slots may be probed");
  const context = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  const secret = context.secrets.APP_CONFIG_ADMIN_API_SECRET;
  if (!secret) throw new Error("Missing preview admin credential");
  const baseUrl = context.env.baseUrl;
  const response = await fetch(new URL("/api/__internal/reset-storage", baseUrl), {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Reset endpoint is unavailable (${response.status})`);
  const deployment = await response.json();
  using session = connectItx({ baseUrl, auth: { type: "admin-secret", secret } });
  const slug = `cleanup-probe-${crypto.randomUUID().slice(0, 8)}`;
  using project = await session.projects.get(slug).create({});
  const { projectId } = await project.__describe();
  console.log(`Cleanup probe created ${slug} (${projectId}) in ${options.env}`);
  const eventType = "events.iterate.test/cleanup-probe/heartbeat";
  await project.scheduler.set({
    key: "cleanup-probe",
    recurrence: { every: 5 },
    script: `async (itx, schedule, trigger) => {
      await itx.streams.get("/cleanup-probe").append({
        type: ${JSON.stringify(eventType)},
        idempotencyKey: trigger.executionId,
        payload: { runCount: trigger.runCount },
      });
    }`,
  });
  // Prove real scheduled work happened before releasing every client handle.
  const heartbeat = await project.streams.get("/cleanup-probe").waitForEvent({
    eventTypes: [eventType],
    timeoutMs: 30_000,
  });
  const after = await fetch(new URL("/api/__internal/reset-storage", baseUrl), {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!after.ok || (await after.json()).version !== deployment.version) {
    throw new Error("Deployment changed during the heartbeat probe; reuse is not established");
  }
  const result = {
    env: options.env,
    slug,
    projectId,
    deployment,
    heartbeat,
    abandonedAt: new Date().toISOString(),
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(result, null, 2));
  return result;
}
