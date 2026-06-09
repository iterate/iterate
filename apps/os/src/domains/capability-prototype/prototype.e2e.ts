import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";

import type { FakeIterateCapability } from "./capability.ts";
import { appendAndRead, type PrototypeScript, type PrototypeScriptInput } from "./scripts.ts";

const PROTOTYPE_PREFIX = "/api/capability-prototype";
const execFileAsync = promisify(execFile);

test("prototype root capability works from Node, dynamic worker, and CLI against the real worker", async () => {
  using ctx = connectPrototypeContextFromNode();
  const projectId = `fake_proj_node_${crypto.randomUUID().slice(0, 8)}`;
  const streamPath = "/prototype/node";
  const eventType = "events.iterate.test/prototype-node";

  for (const executionMode of prototypeExecutionModes({ ctx })) {
    const marker = `${executionMode.name}-${crypto.randomUUID().slice(0, 8)}`;
    const result = await executionMode.run({
      script: appendAndRead,
      vars: {
        eventType,
        marker,
        projectId,
        source: executionMode.name,
        streamPath,
      },
    });

    expect(result).toMatchObject({
      appended: {
        marker,
        projectId,
        source: executionMode.name,
        streamPath,
        type: eventType,
      },
      project: {
        id: projectId,
      },
      readBack: expect.arrayContaining([
        {
          marker,
          source: executionMode.name,
          type: eventType,
        },
      ]),
    });
  }
});

test("prototype denies unauthorized project access against the real worker", async () => {
  const response = await fetch(new URL(`${PROTOTYPE_PREFIX}/run`, baseUrl()), {
    body: JSON.stringify({
      auth: {
        projects: [],
        type: "iterate-auth",
        userId: "user_no_projects",
      },
      functionSource: `async ({ ctx }) => {
        return await ctx.projects.get("fake_proj_forbidden").describe();
      }`,
      vars: {},
    }),
    headers: authHeaders(),
    method: "POST",
  });

  expect(response.ok).toBe(false);
  await expect(response.json()).resolves.toMatchObject({
    error: "Missing project authority for fake_proj_forbidden",
  });
});

test("prototype Project Durable Object can append to Stream Durable Object without auth props", async () => {
  const projectId = `fake_proj_internal_${crypto.randomUUID().slice(0, 8)}`;
  const response = await fetch(
    new URL(`${PROTOTYPE_PREFIX}/internal-project-append?projectId=${projectId}`, baseUrl()),
    {
      headers: authHeaders(),
    },
  );

  expect(response.ok).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    appended: {
      payload: {
        source: "project-do-internal",
      },
      type: "events.iterate.test/project-internal",
    },
    projectId,
  });
});

function prototypeExecutionModes(input: { ctx: RpcStub<FakeIterateCapability> }) {
  return [
    {
      name: "node-capnweb",
      run: ({ script, vars }: ScriptRunInput) =>
        script({
          ctx: input.ctx,
          vars,
        }),
    },
    {
      name: "run-endpoint",
      run: ({ script, vars }: ScriptRunInput) =>
        runPrototypeScriptInDynamicWorker({
          script,
          vars,
        }),
    },
    {
      name: "cli",
      run: ({ script, vars }: ScriptRunInput) =>
        runPrototypeScriptInCli({
          script,
          vars,
        }),
    },
  ] as const;
}

type ScriptRunInput = {
  script: PrototypeScript;
  vars: PrototypeScriptInput["vars"];
};

function connectPrototypeContextFromNode(): RpcStub<FakeIterateCapability> {
  const wsUrl = new URL(PROTOTYPE_PREFIX, baseUrl());
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<FakeIterateCapability>(
    new WebSocket(wsUrl.toString(), { headers: authHeaders() }) as unknown as Parameters<
      typeof newWebSocketRpcSession
    >[0],
  );
}

async function runPrototypeScriptInDynamicWorker(input: ScriptRunInput) {
  const response = await fetch(new URL(`${PROTOTYPE_PREFIX}/run`, baseUrl()), {
    body: JSON.stringify({
      functionSource: input.script.toString(),
      vars: input.vars,
    }),
    headers: authHeaders(),
    method: "POST",
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function runPrototypeScriptInCli(input: ScriptRunInput) {
  const { stdout } = await execFileAsync("pnpm", [
    "exec",
    "tsx",
    "src/domains/capability-prototype/cli.ts",
    JSON.stringify({
      adminApiSecret: adminApiSecret(),
      baseUrl: baseUrl(),
      script: input.script.toString(),
      vars: input.vars,
    }),
  ]);
  return JSON.parse(stdout);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${adminApiSecret()}`,
    "content-type": "application/json",
  };
}

function adminApiSecret() {
  const secret =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    "";
  if (!secret) {
    throw new Error("APP_CONFIG_ADMIN_API_SECRET is required for capability prototype e2e tests.");
  }
  return secret;
}

function baseUrl() {
  const url =
    process.env.OS_CAPABILITY_PROTOTYPE_BASE_URL?.trim().replace(/\/+$/, "") ||
    process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
    "";
  if (!url) {
    throw new Error("APP_CONFIG_BASE_URL is required for capability prototype e2e tests.");
  }
  return url;
}
