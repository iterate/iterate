/**
 * E2E tests for codemode oRPC endpoints.
 * Runs against a live os2 deployment (dev or preview).
 *
 * Set OS2_BASE_URL to the deployment URL before running:
 *   OS2_BASE_URL=https://os.iterate-dev-jonas.com \
 *   OS2_E2E_PROJECT_ID=proj_... \
 *   OS2_E2E_COOKIE='__session=...' pnpm test:e2e
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { osContract } from "@iterate-com/os2-contract";
import type { appRouter } from "~/orpc/root.ts";

type OrpcClient = RouterClient<typeof appRouter>;

function requireBaseUrl() {
  const baseUrl = process.env.OS2_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("OS2_BASE_URL is required for os2 e2e tests.");
  }
  return baseUrl;
}

function requireProjectId() {
  const projectId = process.env.OS2_E2E_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("OS2_E2E_PROJECT_ID is required for os2 codemode e2e tests.");
  }
  return projectId;
}

function requireAuthHeaders() {
  const bearerToken = process.env.OS2_E2E_BEARER_TOKEN?.trim();
  const cookie = process.env.OS2_E2E_COOKIE?.trim();
  if (!bearerToken && !cookie) {
    throw new Error(
      "OS2_E2E_BEARER_TOKEN or OS2_E2E_COOKIE is required for os2 codemode e2e tests.",
    );
  }

  return {
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function createClient(baseUrl: string) {
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
  ) as OrpcClient;
}

function createWebSocketClient(baseUrl: string) {
  const authHeaders = requireAuthHeaders();
  const url = new URL("/api/orpc-ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Browser WebSocket cannot set headers, but these e2e tests run in Node.
  // `ws` lets us carry the same Clerk session cookie/bearer token through the
  // upgrade request that the server's Clerk auth() call reads.
  const websocket = new WebSocket(url.toString(), { headers: authHeaders });
  const client = createORPCClient(new WebSocketRPCLink({ websocket })) as OrpcClient;
  return {
    client,
    close: () => websocket.close(),
  };
}

describe("codemode.executeScript", () => {
  it("starts a script immediately and reads output events from the stream path", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);
    const wsClient = createWebSocketClient(baseUrl);
    const projectId = requireProjectId();

    try {
      const started = await client.project.codemode.executeScript({
        code: "async () => 1 + 1",
        projectSlugOrId: projectId,
        providers: [],
      });

      expect(started.event.type).toBe("events.iterate.com/codemode/script-execution-requested");
      expect(started.streamPath).toBeTruthy();
      const scriptExecutionId = (started.event.payload as { scriptExecutionId: string })
        .scriptExecutionId;

      const stream = await wsClient.client.project.codemode.streamEvents({
        afterOffset: started.event.offset > 1 ? started.event.offset - 1 : "start",
        projectSlugOrId: projectId,
        streamPath: started.streamPath,
      });

      const events: Array<Record<string, unknown>> = [];
      for await (const event of stream) {
        events.push(event as Record<string, unknown>);
        const payload = event.payload as Record<string, unknown>;
        if (
          event.type === "events.iterate.com/codemode/script-execution-completed" &&
          payload.scriptExecutionId === scriptExecutionId
        ) {
          break;
        }
      }

      const finished = events.find(
        (event) => event.type === "events.iterate.com/codemode/script-execution-completed",
      );
      expect(finished?.payload).toMatchObject({
        outcome: { status: "succeeded", output: 2 },
        scriptExecutionId,
      });
    } finally {
      wsClient.close();
    }
  });
});

describe("codemode.describe", () => {
  it("returns short provider instructions", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);
    const projectId = requireProjectId();

    const result = await client.project.codemode.describe({
      projectSlugOrId: projectId,
      providers: [
        {
          instructions: "Test functions are available.",
          invocation: { kind: "event" },
          path: ["test"],
        },
      ],
    });

    expect(result.instructions).toBe("test: Test functions are available.");
  });
});
