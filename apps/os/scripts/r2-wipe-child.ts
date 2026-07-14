import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import {
  deleteAllR2Objects,
  type DeletableR2Bucket,
  type R2WipeChildMessage,
  type R2WipeCounts,
  terminateR2WipeProcessGroup,
} from "./r2-wipe.ts";

interface UserDataR2Bindings {
  [key: string]: unknown;
  FILES_BUCKET: DeletableR2Bucket;
  SANDBOX_BUCKET: DeletableR2Bucket;
  SEARCH_BUCKET: DeletableR2Bucket;
}

interface RemoteR2Proxy {
  env: UserDataR2Bindings;
  dispose(): Promise<void>;
}

export type RemoteR2ProxyFactory = (configPath: string) => Promise<RemoteR2Proxy>;

const CHILD_SELF_TIMEOUT_MS = 115_000;

/**
 * A detached wipe child owns its process group. If its parent disappears,
 * cancellation must stop both this wrapper and Wrangler's workerd process;
 * otherwise an orphan can keep deleting while a replacement deploy writes.
 */
export function armR2WipeChildWatchdog(
  input: {
    childProcess?: Pick<NodeJS.Process, "connected" | "off" | "once" | "pid">;
    terminate?: (pid: number) => void;
    timeoutMs?: number;
  } = {},
) {
  const childProcess = input.childProcess ?? process;
  const terminate = input.terminate ?? terminateR2WipeProcessGroup;
  const timeoutMs = input.timeoutMs ?? CHILD_SELF_TIMEOUT_MS;
  let completed = false;
  let terminating = false;

  const terminateUnexpectedly = () => {
    if (completed || terminating) return;
    terminating = true;
    terminate(childProcess.pid);
  };
  const timeout = setTimeout(terminateUnexpectedly, timeoutMs);
  timeout.unref();
  childProcess.once("disconnect", terminateUnexpectedly);
  childProcess.once("SIGHUP", terminateUnexpectedly);
  childProcess.once("SIGINT", terminateUnexpectedly);
  childProcess.once("SIGTERM", terminateUnexpectedly);
  if (!childProcess.connected) terminateUnexpectedly();

  return {
    complete() {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      childProcess.off("disconnect", terminateUnexpectedly);
      childProcess.off("SIGHUP", terminateUnexpectedly);
      childProcess.off("SIGINT", terminateUnexpectedly);
      childProcess.off("SIGTERM", terminateUnexpectedly);
    },
  };
}

const openRemoteR2Proxy: RemoteR2ProxyFactory = async (configPath) => {
  // Wrangler keeps Worker execution local while forwarding supported binding
  // operations to the configured remote resources.
  // https://developers.cloudflare.com/workers/local-development/#remote-bindings
  // https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy
  return getPlatformProxy<UserDataR2Bindings>({
    configPath,
    envFiles: [],
    persist: false,
    remoteBindings: true,
  });
};

/** Own the Wrangler proxy for one isolated subprocess invocation. */
export async function wipeR2FromChild(
  configPath: string,
  createProxy: RemoteR2ProxyFactory = openRemoteR2Proxy,
): Promise<R2WipeCounts> {
  let proxy: RemoteR2Proxy | undefined;
  let counts: R2WipeCounts | undefined;
  let operationError: unknown;

  try {
    proxy = await createProxy(configPath);
    const exposedCredentials = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((key) =>
      Object.prototype.hasOwnProperty.call(proxy?.env, key),
    );
    if (exposedCredentials.length > 0) {
      throw new Error("Wrangler exposed control-plane credentials as local Worker bindings.");
    }

    const deletions = await Promise.allSettled([
      deleteAllR2Objects(proxy.env.FILES_BUCKET),
      deleteAllR2Objects(proxy.env.SANDBOX_BUCKET),
      deleteAllR2Objects(proxy.env.SEARCH_BUCKET),
    ]);
    const failures = deletions.flatMap((deletion) =>
      deletion.status === "rejected" ? [deletion.reason] : [],
    );
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, `${failures.length} R2 user-data bucket wipes failed.`);
    }
    const [filesDeletion, sandboxDeletion, searchDeletion] = deletions as [
      PromiseFulfilledResult<number>,
      PromiseFulfilledResult<number>,
      PromiseFulfilledResult<number>,
    ];
    counts = {
      filesObjectsDeleted: filesDeletion.value,
      sandboxObjectsDeleted: sandboxDeletion.value,
      searchObjectsDeleted: searchDeletion.value,
    };
  } catch (error) {
    operationError = error;
  }

  let disposeError: unknown;
  try {
    await proxy?.dispose();
  } catch (error) {
    disposeError = error;
  }
  if (operationError !== undefined && disposeError !== undefined) {
    throw new AggregateError(
      [operationError, disposeError],
      "R2 wipe and proxy disposal both failed.",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (disposeError !== undefined) throw disposeError;
  if (counts === undefined) throw new Error("R2 binding subprocess produced no wipe result.");
  return counts;
}

function redactErrorMessage(message: string): string {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const redacted = apiToken
    ? message
        .replaceAll(apiToken, "[REDACTED]")
        .replaceAll(encodeURIComponent(apiToken), "[REDACTED]")
    : message;
  return redacted.replace(/(authorization:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
}

/** Flatten bounded, redacted causes because Error objects do not survive Node IPC. */
export function serializeR2WipeError(error: unknown): {
  message: string;
  causes: string[];
} {
  const message = redactErrorMessage(error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
  const causes: string[] = [];
  const seen = new Set<unknown>([error]);

  const visit = (candidate: unknown) => {
    if (causes.length >= 8 || seen.has(candidate)) return;
    seen.add(candidate);
    const rendered = redactErrorMessage(
      candidate instanceof Error ? candidate.message : String(candidate),
    ).slice(0, 500);
    if (rendered && rendered !== message && !causes.includes(rendered)) causes.push(rendered);

    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) visit(nested);
    }
    if (candidate instanceof Error && candidate.cause !== undefined) visit(candidate.cause);
  };

  if (error instanceof AggregateError) {
    for (const nested of error.errors) visit(nested);
  }
  if (error instanceof Error && error.cause !== undefined) visit(error.cause);
  return { message, causes };
}

async function send(message: R2WipeChildMessage): Promise<void> {
  if (process.send === undefined) throw new Error("R2 binding subprocess requires an IPC channel.");
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("R2 binding subprocess requires a Wrangler config path.");
  const watchdog = armR2WipeChildWatchdog();

  try {
    const counts = await wipeR2FromChild(configPath);
    await send({ type: "success", ...counts });
    watchdog.complete();
    process.disconnect?.();
    process.exit(0);
  } catch (error) {
    await send({ type: "error", ...serializeR2WipeError(error) }).catch(() => {});
    watchdog.complete();
    process.disconnect?.();
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
