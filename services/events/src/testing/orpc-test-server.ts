import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import {
  inferRPCMethodFromContractRouter,
  type AnyContractRouter,
  type ContractRouterClient,
} from "@orpc/contract";
import {
  eventBusContract,
  serviceManifest,
  type EventBusContract,
  type EventsServiceEnv,
} from "@iterate-com/services-contracts/events";

import { eventsService } from "../../fetcher.ts";

interface RpcWebSocket {
  readonly readyState: 0 | 1 | 2 | 3;
  addEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  send: (data: string | ArrayBufferLike | Uint8Array) => void;
}

export interface OrpcTestServer {
  readonly url: string;
  readonly websocketURL: string;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

export interface StartOrpcTestServerOptions {
  readonly env?: Partial<EventsServiceEnv>;
}

export interface CreateOrpcTestHttpClientOptions {
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}

export interface CreateOrpcTestWebSocketClientOptions {
  readonly url?: string;
  readonly websocket?: RpcWebSocket;
}

export interface OrpcTestWebSocketClientFixture<TContract extends AnyContractRouter> {
  readonly websocket: WebSocket;
  readonly client: ContractRouterClient<TContract>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

export interface OrpcTestFixture<TContract extends AnyContractRouter> extends OrpcTestServer {
  readonly client: ContractRouterClient<TContract>;
  readonly createHttpClient: (
    options?: CreateOrpcTestHttpClientOptions,
  ) => ContractRouterClient<TContract>;
  readonly createWebSocketClient: (
    options?: CreateOrpcTestWebSocketClientOptions,
  ) => ContractRouterClient<TContract>;
  readonly startWebSocketClientFixture: (options?: {
    readonly url?: string;
  }) => Promise<OrpcTestWebSocketClientFixture<TContract>>;
}

export interface StartOrpcTestFixtureOptions<
  TContract extends AnyContractRouter,
> extends StartOrpcTestServerOptions {
  readonly contract: TContract;
}

const toReachableHost = (hostname: string): string =>
  hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;

const awaitServerListening = (server: Server): Promise<void> =>
  server.listening
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", (error) => reject(error));
      });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

export const startOrpcTestServer = async (
  options: StartOrpcTestServerOptions = {},
): Promise<OrpcTestServer> => {
  const tempDir =
    options.env?.DATABASE_URL === undefined
      ? await mkdtemp(join(tmpdir(), "events-orpc-test-"))
      : undefined;
  const env = serviceManifest.envVars.parse({
    ...(options.env ?? {}),
    ...(tempDir !== undefined ? { DATABASE_URL: `${tempDir}/events.sqlite` } : {}),
  });

  const service = await eventsService(env);

  const app = new Hono<{ Bindings: HttpBindings }>();
  app.route("/", service.app);

  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  }) as Server;
  server.on("upgrade", service.handleUpgrade);
  await awaitServerListening(server);

  const address = server.address();
  if (address === null || typeof address === "string") {
    await service.shutdown();
    await closeServer(server);
    throw new Error("Expected TCP test server address");
  }

  const host = toReachableHost(address.address);
  const port = address.port;

  const close = async () => {
    await Promise.allSettled([
      service.shutdown(),
      closeServer(server),
      ...(tempDir !== undefined ? [rm(tempDir, { recursive: true, force: true })] : []),
    ]);
  };

  return {
    url: `http://${host}:${port}/orpc`,
    websocketURL: `ws://${host}:${port}/orpc/ws/`,
    [Symbol.asyncDispose]: close,
  };
};

export const startOrpcTestFixture = async <TContract extends AnyContractRouter>(
  options: StartOrpcTestFixtureOptions<TContract>,
): Promise<OrpcTestFixture<TContract>> => {
  const server = await startOrpcTestServer(options);
  const method = inferRPCMethodFromContractRouter(options.contract);

  const createHttpClient = (
    clientOptions: CreateOrpcTestHttpClientOptions = {},
  ): ContractRouterClient<TContract> => {
    const link = new RPCLink({
      url: clientOptions.url ?? server.url,
      method,
      ...(clientOptions.headers ? { headers: clientOptions.headers } : {}),
      ...(clientOptions.fetch ? { fetch: clientOptions.fetch } : {}),
    });
    return createORPCClient(link);
  };

  const createWebSocketClient = (
    clientOptions: CreateOrpcTestWebSocketClientOptions = {},
  ): ContractRouterClient<TContract> => {
    const websocketCtor = globalThis.WebSocket;
    const websocket =
      clientOptions.websocket ??
      (websocketCtor !== undefined
        ? (new websocketCtor(clientOptions.url ?? server.websocketURL) as unknown as RpcWebSocket)
        : undefined);

    if (websocket === undefined) {
      throw new Error("No WebSocket implementation available for websocket client");
    }

    const link = new WebSocketRPCLink({ websocket });
    return createORPCClient(link);
  };

  const startWebSocketClientFixture = async (
    input: {
      readonly url?: string;
    } = {},
  ): Promise<OrpcTestWebSocketClientFixture<TContract>> => {
    const websocket = new WebSocket(input.url ?? server.websocketURL);
    const client = createWebSocketClient({
      websocket: websocket as unknown as RpcWebSocket,
    });

    return {
      websocket,
      client,
      [Symbol.asyncDispose]: async () => {
        websocket.close();
      },
    };
  };

  return {
    ...server,
    client: createHttpClient(),
    createHttpClient,
    createWebSocketClient,
    startWebSocketClientFixture,
    [Symbol.asyncDispose]: server[Symbol.asyncDispose],
  };
};

export const startEventBusTestFixture = (
  options: StartOrpcTestServerOptions = {},
): Promise<OrpcTestFixture<EventBusContract>> =>
  startOrpcTestFixture({
    ...options,
    contract: eventBusContract,
  });
