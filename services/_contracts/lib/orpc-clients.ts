import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
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

export interface RpcWebSocket {
  readonly readyState: 0 | 1 | 2 | 3;
  addEventListener: (
    type: string,
    listener: (event: unknown) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  send: (data: string | ArrayBufferLike | Uint8Array) => void;
}

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
    (new PartySocketWebSocket(resolveServiceOrpcWebSocketUrl(options), undefined, {
      WebSocket: globalThis.WebSocket,
      maxRetries: 20,
      minReconnectionDelay: 250,
      maxReconnectionDelay: 3_000,
    }) as unknown as RpcWebSocket);

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
