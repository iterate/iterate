import { itxEnv as env } from "../../env.ts";
import { getOrCreateBuilderSandbox } from "../sandboxes/builder-sandbox.ts";
import { buildFailureMessageFromError, WorkerBuildFailedError } from "./artifact-store.ts";
import { collectRecipeOutputs, workerBuildRecipe, type WorkerBuildRecipe } from "./build-recipe.ts";
import type { WorkerBuildOptions } from "./schemas.ts";

/**
 * Execute one dynamic-worker build (the shared recipe from build-recipe.ts)
 * and return loader-ready modules. Two runners, one recipe:
 *
 * - Deployed envs drive the PROJECT'S builder sandbox — a real container with
 *   real npm and pinned wrangler (sandboxes/builder-sandbox.ts). All its
 *   egress (npm registry included) flows through the project's egress policy
 *   like any other sandbox traffic.
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
  projectId: string;
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
  input: { buildKey: string; projectId: string },
): Promise<{ mainModule: string; modules: Record<string, string> }> {
  const { sandbox } = await getOrCreateBuilderSandbox(input.projectId);
  // Ephemeral by choice: /build is outside /workspace, so build trees and the
  // npm cache never enter workspace snapshots (the builder's backups stay
  // empty). The cache warms rebuilds only while the container stays up —
  // good enough, and content-addressed artifacts make cold rebuilds correct.
  // The random suffix keeps CONCURRENT builds of one key (which the loader
  // deliberately allows) in separate trees — a shared directory would let one
  // attempt's `rm -rf` or file writes corrupt the other mid-build. Duplicates
  // still converge on the one idempotent KV write.
  const buildDir = `/build/${input.buildKey}-${crypto.randomUUID().slice(0, 8)}`;
  try {
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
      const result = await sandbox.exec(step.command, {
        cwd: buildDir,
        env: { npm_config_cache: "/build/.npm-cache" },
        timeout: step.timeoutMs,
      });
      if (!result.success) {
        throw new WorkerBuildFailedError(
          buildFailureMessageFromError(commandFailureMessage(step, result)),
        );
      }
    }

    // `ls -1` instead of the SDK's listFiles: the output directory is flat by
    // construction (wrangler bundles into it) and a name list is all we need.
    const listing = await sandbox.exec(`ls -1 '${recipe.outputDir}'`, {
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
    await sandbox.exec(`rm -rf '${buildDir}'`, { timeout: 30_000 }).catch(() => {});
  }
}

/** The exec result flattened into the bounded, human-readable message the
 * serve overlay shows. Exit code 124 is the sandbox's verified-timeout
 * answer. */
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
