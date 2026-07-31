import WebSocket from "ws";
import { newWebSocketRpcSession, type RpcStub } from "iterate/sdk/capnweb";
import { z } from "zod";
import { envManagerEnv } from "../../../envs.ts";
import { loadDopplerSecrets } from "../../../scripts/lib/env-context.ts";
import { destroyEnvironmentInBatches } from "../src/destroy-environment-client.ts";
import { isCompiledEnvironmentStage } from "../src/environments.ts";
import { EnvironmentState, type EnvironmentApi, type EnvironmentStage } from "../src/state.ts";

const AccessCredentials = z.object({
  CLOUDFLARE_ACCESS_CLIENT_ID: z.string().trim().min(1),
  CLOUDFLARE_ACCESS_CLIENT_SECRET: z.string().trim().min(1),
});

let accessCredentials: z.output<typeof AccessCredentials> | undefined;
let accessCookie: Promise<string> | undefined;

function managerAccessCredentials() {
  return (accessCredentials ??= AccessCredentials.parse(
    process.env.CLOUDFLARE_ACCESS_CLIENT_ID
      ? process.env
      : loadDopplerSecrets("env-manager", envManagerEnv.dopplerConfig),
  ));
}

function managerAccessCookie(): Promise<string> {
  return (accessCookie ??= (async () => {
    const credentials = managerAccessCredentials();
    const response = await fetch(new URL("/api/health", envManagerEnv.baseUrl), {
      headers: {
        "CF-Access-Client-Id": credentials.CLOUDFLARE_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": credentials.CLOUDFLARE_ACCESS_CLIENT_SECRET,
      },
    });
    if (!response.ok) {
      throw new Error(`Cloudflare Access authentication failed with HTTP ${response.status}.`);
    }
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("CF_Authorization="))
      ?.split(";", 1)[0];
    if (cookie === undefined) {
      throw new Error("Cloudflare Access did not return an authorization cookie.");
    }
    return cookie;
  })());
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
    headers: { Cookie: await managerAccessCookie() },
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
