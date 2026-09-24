import { createCli } from "trpc-cli";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { routedHostnames } from "./generate-wrangler-config.ts";
import { ensureArtifactsNamespace } from "./preview-artifacts.ts";

export default async function ensureResources(options: { env?: string } = {}) {
  const ctx = await resolveEnvContext({
    envs: osEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const namespaces = await ctx.cf<{ id: string; title: string }[]>(
    "/storage/kv/namespaces?per_page=1000",
  );
  const resources = { oauthKvId: "", itxKvId: "" };
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
  // The Artifacts namespace behind `itx.cfArtifacts`: the worker's repo create does not provision
  // one ("Namespace is not active"), so a fresh deployment's must exist before its first project.
  await ensureArtifactsNamespace(ctx.cf, ctx.env.artifactsNamespace);
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  // every routed hostname; a project's own custom hostnames are the worker's, at runtime
  // (src/project/custom-hostnames.ts)
  for (const { hostname } of routedHostnames(ctx.env))
    await ensureProxiedDnsRecord(ctx, zones, hostname, "Clean-room OAuth deployment");
  // IDs live in git, so bring-up always ends in a reviewed commit: on a mismatch with envs.ts, print
  // the entry to paste and fail.
  if (
    resources.oauthKvId !== ctx.env.resources.oauthKvId ||
    resources.itxKvId !== ctx.env.resources.itxKvId
  ) {
    console.log(`\nenvs.ts is out of date for ${ctx.name} — update its resources entry to:\n`);
    console.log(`  resources: ${JSON.stringify(resources, null, 2).replaceAll("\n", "\n  ")},\n`);
    console.log("then commit (the Worker config reads it from envs.ts)");
    process.exit(1);
  }
  console.log(`✅ ${ctx.name} resources all present and match envs.ts`);
}
if (process.argv[1]?.endsWith("ensure-resources.ts"))
  void createCli({ ...import.meta, name: "ensure-resources" }).run();
