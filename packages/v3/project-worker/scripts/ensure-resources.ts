import { createCli } from "trpc-cli";
import { projectWorkerEnvs } from "../../../../envs.ts";
import { resolveEnvContext } from "../../../../scripts/lib/env-context.ts";
import { ensureD1, ensureProxiedDnsRecord } from "../../../../scripts/lib/deploy-helpers.ts";
import { reconcileResources } from "../../../../scripts/lib/wrangler-config.ts";

export default async function ensureResources(options: { env?: string } = {}) {
  const ctx = await resolveEnvContext({
    envs: projectWorkerEnvs,
    dopplerProject: "project-worker",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const db = await ensureD1(ctx, `${ctx.env.workerName}-directory`);
  const namespaces = await ctx.cf<{ id: string; title: string }[]>(
    "/storage/kv/namespaces?per_page=1000",
  );
  const resources = { directoryDbId: db.uuid, oauthKvId: "", secretsKvId: "", itxKvId: "" };
  for (const [key, suffix] of [
    ["oauthKvId", "oauth"],
    ["secretsKvId", "secrets"],
    ["itxKvId", "itx"],
  ] as const) {
    const title = `${ctx.env.workerName}-${suffix}`;
    const namespace =
      namespaces.find((entry) => entry.title === title) ??
      (await ctx.cf<{ id: string }>("/storage/kv/namespaces", {
        method: "POST",
        body: JSON.stringify({ title }),
      }));
    resources[key] = namespace.id;
  }
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  for (const host of [
    new URL(ctx.env.baseUrl).hostname,
    new URL(ctx.env.mcpBaseUrl).hostname,
    `*.${ctx.env.projectHostnameBase}`,
  ])
    await ensureProxiedDnsRecord(ctx, zones, host, "Clean-room OAuth deployment");
  reconcileResources(ctx.name, ctx.env.resources, resources);
}
if (process.argv[1]?.endsWith("ensure-resources.ts"))
  void createCli({ ...import.meta, name: "ensure-resources" }).run();
