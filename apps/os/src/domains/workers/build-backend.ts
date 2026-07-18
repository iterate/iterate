import { itxEnv as env } from "../../env.ts";
import { buildFailureMessageFromError, WorkerBuildFailedError } from "./artifact-store.ts";
import {
  collectRecipeOutputs,
  workerBuildRecipe,
  WRANGLER_VERSION,
  type WorkerBuildRecipe,
} from "./build-recipe.ts";
import type { WorkerBuildOptions } from "./schemas.ts";

/**
 * Execute one dynamic-worker build (the shared recipe from build-recipe.ts)
 * and return loader-ready modules. Two runners, one recipe:
 *
 * - Deployed envs drive the deployment's builder POOL — a fixed handful of
 *   stock sandbox containers with real npm and pinned wrangler
 *   (builder-pool.ts). Builds for one key always land on the same member;
 *   concurrent builds get their own exec session and build tree.
 * - Local dev fetches the vite dev server's `/__dev/worker-build` endpoint,
 *   which runs the identical recipe on the host toolchain — local dev has no
 *   containers (scripts/worker-build-dev-endpoint.ts).
 *
 * Error classification is the caller's contract (worker-loader.ts runBuild):
 * only a genuine build failure — the recipe rejecting the source, a build
 * command exiting nonzero or timing out, output in an unstorable format —
 * throws the named {@link WorkerBuildFailedError}. Everything else (container
 * boot weather, transport, cancellation) stays an ordinary error and
 * therefore retryable, never recorded as a failure.
 */
export async function executeWorkerBuild(input: {
  buildKey: string;
  files: Record<string, string>;
  options: WorkerBuildOptions;
}): Promise<{ mainModule: string; modules: Record<string, string> }> {
  const devEndpoint = env.WORKER_BUILD_DEV_ENDPOINT;
  if (devEndpoint !== undefined && devEndpoint.length > 0) {
    return await buildAtDevEndpoint(devEndpoint, input);
  }

  // Recipe construction rejects malformed sources (missing entry point,
  // unsafe file paths, reserved-name collisions) — deterministic,
  // source-fixable, so a genuine build failure.
  let recipe: WorkerBuildRecipe;
  try {
    recipe = workerBuildRecipe({ files: input.files, options: input.options });
  } catch (error) {
    throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
  }
  return await buildInSandbox(recipe, input);
}

async function buildAtDevEndpoint(
  endpoint: string,
  input: { files: Record<string, string>; options: WorkerBuildOptions },
): Promise<{ mainModule: string; modules: Record<string, string> }> {
  const response = await fetch(endpoint, {
    body: JSON.stringify({ files: input.files, options: input.options }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (response.status === 422) {
    // The endpoint's "the build itself failed" answer — same classification
    // the sandbox lane derives from command exit codes.
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new WorkerBuildFailedError(
      buildFailureMessageFromError(body.message ?? "worker build failed"),
    );
  }
  if (!response.ok) {
    throw new Error(`worker build dev endpoint answered ${response.status}`);
  }
  return (await response.json()) as { mainModule: string; modules: Record<string, string> };
}

async function buildInSandbox(
  recipe: WorkerBuildRecipe,
  input: { buildKey: string },
): Promise<{ mainModule: string; modules: Record<string, string> }> {
  // Deferred import: builder-pool-sandbox pulls the sandbox SDK
  // (`cloudflare:workers`), which only loads inside workerd — and this module
  // sits on import chains that node-side unit tests load. Only the deployed
  // lane reaches this line.
  const { getBuilderSandbox } = await import("./builder-pool-sandbox.ts");
  const sandbox = getBuilderSandbox(env.WORKER_BUILDER, input.buildKey);

  // Ephemeral by choice: the pool's containers snapshot nothing, so build
  // trees and the npm cache live only while a container stays up — good
  // enough (the cache warms rebuilds within a burst) and content-addressed
  // artifacts make cold rebuilds correct. The random suffix keeps CONCURRENT
  // builds — same key (which the loader deliberately allows) or different
  // keys hashed to the same pool member — in separate trees; a shared
  // directory would let one attempt's `rm -rf` or file writes corrupt the
  // other mid-build.
  const buildDir = `/build/${input.buildKey}-${crypto.randomUUID().slice(0, 8)}`;
  // Shell state is per-session on a SHARED container: every build gets its
  // own session so concurrent builds cannot trample each other's shells, and
  // the session carries the npm cache location for every command.
  const session = await sandbox.createSession({
    env: { npm_config_cache: "/build/.npm-cache" },
  });
  try {
    // The pool runs the STOCK sandbox image and installs its own toolchain
    // once per container life. Baking wrangler into the image was tried and
    // reverted: the stock image is cached on effectively every container
    // host, but a per-account derived layer is not — every fresh placement
    // paid a cold image pull measured in MINUTES, observed live as sandbox
    // exec hanging fleet-wide. A failed install throws a PLAIN error —
    // provisioning weather, retryable, never recorded as a build failure of
    // the source.
    const toolchain = await session.exec(
      `command -v wrangler >/dev/null || npm install -g wrangler@${WRANGLER_VERSION} --no-audit --no-fund`,
      { timeout: 120_000 },
    );
    if (!toolchain.success) {
      throw new Error(
        `builder toolchain install failed (exit ${toolchain.exitCode}): ${toolchain.stderr.slice(-500)}`,
      );
    }

    const directories = new Set([buildDir]);
    for (const name of Object.keys(recipe.files)) {
      const lastSlash = name.lastIndexOf("/");
      if (lastSlash > 0) directories.add(`${buildDir}/${name.slice(0, lastSlash)}`);
    }
    for (const directory of directories) {
      await sandbox.mkdir(directory, { recursive: true });
    }
    await Promise.all(
      Object.entries(recipe.files).map(async ([name, content]) => {
        const written = await sandbox.writeFile(`${buildDir}/${name}`, content);
        if (!written.success) throw new Error(`could not write build input "${name}"`);
      }),
    );

    for (const step of recipe.commands) {
      // coreutils `timeout` guarantees the deterministic exit-124 answer for
      // a hung build step regardless of SDK timeout semantics (an SDK-thrown
      // timeout would classify as retryable weather, and a deterministic
      // hang must be a recorded build failure or its delivery retries churn
      // forever). The SDK timeout stays as a backstop with headroom.
      const result = await session.exec(withCommandTimeout(step.command, step.timeoutMs), {
        cwd: buildDir,
        timeout: step.timeoutMs + 30_000,
      });
      if (!result.success) {
        throw new WorkerBuildFailedError(
          buildFailureMessageFromError(commandFailureMessage(step, result)),
        );
      }
    }

    // `ls -1` instead of the SDK's listFiles: the output directory is flat by
    // construction (wrangler bundles into it) and a name list is all we need.
    const listing = await session.exec(`ls -1 '${recipe.outputDir}'`, {
      cwd: buildDir,
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
      return collectRecipeOutputs(recipe, outputs);
    } catch (error) {
      // Output-shape rejection (non-text module, missing entry) is
      // deterministic for this source — a genuine build failure.
      throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
    }
  } finally {
    await session.exec(`rm -rf '${buildDir}'`, { timeout: 30_000 }).catch(() => {});
    await sandbox.deleteSession(session.id).catch(() => {});
  }
}

/** Wrap one build step so a hang is killed IN the container and reported as
 * coreutils' exit 124 — the verified-timeout contract the failure classifier
 * depends on. `-k` covers a step that ignores the polite TERM. */
function withCommandTimeout(command: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const escaped = command.replaceAll("'", `'\\''`);
  return `timeout -k 10 ${seconds} sh -c '${escaped}'`;
}

/** The exec result flattened into the bounded, human-readable message the
 * serve overlay shows. Exit code 124 is the verified-timeout answer. */
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
