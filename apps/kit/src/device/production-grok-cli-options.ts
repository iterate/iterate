import { fileURLToPath } from "node:url";
import {
  DEFAULT_KIT_DEVICE_ID,
  kitDeviceEventStreamPath,
} from "../userspace/config-worker/provider-event-stream.ts";

const defaultProjectId = "prj_65441737530642949cadaf7fe399368b";
const defaultProjectSlug = "kit-stick-vertical-proof";
const defaultBaseUrl = "https://os.iterate.com";
const defaultWorkerHost = "kit--kit-stick-vertical-proof.iterate.app";
const defaultDeviceHost = "192.168.0.21";

export type PttAuthority = "physical" | "remote";

export interface ProductionGrokCliOptions {
  acousticInput?: string;
  baseUrl: string;
  deviceHost: string;
  deviceId: string;
  ffmpegExecutable?: string;
  outputDirectory: string;
  projectApiKey: string;
  projectId: string;
  projectSlug: string;
  pttAuthority: PttAuthority;
  sayExecutable: string;
  soxExecutable?: string;
  workerHost: string;
  xaiApiKey: string;
}

/**
 * Parses the production proof's non-secret CLI surface.
 *
 * The device id deliberately defaults to the historical Stick route, while
 * `--device-id` makes the same event reader and artifact layout available to
 * later boards. Validation reuses the stream-path constructor because a proof
 * must never accept an identity the deployed userspace route cannot isolate.
 */
export function parseProductionGrokCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ProductionGrokCliOptions {
  let baseUrl = defaultBaseUrl;
  let deviceHost = defaultDeviceHost;
  let deviceId = DEFAULT_KIT_DEVICE_ID;
  let outputDirectory: string | undefined;
  let projectId = environment.ITERATE_KIT_PROJECT_ID?.trim() || defaultProjectId;
  let projectSlug = defaultProjectSlug;
  let pttAuthority: PttAuthority = "physical";
  let workerHost = defaultWorkerHost;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = () => {
      const selected = args[++index]?.trim();
      if (!selected) throw new Error(`${flag} requires a value.`);
      return selected;
    };
    if (flag === "--remote-ptt") pttAuthority = "remote";
    else if (flag === "--project-id") projectId = value();
    else if (flag === "--project-slug") projectSlug = value();
    else if (flag === "--base-url") baseUrl = value();
    else if (flag === "--worker-host") workerHost = value();
    else if (flag === "--device-host") deviceHost = value();
    else if (flag === "--device-id") deviceId = value();
    else if (flag === "--output-directory") outputDirectory = value();
    else throw new Error(`Unknown option: ${flag}`);
  }

  /* Validate before deriving either the capability or evidence route. */
  kitDeviceEventStreamPath(deviceId);
  const projectApiKey = environment.ITERATE_KIT_PROJECT_API_KEY?.trim() ?? "";
  if (!projectApiKey) throw new Error("ITERATE_KIT_PROJECT_API_KEY is required.");
  const xaiApiKey = environment.XAI_API_KEY?.trim() ?? "";
  if (!xaiApiKey) throw new Error("XAI_API_KEY is required for the independent acoustic oracle.");
  if (!/^prj_[A-Za-z0-9_-]+$/u.test(projectId)) {
    throw new Error("--project-id must be a prj_ project ID.");
  }
  return {
    acousticInput: environment.ITERATE_KIT_ACOUSTIC_INPUT?.trim() || undefined,
    baseUrl: new URL(baseUrl).origin,
    deviceHost,
    deviceId,
    ffmpegExecutable: environment.ITERATE_KIT_FFMPEG?.trim() || undefined,
    outputDirectory:
      outputDirectory ??
      fileURLToPath(new URL(`../../evidence/${deviceId}-production-grok`, import.meta.url)),
    projectApiKey,
    projectId,
    projectSlug,
    pttAuthority,
    sayExecutable: environment.ITERATE_KIT_SAY?.trim() || "/usr/bin/say",
    soxExecutable: environment.ITERATE_KIT_SOX?.trim() || undefined,
    workerHost,
    xaiApiKey,
  };
}
