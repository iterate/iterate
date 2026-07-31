export const KIT_VOICE_INSTALLER_MARKER = "// iterate-kit-voice-installer:v1";
export const KIT_VOICE_MODE_KEY = "kit-pcm-mode";
export const KIT_VOICE_XAI_SECRET_PATH = "/secrets/kit/xai-api-key";

export type KitVoiceInstallMode = "grok" | "tone";

export interface KitVoiceInstallPlan {
  mode: KitVoiceInstallMode;
  repoChanges: { content: string; path: string }[];
  requiresGrokSecret: boolean;
  secretPath: string;
}

export function kitVoiceRootWorkerSource() {
  return `${KIT_VOICE_INSTALLER_MARKER}
import ExistingProjectWorker from "./worker.base.ts";
import { kitVoiceWorkerRef } from "./apps/kit-voice/app-ref.ts";

/**
 * The installer owns only this tiny host selector. The project's original
 * worker remains intact in worker.base.ts and continues to own every other
 * route and event-processing behavior.
 */
export default class ProjectWorkerWithKit extends ExistingProjectWorker {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-iterate-app") === "kit") {
      return await this.fetchDynamicWorker(request, kitVoiceWorkerRef);
    }
    return await super.fetch(request);
  }
}
`;
}

/**
 * Produces a complete, inspectable mutation plan without touching a project.
 * Refusing ambiguous backup/wrapper state is intentional: an installer may be
 * rerunnable, but it may never guess which project code is safe to overwrite.
 */
export function createKitVoiceInstallPlan(input: {
  appSources: Readonly<Record<string, string>>;
  baseWorker: string | null;
  mode: KitVoiceInstallMode;
  rootWorker: string;
}): KitVoiceInstallPlan {
  const managedRoot = kitVoiceRootWorkerSource();
  const rootIsManaged = input.rootWorker.startsWith(KIT_VOICE_INSTALLER_MARKER);
  const repoChanges = Object.entries(input.appSources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({ content, path }));

  if (rootIsManaged) {
    if (input.rootWorker !== managedRoot) {
      throw new Error(
        "The managed worker.ts was edited. Reconcile it manually before rerunning the installer.",
      );
    }
    if (input.baseWorker === null) {
      throw new Error("The managed worker.ts has no worker.base.ts to preserve project behavior.");
    }
  } else {
    if (input.baseWorker !== null) {
      throw new Error(
        "worker.base.ts already exists but worker.ts is not managed by the kit installer.",
      );
    }
    repoChanges.push(
      { content: input.rootWorker, path: "worker.base.ts" },
      { content: managedRoot, path: "worker.ts" },
    );
  }

  return {
    mode: input.mode,
    repoChanges,
    requiresGrokSecret: input.mode === "grok",
    secretPath: KIT_VOICE_XAI_SECRET_PATH,
  };
}
