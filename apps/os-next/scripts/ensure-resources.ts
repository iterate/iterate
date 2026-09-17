import { createCli } from "trpc-cli";
import { osNextEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { ensureD1, ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { reconcileResources } from "../../../scripts/lib/wrangler-config.ts";

export default async function ensureResources(options: { env?: string } = {}) {
  const ctx = await resolveEnvContext({
    envs: osNextEnvs,
    dopplerProject: "project-worker",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const db = await ensureD1(ctx, `${ctx.env.resourceNamePrefix}-directory`);
  const namespaces = await ctx.cf<{ id: string; title: string }[]>(
    "/storage/kv/namespaces?per_page=1000",
  );
  const resources = { directoryDbId: db.uuid, oauthKvId: "", itxKvId: "" };
  for (const [key, suffix] of [
    ["oauthKvId", "oauth"],
    ["itxKvId", "itx"],
  ] as const) {
    const title = `${ctx.env.resourceNamePrefix}-${suffix}`;
    const namespace =
      namespaces.find((entry) => entry.title === title) ??
      (await ctx.cf<{ id: string }>("/storage/kv/namespaces", {
        method: "POST",
        body: JSON.stringify({ title }),
      }));
    resources[key] = namespace.id;
  }
  // The one R2 bucket behind `itx.r2` (the wrangler generator names it `<resourceNamePrefix>-files`).
  const bucketName = `${ctx.env.resourceNamePrefix}-files`;
  const buckets = await ctx.cf<{ buckets: { name: string }[] }>("/r2/buckets?per_page=1000");
  if (buckets.buckets.some((bucket) => bucket.name === bucketName)) {
    console.log(`R2 bucket ${bucketName} exists`);
  } else {
    await ctx.cf("/r2/buckets", { method: "POST", body: JSON.stringify({ name: bucketName }) });
    console.log(`created R2 bucket ${bucketName}`);
  }
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  for (const host of [
    new URL(ctx.env.baseUrl).hostname,
    new URL(ctx.env.mcpBaseUrl).hostname,
    ...(ctx.env.projectHostnameBase ? [`*.${ctx.env.projectHostnameBase}`] : []),
    ...Object.keys(ctx.env.projectCustomHostnames || {}),
  ].filter((host) => !host.endsWith(".workers.dev")))
    await ensureProxiedDnsRecord(ctx, zones, host, "Clean-room OAuth deployment");
  reconcileResources(ctx.name, ctx.env.resources, resources);
}
if (process.argv[1]?.endsWith("ensure-resources.ts"))
  void createCli({ ...import.meta, name: "ensure-resources" }).run();
