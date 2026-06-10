// itx e2e: proves the spec against a REAL deployed worker (local dev server,
// preview, or production — whatever APP_CONFIG_BASE_URL points at).
//
// The shared scripts in itx-scripts.ts run through every execution mode; the
// live-capability scenarios run from Node because they need a Node-side
// RpcTarget provider. Browser mode joins when the REPL is rewired.

import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import type { ItxClient } from "../client.ts";
import { getItxErrorCode } from "../errors.ts";
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
  // server-side (define with an rpc/source target), not a flag on the live
  // stub.
  const marker = `durable-${RUN_SUFFIX}`;
  await projectItx.caps.define({
    invoke: "path-call",
    name: "slackDurable",
    target: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          cacheKey: crypto.randomUUID(),
          mainModule: "cap.js",
          modules: { "cap.js": pathCallCapSource({ marker }) },
        },
      },
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

  // Own rows only — platform defaults (e.g. `ai` from platform:project)
  // also appear in describe() with their code context as owner.
  const description = (await projectItx.caps.describe()) as Array<{ owner: string }>;
  expect(description.filter((cap) => cap.owner === project.id)).toMatchObject([
    { connected: true, invoke: "path-call", kind: "live", name: "slack" },
    { invoke: "path-call", kind: "rpc", name: "slackDurable" },
  ]);
});

test("platform bindings are dialable capabilities (raw + wrapped)", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-ai` })) as { id: string };
  createdProjectIds.push(project.id);
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
  // Durable Object refs name arbitrary instances across ALL projects, so the
  // namespace allowlist defaults to empty — config has to opt in.
  await expect(
    projectItx.caps.define({
      name: "sneakyDo",
      target: {
        type: "rpc",
        worker: { binding: "PROJECT", name: "someone-elses-project", type: "durable-object" },
      },
    }),
  ).rejects.toThrow(/not dialable/);

  // describe() reports the new kinds and lifts instructions (own rows only —
  // inherited platform defaults carry their code context as owner).
  const caps = (await projectItx.caps.describe()) as Array<{ owner: string }>;
  expect(caps.filter((cap) => cap.owner === project.id)).toMatchObject([
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
    createdProjectIds.push(project.id);
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

test("user-space caps: a named export of the project worker is a first-class capability", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-uw` })) as {
    id: string;
    slug: string;
  };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // (1) Ship user code: replace worker.js in the project's iterate-config
  // repo with one that ALSO exports a capability class. This is the §1
  // litmus test's user-space half — same shape as the first-party McpClient,
  // reached via the ProjectWorker loopback forwarder.
  const marker = `litmus-${RUN_SUFFIX}`;
  const userWorker = `import { WorkerEntrypoint } from "cloudflare:workers";

export default {
  async fetch() {
    return new Response("user worker");
  },
};

export class PetstoreClient extends WorkerEntrypoint {
  async call({ path, args }) {
    if (path.join(".") === "listOperations") {
      return { operations: ["getPet", "listPets"], specUrl: this.ctx.props.specUrl ?? null };
    }
    if (path.join(".") === "echo") {
      const { cap, context, projectId, ...definerProps } = this.ctx.props;
      return { args, attribution: { cap, context, projectId }, definerProps };
    }
    throw new Error("PetstoreClient does not implement " + path.join("."));
  }
}
`;

  // The push runs as an itx script (the in-isolate path agents use); the
  // worker source travels via the endpoint's vars.
  const pushScript = async ({
    itx: scriptItx,
    vars,
  }: {
    itx: Record<string, any>;
    vars: { projectSlug: string; workerSource: string };
  }) => {
    const repo = await scriptItx.repos.ensureIterateConfigInfo({
      projectSlug: vars.projectSlug,
    });
    const url = new URL(repo.remote);
    url.username = "x";
    url.password = repo.token.split("?")[0];
    const dir = "/litmus-config";
    await scriptItx.workspace.gitClone({
      branch: repo.defaultBranch,
      depth: 1,
      dir,
      url: url.toString(),
    });
    await scriptItx.workspace.writeFile(`${dir}/worker.js`, vars.workerSource);
    await scriptItx.workspace.gitAdd({ dir, filepath: "worker.js" });
    await scriptItx.workspace.gitCommit({
      author: { email: "e2e@iterate.com", name: "itx e2e" },
      dir,
      message: "add PetstoreClient capability export",
    });
    await scriptItx.workspace.gitPush({ dir, ref: repo.defaultBranch, remote: "origin" });
    return { pushed: true };
  };
  const pushResponse = await fetch(new URL("/api/itx/run", baseUrl()), {
    body: JSON.stringify({
      context: project.id,
      functionSource: pushScript.toString(),
      vars: { projectSlug: project.slug, workerSource: userWorker },
    }),
    headers: authHeaders(),
    method: "POST",
  });
  const pushBody = (await pushResponse.json()) as { error?: string; result?: unknown };
  if (!pushResponse.ok) throw new Error(`push script failed: ${pushBody.error}`);
  expect(pushBody.result).toEqual({ pushed: true });

  // (2) Point a cap at the user's export via the ProjectWorker forwarder —
  // props.export names THEIR class, props.invoke how to call it.
  await projectItx.caps.define({
    invoke: "path-call",
    meta: { instructions: "Petstore API. Call listOperations() first." },
    name: "petstore",
    target: {
      entrypoint: "ProjectWorker",
      props: {
        export: "PetstoreClient",
        invoke: "path-call",
        marker,
        specUrl: "https://petstore.example.com/openapi.json",
      },
      type: "rpc",
      worker: { type: "loopback" },
    },
  });

  // (3) Call it like any other capability. The Project DO rebuilds the
  // worker from the fresh push and instantiates the named export per call.
  const handle = projectItx as never as Record<string, any>;
  const listed = (await handle.petstore.listOperations()) as {
    operations: string[];
    specUrl: string;
  };
  expect(listed).toEqual({
    operations: ["getPet", "listPets"],
    specUrl: "https://petstore.example.com/openapi.json",
  });

  // (4) Props discipline: definer parameterization arrives intact, and the
  // registry-injected attribution can't be spoofed by the definer.
  const echoed = (await handle.petstore.echo({ hello: 1 })) as {
    args: unknown[];
    attribution: { cap: string; context: string; projectId: string };
    definerProps: Record<string, unknown>;
  };
  expect(echoed.args).toEqual([{ hello: 1 }]);
  expect(echoed.attribution).toEqual({
    cap: "petstore",
    context: project.id,
    projectId: project.id,
  });
  expect(echoed.definerProps).toEqual({
    marker,
    specUrl: "https://petstore.example.com/openapi.json",
  });
});

test("url caps dial a remote Cap'n Web server over a WebSocket session", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-url` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // The remote server is THIS deployment's own /api/itx endpoint — the one
  // Cap'n Web server every e2e target is guaranteed to have. Auth rides the
  // WebSocket handshake headers, which is exactly what url-ref headers are
  // for. (In production these would be getSecret() placeholders, substituted
  // by the same egress path McpClient headers use.)
  await projectItx.caps.define({
    meta: { instructions: "This deployment's own itx, dialed back over the network." },
    name: "remoteItx",
    target: {
      headers: { authorization: `Bearer ${adminApiSecret()}` },
      type: "url",
      url: new URL(`/api/itx/${project.id}`, baseUrl()).toString(),
    },
  });

  // Members mode against the remote main: the path pipelines over the dial's
  // own capnweb session and resolves on the remote handle. The remote handle
  // describing a registry that contains the very cap being dialed is the
  // round trip working end to end.
  const handle = projectItx as never as Record<string, any>;
  const described = (await handle.remoteItx.describe()) as {
    caps: Array<{ name: string }>;
    context: string;
    project: { id: string };
  };
  expect(described.context).toBe(project.id);
  expect(described.project.id).toBe(project.id);
  expect(described.caps.map((cap) => cap.name)).toContain("remoteItx");
});

test("platform defaults arrive from the platform:project code context, and own rows shadow them", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-def` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // A fresh project has zero rows of its own, but `ai` is already there —
  // inherited from the code-defined parent context, with that context's
  // name as owner (itx-next.md §8).
  type DescribedCaps = { caps: Array<{ name: string; owner: string }> };
  const before = (await projectItx.describe()) as DescribedCaps;
  expect(before.caps.find((cap) => cap.name === "ai")).toMatchObject({
    invoke: "path-call",
    kind: "rpc",
    owner: "platform:project",
  });
  // The whole migrated kernel arrives the same way (§8: cap #0 disappears).
  for (const name of ["repos", "workspace", "worker"]) {
    expect(before.caps.find((cap) => cap.name === name)).toMatchObject({
      owner: "platform:project",
    });
  }

  // Defaults cannot be revoked — succeeding would lie (the default keeps
  // serving). Shadowing is the override mechanism.
  await expect(projectItx.caps.revoke({ name: "ai" })).rejects.toThrow(/platform default/);

  // Shadowing is prototype semantics: a row of this context's own wins, and
  // describe() shows exactly one `ai` with the project as owner.
  class ShadowAi extends RpcTarget {
    async call({ path }: { path: string[]; args: unknown[] }) {
      return { method: path.join("."), provider: "shadow" };
    }
  }
  await projectItx.caps.provide({
    invoke: "path-call",
    name: "ai",
    target: new ShadowAi() as never,
  });
  const after = (await projectItx.describe()) as DescribedCaps;
  const aiCaps = after.caps.filter((cap) => cap.name === "ai");
  expect(aiCaps).toHaveLength(1);
  expect(aiCaps[0]!.owner).toBe(project.id);

  const handle = projectItx as never as Record<string, any>;
  expect(await handle.ai.run("model", { prompt: "hi" })).toEqual({
    method: "run",
    provider: "shadow",
  });
});

test("absolute stream refs are sugar through the one access check", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-ref` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // Absolute string ref from the admin global handle (access "all") writes
  // into the project's namespace…
  const marker = crypto.randomUUID().slice(0, 8);
  await itx.streams.get(`${project.id}:/itx-e2e/refs`).append({
    payload: { marker },
    type: "events.iterate.test/itx/e2e",
  });

  // …and the structured form on the project handle reads it back.
  const events = (await projectItx.streams
    .get({ namespace: project.id, path: "/itx-e2e/refs" })
    .read()) as Array<{ payload: { marker?: string } }>;
  expect(events.map((event) => event.payload.marker)).toContain(marker);

  // A project handle cannot fully-qualify its way out of its access set —
  // masked as NOT_FOUND, indistinguishable from a namespace that exists.
  // Probed in-isolate (a script on the project context) where the throw is
  // synchronous: capnweb pipelining onto a rejected intermediate stub would
  // replace the real error with a local follow-up one.
  const probe = async ({ itx: scriptItx }: { itx: Record<string, any> }) => {
    try {
      await scriptItx.streams.get("global:/anything").describe();
      return { threw: false };
    } catch (error) {
      return { code: (error as { code?: string }).code ?? null, threw: true };
    }
  };
  const probeResponse = await fetch(new URL("/api/itx/run", baseUrl()), {
    body: JSON.stringify({ context: project.id, functionSource: probe.toString() }),
    headers: authHeaders(),
    method: "POST",
  });
  const probeBody = (await probeResponse.json()) as { result?: unknown };
  expect(probeResponse.ok).toBe(true);
  expect(probeBody.result).toEqual({ code: "NOT_FOUND", threw: true });
});

// Cold first-run of the isolate + stream DO can take >45s on a fresh preview.
test(
  "script executions leave a two-event record on the /itx stream",
  { timeout: 90_000 },
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-rec` })) as { id: string };
    createdProjectIds.push(project.id);

    const response = await fetch(new URL("/api/itx/run", baseUrl()), {
      body: JSON.stringify({
        context: project.id,
        functionSource: "async ({ vars }) => vars.a + vars.b",
        vars: { a: 40, b: 2 },
      }),
      headers: authHeaders(),
      method: "POST",
    });
    const body = (await response.json()) as { executionId: string; result: unknown };
    expect(response.ok).toBe(true);
    expect(body.result).toBe(42);
    expect(typeof body.executionId).toBe("string");

    using projectItx = await itx.projects.get(project.id);
    const events = (await projectItx.streams.get("/itx").read()) as Array<{
      payload: Record<string, unknown>;
      type: string;
    }>;
    const requested = events.find(
      (event) =>
        event.type === "events.iterate.com/itx/execution-requested" &&
        event.payload.executionId === body.executionId,
    );
    const completed = events.find(
      (event) =>
        event.type === "events.iterate.com/itx/execution-completed" &&
        event.payload.executionId === body.executionId,
    );
    expect(requested?.payload).toMatchObject({ context: project.id });
    expect(completed?.payload).toMatchObject({ ok: true, result: 42 });
  },
);

test("worker caps hold a correctly scoped itx of their own", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-todo` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  await projectItx.caps.define({
    name: "todo",
    target: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          cacheKey: crypto.randomUUID(),
          mainModule: "cap.js",
          modules: { "cap.js": todoCapSource() },
        },
      },
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
    target: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          cacheKey: crypto.randomUUID(),
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
    target: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          cacheKey: crypto.randomUUID(),
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
      },
    },
  });

  // Consumer cap: a DIFFERENT dynamic worker that reaches the first one
  // purely through env.ITERATE.context — itx.inventory.count() and the nested
  // itx.inventory.skus.priceOf(...) are proxied worker→worker, no wiring.
  await projectItx.caps.define({
    name: "report",
    target: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          cacheKey: crypto.randomUUID(),
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

test("kernel errors cross capnweb as ItxError-shaped errors with codes", async () => {
  using itx = connectGlobal();

  // The REAL wire crossing: capnweb reconstructs a plain Error and reattaches
  // the kernel ItxError's own enumerable props (code, details). NOT_FOUND
  // also covers forbidden projects (existence masking), so this is the shape
  // every access failure takes.
  const error = await itx.projects.get("definitely-not-a-project").then(
    () => null,
    (thrown: unknown) => thrown as Error & { code?: unknown; details?: unknown },
  );
  expect(error).not.toBeNull();
  // capnweb 0.8.0 reconstructs unknown error names as plain Error and drops
  // the name (ERROR_TYPES[name] || Error; the props loop skips "name"), so
  // class/name identity is untransmittable — detection is duck-typed via the
  // own enumerable code/details props, which DO cross (DECISIONS D18).
  expect(error!.name).toBe("Error");
  expect(error!.code).toBe("NOT_FOUND");
  // And the helper the whole client layer uses must agree:
  expect(getItxErrorCode(error)).toBe("NOT_FOUND");
  expect(error!.details).toEqual({ projectIdOrSlug: "definitely-not-a-project" });
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
      target: {
        type: "rpc",
        worker: {
          type: "source",
          source: {
            cacheKey: "x",
            mainModule: "cap.js",
            modules: { "cap.js": "export default {}" },
          },
        },
      },
    }),
  ).rejects.toThrow(/reserved/);

  // itx.project IS the full Project DO surface (D17) — except the itx*
  // registry verbs, which are node-to-node plumbing: itxInvoke carries the
  // trusted chain-delegation `origin`, so exposing it would let any handle
  // holder spoof another context's identity (a sibling fork's workspace).
  // The proxy masks them; the registry's reserved-segment gate stays as
  // defense in depth for paths arriving over the real chain.
  const projectDo = (projectItx as { project: unknown }).project as {
    itxInvoke(input: {
      args: unknown[];
      name: string;
      origin?: string;
      path: string[];
    }): Promise<unknown>;
  };
  await expect(
    projectDo.itxInvoke({ args: [], name: "workspace", origin: "ctx_spoofed", path: ["readFile"] }),
  ).rejects.toThrow(/internal registry plumbing/);
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
