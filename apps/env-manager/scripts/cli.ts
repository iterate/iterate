import { NodeServices } from "@effect/platform-node";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import WebSocket from "ws";
import { newWebSocketRpcSession, type RpcStub } from "iterate/sdk/capnweb";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { z } from "zod";
import { envManagerEnv } from "../../../envs.ts";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import { isCompiledEnvironmentStage } from "../src/environments.ts";
import { EnvironmentState, type EnvironmentApi, type EnvironmentStage } from "../src/state.ts";

const DopplerSecrets = z.looseObject({
  AUTH_FORGE_ES256_PRIVATE_JWK: z.string().optional(),
});

function runPlatformEffect<A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped));
}

const loadDopplerSecrets = Effect.fn("envManager.loadDopplerSecrets")(function* (
  project: string,
  config: string,
) {
  const spawner = yield* ChildProcessSpawner;
  const output = yield* spawner.string(
    ChildProcess.make(
      "doppler",
      [
        "secrets",
        "download",
        "--no-file",
        "--format",
        "json",
        "--project",
        project,
        "--config",
        config,
      ],
      { stdin: "inherit", stderr: "inherit" },
    ),
  );
  return yield* Effect.try({
    try: () => DopplerSecrets.parse(JSON.parse(output)),
    catch: (cause) =>
      new Error(`Doppler returned invalid secrets for ${project}/${config}.`, { cause }),
  });
});

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

async function managerBearerToken(): Promise<string> {
  const explicit = process.env.ENV_MANAGER_API_TOKEN?.trim();
  if (explicit) return explicit;

  const forgeKey =
    process.env.AUTH_FORGE_ES256_PRIVATE_JWK?.trim() ??
    (await runPlatformEffect(loadDopplerSecrets("_shared", envManagerEnv.dopplerConfig)))
      .AUTH_FORGE_ES256_PRIVATE_JWK;
  if (forgeKey === undefined) {
    throw new Error(
      "Environment-manager authentication requires ENV_MANAGER_API_TOKEN or " +
        "AUTH_FORGE_ES256_PRIVATE_JWK.",
    );
  }
  return await mintForgedAccessToken({
    forgePrivateJwk: forgeKey,
    issuer: `${envManagerEnv.authBaseUrl}/api/auth`,
    audience: new URL(envManagerEnv.baseUrl).origin,
    email: "env-manager-cli@iterate.com",
    admin: true,
  });
}

function environmentStage(value: string): EnvironmentStage {
  if (!isCompiledEnvironmentStage(value)) {
    throw new Error(`Environment ${value} is not compiled into env-manager.`);
  }
  return value;
}

async function connect(stage: EnvironmentStage): Promise<{
  api: RpcStub<EnvironmentApi>;
  close: () => void;
}> {
  const endpoint = new URL(`/api/environments/${stage}`, envManagerEnv.baseUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(endpoint, {
    handshakeTimeout: 15_000,
    headers: { authorization: `Bearer ${await managerBearerToken()}` },
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("open", onOpen);
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    socket.once("error", onError);
    socket.once("open", onOpen);
  });

  // `ws` implements the browser WebSocket contract Cap'n Web consumes but
  // deliberately omits its DOM event-handler declarations.
  const api = newWebSocketRpcSession<EnvironmentApi>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
  return {
    api,
    close: () => {
      api[Symbol.dispose]?.();
      socket.close();
    },
  };
}

async function withEnvironment(
  stage: EnvironmentStage,
  operation: (api: RpcStub<EnvironmentApi>) => Promise<void | EnvironmentState>,
): Promise<EnvironmentState> {
  const connection = await connect(stage);
  try {
    const result = await operation(connection.api);
    return EnvironmentState.parse(result ?? (await connection.api.status()));
  } finally {
    connection.close();
  }
}

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
  return await withEnvironment(environmentStage(options.env), (api) => api.status());
}

/** Destroy a non-production environment, including its Workers and Durable Object data. */
export async function destroy(options: { env: string }) {
  const stage = environmentStage(options.env);
  if (stage === "prd") {
    throw new Error(
      "Production destruction requires an authenticated browser session; use the environment-manager dashboard.",
    );
  }
  const state = await withEnvironment(stage, (api) => api.destroy(stage));
  await runPlatformEffect(removeResourceManifest(stage));
  return state;
}

void createCli({ ...import.meta, name: "env-manager" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
