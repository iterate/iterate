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
import type { Plugin } from "vite";
import { workerBuildRecipe } from "../src/domains/workers/build-recipe.ts";
import { runWorkerBuildRecipeOnHost } from "./lib/worker-build-host-runner.ts";

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

  const result = await runWorkerBuildRecipeOnHost(recipe);
  if (result.status === "build-failed") {
    respond(422, { message: result.message });
    return;
  }
  respond(200, { mainModule: result.mainModule, modules: result.modules });
}
