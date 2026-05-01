import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { BaseAppConfig, parseAppConfigFromEnv } from "./config.ts";

export const NewStyleCloudflareAppSlug = z.enum([
  "agents",
  "codemode",
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
  codemode: {
    slug: "codemode",
    displayName: "Codemode",
    appPath: "apps/codemode",
    dopplerProject: "codemode",
    paths: ["apps/codemode/**", "apps/codemode-contract/**"],
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
    deploymentDependencies: ["events"],
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
  return parseAppConfigFromEnv({
    configSchema: BaseAppConfig,
    env,
    prefix: "APP_CONFIG_",
  }).baseUrl;
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
      "exec",
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

async function runCommand(params: {
  args: string[];
  command: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  workingDirectory: string;
}) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(params.command, params.args, {
      cwd: params.workingDirectory,
      env: params.environment,
      signal: params.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk));
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      });
    });
  });
}
