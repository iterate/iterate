import { NodeServices } from "@effect/platform-node";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { EnvironmentState, type EnvironmentStage } from "../src/state.ts";
import {
  destroyEnvironment,
  environmentStage,
  readEnvironmentState,
  withEnvironment,
} from "./client.ts";

function runPlatformEffect<A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped));
}

const removeResourceManifest = Effect.fn("envManager.removeResourceManifest")(function* (
  stage: EnvironmentStage,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  yield* fileSystem.remove(
    path.join(appRoot, ".alchemy", "output", stage, "cloudflare-resources.json"),
    { force: true },
  );
});

const writeResourceManifest = Effect.fn("envManager.writeResourceManifest")(function* (input: {
  resources: EnvironmentState["resources"];
  stage: EnvironmentStage;
}) {
  if (input.resources === undefined) {
    return yield* Effect.fail(
      new Error(`Environment manager returned no resources for ${input.stage}.`),
    );
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const directory = path.join(appRoot, ".alchemy", "output", input.stage);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const temporary = yield* fileSystem.makeTempFileScoped({ directory });
  yield* fileSystem.writeFileString(temporary, `${JSON.stringify(input.resources, null, 2)}\n`);
  yield* fileSystem.rename(temporary, path.join(directory, "cloudflare-resources.json"));
});

/** Create or converge one environment and write its Wrangler input manifest. */
export async function deploy(options: { env: string }) {
  const stage = environmentStage(options.env);
  await runPlatformEffect(removeResourceManifest(stage));
  const state = await withEnvironment(stage, (api) => api.deploy());
  await runPlatformEffect(
    writeResourceManifest({ resources: state.resources, stage }).pipe(Effect.scoped),
  );
  return state;
}

/** Verify all Alchemy-owned resources for an environment. */
export async function check(options: { env: string }) {
  return await withEnvironment(environmentStage(options.env), (api) => api.check());
}

/** Read the durable, live-published state for an environment. */
export async function status(options: { env: string }) {
  return await readEnvironmentState(environmentStage(options.env));
}

/** Destroy a non-production environment, including its Workers and Durable Object data. */
export async function destroy(options: { env: string }) {
  const stage = environmentStage(options.env);
  if (stage === "prd") {
    throw new Error(
      "Production destruction requires an authenticated browser session; use the environment-manager dashboard.",
    );
  }
  await runPlatformEffect(removeResourceManifest(stage));
  return await destroyEnvironment(stage);
}

void createCli({ ...import.meta, name: "env-manager" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
