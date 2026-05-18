import { runCommand } from "../../packages/shared/src/node/run-command.ts";
import { cloudflarePreviewApps } from "./apps.ts";

export const PREVIEW_DOPPLER_SHARED_PROJECT = "_shared";

export function previewDopplerConfigName(previewNumber: number) {
  return `preview_${previewNumber}`;
}

/** App Doppler projects checked by preview reconcile and bootstrapped per slot. */
export function listPreviewAppDopplerProjects() {
  return [...new Set(Object.values(cloudflarePreviewApps).map((app) => app.dopplerProject))].sort();
}

/** App projects plus `_shared`, which owns inheritable preview credentials. */
export function listPreviewManagedDopplerProjects() {
  return [PREVIEW_DOPPLER_SHARED_PROJECT, ...listPreviewAppDopplerProjects()];
}

export type PreviewDopplerProjectEnsureResult = {
  dopplerProject: string;
  action: "exists" | "created";
};

export async function ensurePreviewManagedDopplerProjectsExist(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerProjects?: string[];
  repositoryRoot: string;
}) {
  const dopplerProjects = input.dopplerProjects ?? listPreviewManagedDopplerProjects();
  const results: PreviewDopplerProjectEnsureResult[] = [];

  for (const dopplerProject of dopplerProjects) {
    const exists = await dopplerProjectExists({
      commandEnvironment: input.commandEnvironment,
      dopplerProject,
      repositoryRoot: input.repositoryRoot,
    });
    if (exists) {
      results.push({ dopplerProject, action: "exists" });
      continue;
    }

    await runDoppler({
      args: ["projects", "create", dopplerProject],
      commandEnvironment: input.commandEnvironment,
      repositoryRoot: input.repositoryRoot,
    });
    results.push({ dopplerProject, action: "created" });
  }

  return results;
}

async function dopplerProjectExists(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerProject: string;
  repositoryRoot: string;
}) {
  const result = await runCommand({
    command: "doppler",
    args: ["projects", "get", input.dopplerProject, "--json"],
    echoOutput: false,
    environment: input.commandEnvironment,
    workingDirectory: input.repositoryRoot,
  });
  return result.exitCode === 0;
}

async function runDoppler(input: {
  args: string[];
  commandEnvironment: NodeJS.ProcessEnv;
  repositoryRoot: string;
}) {
  const result = await runCommand({
    command: "doppler",
    args: input.args,
    echoOutput: true,
    environment: input.commandEnvironment,
    workingDirectory: input.repositoryRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `doppler ${input.args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`.trim(),
    );
  }
  return result;
}
