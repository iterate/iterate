import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connectItxReady } from "iterate/node";
import { installKitVoiceUserspace, type InstallKitVoiceResult } from "../src/userspace/install.ts";
import type { KitVoiceInstallMode } from "../src/userspace/install-plan.ts";

const runtimeSourceNames = [
  "app-ref.ts",
  "device-control.ts",
  "device-id.ts",
  "device-events.ts",
  "device-metrics.ts",
  "device-tools.ts",
  "pcm-proxy.ts",
  "provider-event-stream.ts",
  "providers.ts",
  "routes.ts",
  "worker.ts",
  "workerd-globals.d.ts",
] as const;

const usage = `Usage:
  pnpm --dir apps/kit exec tsx scripts/install-userspace-worker.ts \\
    --project-id <prj_...> [--mode tone|grok] [--base-url <origin>] [--plan] [--apply]

Defaults:
  --mode tone
  --base-url https://os.iterate.com
  read-only dry-run unless --apply is present
  concise result summary unless --plan is present

Output:
  --plan                         include generated source in the result

Required secret environment:
  ITERATE_KIT_PROJECT_API_KEY
  XAI_API_KEY                    only with --mode grok --apply

The project credential and xAI key have no command-line flags, keeping them
out of shell history and process listings. Authentication is project-scoped;
this installer does not use the deployment admin secret.`;

export async function installUserspaceWorkerFromCli(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<InstallKitVoiceResult> {
  const options = parseInstallerCliOptions(args, environment);
  const appSources = await readRuntimeSources();
  using project = await connectItxReady(
    {
      auth: {
        projectId: options.projectId,
        secret: options.projectApiKey,
        type: "project-secret",
      },
      baseUrl: options.baseUrl,
      projectId: options.projectId,
    },
    {
      retryInitialConnection: {
        delayMs: 250,
        onRetry: (retry) => {
          console.warn(
            JSON.stringify({
              code: "kit-installer-initial-connect-retry",
              delayMs: retry.delayMs,
              message: retry.error.message,
            }),
          );
        },
      },
    },
  );
  return await installKitVoiceUserspace({
    apply: options.apply,
    appSources,
    mode: options.mode,
    project,
    projectId: options.projectId,
    xaiApiKey: options.xaiApiKey,
  });
}

interface InstallerCliOptions {
  apply: boolean;
  baseUrl: string;
  mode: KitVoiceInstallMode;
  printPlan: boolean;
  projectApiKey: string;
  projectId: string;
  xaiApiKey?: string;
}

export function parseInstallerCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): InstallerCliOptions {
  let apply = false;
  let baseUrl = "https://os.iterate.com";
  let mode: KitVoiceInstallMode = "tone";
  let printPlan = false;
  let projectId = environment.ITERATE_KIT_PROJECT_ID?.trim() ?? "";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--plan") {
      printPlan = true;
      continue;
    }
    if (argument === "--project-id") {
      projectId = requiredArgument(args, ++index, argument);
      continue;
    }
    if (argument === "--base-url") {
      baseUrl = requiredArgument(args, ++index, argument).replace(/\/+$/u, "");
      continue;
    }
    if (argument === "--mode") {
      const selectedMode = requiredArgument(args, ++index, argument);
      if (selectedMode !== "tone" && selectedMode !== "grok") {
        throw new Error("--mode must be either tone or grok.");
      }
      mode = selectedMode;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!/^prj_[A-Za-z0-9_-]+$/u.test(projectId)) {
    throw new Error("--project-id (or ITERATE_KIT_PROJECT_ID) must be a prj_ project ID.");
  }
  const projectApiKey = environment.ITERATE_KIT_PROJECT_API_KEY?.trim() ?? "";
  if (!projectApiKey) throw new Error("ITERATE_KIT_PROJECT_API_KEY is required.");
  const xaiApiKey = environment.XAI_API_KEY?.trim();
  if (apply && mode === "grok" && !xaiApiKey) {
    throw new Error("XAI_API_KEY is required for --mode grok --apply.");
  }

  const parsedBaseUrl = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    throw new Error("--base-url must use http or https.");
  }
  return {
    apply,
    baseUrl: parsedBaseUrl.origin,
    mode,
    printPlan,
    projectApiKey,
    projectId,
    ...(xaiApiKey ? { xaiApiKey } : {}),
  };
}

export async function readRuntimeSources(): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      runtimeSourceNames.map(async (name) => [
        `apps/kit-voice/${name}`,
        await readFile(new URL(`../src/userspace/config-worker/${name}`, import.meta.url), "utf8"),
      ]),
    ),
  );
}

function requiredArgument(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

/**
 * The mutation plan contains every generated worker file, which is valuable
 * for explicit inspection but far too noisy as the normal apply result. The
 * default keeps the operational facts needed for a checkpoint without
 * printing tens of kilobytes of source.
 */
export function formatInstallerResult(result: InstallKitVoiceResult, includePlan: boolean): string {
  if (includePlan) return JSON.stringify(result, null, 2);
  return JSON.stringify(
    {
      applied: result.applied,
      changedPathCount: result.changedPaths.length,
      changedPaths: result.changedPaths,
      ...(result.commitOid === undefined ? {} : { commitOid: result.commitOid }),
      mode: result.mode,
      projectId: result.projectId,
      requiresGrokSecret: result.plan.requiresGrokSecret,
      secretPath: result.plan.secretPath,
    },
    null,
    2,
  );
}

/**
 * Cap'n Web's Node transport can retain the underlying WebSocket after its RPC
 * stubs are disposed. A one-shot installer must not become an accidental
 * daemon, so exit explicitly—but only from stdout's completion callback, or a
 * piped JSON result could be truncated.
 */
export function writeInstallerResultAndExit(
  result: InstallKitVoiceResult,
  options: {
    exit?: (code: number) => void;
    includePlan: boolean;
    write?: (output: string, flushed: () => void) => void;
  },
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const write =
    options.write ??
    ((output: string, flushed: () => void) => {
      process.stdout.write(output, flushed);
    });
  write(`${formatInstallerResult(result, options.includePlan)}\n`, () => exit(0));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage);
  } else {
    try {
      const result = await installUserspaceWorkerFromCli(process.argv.slice(2), process.env);
      writeInstallerResultAndExit(result, {
        includePlan: process.argv.includes("--plan"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`, () => process.exit(1));
    }
  }
}
