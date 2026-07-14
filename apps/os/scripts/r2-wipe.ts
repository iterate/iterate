import { fork, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export interface DeletableR2Bucket {
  list(options: { limit: number }): Promise<{
    objects: ReadonlyArray<{ key: string }>;
    truncated: boolean;
  }>;
  delete(keys: string[]): Promise<void>;
}

export interface R2WipeCounts {
  filesObjectsDeleted: number;
  sandboxObjectsDeleted: number;
  searchObjectsDeleted: number;
}

export interface R2WipeResult {
  bucketName: string;
  objectsDeleted: number;
}

const R2WipeChildMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("success"),
      filesObjectsDeleted: z.number().int().nonnegative(),
      sandboxObjectsDeleted: z.number().int().nonnegative(),
      searchObjectsDeleted: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      message: z.string().max(2000),
      causes: z.array(z.string().max(500)).max(8),
    })
    .strict(),
]);

export type R2WipeChildMessage = z.infer<typeof R2WipeChildMessage>;

export interface R2WipeChildInput {
  accountId: string;
  apiToken: string;
  configPath: string;
}

export type R2WipeChildRunner = (input: R2WipeChildInput) => Promise<R2WipeCounts>;

export interface R2WipeDependencies {
  runChild?: R2WipeChildRunner;
  removeTemporaryDirectory?: (path: string) => Promise<void>;
}

const CHILD_TIMEOUT_MS = 2 * 60 * 1000;
const CHILD_SCRIPT = fileURLToPath(new URL("./r2-wipe-child.ts", import.meta.url));
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHILD_AMBIENT_KEYS = [
  "CI",
  "HOME",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "SystemRoot",
  "WINDIR",
] as const;

export interface R2WipeSubprocess {
  readonly connected: boolean;
  readonly pid?: number;
  disconnect(): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  unref(): void;
}

/** Terminate one detached process group, including Wrangler/workerd descendants. */
export function terminateR2WipeProcessGroup(pid: number): void {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    // taskkill returns 128 when the process tree has already exited.
    if (result.status !== 0 && result.status !== 128) {
      throw new Error(`taskkill failed with status ${String(result.status)}.`);
    }
    return;
  }

  try {
    // The detached child is a process-group leader. Negative PID addresses
    // the complete group, including Wrangler's workerd descendant.
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
}

/** Terminate the wrapper and every Wrangler/workerd descendant it started. */
export function terminateR2WipeProcessTree(child: R2WipeSubprocess): void {
  if (child.pid !== undefined) terminateR2WipeProcessGroup(child.pid);
}

function combineLifecycleErrors(primary: Error, terminationError: unknown): Error {
  return terminationError === undefined
    ? primary
    : new AggregateError(
        [primary, terminationError],
        `${primary.message} Process-tree termination also failed.`,
      );
}

/** Wait for one child result, with bounded and idempotent process-tree ownership. */
export async function waitForR2WipeSubprocess(
  child: R2WipeSubprocess,
  options: {
    terminate?: (child: R2WipeSubprocess) => void;
    timeoutMs?: number;
  } = {},
): Promise<R2WipeCounts> {
  const terminate = options.terminate ?? terminateR2WipeProcessTree;
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;

  return await new Promise<R2WipeCounts>((resolve, reject) => {
    let childMessage: R2WipeChildMessage | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout;

    const finish = (
      outcome: { counts: R2WipeCounts } | { error: Error },
      terminateTree: boolean,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      let terminationError: unknown;
      if (terminateTree) {
        try {
          terminate(child);
        } catch (error) {
          terminationError = error;
        }
      }
      if (child.connected) {
        try {
          child.disconnect();
        } catch {
          // The process may have closed IPC between the connected check and
          // disconnect. Process-tree ownership above is the safety boundary.
        }
      }
      child.unref();

      if ("counts" in outcome && terminationError === undefined) {
        resolve(outcome.counts);
        return;
      }
      const primary =
        "error" in outcome
          ? outcome.error
          : new Error("R2 binding subprocess succeeded but its process tree did not terminate.");
      reject(combineLifecycleErrors(primary, terminationError));
    };

    child.on("message", (message) => {
      const parsed = R2WipeChildMessage.safeParse(message);
      if (parsed.success) childMessage = parsed.data;
    });
    child.once("error", (error) => {
      finish(
        { error: new Error("R2 binding subprocess failed to start.", { cause: error }) },
        true,
      );
    });
    child.once("exit", (code, signal) => {
      if (childMessage?.type === "success" && code === 0) {
        finish(
          {
            counts: {
              filesObjectsDeleted: childMessage.filesObjectsDeleted,
              sandboxObjectsDeleted: childMessage.sandboxObjectsDeleted,
              searchObjectsDeleted: childMessage.searchObjectsDeleted,
            },
          },
          true,
        );
        return;
      }
      const error =
        childMessage?.type === "error"
          ? childMessage.causes.length > 0
            ? new AggregateError(
                childMessage.causes.map((message) => new Error(message)),
                `R2 binding subprocess failed: ${childMessage.message}`,
              )
            : new Error(`R2 binding subprocess failed: ${childMessage.message}`)
          : new Error(
              `R2 binding subprocess exited without a result (code ${String(code)}, signal ${String(signal)}).`,
            );
      finish({ error }, true);
    });
    timeout = setTimeout(() => {
      finish(
        { error: new Error(`R2 binding subprocess exceeded ${timeoutMs}ms and was killed.`) },
        true,
      );
    }, timeoutMs);
  });
}

/** Delete and re-list page one until a strongly-consistent R2 bucket is empty. */
export async function deleteAllR2Objects(bucket: DeletableR2Bucket): Promise<number> {
  let objectsDeleted = 0;

  for (;;) {
    // R2 list and bulk delete accept at most 1,000 objects per call. Re-listing
    // page one avoids cursor invalidation while deleting the listed objects.
    // https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
    const listing = await bucket.list({ limit: 1000 });
    const keys = listing.objects.map((object) => object.key);

    if (keys.length === 0) {
      if (listing.truncated) {
        throw new Error(
          "R2 returned an empty truncated listing; refusing to report a partial wipe.",
        );
      }
      return objectsDeleted;
    }

    await bucket.delete(keys);
    objectsDeleted += keys.length;
  }
}

/** The only environment inherited by the trusted Wrangler proxy subprocess. */
export function r2WipeChildEnvironment(
  credentials: { accountId: string; apiToken: string },
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
    CLOUDFLARE_API_TOKEN: credentials.apiToken,
    // Defense in depth: even this allowlisted environment must never become
    // local Worker bindings through Wrangler's opt-in process-env behavior.
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  for (const key of CHILD_AMBIENT_KEYS) {
    const value = ambient[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

const runR2WipeChild: R2WipeChildRunner = async (input) => {
  const child = fork(CHILD_SCRIPT, [input.configPath], {
    cwd: APP_ROOT,
    detached: process.platform !== "win32",
    env: r2WipeChildEnvironment(input),
    execArgv: ["--import", import.meta.resolve("tsx")],
    // Results cross this boundary only as validated IPC messages. Ignoring
    // output avoids referenced pipes that could keep the parent alive after a
    // failed process-tree termination.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return await waitForR2WipeSubprocess(child);
};

/**
 * Wipe OS's user-content buckets through local Wrangler remote bindings.
 *
 * The temporary config contains resource names, never credentials. A trusted,
 * short-lived child process owns Wrangler and receives only a strict environment
 * allowlist; no Worker is deployed and no HTTP route is opened.
 */
export async function wipeRemoteUserDataBuckets(
  input: {
    accountId: string;
    apiToken: string;
    compatibilityDate: string;
    workerName: string;
  },
  dependencies: R2WipeDependencies = {},
): Promise<R2WipeResult[]> {
  const runChild = dependencies.runChild ?? runR2WipeChild;
  const removeTemporaryDirectory =
    dependencies.removeTemporaryDirectory ??
    (async (path: string) => rm(path, { force: true, recursive: true }));
  const filesBucketName = `${input.workerName}-files`;
  const sandboxBucketName = `${input.workerName}-sandboxes`;
  const searchBucketName = `${input.workerName}-search-index`;
  const directory = await mkdtemp(join(tmpdir(), "os-r2-wipe-"));
  const configPath = join(directory, "wrangler.json");
  let result: R2WipeResult[] | undefined;
  let operationError: unknown;

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        name: `${input.workerName}-r2-wipe`,
        account_id: input.accountId,
        compatibility_date: input.compatibilityDate,
        r2_buckets: [
          { binding: "FILES_BUCKET", bucket_name: filesBucketName, remote: true },
          { binding: "SANDBOX_BUCKET", bucket_name: sandboxBucketName, remote: true },
          { binding: "SEARCH_BUCKET", bucket_name: searchBucketName, remote: true },
        ],
      }),
    );

    const counts = await runChild({
      accountId: input.accountId,
      apiToken: input.apiToken,
      configPath,
    });
    result = [
      { bucketName: filesBucketName, objectsDeleted: counts.filesObjectsDeleted },
      { bucketName: sandboxBucketName, objectsDeleted: counts.sandboxObjectsDeleted },
      { bucketName: searchBucketName, objectsDeleted: counts.searchObjectsDeleted },
    ];
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await removeTemporaryDirectory(directory);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "R2 wipe and temporary-config cleanup both failed.",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error("R2 wipe produced no result.");
  return result;
}
