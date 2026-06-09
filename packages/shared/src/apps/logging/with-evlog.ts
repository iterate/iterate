// Back-compat shim: moved to @iterate-com/shared/evlog. The new withEvlog takes
// a plain `app: { name, slug }` instead of an AppManifest; this wrapper keeps
// the old manifest-taking signature for existing callers (apps/semaphore).
import type { SharedRequestLogger } from "../../request-logging.ts";
import { withEvlog as withEvlogNew } from "../../evlog/with-evlog.ts";
import type { AppLogsConfig } from "../../evlog/types.ts";
import type { AppManifest } from "../types.ts";

export {
  createPrettyStdoutDrain,
  createRawStdoutDrain,
  formatCompactDuration,
  installEvlogConsoleFilter,
  renderPrettyStdoutEvent,
  writePrettyStdout,
  writeRawStdoutEvent,
} from "../../evlog/stdout.ts";
export type { AppStdoutEvent, RequestLogEntry } from "../../evlog/stdout.ts";
export {
  currentEvlog,
  getCurrentEvlog,
  setWithEvlogFlushHandler,
  shouldKeepAppRequestLog,
} from "../../evlog/with-evlog.ts";

export async function withEvlog<TResponse extends Response>(
  options: {
    request: Request;
    manifest: AppManifest;
    config: { logs: AppLogsConfig };
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  },
  run: (args: { log: SharedRequestLogger }) => Promise<TResponse>,
): Promise<TResponse> {
  return withEvlogNew(
    {
      request: options.request,
      app: { name: options.manifest.packageName, slug: options.manifest.slug },
      config: options.config,
      executionCtx: options.executionCtx,
    },
    run,
  );
}
