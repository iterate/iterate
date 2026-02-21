import {
  createOrpcOpenApiServiceClient,
  createOrpcRpcServiceClient,
  createOrpcRpcWebSocketServiceClient,
  type RpcWebSocket,
  type ServiceClientEnv,
} from "@iterate-com/services-contracts/lib";
import { serviceManifest, type EventBusContract } from "@iterate-com/services-contracts/events";
import type { ContractRouterClient } from "@orpc/contract";

type EventBusManifest = Pick<typeof serviceManifest, "slug" | "port" | "orpcContract">;

interface BaseEventBusClientOptions {
  readonly env: ServiceClientEnv;
  readonly manifest: EventBusManifest;
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
): ContractRouterClient<EventBusContract> =>
  createOrpcRpcServiceClient({
    env: options.env,
    manifest: options.manifest,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

export const createEventBusWebSocketClient = (
  options: CreateEventBusWebSocketClientOptions,
): ContractRouterClient<EventBusContract> =>
  createOrpcRpcWebSocketServiceClient({
    env: options.env,
    manifest: options.manifest,
    ...(options.websocket ? { websocket: options.websocket } : {}),
  });

export const createEventBusOpenApiClient = (
  options: CreateEventBusOpenApiClientOptions,
): ContractRouterClient<EventBusContract> =>
  createOrpcOpenApiServiceClient({
    env: options.env,
    manifest: options.manifest,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

export type EventBusContractClient = ContractRouterClient<EventBusContract>;
export type EventBusClient = EventBusContractClient;
