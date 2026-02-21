import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  RPCLink as WebSocketRPCLink,
  type LinkWebsocketClientOptions,
} from "@orpc/client/websocket";
import {
  type AnyContractRouter,
  inferRPCMethodFromContractRouter,
  type ContractRouterClient,
} from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { WebSocket as PartySocketWebSocket } from "partysocket";

import {
  resolveServiceOpenApiBaseUrl,
  resolveServiceOrpcUrl,
  resolveServiceOrpcWebSocketUrl,
  type ServiceClientEnv,
  type ServiceManifestLike,
} from "./service-url.ts";

export type OrpcRpcWebSocket = LinkWebsocketClientOptions["websocket"];
export type RpcWebSocket = OrpcRpcWebSocket;

export const isRpcWebSocket = (value: unknown): value is RpcWebSocket => {
  if (typeof value !== "object" || value === null) return false;

  const readyState = Reflect.get(value, "readyState");
  const addEventListener = Reflect.get(value, "addEventListener");
  const send = Reflect.get(value, "send");

  return (
    (readyState === 0 || readyState === 1 || readyState === 2 || readyState === 3) &&
    typeof addEventListener === "function" &&
    typeof send === "function"
  );
};

export const asRpcWebSocket = (value: unknown): RpcWebSocket => {
  if (isRpcWebSocket(value)) return value;
  throw new Error("Expected websocket with readyState/addEventListener/send");
};

interface BaseServiceClientOptions<TContract extends AnyContractRouter> {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike<TContract>;
}

export interface CreateOrpcRpcServiceClientOptions<
  TContract extends AnyContractRouter,
> extends BaseServiceClientOptions<TContract> {
  readonly headers?: Record<string, string>;
  readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}

export interface CreateOrpcRpcWebSocketServiceClientOptions<
  TContract extends AnyContractRouter,
> extends BaseServiceClientOptions<TContract> {
  readonly websocket?: RpcWebSocket;
}

export interface CreateOrpcOpenApiServiceClientOptions<
  TContract extends AnyContractRouter,
> extends BaseServiceClientOptions<TContract> {
  readonly headers?: Record<string, string>;
  readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}

export const createOrpcRpcServiceClient = <TContract extends AnyContractRouter>(
  options: CreateOrpcRpcServiceClientOptions<TContract>,
): ContractRouterClient<TContract> => {
  const link = new RPCLink({
    url: resolveServiceOrpcUrl(options),
    method: inferRPCMethodFromContractRouter(options.manifest.orpcContract),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
};

export const createOrpcRpcWebSocketServiceClient = <TContract extends AnyContractRouter>(
  options: CreateOrpcRpcWebSocketServiceClientOptions<TContract>,
): ContractRouterClient<TContract> => {
  const websocket =
    options.websocket ??
    asRpcWebSocket(
      new PartySocketWebSocket(resolveServiceOrpcWebSocketUrl(options), undefined, {
        ...(globalThis.WebSocket ? { WebSocket: globalThis.WebSocket } : {}),
        maxRetries: 20,
        minReconnectionDelay: 250,
        maxReconnectionDelay: 3_000,
      }),
    );

  const link = new WebSocketRPCLink({ websocket });
  return createORPCClient(link);
};

export const createOrpcOpenApiServiceClient = <TContract extends AnyContractRouter>(
  options: CreateOrpcOpenApiServiceClientOptions<TContract>,
): ContractRouterClient<TContract> => {
  const link = new OpenAPILink(options.manifest.orpcContract, {
    url: resolveServiceOpenApiBaseUrl(options),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
};
