// itx e2e: proves the spec against a REAL deployed worker (local dev server,
// preview, or production — whatever APP_CONFIG_BASE_URL points at).
//
// The shared scripts in itx-scripts.ts run through every execution mode; the
// live-capability scenarios run from Node because they need a Node-side
// RpcTarget provider. Browser mode joins when the REPL is rewired.

import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import type { ItxClient } from "../client.ts";
import {
  adminApiSecret,
  baseUrl,
  connectGlobal,
  registerCreatedProjectCleanup,
} from "./e2e-env.ts";
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

const createdProjectIds = registerCreatedProjectCleanup();

test("itx scripts run identically over Cap'n Web and /api/itx/run", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: PROJECT_SLUG })) as {
    id: string;
    slug: string;
  };
  createdProjectIds.push(project.id);
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
  createdProjectIds.push(project.id);

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
    // Legacy `source:` input normalizes to an rpc/source target.
    { invoke: "path-call", kind: "rpc", name: "slackDurable" },
  ]);
});

test("platform bindings are dialable capabilities (raw + wrapped)", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-ai` })) as { id: string };
  using projectItx = await itx.projects.get(project.id);

  // (1) Raw binding ref: env.AI itself is the target; members replay applies
  // the dotted path straight onto it. models() is a free catalog read.
  await projectItx.caps.define({
    meta: { instructions: "Workers AI. Use like the env.AI binding." },
    name: "ai",
    target: { type: "rpc", worker: { binding: "AI", type: "binding" } },
  });
  const models = (await (projectItx as never as Record<string, any>).ai.models()) as unknown[];
  expect(Array.isArray(models)).toBe(true);
  expect(models.length).toBeGreaterThan(0);

  // (2) Wrapped via the BindingCapability loopback (path-call): same binding,
  // reached through the thin policy entrypoint — the §2 pattern.
  await projectItx.caps.define({
    invoke: "path-call",
    name: "aiWrapped",
    target: {
      entrypoint: "BindingCapability",
      props: { binding: "AI" },
      type: "rpc",
      worker: { type: "loopback" },
    },
  });
  const wrapped = (await (
    projectItx as never as Record<string, any>
  ).aiWrapped.models()) as unknown[];
  expect(Array.isArray(wrapped)).toBe(true);

  // (3) Allowlist: a non-dialable binding refuses at define time, and a
  // loopback export outside DIALABLE_LOOPBACKS refuses too.
  await expect(
    projectItx.caps.define({
      name: "db",
      target: { type: "rpc", worker: { binding: "DB", type: "binding" } },
    }),
  ).rejects.toThrow(/not dialable/);
  await expect(
    projectItx.caps.define({
      name: "sneaky",
      target: { entrypoint: "ItxEntrypoint", type: "rpc", worker: { type: "loopback" } },
    }),
  ).rejects.toThrow(/not dialable/);

  // describe() reports the new kinds and lifts instructions.
  const caps = await projectItx.caps.describe();
  expect(caps).toMatchObject([
    { instructions: "Workers AI. Use like the env.AI binding.", kind: "rpc", name: "ai" },
    { invoke: "path-call", kind: "rpc", name: "aiWrapped" },
  ]);
});

// A remote MCP server to test against: explicit env wins; otherwise the mock
// provider worker (same source the inbound-MCP e2e suite uses), if deployed.
const MCP_TEST_SERVER_URL =
  process.env.OS_E2E_MCP_SERVER_URL?.trim() ||
  (process.env.MOCK_PROVIDER_BASE_URL
    ? `${process.env.MOCK_PROVIDER_BASE_URL.replace(/\/+$/, "")}/mcp`
    : "");

test.skipIf(!MCP_TEST_SERVER_URL)(
  "the first-party McpClient cap bridges a remote MCP server",
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-mcp` })) as { id: string };
    using projectItx = await itx.projects.get(project.id);

    await projectItx.caps.define({
      invoke: "path-call",
      meta: { instructions: "Test MCP server. Call listTools() first." },
      name: "mcptest",
      target: {
        entrypoint: "McpClient",
        props: { serverUrl: MCP_TEST_SERVER_URL },
        type: "rpc",
        worker: { type: "loopback" },
      },
    });

    const handle = projectItx as never as Record<string, any>;
    const listed = (await handle.mcptest.listTools()) as { tools: { name: string }[] };
    expect(Array.isArray(listed.tools)).toBe(true);
    expect(listed.tools.length).toBeGreaterThan(0);

    // Call the first listed tool with empty args — the mock provider's tools
    // are unary echoes; any structured result proves the bridge end to end.
    const firstTool = listed.tools[0]!.name;
    const result = await handle.mcptest[firstTool]({});
    expect(result).toBeDefined();
  },
);

test("worker caps hold a correctly scoped itx of their own", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-todo` })) as { id: string };
  createdProjectIds.push(project.id);
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

test("members caps auto-proxy every public method/getter at any depth", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-proxy` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // No method list anywhere: the WorkerEntrypoint just exports methods (and a
  // getter returning a nested surface), and they are all instantly callable.
  await projectItx.caps.define({
    name: "kit",
    source: {
      codeId: crypto.randomUUID(),
      mainModule: "cap.js",
      modules: {
        "cap.js": `
          import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
          class Math extends RpcTarget {
            add({ a, b }) { return a + b; }
          }
          export default class extends WorkerEntrypoint {
            echo(input) { return { echoed: input }; }
            get math() { return new Math(); }
          }
        `,
      },
    },
  });

  const kit = (projectItx as never as Record<string, any>).kit;
  await expect(kit.echo({ hi: 1 })).resolves.toEqual({ echoed: { hi: 1 } });
  // Depth: getter → nested RpcTarget → method, all proxied with no wiring.
  await expect(kit.math.add({ a: 2, b: 3 })).resolves.toBe(5);
});

test("one dynamic worker cap calls another's methods through its own itx", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-w2w` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // Provider cap: a plain WorkerEntrypoint exporting a method + a nested
  // getter. No method list — the whole public surface is proxied.
  await projectItx.caps.define({
    name: "inventory",
    source: {
      codeId: crypto.randomUUID(),
      mainModule: "cap.js",
      modules: {
        "cap.js": `
          import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
          class Skus extends RpcTarget { priceOf({ sku }) { return sku === "ABC" ? 42 : 0; } }
          export default class extends WorkerEntrypoint {
            count() { return 7; }
            get skus() { return new Skus(); }
          }
        `,
      },
    },
  });

  // Consumer cap: a DIFFERENT dynamic worker that reaches the first one
  // purely through env.ITERATE.context — itx.inventory.count() and the nested
  // itx.inventory.skus.priceOf(...) are proxied worker→worker, no wiring.
  await projectItx.caps.define({
    name: "report",
    source: {
      codeId: crypto.randomUUID(),
      mainModule: "cap.js",
      modules: {
        "cap.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async build({ sku }) {
              const itx = await this.env.ITERATE.context;
              const count = await itx.inventory.count();
              const price = await itx.inventory.skus.priceOf({ sku });
              return { count, price, total: count * price };
            }
          }
        `,
      },
    },
  });

  const report = (projectItx as never as Record<string, any>).report;
  await expect(report.build({ sku: "ABC" })).resolves.toEqual({
    count: 7,
    price: 42,
    total: 294,
  });
});

test("revoked and offline caps fail with instructive errors", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-err` })) as { id: string };
  createdProjectIds.push(project.id);
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

  // itx.project IS the full Project DO surface (D17): any public method is
  // callable, so a method added to the DO is instantly reachable here. But a
  // hand-built reserved path through itxInvoke is still gated server-side, so
  // the full surface can never be abused to reach prototype internals.
  await projectItx.caps.define({
    name: "probe",
    source: {
      codeId: crypto.randomUUID(),
      mainModule: "cap.js",
      modules: {
        "cap.js":
          "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { ok() { return 1; } }",
      },
    },
  });
  const projectDo = (projectItx as { project: unknown }).project as {
    itxInvoke(input: { args: unknown[]; name: string; path: string[] }): Promise<unknown>;
  };
  await expect(
    projectDo.itxInvoke({ args: [], name: "probe", path: ["constructor"] }),
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

function authHeaders() {
  return {
    authorization: `Bearer ${adminApiSecret()}`,
    "content-type": "application/json",
  };
}
