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
export type ProductionSpokenCountScenario =
  | "count-100-to-200"
  | "count-200-to-300"
  | "count-300-to-400-interrupted"
  | "count-to-100";
export type ProductionGrokProofScenario = "conversation" | ProductionSpokenCountScenario;

export type ProductionSpokenCountPlan =
  | {
      interrupted: false;
      range: { end: number; start: number };
    }
  | {
      interrupted: true;
      minimumNumbers: number;
      range: { end: number; start: number };
    };

const spokenCountScenarioByFlag: Readonly<Record<string, ProductionSpokenCountScenario>> = {
  "--count-100-to-200": "count-100-to-200",
  "--count-200-to-300": "count-200-to-300",
  "--count-300-to-400-interrupted": "count-300-to-400-interrupted",
  "--count-to-100": "count-to-100",
};
const spokenCountFlagByScenario: Readonly<Record<ProductionSpokenCountScenario, string>> = {
  "count-100-to-200": "--count-100-to-200",
  "count-200-to-300": "--count-200-to-300",
  "count-300-to-400-interrupted": "--count-300-to-400-interrupted",
  "count-to-100": "--count-to-100",
};
const spokenCountPlanByScenario: Readonly<
  Record<ProductionSpokenCountScenario, ProductionSpokenCountPlan>
> = {
  "count-100-to-200": { interrupted: false, range: { end: 200, start: 100 } },
  "count-200-to-300": { interrupted: false, range: { end: 300, start: 200 } },
  "count-300-to-400-interrupted": {
    interrupted: true,
    minimumNumbers: 25,
    range: { end: 400, start: 300 },
  },
  "count-to-100": { interrupted: false, range: { end: 100, start: 1 } },
};

/** Returns the complete terminal policy for one physical spoken-count gate. */
export function productionSpokenCountPlan(
  scenario: ProductionGrokProofScenario,
): ProductionSpokenCountPlan | undefined {
  if (scenario === "conversation") return undefined;
  return spokenCountPlanByScenario[scenario];
}

/** Builds the one direction-redundant acoustic command shared by every board. */
export function productionSpokenCountPrompt(range: { end: number; start: number }): string {
  /*
   * Do not collapse this to the more natural “Count from A through B”. In a
   * retained physical run, xAI heard its first word as “Down”; Grok then
   * correctly generated B..A and wasted a 76-second acceptance interval. The
   * transport had not failed—the instruction had one fragile acoustic point
   * of failure. “Upwards”, “start”, and “end” make direction independently
   * recoverable without changing the numbers the output oracle accepts.
   *
   * Keeping the prompt beside the shared scenario plan matters too: Stick's
   * former runner accepted the same CLI flags as the full-duplex boards but
   * silently substituted its default sprite sentence. One board-independent
   * command prevents target-local proof dialects from drifting again.
   */
  return (
    `Count upwards from ${range.start} through ${range.end}. ` +
    `Start with ${range.start}, end with ${range.end}, include both endpoints, ` +
    "and say every number exactly once, with no preamble and no omissions"
  );
}

/** Returns the fixed physical acceptance range named by a count scenario. */
export function productionSpokenCountRange(
  scenario: ProductionGrokProofScenario,
): { end: number; start: number } | undefined {
  return productionSpokenCountPlan(scenario)?.range;
}

/** Shares exact scenario flags between the outer flash runner and inner proof. */
export function productionSpokenCountFlag(
  scenario: ProductionGrokProofScenario,
): string | undefined {
  if (scenario === "conversation") return undefined;
  return spokenCountFlagByScenario[scenario];
}

export function productionSpokenCountScenarioFromFlag(
  flag: string,
): ProductionSpokenCountScenario | undefined {
  return spokenCountScenarioByFlag[flag];
}

export interface ProductionGrokCliOptions {
  acousticInput?: string;
  baseUrl: string;
  deviceHost: string;
  deviceId: string;
  ffmpegExecutable?: string;
  outputDirectory: string;
  projectApiKey?: string;
  projectId: string;
  projectSlug: string;
  pttAuthority: PttAuthority;
  scenario: ProductionGrokProofScenario;
  sayExecutable: string;
  soxExecutable?: string;
  turns: number;
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
  let scenario: ProductionGrokProofScenario = "conversation";
  let turns = 1;
  let workerHost = defaultWorkerHost;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = () => {
      const selected = args[++index]?.trim();
      if (!selected) throw new Error(`${flag} requires a value.`);
      return selected;
    };
    const spokenCountScenario = productionSpokenCountScenarioFromFlag(flag);
    if (flag === "--remote-ptt") pttAuthority = "remote";
    else if (spokenCountScenario) {
      if (scenario !== "conversation") {
        throw new Error("Only one spoken-count scenario may be selected.");
      }
      scenario = spokenCountScenario;
    } else if (flag === "--project-id") projectId = value();
    else if (flag === "--project-slug") projectSlug = value();
    else if (flag === "--base-url") baseUrl = value();
    else if (flag === "--worker-host") workerHost = value();
    else if (flag === "--device-host") deviceHost = value();
    else if (flag === "--device-id") deviceId = value();
    else if (flag === "--output-directory") outputDirectory = value();
    else if (flag === "--turns") {
      turns = Number(value());
      if (!Number.isSafeInteger(turns) || turns < 1 || turns > 20) {
        throw new Error("--turns must be an integer from 1 through 20.");
      }
    } else throw new Error(`Unknown option: ${flag}`);
  }

  /* Validate before deriving either the capability or evidence route. */
  kitDeviceEventStreamPath(deviceId);
  const projectApiKey = environment.ITERATE_KIT_PROJECT_API_KEY?.trim() || undefined;
  if (!projectApiKey && !environment.APP_CONFIG_ADMIN_API_SECRET?.trim()) {
    throw new Error("A project ingress credential or admin pairing credential is required.");
  }
  const xaiApiKey =
    environment.XAI_API_KEY?.trim() || environment.APP_CONFIG_X_AI_API_KEY?.trim() || "";
  if (!xaiApiKey) {
    throw new Error(
      "XAI_API_KEY or APP_CONFIG_X_AI_API_KEY is required for the independent acoustic oracle.",
    );
  }
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
    scenario,
    sayExecutable: environment.ITERATE_KIT_SAY?.trim() || "/usr/bin/say",
    soxExecutable: environment.ITERATE_KIT_SOX?.trim() || undefined,
    turns,
    workerHost,
    xaiApiKey,
  };
}
