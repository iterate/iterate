import {
  KIT_VOICE_MODE_KEY,
  KIT_VOICE_XAI_SECRET_PATH,
  createKitVoiceInstallPlan,
  type KitVoiceInstallMode,
  type KitVoiceInstallPlan,
} from "./install-plan.ts";

const XAI_EGRESS_POLICY = { urls: ["https://api.x.ai"] };

interface InstallProject {
  kv: {
    set(key: string, value: unknown): Promise<void>;
  };
  repo: {
    commitFiles(input: {
      changes: { content: string; path: string }[];
      message: string;
    }): Promise<{ changedPaths: string[]; commitOid: string }>;
    readFile(input: {
      path: string;
    }): Promise<{ commitOid: string; content: string; path: string } | null>;
  };
  secrets: {
    get(path: string): {
      __describe(): Promise<{ created: boolean }>;
      create(input: { egress: { urls: string[] }; material: unknown }): Promise<unknown>;
      update(input: { egress: { urls: string[] }; material: unknown }): Promise<unknown>;
    };
  };
}

export interface InstallKitVoiceOptions {
  apply: boolean;
  appSources: Readonly<Record<string, string>>;
  mode: KitVoiceInstallMode;
  project: InstallProject;
  projectId: string;
  xaiApiKey?: string;
}

export interface InstallKitVoiceResult {
  applied: boolean;
  changedPaths: string[];
  commitOid?: string;
  mode: KitVoiceInstallMode;
  plan: KitVoiceInstallPlan;
  projectId: string;
}

/**
 * Installs one complete app version through the project's public capability
 * surface. Planning is read-only and is therefore the default CLI behavior.
 *
 * On apply, the order is deliberate:
 *
 * 1. Pin the provider key before any source can reference it.
 * 2. Commit the complete worker source as one repository mutation.
 * 3. Flip the tiny mode knob last.
 *
 * If the final KV write fails, the installed worker safely retains the old
 * mode (or its tone default) and a rerun converges. There is no interval where
 * Grok mode is selected without both code and credential.
 */
export async function installKitVoiceUserspace(
  options: InstallKitVoiceOptions,
): Promise<InstallKitVoiceResult> {
  const [rootWorkerFile, baseWorkerFile] = await Promise.all([
    options.project.repo.readFile({ path: "worker.ts" }),
    options.project.repo.readFile({ path: "worker.base.ts" }),
  ]);
  if (rootWorkerFile === null) {
    throw new Error("The project config repo has no worker.ts to preserve.");
  }

  const plan = createKitVoiceInstallPlan({
    appSources: options.appSources,
    baseWorker: baseWorkerFile?.content ?? null,
    mode: options.mode,
    rootWorker: rootWorkerFile.content,
  });
  if (!options.apply) {
    return {
      applied: false,
      changedPaths: plan.repoChanges.map((change) => change.path),
      mode: options.mode,
      plan,
      projectId: options.projectId,
    };
  }

  if (plan.requiresGrokSecret) {
    const xaiApiKey = options.xaiApiKey?.trim();
    if (!xaiApiKey) {
      throw new Error("XAI_API_KEY is required when applying Grok mode.");
    }
    const secret = options.project.secrets.get(KIT_VOICE_XAI_SECRET_PATH);
    const description = await secret.__describe();
    if (description.created) {
      await secret.update({ egress: XAI_EGRESS_POLICY, material: xaiApiKey });
    } else {
      await secret.create({ egress: XAI_EGRESS_POLICY, material: xaiApiKey });
    }
  }

  const commit = await options.project.repo.commitFiles({
    changes: plan.repoChanges,
    message: "Install Iterate Kit voice userspace worker",
  });
  await options.project.kv.set(KIT_VOICE_MODE_KEY, options.mode);
  return {
    applied: true,
    changedPaths: commit.changedPaths,
    commitOid: commit.commitOid,
    mode: options.mode,
    plan,
    projectId: options.projectId,
  };
}
