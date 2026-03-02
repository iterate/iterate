import type { RestartingProcessEntry } from "pidnap";
import { createClient } from "pidnap/client";
import type { IterateConfig } from "../../config/index.ts";
import { loadConfig } from "../config-loader.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";

const ITERATE_USER_TAG = "iterate:user";

type DesiredProcess = {
  name: string;
  definition: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    inheritProcessEnv?: boolean;
  };
  options?: RestartingProcessEntry["options"];
  envOptions?: RestartingProcessEntry["envOptions"];
  tags: string[];
};

type ExistingProcess = {
  name: string;
  tags: string[];
};

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

function buildDesiredProcesses(config: IterateConfig): DesiredProcess[] {
  const seen = new Set<string>();
  const desired: DesiredProcess[] = [];

  for (const processConfig of config.pidnap?.processes ?? []) {
    if (seen.has(processConfig.name)) {
      throw new Error(`Duplicate pidnap process name in iterate.config.ts: ${processConfig.name}`);
    }
    seen.add(processConfig.name);

    desired.push({
      name: processConfig.name,
      definition: processConfig.definition,
      options: processConfig.options,
      envOptions: processConfig.envOptions,
      tags: dedupeTags([...(processConfig.tags ?? []), ITERATE_USER_TAG]),
    });
  }

  return desired;
}

export async function reconcilePidnapProcesses(options?: { configCwd?: string }): Promise<void> {
  const cwd = options?.configCwd ?? getAgentWorkingDirectory();
  const config = await loadConfig(cwd, { forceReload: true });
  const desired = buildDesiredProcesses(config);
  const desiredNames = new Set(desired.map((processConfig) => processConfig.name));

  const client = createClient(process.env.PIDNAP_RPC_URL ?? "http://127.0.0.1:9876/rpc");
  const existingProcesses = (await client.processes.list()) satisfies ExistingProcess[];

  const managedExistingProcessNames = existingProcesses
    .filter((processInfo) => processInfo.tags.includes(ITERATE_USER_TAG))
    .map((processInfo) => processInfo.name);

  for (const processConfig of desired) {
    await client.processes.updateConfig({
      processSlug: processConfig.name,
      definition: processConfig.definition,
      options: processConfig.options,
      envOptions: processConfig.envOptions,
      tags: processConfig.tags,
      restartImmediately: false,
    });
    console.log(`[pidnap-reconcile] upserted process: ${processConfig.name}`);
  }

  for (const processName of managedExistingProcessNames) {
    if (desiredNames.has(processName)) continue;
    await client.processes.delete({ processSlug: processName });
    console.log(`[pidnap-reconcile] removed process: ${processName}`);
  }
}
