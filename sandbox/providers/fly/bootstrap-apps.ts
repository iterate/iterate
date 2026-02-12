import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod/v4";

const FLY_API_BASE = "https://api.machines.dev";
const PREFIX_BY_DOPPLER_CONFIG = {
  dev: "dev",
  stg: "stg",
  prd: "prd",
} as const;
const SHARED_IMAGE_REGISTRY_APP = "iterate-sandbox";

const Env = z.object({
  FLY_API_TOKEN: z.string().optional(),
  FLY_ORG: z.string().default("iterate"),
  FLY_NETWORK: z.string().optional(),
  DOPPLER_PROJECT: z.string().default("os"),
});

type Env = z.infer<typeof Env>;

function resolveFlyToken(env: Env): string {
  return env.FLY_API_TOKEN ?? "";
}

async function flyApi(params: {
  token: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<void> {
  const { token, method, path, body } = params;
  const response = await fetch(`${FLY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.ok) return;
  const message = text.toLowerCase();
  if (message.includes("already exists") || message.includes("has already been taken")) {
    return;
  }
  throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
}

function updateDopplerSecrets(params: { project: string; config: string; prefix: string }): void {
  const { project, config, prefix } = params;
  execSync(
    [
      "doppler secrets set",
      `SANDBOX_NAME_PREFIX=${prefix}`,
      `SANDBOX_FLY_REGISTRY_APP=${SHARED_IMAGE_REGISTRY_APP}`,
      "--project",
      project,
      "--config",
      config,
    ].join(" "),
    { stdio: "inherit" },
  );
}

async function main(): Promise<void> {
  const env = Env.parse(process.env);
  const token = resolveFlyToken(env);
  if (!token) {
    throw new Error("Missing FLY_API_TOKEN.");
  }

  const { values } = parseArgs({
    options: {
      "no-update-doppler": { type: "boolean", default: false },
    },
    strict: true,
  });

  await flyApi({
    token,
    method: "POST",
    path: "/v1/apps",
    body: {
      app_name: SHARED_IMAGE_REGISTRY_APP,
      org_slug: env.FLY_ORG,
      ...(env.FLY_NETWORK ? { network: env.FLY_NETWORK } : {}),
    },
  });
  console.log(`ensured shared fly image registry app '${SHARED_IMAGE_REGISTRY_APP}'`);

  for (const [config, prefix] of Object.entries(PREFIX_BY_DOPPLER_CONFIG)) {
    if (!values["no-update-doppler"]) {
      updateDopplerSecrets({
        project: env.DOPPLER_PROJECT,
        config,
        prefix,
      });
      console.log(
        `set Doppler ${env.DOPPLER_PROJECT}/${config}: SANDBOX_NAME_PREFIX=${prefix}, SANDBOX_FLY_REGISTRY_APP=${SHARED_IMAGE_REGISTRY_APP}`,
      );
    }
  }
}

await main();
