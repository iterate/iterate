import { resolve } from "node:path";
import { z } from "zod";
import { runCommand } from "../node/run-command.ts";

export const NewStyleCloudflareAppSlug = z.enum([
  "agents",
  "example",
  "os2",
  "semaphore",
  "ingress-proxy",
]);

export type NewStyleCloudflareAppSlug = z.infer<typeof NewStyleCloudflareAppSlug>;

export type NewStyleCloudflareAppDeploymentManifest = {
  slug: NewStyleCloudflareAppSlug;
  displayName: string;
  appPath: `apps/${string}`;
  dopplerProject: string;
  paths: string[];
  /**
   * Temporary deployment dependency graph. This belongs in each app manifest or
   * contract long-term; orchestration should eventually ask apps for topology
   * instead of carrying it in a central registry.
   */
  deploymentDependencies?: string[];
};

export const newStyleCloudflareAppSharedPaths = [
  "packages/shared/src/alchemy/**",
  "packages/shared/src/apps/**",
] as const;

export const newStyleCloudflareApps: Record<
  NewStyleCloudflareAppSlug,
  NewStyleCloudflareAppDeploymentManifest
> = {
  agents: {
    slug: "agents",
    displayName: "Agents",
    appPath: "apps/agents",
    dopplerProject: "agents",
    paths: ["apps/agents/**", "apps/agents-contract/**"],
  },
  example: {
    slug: "example",
    displayName: "Example",
    appPath: "apps/example",
    dopplerProject: "example",
    paths: ["apps/example/**", "apps/example-contract/**"],
  },
  os2: {
    slug: "os2",
    displayName: "OS",
    appPath: "apps/os2",
    dopplerProject: "os2",
    paths: ["apps/os2/**", "apps/os2-contract/**"],
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    dopplerProject: "semaphore",
    paths: ["apps/semaphore/**", "apps/semaphore-contract/**"],
  },
  "ingress-proxy": {
    slug: "ingress-proxy",
    displayName: "Ingress Proxy",
    appPath: "apps/ingress-proxy",
    dopplerProject: "ingress-proxy",
    paths: ["apps/ingress-proxy/**", "apps/ingress-proxy-contract/**"],
  },
};

export function isNewStyleCloudflareAppSlug(value: string): value is NewStyleCloudflareAppSlug {
  return NewStyleCloudflareAppSlug.safeParse(value).success;
}

export function resolveNewStyleCloudflareAppBaseUrlFromEnv(env: NodeJS.ProcessEnv) {
  if (typeof env.APP_CONFIG_BASE_URL === "string" && env.APP_CONFIG_BASE_URL.trim() !== "") {
    return z.url().parse(env.APP_CONFIG_BASE_URL);
  }

  if (typeof env.APP_CONFIG !== "string" || env.APP_CONFIG.trim() === "") {
    return undefined;
  }

  const parsed = z
    .object({
      baseUrl: z.url().optional(),
    })
    .passthrough()
    .parse(JSON.parse(env.APP_CONFIG));

  return parsed.baseUrl;
}

export async function runNewStyleCloudflareAppAlchemy(input: {
  app: NewStyleCloudflareAppDeploymentManifest;
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerConfig: string;
  operation: "up" | "down";
  repositoryRoot: string;
  signal?: AbortSignal;
}) {
  return await runCommand({
    args: [
      "run",
      "--project",
      input.app.dopplerProject,
      "--config",
      input.dopplerConfig,
      "--",
      "pnpm",
      "tsx",
      "./alchemy.run.ts",
      ...(input.operation === "down" ? ["--destroy"] : []),
    ],
    command: "doppler",
    environment: input.commandEnvironment,
    signal: input.signal,
    workingDirectory: resolve(input.repositoryRoot, input.app.appPath),
  });
}
