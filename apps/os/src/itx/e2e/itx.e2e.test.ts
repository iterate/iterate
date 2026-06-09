// itx e2e: proves the spec against a REAL deployed worker (local dev server,
// preview, or production — whatever APP_CONFIG_BASE_URL points at).
//
// The shared scripts in itx-scripts.ts run through every execution mode; the
// live-capability scenarios run from Node because they need a Node-side
// RpcTarget provider. Browser mode joins when the REPL is rewired.

import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { connectItx, type ItxClient } from "../client.ts";
import {
  appendAndReadStream,
  callPathCapability,
  describeProject,
  pathCallCapSource,
  todoCapSource,
  type ItxScript,
} from "./itx-scripts.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const PROJECT_SLUG = `itx-e2e-${RUN_SUFFIX}`;

test("itx scripts run identically over Cap'n Web and /api/itx/run", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: PROJECT_SLUG })) as {
    id: string;
    slug: string;
  };
  expect(project.slug).toBe(PROJECT_SLUG);

  for (const mode of executionModes(itx)) {
    const marker = `${mode.name}-${crypto.randomUUID().slice(0, 8)}`;

    const described = await mode.run(describeProject, { projectId: project.id });
    expect(described).toMatchObject({
      context: project.id,
      projectId: project.id,
      slug: PROJECT_SLUG,
    });

    const streamed = await mode.run(appendAndReadStream, {
      eventType: "events.iterate.test/itx/e2e",
      marker,
      projectId: project.id,
      streamPath: "/itx-e2e/log",
    });
    expect(streamed).toMatchObject({
      appended: { marker, type: "events.iterate.test/itx/e2e" },
    });
    expect((streamed as { readBackMarkers: string[] }).readBackMarkers).toContain(marker);
  }
});

test("the five-step capability flow: provide live, call, promote durable, call from a script", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-caps` })) as { id: string };

  // (1) A provider written in this Node process: ONE call({ path, args })
  // method is the whole implementation of an SDK-shaped surface.
  class FakeSlackSdk extends RpcTarget {
    async call({ path, args }: { path: string[]; args: unknown[] }) {
      return { args, method: path.join("."), provider: "node-live" };
    }
  }

  // (2) Provide it as a live cap on the project context.
  using projectItx = await itx.projects.get(project.id);
  await projectItx.caps.provide({
    invoke: "path-call",
    name: "slack",
    target: new FakeSlackSdk() as never,
  });

  // (3) Anyone holding a handle calls it through the fallthrough — zero
  // client code, the Slack SDK docs are the tool docs.
  const liveResult = (await (projectItx as never as Record<string, any>).slack.chat.postMessage({
    text: "hi from the live cap",
  })) as { method: string; provider: string };
  expect(liveResult).toMatchObject({ method: "chat.postMessage", provider: "node-live" });

  // (4) "I like this mount" → promote: durable means the code moves
  // server-side (define with source), not a flag on the live stub.
  const marker = `durable-${RUN_SUFFIX}`;
  await projectItx.caps.define({
    invoke: "path-call",
    name: "slackDurable",
    source: {
      codeId: crypto.randomUUID(),
      mainModule: "cap.js",
      modules: { "cap.js": pathCallCapSource({ marker }) },
    },
  });

  // (5) The SAME dotted call works from an itx script in a dynamic worker,
  // where the live provider (this Node process) is also still reachable.
  for (const mode of executionModes(itx)) {
    const viaDurable = await mode.run(callPathCapability, {
      capName: "slackDurable",
      projectId: project.id,
      text: `via-${mode.name}`,
    });
    expect(viaDurable).toMatchObject({ marker, method: "chat.postMessage" });
  }

  const description = await projectItx.caps.describe();
  expect(description).toMatchObject([
    { connected: true, invoke: "path-call", kind: "live", name: "slack" },
    { invoke: "path-call", kind: "worker", name: "slackDurable" },
  ]);
});

test("worker caps hold a correctly scoped itx of their own", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-todo` })) as { id: string };
  using projectItx = await itx.projects.get(project.id);

  await projectItx.caps.define({
    name: "todo",
    source: {
      codeId: crypto.randomUUID(),
      mainModule: "cap.js",
      modules: { "cap.js": todoCapSource() },
    },
  });

  const todo = (projectItx as never as Record<string, any>).todo;
  await todo.add({ text: "ship the capability layer" });
  await todo.add({ text: "delete the mounts" });
  await expect(todo.list()).resolves.toEqual(["ship the capability layer", "delete the mounts"]);

  // The cap's events went through ITS itx onto the project's streams —
  // visible to any other holder of a project handle. (Streams also carry
  // platform lifecycle events, so filter to the cap's event type.)
  const events = (await projectItx.streams.get("/itx-e2e/todos").read()) as Array<{
    payload: { text?: string };
    type: string;
  }>;
  expect(
    events
      .filter((event) => event.type === "events.iterate.test/itx/todo-added")
      .map((event) => event.payload.text),
  ).toEqual(["ship the capability layer", "delete the mounts"]);
});

test("revoked and offline caps fail with instructive errors", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-err` })) as { id: string };
  using projectItx = await itx.projects.get(project.id);

  await expect((projectItx as never as Record<string, any>).nothingHere.run()).rejects.toThrow(
    /No capability named "nothingHere"/,
  );

  await expect(
    projectItx.caps.define({
      name: "then",
      source: { codeId: "x", mainModule: "cap.js", modules: { "cap.js": "export default {}" } },
    }),
  ).rejects.toThrow(/reserved/);
});

// ---- execution modes --------------------------------------------------------

type ExecutionMode = {
  name: string;
  run<Vars extends Record<string, unknown>>(script: ItxScript<Vars>, vars: Vars): Promise<unknown>;
};

function executionModes(itx: ItxClient): ExecutionMode[] {
  return [
    {
      name: "node-capnweb",
      run: (script, vars) => Promise.resolve(script({ itx: itx as never, vars })),
    },
    {
      name: "run-endpoint",
      run: async (script, vars) => {
        const response = await fetch(new URL("/api/itx/run", baseUrl()), {
          body: JSON.stringify({ functionSource: script.toString(), vars }),
          headers: authHeaders(),
          method: "POST",
        });
        const body = (await response.json()) as { error?: string; result?: unknown };
        if (!response.ok) {
          throw new Error(`/api/itx/run failed: ${body.error ?? JSON.stringify(body)}`);
        }
        return body.result;
      },
    },
  ];
}

function connectGlobal(): ItxClient {
  return connectItx({ baseUrl: baseUrl(), token: adminApiSecret() });
}

function authHeaders() {
  return {
    authorization: `Bearer ${adminApiSecret()}`,
    "content-type": "application/json",
  };
}

function adminApiSecret() {
  const secret =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required for itx e2e tests.");
  return secret;
}

function baseUrl() {
  const url =
    process.env.OS_ITX_E2E_BASE_URL?.trim().replace(/\/+$/, "") ||
    process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
    "";
  if (!url) throw new Error("APP_CONFIG_BASE_URL is required for itx e2e tests.");
  return url;
}
