import { initLogger } from "evlog";
import { initWorkersLogger } from "evlog/workers";
import type { AppContext } from "../types.ts";
import {
  createPrettyStdoutDrain,
  createRawStdoutDrain,
  installEvlogConsoleFilter,
} from "./stdout.ts";

type AppLoggingContext = AppContext<any, { logs: { stdoutFormat: "raw" | "pretty" } }>;

/**
 * Nitro owns request logger lifecycle, but we still want app config to drive the
 * stdout format policy. This helper returns the evlog module options that
 * `vite.config.ts` passes to `evlog/nitro/v3`.
 */
export function createNitroEvlogModuleOptions(options: { context: AppLoggingContext }) {
  return {
    env: {
      appName: options.context.manifest.packageName,
      version: options.context.manifest.version,
    },
    ...(options.context.config.logs.stdoutFormat === "pretty"
      ? {
          pretty: false,
          stringify: false,
        }
      : {}),
  };
}

/**
 * Workers explicitly choose their global logger init path.
 *
 * `stdoutFormat` is selected only by app config. `manifest` still contributes
 * stable app/version metadata to the emitted event.
 */
export function initConfiguredWorkerLogging(options: { context: AppLoggingContext }) {
  const initOptions = {
    env: {
      appName: options.context.manifest.packageName,
      version: options.context.manifest.version,
    },
    pretty: false,
    stringify: false,
  } satisfies {
    env: { appName: string; version: string };
    pretty: false;
    stringify: false;
  };

  if (options.context.config.logs.stdoutFormat === "pretty") {
    installEvlogConsoleFilter();
    initLogger({
      ...initOptions,
      drain: createPrettyStdoutDrain(),
    });
    return;
  }

  initWorkersLogger({
    ...initOptions,
    drain: createRawStdoutDrain(),
  });
}

/**
 * Request-final events keep a short one-line summary `message` while the
 * structured fields stay the source of truth.
 */
export function formatEvlogRequestSummaryMessage(options: {
  method?: string | null;
  path?: string | null;
  status: number;
  durationMs: number;
  requestLogCount: number;
}) {
  const method = options.method?.trim() || "UNKNOWN";
  const path = options.path?.trim() || "unknown";
  const linesWord = options.requestLogCount === 1 ? "line" : "lines";

  return `${method} ${path} ${options.status} in ${options.durationMs}ms (${options.requestLogCount} ${linesWord})`;
}
