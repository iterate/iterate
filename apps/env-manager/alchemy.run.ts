import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import { authEnvs, envs } from "../../envs.ts";
import {
  makeAuthResources,
  makeEnvironmentResources,
} from "./src/alchemy/environment-resources.ts";
import type { AlchemyResources } from "./src/state.ts";

const WriteResourceManifest = Alchemy.Action(
  "WriteResourceManifest",
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stage = yield* Alchemy.Stage;
    const outputRoot = yield* path.fromFileUrl(new URL("./.alchemy/output", import.meta.url));

    return Effect.fn(function* (input: { resources: AlchemyResources; nonce: number }) {
      const directory = path.join(outputRoot, stage);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const temporary = yield* fileSystem.makeTempFileScoped({ directory });
      yield* fileSystem.writeFileString(temporary, `${JSON.stringify(input.resources, null, 2)}\n`);
      yield* fileSystem.rename(temporary, path.join(directory, "cloudflare-resources.json"));
    }, Effect.scoped);
  }),
);

export default Alchemy.Stack(
  "IterateDataResources",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (stage === "placeholder") return;

    const platformEnvironment = Object.values(envs).find(
      (environment) => environment.dopplerConfig === stage,
    );
    const authEnvironment = Object.values(authEnvs).find(
      (environment) => environment.dopplerConfig === stage,
    );
    const resources = platformEnvironment
      ? yield* makeEnvironmentResources(stage)
      : authEnvironment
        ? yield* makeAuthResources(stage)
        : yield* Effect.die(new Error(`Unknown deployed environment ${stage}.`));

    // An Action normally memoizes by input. The nonce rematerializes this
    // checkout-local manifest after every successful no-op apply.
    yield* WriteResourceManifest({ resources, nonce: yield* Random.nextInt });
    return resources;
  }),
);
