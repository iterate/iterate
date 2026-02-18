import type { RestartingProcessEntry } from "pidnap";
import type { IterateConfig } from "../../config/index.ts";
import { loadConfig } from "../config-loader.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";
import { createClient } from "pidnap/client";

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

export async function reconcilePidnapProcesses(): Promise<void> {
  const cwd = getAgentWorkingDirectory();
  const config = await loadConfig(cwd, { forceReload: true });
  const desired = buildDesiredProcesses(config);

  const client = createClient(process.env.PIDNAP_RPC_URL ?? "http://127.0.0.1:9876/rpc");

  for (const processConfig of desired) {
    try {
      await client.processes.add(processConfig);
      console.log(`[pidnap-reconcile] added process: ${processConfig.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already in use")) {
        console.log(`[pidnap-reconcile] process already exists: ${processConfig.name}`);
        continue;
      }
      throw error;
    }
  }
}
