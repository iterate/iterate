import { resolve } from "node:path";
import { z } from "zod";
import { runCommand } from "../node/run-command.ts";

export const NewStyleCloudflareAppSlug = z.enum(["os", "semaphore"]);

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
  "packages/ui/**",
  "packages/mock-http-proxy/**",
] as const;

export const newStyleCloudflareApps: Record<
  NewStyleCloudflareAppSlug,
  NewStyleCloudflareAppDeploymentManifest
> = {
  os: {
    slug: "os",
    displayName: "OS",
    appPath: "apps/os",
    dopplerProject: "os",
    paths: ["apps/os/**", "apps/os-contract/**", "apps/auth/**", "apps/auth-contract/**"],
  },
  semaphore: {
    slug: "semaphore",
    displayName: "Semaphore",
    appPath: "apps/semaphore",
    dopplerProject: "semaphore",
    paths: ["apps/semaphore/**", "apps/semaphore-contract/**"],
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
