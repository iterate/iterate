import {
  KIT_VOICE_MODE_KEY,
  KIT_VOICE_XAI_SECRET_PATH,
  createKitVoiceInstallPlan,
  type KitVoiceInstallMode,
  type KitVoiceInstallPlan,
} from "./install-plan.ts";
import { kitVoiceWorkerRef } from "./config-worker/app-ref.ts";

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
      __describe(): Promise<{
        created: boolean;
        egress?: { urls: string[] };
        hasMaterial?: boolean;
      }>;
      create(input: { egress: { urls: string[] }; material: unknown }): Promise<unknown>;
      update(input: { egress: { urls: string[] }; material: unknown }): Promise<unknown>;
    };
  };
  workers: {
    get(ref: typeof kitVoiceWorkerRef): {
      kill(): Promise<void>;
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
 * 1. Prove that the provider key already exists with the correct egress pin,
 *    or write the supplied replacement, before source can reference it.
 * 2. Commit the complete worker source as one repository mutation.
 * 3. Flip the tiny mode knob last.
 * 4. Abort the old stateful incarnation so the next device reconnect must
 *    boot from that complete committed generation.
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
    const secret = options.project.secrets.get(KIT_VOICE_XAI_SECRET_PATH);
    const description = await secret.__describe();
    if (xaiApiKey) {
      if (description.created) {
        await secret.update({ egress: XAI_EGRESS_POLICY, material: xaiApiKey });
      } else {
        await secret.create({ egress: XAI_EGRESS_POLICY, material: xaiApiKey });
      }
    } else {
      /*
       * Secret material is intentionally write-only. A source-only upgrade
       * must not demand plaintext merely to write the same credential again;
       * the public description is sufficient to prove both availability and
       * the immutable egress boundary. Refuse any ambiguous state before the
       * repo mutation so a failed install remains completely non-partial.
       */
      if (!description.created || description.hasMaterial !== true) {
        throw new Error("XAI_API_KEY is required when no populated Grok secret exists.");
      }
      if (
        description.egress !== undefined &&
        (description.egress.urls.length !== XAI_EGRESS_POLICY.urls.length ||
          description.egress.urls[0] !== XAI_EGRESS_POLICY.urls[0])
      ) {
        throw new Error("The existing Grok secret is not pinned exclusively to https://api.x.ai.");
      }
    }
  }

  const commit = await options.project.repo.commitFiles({
    changes: plan.repoChanges,
    message: "Install Iterate Kit voice userspace worker",
  });
  await options.project.kv.set(KIT_VOICE_MODE_KEY, options.mode);
  try {
    await options.project.workers.get(kitVoiceWorkerRef).kill();
  } catch (error) {
    /*
     * DurableObjectState.abort() destroys the target before its RPC can send
     * a success response, so the platform's successful lifecycle boundary is
     * necessarily observed as this exact rejection by the caller. Match only
     * the explicit abort reason: auth, routing, or build failures must still
     * make an install fail rather than being normalized as a restart.
     */
    if (!isExpectedWorkerKill(error)) throw error;
  }
  return {
    applied: true,
    changedPaths: commit.changedPaths,
    commitOid: commit.commitOid,
    mode: options.mode,
    plan,
    projectId: options.projectId,
  };
}

function isExpectedWorkerKill(error: unknown): boolean {
  return error instanceof Error && error.message === "kill requested";
}
