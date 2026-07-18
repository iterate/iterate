/**
 * Run the shared dynamic-worker build recipe on the HOST node toolchain — the
 * runner behind local dev's `/__dev/worker-build` endpoint and the deploy-time
 * template seeder. `wrangler` resolves through apps/os's own node_modules/.bin,
 * so the pin is the SAME one the build key names (build-recipe.test.ts asserts
 * the three-way lockstep with WRANGLER_VERSION and the sandbox image).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectRecipeOutputs,
  collectViteRecipeOutputs,
  type WorkerBuildRecipe,
} from "../../src/domains/workers/build-recipe.ts";

const TOOLCHAIN_BIN_DIR = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

export type HostRecipeRunResult =
  /** The build itself failed (nonzero exit, timeout, unstorable output) —
   * deterministic for this source, the caller records/reports it. Infra
   * problems (fs errors, spawn failures) throw instead and stay retryable. */
  | { status: "build-failed"; message: string }
  | { status: "ok"; mainModule: string; modules: Record<string, string> };

export async function runWorkerBuildRecipeOnHost(
  recipe: WorkerBuildRecipe,
): Promise<HostRecipeRunResult> {
  const buildDir = await mkdtemp(join(tmpdir(), "iterate-worker-build-"));
  try {
    for (const [name, content] of Object.entries(recipe.files)) {
      // Recipe construction validated every name as a safe relative path.
      const path = join(buildDir, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }

    for (const step of recipe.commands) {
      const failure = await runShellCommand(step, buildDir);
      if (failure !== null) return { status: "build-failed", message: failure };
    }

    const outputDir = join(buildDir, recipe.outputDir);
    const outputs: Record<string, string> = {};
    if (recipe.pipeline === "vite") {
      // The vite lane's output is the nested dist/ tree; keys carry the
      // dist/ prefix the collector expects. Maps and vite manifests are
      // skipped before read, mirroring the sandbox runner.
      const walk = async (dir: string, prefix: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          const key = `${prefix}${entry.name}`;
          if (entry.isDirectory()) await walk(path, `${key}/`);
          else if (entry.isFile() && !key.endsWith(".map") && !key.includes("/.vite/")) {
            outputs[key] = await readFile(path, "utf8");
          }
        }
      };
      await walk(outputDir, `${recipe.outputDir}/`);
    } else {
      for (const entry of await readdir(outputDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        outputs[entry.name] = await readFile(join(outputDir, entry.name), "utf8");
      }
    }
    try {
      return {
        status: "ok",
        ...(recipe.pipeline === "vite"
          ? collectViteRecipeOutputs(outputs)
          : collectRecipeOutputs(recipe, outputs)),
      };
    } catch (error) {
      return {
        status: "build-failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    await rm(buildDir, { force: true, recursive: true }).catch(() => {});
  }
}

/** Run one recipe command to completion; null on success, else the bounded
 * failure message (both timeouts and nonzero exits are build failures — the
 * same classification the sandbox runner derives from exit codes). */
function runShellCommand(
  step: { command: string; timeoutMs: number },
  cwd: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", step.command],
      {
        cwd,
        env: { ...process.env, PATH: `${TOOLCHAIN_BIN_DIR}:${process.env.PATH ?? ""}` },
        maxBuffer: 64 * 1024 * 1024,
        timeout: step.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(null);
          return;
        }
        const what = error.killed
          ? `build step timed out after ${Math.round(step.timeoutMs / 1000)}s`
          : `build step failed (exit ${error.code ?? "?"})`;
        const detail = [stderr.slice(-1_500), stdout.slice(-500)]
          .filter((part) => part.length > 0)
          .join("\n");
        resolve(`${what}: ${step.command}\n${detail}`);
      },
    );
  });
}
