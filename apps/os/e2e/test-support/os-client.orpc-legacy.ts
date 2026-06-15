// @ts-nocheck
/* eslint-disable */
/**
 * Legacy oRPC e2e reference.
 *
 * This file intentionally is NOT named `.test.ts`.
 * Vitest discovers and executes `.test.ts` files under `apps/os/e2e/vitest`,
 * and this code imports the removed oRPC stack. It is preserved only as
 * reference material for porting Misha's original e2e coverage to ITX.
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import WebSocket from "ws";
import { osContract } from "@iterate-com/os-contract";
import type { Event } from "@iterate-com/shared/streams/types";
import { localDevServerBaseUrl } from "./dev-server.ts";
import type { appRouter } from "~/orpc/root.ts";

export type OsClient = RouterClient<typeof appRouter>;
const appRoot = fileURLToPath(new URL("../..", import.meta.url));

export function requireBaseUrl() {
  let baseUrl = process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "");
  baseUrl ||= localDevServerBaseUrl(appRoot);
  if (!baseUrl) {
    console.log(`No base URL found in environment, reading from Doppler.`);
    const dopplerEnv = execSync(`doppler run -- node -p 'JSON.stringify(process.env)'`);
    Object.assign(process.env, JSON.parse(dopplerEnv.toString()), process.env);
    baseUrl = process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "");
    baseUrl ||= localDevServerBaseUrl(appRoot);
  }
  if (!baseUrl) {
    throw new Error(
      "APP_CONFIG_BASE_URL is required for os e2e tests, or start local dev with `pnpm dev` first.",
    );
  }
  return baseUrl;
}

export function requireAuthHeaders() {
  const bearerToken =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    process.env.OS_E2E_BEARER_TOKEN?.trim();
  const cookie = process.env.OS_E2E_COOKIE?.trim();
  if (!bearerToken && !cookie) {
    throw new Error(
      "OS_E2E_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, APP_CONFIG_ADMIN_API_SECRET, OS_E2E_BEARER_TOKEN, or OS_E2E_COOKIE is required for os e2e tests.",
    );
  }

  return {
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

export function requireAdminBearerToken() {
  const token =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!token) {
    throw new Error(
      "OS_E2E_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, or APP_CONFIG_ADMIN_API_SECRET is required for admin os e2e tests.",
    );
  }
  return token;
}

export function requireRootAccessToken() {
  return requireAdminBearerToken();
}

export function createOsClient(baseUrl: string = requireBaseUrl()) {
  const authHeaders = requireAuthHeaders();
  return createORPCClient(
    new OpenAPILink(osContract, {
      url: `${baseUrl}/api`,
      fetch: (input, init) => {
        const requestInit: RequestInit = init ?? {};
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        for (const [key, value] of new Headers(requestInit.headers)) {
          headers.set(key, value);
        }
        for (const [key, value] of Object.entries(authHeaders)) {
          headers.set(key, value);
        }
        if (input instanceof Request) {
          return fetch(new Request(input, { ...requestInit, headers }));
        }
        return fetch(input, { ...requestInit, headers });
      },
    }),
  ) as OsClient;
}

export function createAdminOsClient(baseUrl: string = requireBaseUrl()) {
  const bearerToken = requireAdminBearerToken();
  return createORPCClient(
    new OpenAPILink(osContract, {
      url: `${baseUrl}/api`,
      fetch: (input, init) => {
        const requestInit: RequestInit = init ?? {};
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        for (const [key, value] of new Headers(requestInit.headers)) {
          headers.set(key, value);
        }
        headers.set("Authorization", `Bearer ${bearerToken}`);
        if (input instanceof Request) {
          return fetch(new Request(input, { ...requestInit, headers }));
        }
        return fetch(input, { ...requestInit, headers });
      },
    }),
  ) as OsClient;
}

export function createOsWebSocketClient(baseUrl: string = requireBaseUrl()) {
  const authHeaders = requireAuthHeaders();
  const url = new URL("/api/orpc-ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const websocket = new WebSocket(url.toString(), { headers: authHeaders });
  const client = createORPCClient(new WebSocketRPCLink({ websocket })) as OsClient;
  return {
    client,
    close: () => websocket.close(),
  };
}

export async function createProject(client: OsClient, slugPrefix: string) {
  return await client.projects.create({
    slug: `${slugPrefix}-${uniqueSuffix()}`,
  });
}

export async function readProjectStreamUntil<T extends Event>(input: {
  afterOffset: number | "start";
  client: OsClient;
  predicate: (event: Event) => event is T;
  projectSlugOrId: string;
  streamPath: string;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 4_000;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await input.client.project.streams.read({
      afterOffset: input.afterOffset,
      projectSlugOrId: input.projectSlugOrId,
      streamPath: input.streamPath,
    });
    if (result.events.some(input.predicate)) return result.events;
    await delay(1_000);
  }

  const result = await input.client.project.streams.read({
    afterOffset: input.afterOffset,
    projectSlugOrId: input.projectSlugOrId,
    streamPath: input.streamPath,
  });
  throw new Error(
    `Timed out waiting for project stream event matching ${input.predicate.toString()}. Saw: ${JSON.stringify(result.events, null, 2)}`,
  );
}

export async function streamProjectEventsUntil<T extends Event>(input: {
  afterOffset: number | "start";
  client: OsClient;
  predicate: (event: Event) => event is T;
  projectSlugOrId: string;
  streamPath: string;
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs || 4_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: Event[] = [];

  try {
    const stream = await input.client.project.streams.streamEvents(
      {
        afterOffset: input.afterOffset,
        projectSlugOrId: input.projectSlugOrId,
        streamPath: input.streamPath,
      },
      { signal: controller.signal },
    );

    for await (const event of stream) {
      events.push(event);
      if (input.predicate(event)) return events;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
  }

  throw new Error(
    `Timed out streaming project event matching ${input.predicate.toString()}. Saw: ${JSON.stringify(events, null, 2)}`,
  );
}

export function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
