// scripts/seed-instance-secrets.ts — THE DEPLOYMENT'S OWN KEYS: set Exa, Parallel and OpenAI at
// `global:/secrets/{exa,parallel,openai}` on a deployment, as its operator (the admin bearer's
// `session.global`), and with `--lend-to-every-project` lend each to every project as the same path
// (apps/os/docs/integrations.md "Instance lends"). The keys come from the target's Doppler `os`
// config: EXA_API_KEY, PARALLEL_API_KEY and OPENAI_API_KEY. No value is ever printed.
//
//   pnpm --dir apps/os seed-instance-secrets --env preview [--pr 3063] [--lend-to-every-project]
//
// `--env` names the target in envs.ts and is required: there is no default, and prd also needs
// `--confirm-prd`.
import { spawnSync } from "node:child_process";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "undici";
import { createCli } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import type { IterateApi } from "iterate/api";
import { OS_DOPPLER_PROJECT, osEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { parseAppConfig } from "../src/app-config.ts";
import { previewUrl } from "./preview-config.ts";

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
  /** a per-PR preview of `--env preview`, by its PR number */
  pr?: number;
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
  const baseUrl = options.pr ? previewUrl(`pr${options.pr}`) : context.env.baseUrl;
  const adminSecret = parseAppConfig({
    APP_CONFIG: context.secrets.APP_CONFIG,
    APP_CONFIG_SECRETS__KEY: context.secrets.APP_CONFIG_SECRETS__KEY,
  }).secrets.adminBearer.exposeSecret();
  const keys = KEYS.map((key) => ({
    ...key,
    value: dopplerSecret(
      (key.variable === "OPENAI_API_KEY" && options.openaiConfig) || context.env.dopplerConfig,
      key.variable,
    ),
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

/** One variable of a Doppler `os` config, never echoed. */
function dopplerSecret(config: string, name: string) {
  const result = spawnSync(
    "doppler",
    ["secrets", "get", name, "--plain", "--project", OS_DOPPLER_PROJECT, "--config", config],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim())
    throw new Error(
      `doppler ${OS_DOPPLER_PROJECT}/${config} has no ${name}: ${result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "seed-instance-secrets" }).run();
