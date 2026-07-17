/**
 * Local dev's dynamic-worker build backend: a dev-only vite middleware at
 * `/__dev/worker-build` that runs the SHARED build recipe (npm install +
 * pinned wrangler dry-run — src/domains/workers/build-recipe.ts) on the host
 * toolchain. Deployed envs run the identical recipe in the project's builder
 * sandbox; local dev has no containers, and keeping a second bundler
 * implementation around for dev is exactly the resolution-semantics drift
 * this pipeline exists to kill.
 *
 * The worker side (domains/workers/build-backend.ts) finds this endpoint via
 * the WORKER_BUILD_DEV_ENDPOINT var, set only under `pnpm dev`
 * (generate-wrangler-config.ts). Trust: dev-only, bound to the dev server's
 * own origin; `--ignore-scripts` keeps posted build INPUTS from executing
 * code, same as in the container.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { collectRecipeOutputs, workerBuildRecipe } from "../src/domains/workers/build-recipe.ts";

/** apps/os's own node_modules/.bin, so the recipe's `wrangler` resolves to
 * the SAME pin the build key names (build-recipe.test.ts asserts the
 * devDependency matches WRANGLER_VERSION). */
const TOOLCHAIN_BIN_DIR = fileURLToPath(new URL("../node_modules/.bin", import.meta.url));

export function workerBuildDevEndpoint(): Plugin {
  return {
    name: "iterate:worker-build-dev-endpoint",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/worker-build", (req, res) => {
        void handleBuildRequest(req, res).catch((error: unknown) => {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ message: String(error) }));
        });
      });
    },
  };
}

async function handleBuildRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const { files, options } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    files: Record<string, string>;
    options: Record<string, unknown>;
  };

  const respond = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  // 422 = "the build itself failed" (the worker side records it and serves
  // the failure overlay); 500 stays "the endpoint broke" and retryable.
  let recipe: ReturnType<typeof workerBuildRecipe>;
  try {
    recipe = workerBuildRecipe({ files, options });
  } catch (error) {
    respond(422, { message: error instanceof Error ? error.message : String(error) });
    return;
  }

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
      if (failure !== null) {
        respond(422, { message: failure });
        return;
      }
    }

    const outputDir = join(buildDir, recipe.outputDir);
    const outputs: Record<string, string> = {};
    for (const entry of await readdir(outputDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      outputs[entry.name] = await readFile(join(outputDir, entry.name), "utf8");
    }
    try {
      respond(200, collectRecipeOutputs(recipe, outputs));
    } catch (error) {
      respond(422, { message: error instanceof Error ? error.message : String(error) });
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
