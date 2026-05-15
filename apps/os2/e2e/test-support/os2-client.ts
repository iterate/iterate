import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import WebSocket from "ws";
import { osContract } from "@iterate-com/os2-contract";
import type { Event } from "@iterate-com/shared/streams/types";
import type { appRouter } from "~/orpc/root.ts";

export type Os2Client = RouterClient<typeof appRouter>;

export function requireBaseUrl() {
  const baseUrl = (process.env.OS2_BASE_URL ?? process.env.APP_CONFIG_BASE_URL)
    ?.trim()
    .replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("OS2_BASE_URL or APP_CONFIG_BASE_URL is required for os2 e2e tests.");
  }
  return baseUrl;
}

export function requireAuthHeaders() {
  const bearerToken =
    process.env.OS2_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_E2E_BEARER_TOKEN?.trim();
  const cookie = process.env.OS2_E2E_COOKIE?.trim();
  if (!bearerToken && !cookie) {
    throw new Error(
      "OS2_E2E_ADMIN_API_SECRET, OS2_ADMIN_API_SECRET, APP_CONFIG_ADMIN_API_SECRET, OS2_E2E_BEARER_TOKEN, or OS2_E2E_COOKIE is required for os2 e2e tests.",
    );
  }

  return {
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

export function requireAdminBearerToken() {
  const token =
    process.env.OS2_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!token) {
    throw new Error(
      "OS2_E2E_ADMIN_API_SECRET, OS2_ADMIN_API_SECRET, or APP_CONFIG_ADMIN_API_SECRET is required for admin os2 e2e tests.",
    );
  }
  return token;
}

export function createOs2Client(baseUrl: string = requireBaseUrl()) {
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
  ) as Os2Client;
}

export function createAdminOs2Client(baseUrl: string = requireBaseUrl()) {
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
  ) as Os2Client;
}

export function createOs2WebSocketClient(baseUrl: string = requireBaseUrl()) {
  const authHeaders = requireAuthHeaders();
  const url = new URL("/api/orpc-ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const websocket = new WebSocket(url.toString(), { headers: authHeaders });
  const client = createORPCClient(new WebSocketRPCLink({ websocket })) as Os2Client;
  return {
    client,
    close: () => websocket.close(),
  };
}

export async function createProject(client: Os2Client, slugPrefix: string) {
  return await client.projects.create({
    slug: `${slugPrefix}-${uniqueSuffix()}`,
  });
}

export async function readProjectStreamUntil(input: {
  afterOffset: number | "start";
  client: Os2Client;
  predicate(event: Event): boolean;
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

export function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
