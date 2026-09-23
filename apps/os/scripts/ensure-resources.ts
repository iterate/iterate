import { createCli } from "trpc-cli";
import { osEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { ensureD1, ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { registrableDomainOf } from "../../../scripts/lib/start-app.ts";
import { reconcileResources } from "../../../scripts/lib/wrangler-config.ts";
import { ownZonesOf } from "./generate-wrangler-config.ts";

export default async function ensureResources(options: { env?: string } = {}) {
  const ctx = await resolveEnvContext({
    envs: osEnvs,
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
    ...(ctx.env.ingressRouting?.type === "subdomains"
      ? [`*.${ctx.env.ingressRouting.hostname}`]
      : []),
    // this account's own custom apexes; the SaaS ones are custom hostnames, below
    ...Object.keys(ctx.env.temporaryCustomHostnames || {}).filter((hostname) =>
      ownZonesOf(ctx.env).has(registrableDomainOf(hostname)),
    ),
  ].filter((host) => !host.endsWith(".workers.dev")))
    await ensureProxiedDnsRecord(ctx, zones, host, "Clean-room OAuth deployment");
  // CLOUDFLARE FOR SAAS: a custom apex whose zone lives in another account is a custom hostname on
  // the first SaaS zone (the zone's fallback origin, `cname.<zone>`, is ours) — created here with an
  // HTTP DV certificate; it turns active once the owner CNAMEs their apex to that fallback origin.
  const [saasZoneName] = ctx.env.cloudflareForSaasProjectHostnameBases || [];
  const saasHostnames = Object.keys(ctx.env.temporaryCustomHostnames || {}).filter(
    (hostname) => !ownZonesOf(ctx.env).has(registrableDomainOf(hostname)),
  );
  if (saasHostnames.length && !saasZoneName)
    throw new Error(
      `${saasHostnames.join(", ")}: custom apexes outside this account's zones need cloudflareForSaasProjectHostnameBases`,
    );
  const saasZone = zones.find((zone) => zone.name === saasZoneName);
  if (saasHostnames.length && !saasZone)
    throw new Error(`${saasZoneName}: the SaaS zone is not in this account`);
  for (const hostname of saasHostnames) {
    const existing = await ctx.cfV4<
      {
        id: string;
        hostname: string;
        status: string;
        ssl?: { status?: string };
      }[]
    >(`/zones/${saasZone!.id}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
    const current = existing.find(
      (entry) => entry.hostname === hostname && entry.status !== "deleted",
    );
    const ssl = { method: "http", type: "dv", settings: { min_tls_version: "1.2" } };
    if (current?.status === "moved" || current?.ssl?.status === "deleted") {
      // A hostname can still exist here after traffic moved to another SaaS zone. Refreshing the
      // same SSL configuration requests DCV again; a mere existence check would leave it moved.
      await ctx.cfV4(`/zones/${saasZone!.id}/custom_hostnames/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ssl }),
      });
      console.log(`requested reactivation of custom hostname ${hostname} on ${saasZoneName}`);
      continue;
    }
    if (current) {
      console.log(
        `custom hostname ${hostname} exists on ${saasZoneName} (hostname ${current.status}, SSL ${current.ssl?.status || "unknown"})`,
      );
      continue;
    }
    await ctx.cfV4(`/zones/${saasZone!.id}/custom_hostnames`, {
      method: "POST",
      body: JSON.stringify({
        hostname,
        ssl,
      }),
    });
    console.log(
      `created custom hostname ${hostname} on ${saasZoneName} — its owner CNAMEs the apex to cname.${saasZoneName}`,
    );
  }
  reconcileResources(ctx.name, ctx.env.resources, resources);
}
if (process.argv[1]?.endsWith("ensure-resources.ts"))
  void createCli({ ...import.meta, name: "ensure-resources" }).run();
