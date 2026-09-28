// scripts/seed-instance-secrets.ts — THE DEPLOYMENT'S OWN KEYS: set Exa, Parallel and OpenAI at
// `global:/secrets/{exa,parallel,openai}` on a deployment, as its operator (the admin bearer's
// `session.global`), and with `--lend-to-every-project` lend each to every project as the same path
// (apps/os/docs/integrations.md "Instance lends"). The keys come from the target's Doppler `os`
// config: EXA_API_KEY, PARALLEL_API_KEY and OPENAI_API_KEY. No value is ever printed.
//
//   pnpm --dir apps/os seed-instance-secrets --env preview [--deployment pr3063-a1b2c3d] [--lend-to-every-project]
//
// `--env` names the target in envs.ts and is required: there is no default, and prd also needs
// `--confirm-prd`.
import { createCli } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { connectIterate } from "iterate/node";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { parseAppConfig } from "../src/app-config.ts";
import { previewDeploymentUrls } from "./preview-config.ts";

/** Each key: its path on the instance, the variable of Doppler `os` it comes from, and the origins
 *  it is pinned to. */
const KEYS = [
  { path: "/secrets/exa", variable: "EXA_API_KEY", urls: ["https://api.exa.ai"] },
  { path: "/secrets/parallel", variable: "PARALLEL_API_KEY", urls: ["https://api.parallel.ai"] },
  { path: "/secrets/openai", variable: "OPENAI_API_KEY", urls: ["https://api.openai.com"] },
] as const;

/** Set the deployment's own Exa, Parallel and OpenAI keys, and optionally lend each to every project. */
export default async function seedInstanceSecrets(options: {
  /** the target deployment in envs.ts (preview, prd, …) — required, never defaulted */
  env: string;
  /** a per-commit deployment, by its name (`pr3063-a1b2c3d`), in place of `--env preview`'s own
   *  worker; its keys go with it, so a PR's next push needs seeding again */
  deployment?: string;
  /** lend each key to every project as its own path (`/secrets/openai` …) */
  lendToEveryProject?: boolean;
  /** required with `--env prd` */
  confirmPrd?: boolean;
}) {
  if (options.env === "prd" && !options.confirmPrd)
    throw new Error("--env prd sets production's keys: pass --confirm-prd as well");
  const context = await resolveEnvContext({
    envs: osEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
  });
  const baseUrl = options.deployment
    ? previewDeploymentUrls(options.deployment).os
    : context.env.baseUrl;
  const adminSecret = parseAppConfig({
    APP_CONFIG: context.secrets.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: context.secrets.APP_CONFIG_SECRETS__KEY,
  }).secrets.adminBearer.exposeSecret();
  const keys = KEYS.map((key) => {
    const value = context.secrets[key.variable];
    if (!value)
      throw new Error(
        `doppler ${OS_DOPPLER_PROJECT}/${context.env.dopplerConfig} has no ${key.variable}`,
      );
    return { ...key, value };
  });

  using connection = await connectIterate({
    baseUrl,
    auth: { type: "admin-secret", secret: adminSecret },
  });
  const { global } = connection.session;
  for (const key of keys) {
    await global.secrets.set(key.path, key.value, { urls: [...key.urls] });
    console.log(`set ${key.path} on ${baseUrl}, pinned to ${key.urls.join(", ")}`);
  }
  if (!options.lendToEveryProject) return;
  const catalog = await global.secrets.list();
  for (const key of keys) {
    const lent = Object.values(catalog.find((row) => row.path === key.path)?.lends ?? {}).some(
      (lend) => lend.to === "every-project",
    );
    if (lent) {
      console.log(`${key.path} is lent to every project already`);
      continue;
    }
    const { everyProject } = await global.secrets.lend(key.path, {
      to: "every-project",
      as: key.path,
    });
    console.log(
      `lent ${key.path} to every project: ${everyProject?.borrowed} borrow it, ${everyProject?.kept.length} keep their own, ${everyProject?.failed.length} failed`,
    );
    for (const failed of everyProject?.failed ?? [])
      console.log(`  ${failed.projectId}: ${failed.error}`);
  }
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "seed-instance-secrets" }).run();
