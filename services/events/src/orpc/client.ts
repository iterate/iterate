import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  RPCLink as WebSocketRPCLink,
  type LinkWebsocketClientOptions,
} from "@orpc/client/websocket";
import { inferRPCMethodFromContractRouter, type ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import {
  resolveServiceOpenApiBaseUrl,
  resolveServiceOrpcUrl,
  resolveServiceOrpcWebSocketUrl,
  type ServiceManifestLike,
  type ServiceClientEnv,
} from "@iterate-com/events-contract/lib";
import { type EventBusContract } from "@iterate-com/events-contract";

type EventBusManifest = ServiceManifestLike<EventBusContract>;
type RpcWebSocket = LinkWebsocketClientOptions["websocket"];

interface BaseEventBusClientOptions {
  readonly env: ServiceClientEnv;
  readonly manifest: EventBusManifest;
  readonly preferSameOrigin?: boolean;
}

export interface CreateEventBusClientOptions extends BaseEventBusClientOptions {
  readonly headers?: Record<string, string>;
  readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}

export interface CreateEventBusWebSocketClientOptions extends BaseEventBusClientOptions {
  readonly websocket?: RpcWebSocket;
}

export interface CreateEventBusOpenApiClientOptions extends BaseEventBusClientOptions {
  readonly headers?: Record<string, string>;
  readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}

export const createEventBusClient = (
  options: CreateEventBusClientOptions,
): ContractRouterClient<EventBusContract> => {
  const method = inferRPCMethodFromContractRouter(options.manifest.orpcContract);
  const link = new RPCLink({
    url: resolveServiceOrpcUrl({
      env: options.env,
      manifest: options.manifest,
      preferSameOrigin: options.preferSameOrigin,
    }),
    method,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
};

export const createEventBusWebSocketClient = (
  options: CreateEventBusWebSocketClientOptions,
): ContractRouterClient<EventBusContract> => {
  const websocket =
    options.websocket ??
    new WebSocket(
      resolveServiceOrpcWebSocketUrl({
        env: options.env,
        manifest: options.manifest,
        preferSameOrigin: options.preferSameOrigin,
      }),
      ["orpc"],
    );

  const link = new WebSocketRPCLink({ websocket });
  return createORPCClient(link);
};

export const createEventBusOpenApiClient = (
  options: CreateEventBusOpenApiClientOptions,
): ContractRouterClient<EventBusContract> => {
  const link = new OpenAPILink(options.manifest.orpcContract, {
    url: resolveServiceOpenApiBaseUrl({
      env: options.env,
      manifest: options.manifest,
      preferSameOrigin: options.preferSameOrigin,
    }),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
};

export type EventBusContractClient = ContractRouterClient<EventBusContract>;
export type EventBusClient = EventBusContractClient;
