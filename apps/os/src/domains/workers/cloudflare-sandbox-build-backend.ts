import { buildFailureMessageFromError, WorkerBuildFailedError } from "./artifact-store.ts";
import { builderPoolMember, WORKER_BUILDER_POOL_SIZE } from "./builder-pool.ts";
import { getBuilderSandbox, type WorkerBuilderDurableObject } from "./builder-pool-sandbox.ts";
import {
  collectRecipeOutputs,
  PNPM_VERSION,
  workerBuildRecipe,
  WRANGLER_VERSION,
  type WorkerBuildRecipe,
} from "./build-recipe.ts";
import type {
  WorkerBuildBackend,
  WorkerBuildOutcome,
  WorkerBuildOutput,
  WorkerBuildRequest,
} from "./worker-build-contract.ts";

const TOOLCHAIN_ROOT = `/build/.toolchain/wrangler-${WRANGLER_VERSION}-pnpm-${PNPM_VERSION}`;
const TOOLCHAIN_BIN = `${TOOLCHAIN_ROOT}/bin`;
const WRANGLER_BIN = `${TOOLCHAIN_BIN}/wrangler`;
const PNPM_BIN = `${TOOLCHAIN_BIN}/pnpm`;
const TOOLCHAIN_LOCK = `/tmp/.worker-build-toolchain-${WRANGLER_VERSION}-${PNPM_VERSION}.lock`;
const EXEC_ENV = {
  BUN_INSTALL_BIN: TOOLCHAIN_BIN,
  BUN_INSTALL_CACHE_DIR: "/build/.bun-cache",
  BUN_INSTALL_GLOBAL_DIR: `${TOOLCHAIN_ROOT}/global`,
  PATH: `${TOOLCHAIN_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  npm_config_cache: "/build/.npm-cache",
  npm_config_store_dir: "/build/.pnpm-store",
};

/** Bun installed the Wrangler pin in 1.9s in a live stock preview container;
 * the exact two-pin layout is covered by a local stock-toolchain probe. Sixty
 * seconds leaves ample registry headroom while keeping a sick member bounded
 * tightly enough for the one-hop failover to help CI. */
const TOOLCHAIN_TIMEOUT_MS = 60_000;

/**
 * Current implementation of the technology-neutral worker-build backend.
 * Container addressing, toolchain provisioning, load balancing, failover,
 * and filesystem cleanup are private to this adapter.
 */
export class CloudflareSandboxWorkerBuildBackend implements WorkerBuildBackend {
  readonly #activeByMember = new Map<string, number>();
  readonly #namespace: DurableObjectNamespace<WorkerBuilderDurableObject>;

  constructor(namespace: DurableObjectNamespace<WorkerBuilderDurableObject>) {
    this.#namespace = namespace;
  }

  async build(input: WorkerBuildRequest): Promise<WorkerBuildOutcome> {
    let recipe: WorkerBuildRecipe;
    try {
      recipe = workerBuildRecipe({ files: input.files, options: input.options });
    } catch (error) {
      return { status: "build-failed", message: buildFailureMessageFromError(error) };
    }

    try {
      return { status: "built", output: await this.#buildWithFailover(recipe, input.buildKey) };
    } catch (error) {
      if (error instanceof WorkerBuildFailedError) {
        return { status: "build-failed", message: error.message };
      }
      throw error;
    }
  }

  async #buildWithFailover(
    recipe: WorkerBuildRecipe,
    buildKey: string,
  ): Promise<WorkerBuildOutput> {
    const attempted = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const lease = this.#leaseMember(buildKey, attempted);
      attempted.add(lease.member);
      try {
        return await buildOnPoolMember(
          getBuilderSandbox(this.#namespace, lease.member),
          recipe,
          buildKey,
          lease.member,
          attempt,
        );
      } catch (error) {
        if (error instanceof WorkerBuildFailedError) throw error;
        lastError = error;
      } finally {
        lease.release();
      }
    }
    throw lastError;
  }

  #leaseMember(buildKey: string, excluded: Set<string>): { member: string; release(): void } {
    const candidates = Array.from({ length: WORKER_BUILDER_POOL_SIZE }, (_, attempt) =>
      builderPoolMember(buildKey, attempt),
    ).filter((member) => !excluded.has(member));
    const member = candidates.reduce((best, candidate) =>
      (this.#activeByMember.get(candidate) ?? 0) < (this.#activeByMember.get(best) ?? 0)
        ? candidate
        : best,
    );
    this.#activeByMember.set(member, (this.#activeByMember.get(member) ?? 0) + 1);
    return {
      member,
      release: () => {
        const remaining = (this.#activeByMember.get(member) ?? 1) - 1;
        if (remaining === 0) this.#activeByMember.delete(member);
        else this.#activeByMember.set(member, remaining);
      },
    };
  }
}

async function buildOnPoolMember(
  sandbox: WorkerBuilderDurableObject,
  recipe: WorkerBuildRecipe,
  buildKey: string,
  member: string,
  attempt: number,
): Promise<WorkerBuildOutput> {
  const buildDir = `/build/${buildKey}-${crypto.randomUUID().slice(0, 8)}`;
  let buildDirectoryCreated = false;
  let phase = "toolchain";
  const startedAt = Date.now();
  let attemptResult:
    | { status: "built"; output: WorkerBuildOutput }
    | { status: "failed"; error: unknown };
  try {
    // The stock image includes Bun but neither pnpm nor Corepack. Bun installs
    // the two fixed platform tools into a versioned shared directory; flock
    // makes a cold burst pay that bootstrap exactly once per container.
    const toolchain = await sandbox.exec(
      withCommandTimeout(
        `test -x '${WRANGLER_BIN}' -a -x '${PNPM_BIN}' || flock '${TOOLCHAIN_LOCK}' sh -c "test -x '${WRANGLER_BIN}' -a -x '${PNPM_BIN}' || bun install -g 'wrangler@${WRANGLER_VERSION}' 'pnpm@${PNPM_VERSION}' --no-progress --no-summary"`,
        TOOLCHAIN_TIMEOUT_MS,
      ),
      { env: EXEC_ENV, timeout: TOOLCHAIN_TIMEOUT_MS + 15_000 },
    );
    if (!toolchain.success) {
      throw new Error(
        `builder toolchain install failed (exit ${toolchain.exitCode}): ${toolchain.stderr.slice(-500)}`,
      );
    }

    phase = "inputs";
    const directories = new Set([buildDir]);
    for (const name of Object.keys(recipe.files)) {
      const lastSlash = name.lastIndexOf("/");
      if (lastSlash > 0) directories.add(`${buildDir}/${name.slice(0, lastSlash)}`);
    }
    for (const directory of directories) {
      await sandbox.mkdir(directory, { recursive: true });
      if (directory === buildDir) buildDirectoryCreated = true;
    }
    await Promise.all(
      Object.entries(recipe.files).map(async ([name, content]) => {
        const written = await sandbox.writeFile(`${buildDir}/${name}`, content);
        if (!written.success) throw new Error(`could not write build input "${name}"`);
      }),
    );

    for (const [index, step] of recipe.commands.entries()) {
      phase = `command-${index + 1}`;
      const result = await sandbox.exec(withCommandTimeout(step.command, step.timeoutMs), {
        cwd: buildDir,
        env: EXEC_ENV,
        timeout: step.timeoutMs + 15_000,
      });
      if (!result.success) {
        throw new WorkerBuildFailedError(
          buildFailureMessageFromError(commandFailureMessage(step, result)),
        );
      }
    }

    phase = "outputs";
    const listing = await sandbox.exec(`ls -1A '${recipe.outputDir}'`, {
      cwd: buildDir,
      env: EXEC_ENV,
      timeout: 30_000,
    });
    if (!listing.success) {
      throw new Error(`could not list worker build outputs: ${listing.stderr}`);
    }
    const outputs = Object.fromEntries(
      await Promise.all(
        listing.stdout
          .split("\n")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
          .map(async (name) => {
            const read = await sandbox.readFile(`${buildDir}/${recipe.outputDir}/${name}`);
            if (!read.success) throw new Error(`could not read worker build output "${name}"`);
            return [name, read.content] as const;
          }),
      ),
    );
    try {
      attemptResult = { status: "built", output: collectRecipeOutputs(recipe, outputs) };
    } catch (error) {
      throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
    }
  } catch (error) {
    // Source failures are an answered coordinator outcome, not error signal.
    // Infrastructure failures are real even when the bounded failover heals
    // the caller, so record each failed member once with enough context to
    // explain it.
    if (!(error instanceof WorkerBuildFailedError)) {
      console.error("worker build backend infrastructure failure", {
        attempt,
        buildKey,
        durationMs: Date.now() - startedAt,
        error: errorSummary(error),
        member,
        phase,
        willFailOver: attempt === 0,
      });
    }
    attemptResult = { status: "failed", error };
  }

  // Sessionless SDK operations mean this cleanup cannot strand a persistent
  // bash session. Inner coreutils timeouts also reap command children even if
  // the caller's RPC disappears before the SDK response arrives. Cleanup is
  // part of success: a failure supersedes the attempted answer and causes the
  // adapter's bounded failover instead of silently leaking state.
  if (buildDirectoryCreated) {
    try {
      const cleanup = await sandbox.exec(`rm -rf '${buildDir}'`, {
        env: EXEC_ENV,
        timeout: 30_000,
      });
      if (!cleanup.success) {
        throw new Error(
          `worker build cleanup failed (exit ${cleanup.exitCode}): ${cleanup.stderr.slice(-500)}`,
        );
      }
    } catch (error) {
      console.error("worker build backend cleanup failure", {
        attempt,
        buildKey,
        durationMs: Date.now() - startedAt,
        error: errorSummary(error),
        member,
        phase: "cleanup",
        willFailOver: attempt === 0,
      });
      throw error;
    }
  }

  if (attemptResult.status === "failed") throw attemptResult.error;
  return attemptResult.output;
}

/** Kill a hung command inside the container. The SDK timeout remains a
 * transport backstop; coreutils' exit 124 is the deterministic build-timeout
 * answer recorded for source commands. */
function withCommandTimeout(command: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const escaped = command.replaceAll("'", `'\\''`);
  return `timeout -k 10 ${seconds} sh -c '${escaped}'`;
}

function commandFailureMessage(
  step: { command: string; timeoutMs: number },
  result: { exitCode: number; stderr: string; stdout: string },
): string {
  const what =
    result.exitCode === 124
      ? `build step timed out after ${Math.round(step.timeoutMs / 1000)}s`
      : `build step failed (exit ${result.exitCode})`;
  const detail = [result.stderr.slice(-1_500), result.stdout.slice(-500)]
    .filter((part) => part.length > 0)
    .join("\n");
  return `${what}: ${step.command}\n${detail}`;
}

function errorSummary(error: unknown): { message: string; name: string } {
  if (error instanceof Error) return { message: error.message.slice(-1_000), name: error.name };
  return { message: String(error).slice(-1_000), name: typeof error };
}
