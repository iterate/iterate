/**
 * Deployment-targeted tests for OS2 project agents.
 *
 * These run through public oRPC/OpenAPI routes against a live OS2 deployment:
 *
 *   OS2_BASE_URL=https://os2.iterate-preview-2.com \
 *   doppler run --project os2 --config preview_2 -- \
 *   pnpm --dir apps/os2 test:e2e ./e2e/vitest/agents.e2e.test.ts
 */
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import { osContract } from "@iterate-com/os2-contract";
import type { Event } from "@iterate-com/shared/streams/types";
import type { appRouter } from "~/orpc/root.ts";

type OrpcClient = RouterClient<typeof appRouter>;

const createdProjectIds: string[] = [];

afterEach(async () => {
  const client = createClient(requireBaseUrl());
  for (const id of createdProjectIds.splice(0)) {
    await client.projects.remove({ id }).catch(() => undefined);
  }
});

describe("project agents codemode", () => {
  it("lets codemode send visible agent responses through ctx.chat.sendMessage", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);
    const project = await createProject(client, "agent-chat-tool");
    const suffix = uniqueSuffix();
    const agentPath = `/agents/chat-tool-${suffix}`;
    const message = `agent chat tool provider proof ${suffix}`;

    await client.project.agents.runtimeState({
      agentPath,
      projectSlugOrId: project.id,
    });

    const output = await client.project.streams.append({
      projectSlugOrId: project.id,
      streamPath: agentPath,
      event: {
        type: "events.iterate.com/agent/output-added",
        payload: {
          content: `\`\`\`js
async (ctx) => {
  await ctx.chat.sendMessage({ message: ${JSON.stringify(message)} });
}
\`\`\``,
        },
      },
    });

    const events = await readUntil({
      agentPath,
      client,
      projectId: project.id,
      afterOffset: "start",
      predicate: (event) =>
        event.type === "events.iterate.com/agent-chat/assistant-response-added" &&
        (event.payload as { message?: unknown }).message === message,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: expect.objectContaining({
          path: ["chat"],
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/function-call-requested",
        payload: expect.objectContaining({
          path: ["chat", "sendMessage"],
          providerPath: ["chat"],
        }),
      }),
    );
    const scriptRequested = events.find(
      (event) => event.type === "events.iterate.com/codemode/script-execution-requested",
    );
    if (!scriptRequested) {
      throw new Error("Expected codemode/script-execution-requested after agent output.");
    }
    const scriptRequestDelayMs =
      new Date(scriptRequested.createdAt).getTime() - new Date(output.event.createdAt).getTime();
    expect(scriptRequestDelayMs).toBeLessThan(1_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/agent-chat/assistant-response-added",
        payload: expect.objectContaining({
          channel: "web",
          message,
        }),
      }),
    );
  });

  it("does not append normal out-of-order reducer errors during an agent codemode turn", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);
    const project = await createProject(client, "agent-ordering");
    const suffix = uniqueSuffix();
    const agentPath = `/agents/ordering-${suffix}`;
    const message = `agent ordering proof ${suffix}`;

    await client.project.agents.runtimeState({
      agentPath,
      projectSlugOrId: project.id,
    });

    const output = await client.project.streams.append({
      projectSlugOrId: project.id,
      streamPath: agentPath,
      event: {
        type: "events.iterate.com/agent/output-added",
        payload: {
          content: `\`\`\`js
async (ctx) => {
  await ctx.chat.sendMessage({ message: ${JSON.stringify(message)} });
}
\`\`\``,
        },
      },
    });

    const events = await readUntil({
      agentPath,
      client,
      projectId: project.id,
      afterOffset: output.event.offset - 1,
      predicate: (event) => event.type === "events.iterate.com/codemode/script-execution-completed",
    });
    await delay(1_000);
    const settled = await client.project.streams.read({
      afterOffset: output.event.offset - 1,
      projectSlugOrId: project.id,
      streamPath: agentPath,
    });
    const processorErrors = settled.events.filter(
      (event) => event.type === "events.iterate.com/core/error-occurred",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/function-call-requested",
        payload: expect.objectContaining({
          path: ["chat", "sendMessage"],
        }),
      }),
    );
    expect(processorErrors).toEqual([]);
  });
});

function requireBaseUrl() {
  const baseUrl = process.env.OS2_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("OS2_BASE_URL is required for os2 agents e2e tests.");
  }
  return baseUrl;
}

function requireAuthHeaders() {
  const bearerToken =
    process.env.OS2_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_E2E_BEARER_TOKEN?.trim();
  const cookie = process.env.OS2_E2E_COOKIE?.trim();
  if (!bearerToken && !cookie) {
    throw new Error(
      "OS2_E2E_ADMIN_API_SECRET, OS2_ADMIN_API_SECRET, APP_CONFIG_ADMIN_API_SECRET, OS2_E2E_BEARER_TOKEN, or OS2_E2E_COOKIE is required for os2 agents e2e tests.",
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

async function createProject(client: OrpcClient, slugPrefix: string) {
  const project = await client.projects.create({
    metadata: {
      seededBy: "os2-agents-e2e",
    },
    slug: `${slugPrefix}-${uniqueSuffix()}`,
  });
  createdProjectIds.push(project.id);
  return project;
}

async function readUntil(input: {
  afterOffset: number | "start";
  agentPath: string;
  client: OrpcClient;
  predicate(event: Event): boolean;
  projectId: string;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const result = await input.client.project.streams.read({
      afterOffset: input.afterOffset,
      projectSlugOrId: input.projectId,
      streamPath: input.agentPath,
    });
    if (result.events.some(input.predicate)) return result.events;
    await delay(1_000);
  }

  const result = await input.client.project.streams.read({
    afterOffset: input.afterOffset,
    projectSlugOrId: input.projectId,
    streamPath: input.agentPath,
  });
  throw new Error(
    `Timed out waiting for agent stream event. Saw: ${JSON.stringify(result.events)}`,
  );
}

function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
