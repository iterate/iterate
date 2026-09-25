// scripts/seed-instance-secrets.ts — THE DEPLOYMENT'S OWN KEYS: set Exa, Parallel and OpenAI at
// `global:/secrets/{exa,parallel,openai}` on a deployment, as its operator (the admin bearer's
// `session.global`), and with `--lend-to-every-project` lend each to every project as the same path
// (apps/os README "Instance lends"). The keys come from Doppler: Exa and Parallel from the legacy
// platform's `os-legacy-2026-04` (APP_CONFIG_INTEGRATIONS__EXA, APP_CONFIG_INTEGRATIONS__PARALLEL),
// OpenAI from `os` (OPENAI_API_KEY). No value is ever printed.
//
//   pnpm --dir apps/os seed-instance-secrets --env preview [--deployment pr3063-a1b2c3d] [--lend-to-every-project]
//
// `--env` names the target in envs.ts and is required: there is no default, and prd also needs
// `--confirm-prd`.
import { spawnSync } from "node:child_process";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "undici";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import type { IterateApi } from "iterate/api";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { parseAppConfig } from "../src/app-config.ts";
import { previewDeploymentUrls } from "./preview-config.ts";

/** Each key: its path on the instance, the Doppler project and variable it comes from, and the
 *  origins it is pinned to. */
const KEYS = [
  {
    path: "/secrets/exa",
    dopplerProject: "os-legacy-2026-04",
    variable: "APP_CONFIG_INTEGRATIONS__EXA",
    urls: ["https://api.exa.ai"],
  },
  {
    path: "/secrets/parallel",
    dopplerProject: "os-legacy-2026-04",
    variable: "APP_CONFIG_INTEGRATIONS__PARALLEL",
    urls: ["https://api.parallel.ai"],
  },
  {
    path: "/secrets/openai",
    dopplerProject: OS_DOPPLER_PROJECT,
    variable: "OPENAI_API_KEY",
    urls: ["https://api.openai.com"],
  },
] as const;

/** A legacy integration's config is `{ "apiKey": "…" }` as JSON, or the bare key. */
const keyOf = (text: string) =>
  text.startsWith("{")
    ? z.object({ apiKey: z.string().min(1) }).parse(JSON.parse(text)).apiKey
    : text;

/** Set the deployment's own Exa, Parallel and OpenAI keys, and optionally lend each to every project. */
export default async function seedInstanceSecrets(options: {
  /** the target deployment in envs.ts (preview, prd, …) — required, never defaulted */
  env: string;
  /** a per-commit deployment, by its name (`pr3063-a1b2c3d`), in place of `--env preview`'s own
   *  worker; its keys go with it, so a PR's next push needs seeding again */
  deployment?: string;
  /** the Doppler config of os-legacy-2026-04 that Exa's and Parallel's keys are read from (prd when unset) */
  legacyConfig?: string;
  /** the Doppler config OPENAI_API_KEY is read from (os); the target's own config when unset */
  openaiConfig?: string;
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
  const configOf = (dopplerProject: string) =>
    dopplerProject === OS_DOPPLER_PROJECT
      ? options.openaiConfig || context.env.dopplerConfig
      : options.legacyConfig || "prd";
  const keys = KEYS.map((key) => ({
    ...key,
    value: keyOf(dopplerSecret(key.dopplerProject, configOf(key.dopplerProject), key.variable)),
  }));

  const url = new URL("/api", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  // Undici implements the WebSocket transport; Workers' ambient type has extra unrelated members.
  using rpc = newWebSocketRpcSession<Pick<IterateApi, "authenticate">>(
    socket as unknown as globalThis.WebSocket,
  );
  try {
    const global = rpc.authenticate({ type: "admin-secret", secret: adminSecret }).global;
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
  } finally {
    socket.close();
  }
}

/** One variable of a Doppler config, never echoed. */
function dopplerSecret(project: string, config: string, name: string): string {
  const result = spawnSync(
    "doppler",
    ["secrets", "get", name, "--plain", "--project", project, "--config", config],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim())
    throw new Error(`doppler ${project}/${config} has no ${name}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "seed-instance-secrets" }).run();
