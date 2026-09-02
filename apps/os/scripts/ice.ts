/**
 * Operator surface for the DO ice switch (src/domains/streams/do-ice.ts):
 * freeze or resume an environment's stream-DO alarm loops without touching
 * data. The reversible containment for a Durable Objects duration runaway —
 * see tasks/do-ice-circuit-breaker.md and tasks/stream-do-wake-loop-runaway.md.
 *
 *   pnpm cli ice status --env preview_3
 *   pnpm cli ice on     --env preview_3 --reason "duration runaway 2026-09-02"
 *   pnpm cli ice off    --env preview_3
 *
 * Writes the flag through the Cloudflare KV REST API (control plane), so it
 * works even while the environment's workers are the thing melting down.
 * Propagation: hot (rebooting) DOs read the flag on their next boot; a
 * long-resident incarnation converges within one alarm cycle after its
 * ~30s cached read expires.
 */
import { envs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { DO_ICE_KV_KEY } from "../src/domains/streams/do-ice.ts";

type IceTargetOptions = {
  /** Target environment name from envs.ts. Required — a containment switch must never infer its target. */
  env: string;
};

export async function status(options: IceTargetOptions) {
  const { cf, env, name } = await context(options);
  const keys = await cf<{ name: string }[]>(
    `/storage/kv/namespaces/${env.resources.projectDirectoryKvId}/keys?prefix=${encodeURIComponent(DO_ICE_KV_KEY)}`,
  );
  const iced = keys.some((key) => key.name === DO_ICE_KV_KEY);
  console.log(
    iced ? `🧊 ${name} is ICED (stream alarms drain, no re-arm)` : `🔥 ${name} is not iced`,
  );
  return { env: name, iced };
}

export async function on(options: IceTargetOptions & { reason?: string }) {
  const { cf, env, name } = await context(options);
  await cf(
    `/storage/kv/namespaces/${env.resources.projectDirectoryKvId}/values/${encodeURIComponent(DO_ICE_KV_KEY)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        icedAt: new Date().toISOString(),
        reason: options.reason || "unspecified",
      }),
    },
  );
  console.log(
    `🧊 ${name} iced. Stream DOs stop re-arming alarms and minting woken events as their ` +
      `cached flag reads expire (next boot for hot DOs, ~1 alarm cycle for residents). ` +
      `Un-ice with: pnpm cli ice off --env ${name}`,
  );
  return { env: name, iced: true };
}

export async function off(options: IceTargetOptions) {
  const { cf, env, name } = await context(options);
  await cf(
    `/storage/kv/namespaces/${env.resources.projectDirectoryKvId}/values/${encodeURIComponent(DO_ICE_KV_KEY)}`,
    { method: "DELETE" },
  );
  console.log(
    `🔥 ${name} un-iced. Streams resume lazily: the next real interaction boots them and ` +
      `deliveries catch up from durable cursors.`,
  );
  return { env: name, iced: false };
}

async function context(options: IceTargetOptions) {
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  return { cf: ctx.cf, env: ctx.env, name: ctx.name };
}
