import { createCli } from "trpc-cli";
import { OS_DOPPLER_PROJECT, getEnv, osEnvs } from "../../envs.ts";
import { resolveEnvContext } from "../lib/env-context.ts";
import { ensureProxiedDnsRecord } from "../lib/deploy-helpers.ts";
import { osResourceNames } from "../../apps/os/scripts/os-env.ts";
import { routedHostnames } from "../../apps/os/scripts/generate-wrangler-config.ts";
import { ensureD1 } from "./d1.ts";
import { ensureArtifactsNamespace } from "./preview-artifacts.ts";

export default async function ensureResources(options: { env: string }) {
  const ctx = await resolveEnvContext(getEnv(options.env, osEnvs), {
    dopplerProject: OS_DOPPLER_PROJECT,
  });
  const namespaces = await ctx.cf<{ id: string; title: string }[]>(
    "/storage/kv/namespaces?per_page=1000",
  );
  const resources = { oauthKvId: "", itxKvId: "", dbId: "" };
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
  const names = osResourceNames(ctx.env.resourceNamePrefix);
  // The control plane's D1 (the wrangler generator binds it as DB); the deploy migrates it
  // (scripts/os/d1.ts).
  resources.dbId = (await ensureD1(ctx.cf, names.db, "weur")).uuid;
  // The one R2 bucket behind `itx.r2`.
  const bucketName = names.files;
  const buckets = await ctx.cf<{ buckets: { name: string }[] }>("/r2/buckets?per_page=1000");
  if (buckets.buckets.some((bucket) => bucket.name === bucketName)) {
    console.log(`R2 bucket ${bucketName} exists`);
  } else {
    await ctx.cf("/r2/buckets", { method: "POST", body: JSON.stringify({ name: bucketName }) });
    console.log(`created R2 bucket ${bucketName}`);
  }
  // The Artifacts namespace behind `itx.cfArtifacts`: the worker's repo create does not provision
  // one ("Namespace is not active"), so a fresh deployment's must exist before its first project.
  await ensureArtifactsNamespace(ctx.cf, names.repos);
  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  // every routed hostname; a project's own custom hostnames are the worker's, at runtime
  // (apps/os/src/project/custom-hostnames.ts)
  for (const { hostname } of routedHostnames(ctx.env))
    await ensureProxiedDnsRecord(ctx, zones, hostname, "Clean-room OAuth deployment");
  // IDs live in git, so bring-up always ends in a reviewed commit: on a mismatch with envs.ts, print
  // the entry to paste and fail.
  if (
    resources.oauthKvId !== ctx.env.resources?.oauthKvId ||
    resources.itxKvId !== ctx.env.resources?.itxKvId ||
    resources.dbId !== ctx.env.resources?.dbId
  ) {
    console.log(`\nenvs.ts is out of date for ${ctx.env.name} — update its resources entry to:\n`);
    console.log(`  resources: ${JSON.stringify(resources, null, 2).replaceAll("\n", "\n  ")},\n`);
    console.log("then commit (the Worker config reads it from envs.ts)");
    process.exit(1);
  }
  console.log(`✅ ${ctx.env.name} resources all present and match envs.ts`);
}
if (process.argv[1]?.endsWith("ensure-resources.ts"))
  void createCli({ ...import.meta, name: "ensure-resources" }).run();
