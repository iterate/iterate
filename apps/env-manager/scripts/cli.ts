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
import {
  authEnvs,
  docsEnvs,
  dummyPetshopEnvs,
  envManagerEnv,
  envs,
  streamsExampleEnvs,
} from "../../../envs.ts";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import { makeCloudflareControlPlane } from "../src/cloudflare-control-plane.ts";
import { isCompiledPreviewStage } from "../src/environments.ts";
import { EnvironmentState, type EnvironmentApi, type PreviewStage } from "../src/state.ts";

const DopplerSecrets = z.looseObject({
  AUTH_FORGE_ES256_PRIVATE_JWK: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string(),
  CLOUDFLARE_API_TOKEN: z.string(),
  ENV_MANAGER_API_TOKEN: z.string().optional(),
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

const runLocalAlchemy = Effect.fn("envManager.runLocalAlchemy")(function* (input: {
  operation: "deploy" | "destroy";
  stage: string;
}) {
  const environment = Object.values(authEnvs).find(
    (candidate) => candidate.dopplerConfig === input.stage,
  );
  if (environment === undefined) {
    return yield* Effect.fail(new Error(`Unknown deployed environment ${input.stage}.`));
  }

  const secrets = yield* loadDopplerSecrets("auth", input.stage);
  if (secrets.CLOUDFLARE_ACCOUNT_ID !== environment.cloudflareAccountId) {
    return yield* Effect.fail(
      new Error(
        `Doppler auth/${input.stage} targets ${secrets.CLOUDFLARE_ACCOUNT_ID}; ` +
          `envs.ts requires ${environment.cloudflareAccountId}.`,
      ),
    );
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const outputPath = path.join(
    appRoot,
    ".alchemy",
    "output",
    input.stage,
    "cloudflare-resources.json",
  );
  yield* fileSystem.remove(outputPath, { force: true });

  const spawner = yield* ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "pnpm",
      ["exec", "alchemy", input.operation, "alchemy.run.ts", "--stage", input.stage, "--yes"],
      {
        cwd: appRoot,
        env: {
          CLOUDFLARE_ACCOUNT_ID: secrets.CLOUDFLARE_ACCOUNT_ID,
          CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN,
        },
        extendEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(
      new Error(`Alchemy ${input.operation} for ${input.stage} exited with ${exitCode}.`),
    );
  }
});

const removeLocalResourceManifest = Effect.fn("envManager.removeLocalResourceManifest")(function* (
  stage: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  yield* fileSystem.remove(
    path.join(appRoot, ".alchemy", "output", stage, "cloudflare-resources.json"),
    { force: true },
  );
});

const writeLocalResourceManifest = Effect.fn("envManager.writeLocalResourceManifest")(
  function* (input: { resources: EnvironmentState["resources"]; stage: string }) {
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
  },
);

async function managerBearerToken(): Promise<string> {
  const explicit = process.env.ENV_MANAGER_API_TOKEN?.trim();
  if (explicit) return explicit;

  const inheritedForgeKey = process.env.AUTH_FORGE_ES256_PRIVATE_JWK?.trim();
  const forgeKey =
    inheritedForgeKey ??
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

async function connect(stage: PreviewStage): Promise<{
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

  // Cap'n Web accepts the browser WebSocket interface; ws implements that
  // interface but deliberately does not declare the DOM event-handler fields.
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

function previewStage(value: string): PreviewStage {
  if (!isCompiledPreviewStage(value)) {
    throw new Error(`Environment ${value} is not a compiled preview slot.`);
  }
  return value;
}

async function withRemoteEnvironment(
  stage: PreviewStage,
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

async function destroyLocalWranglerEnvironment(stage: string) {
  const platformEnvironment = Object.values(envs).find(
    (environment) => environment.dopplerConfig === stage,
  );
  const authEnvironment = Object.values(authEnvs).find(
    (environment) => environment.dopplerConfig === stage,
  );
  if (platformEnvironment === undefined && authEnvironment === undefined) {
    throw new Error(`Unknown deployed environment ${stage}.`);
  }

  const project = platformEnvironment === undefined ? "auth" : "os";
  const secrets = await runPlatformEffect(loadDopplerSecrets(project, stage));
  const expectedAccountId =
    platformEnvironment?.cloudflareAccountId ?? authEnvironment?.cloudflareAccountId;
  if (secrets.CLOUDFLARE_ACCOUNT_ID !== expectedAccountId) {
    throw new Error(
      `Doppler ${project}/${stage} targets ${secrets.CLOUDFLARE_ACCOUNT_ID}; ` +
        `envs.ts requires ${expectedAccountId}.`,
    );
  }
  const controlPlane = makeCloudflareControlPlane({
    accountId: secrets.CLOUDFLARE_ACCOUNT_ID,
    apiToken: secrets.CLOUDFLARE_API_TOKEN,
  });

  if (platformEnvironment === undefined) {
    if (authEnvironment === undefined) {
      throw new Error(`Unknown Auth environment ${stage}.`);
    }
    await controlPlane.destroyWranglerEnvironment({
      workerNames: [authEnvironment.authWorkerName],
    });
    return;
  }

  const supportingWorkerNames = [docsEnvs, dummyPetshopEnvs, streamsExampleEnvs].map(
    (environments) => {
      const environment = Object.values(environments).find(
        (candidate) => candidate.dopplerConfig === stage,
      );
      if (environment === undefined) {
        throw new Error(`No supporting Worker environment exists for ${stage}.`);
      }
      return environment.workerName;
    },
  );
  await controlPlane.destroyWranglerEnvironment({
    osWorkerName: platformEnvironment.osWorkerName,
    workerNames: [
      platformEnvironment.osWorkerName,
      `${platformEnvironment.osWorkerName}-typechecker`,
      `${platformEnvironment.osWorkerName}-worker-bundler`,
      platformEnvironment.semaphoreWorkerName,
      ...supportingWorkerNames,
      ...(authEnvironment === undefined ? [] : [authEnvironment.authWorkerName]),
    ],
  });
}

/** Create or converge one environment. Preview slots run in their Durable Object; production runs locally. */
export async function deploy(options: { env: string }) {
  if (isCompiledPreviewStage(options.env)) {
    await runPlatformEffect(removeLocalResourceManifest(options.env));
    const state = await withRemoteEnvironment(options.env, (api) => api.deploy());
    await runPlatformEffect(
      writeLocalResourceManifest({
        resources: state.resources,
        stage: options.env,
      }).pipe(Effect.scoped),
    );
    return state;
  }
  await runPlatformEffect(runLocalAlchemy({ operation: "deploy", stage: options.env }));
  return { stage: options.env, lifecycle: "ready" };
}

/** Verify all six Alchemy-owned resources for a preview slot. */
export async function check(options: { env: string }) {
  return await withRemoteEnvironment(previewStage(options.env), (api) => api.check());
}

/** Read the durable, live-published state for a preview slot. */
export async function status(options: { env: string }) {
  return await withRemoteEnvironment(previewStage(options.env), (api) => api.status());
}

/** Destroy all Wrangler and Alchemy resources for an environment. */
export async function destroy(options: { env: string; yesIMeanPrd?: boolean }) {
  if (isCompiledPreviewStage(options.env)) {
    const state = await withRemoteEnvironment(options.env, (api) => api.destroy());
    await runPlatformEffect(removeLocalResourceManifest(options.env));
    return state;
  }
  if (options.env === "prd" && options.yesIMeanPrd !== true) {
    throw new Error("Refusing to destroy production without --yes-i-mean-prd.");
  }
  await destroyLocalWranglerEnvironment(options.env);
  await runPlatformEffect(runLocalAlchemy({ operation: "destroy", stage: options.env }));
  return { stage: options.env, lifecycle: "empty" };
}

void createCli({ ...import.meta, name: "env-manager" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
