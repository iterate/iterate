import { NodeServices } from "@effect/platform-node";
import WebSocket from "ws";
import { newWebSocketRpcSession, type RpcStub } from "iterate/sdk/capnweb";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { envManagerEnv } from "../../../envs.ts";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import { destroyEnvironmentInBatches } from "../src/destroy-environment-client.ts";
import { isCompiledEnvironmentStage } from "../src/environments.ts";
import { EnvironmentState, type EnvironmentApi, type EnvironmentStage } from "../src/state.ts";

const DopplerSecrets = z.looseObject({
  AUTH_FORGE_ES256_PRIVATE_JWK: z.string().optional(),
});

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

let dopplerForgeKey: Promise<string | undefined> | undefined;

function loadDopplerForgeKey(): Promise<string | undefined> {
  dopplerForgeKey ??= Effect.runPromise(
    loadDopplerSecrets("_shared", envManagerEnv.dopplerConfig).pipe(
      Effect.map(({ AUTH_FORGE_ES256_PRIVATE_JWK }) => AUTH_FORGE_ES256_PRIVATE_JWK),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  );
  return dopplerForgeKey;
}

async function managerBearerToken(): Promise<string> {
  const explicit = process.env.ENV_MANAGER_API_TOKEN?.trim();
  if (explicit) return explicit;

  const forgeKey =
    process.env.AUTH_FORGE_ES256_PRIVATE_JWK?.trim() ?? (await loadDopplerForgeKey());
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

export function environmentStage(value: string): EnvironmentStage {
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

export async function withEnvironment(
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

export async function readEnvironmentState(stage: EnvironmentStage): Promise<EnvironmentState> {
  return await withEnvironment(stage, (api) => api.status());
}

export async function destroyEnvironment(
  stage: EnvironmentStage,
  signal?: AbortSignal,
  verifyOwnership?: () => Promise<void>,
): Promise<EnvironmentState> {
  return await destroyEnvironmentInBatches({
    stage,
    connect: () => connect(stage),
    signal,
    verifyOwnership,
  });
}
