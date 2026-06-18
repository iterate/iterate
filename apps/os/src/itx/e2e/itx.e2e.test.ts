// itx e2e: proves the spec against a REAL deployed worker (local dev server,
// preview, or production — whatever APP_CONFIG_BASE_URL points at).
//
// The catalogue examples (src/itx/examples.ts — the same entries the REPL UI
// shows) run through every server-side runtime via the matrix below; the
// live-capability scenarios run from Node because they need a Node-side
// RpcTarget provider. The browser runtime runs the same catalogue in
// itx.browser.test.ts.

import { expect, test as baseTest } from "vitest";
import { RpcTarget } from "capnweb";
import { getItxErrorCode } from "../errors.ts";
import { ITX_EXAMPLES } from "../examples.ts";
import {
  adminApiSecret,
  baseUrl,
  connectGlobal,
  registerCreatedProjectCleanup,
} from "./e2e-env.ts";
import { EXAMPLE_CASES, EXAMPLE_IDS_WITHOUT_CASES } from "./example-cases.ts";
import {
  MATRIX_RUNTIMES,
  projectWorkerRunnerSource,
  pushProjectRepoFiles,
  runExampleCode,
} from "./example-matrix.ts";
import { slackShapedCapabilitySource, todoCapabilitySource } from "./itx-scripts.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const PROJECT_SLUG = `itx-e2e-${RUN_SUFFIX}`;

const createdProjectIds = registerCreatedProjectCleanup();

// ---- the catalogue matrix ---------------------------------------------------
// One project, created here (the harness's job); every example then connects
// INTO it and gets straight to work — itx.streams.get("/repl/demo"), no
// narrowing boilerplate. The project-worker runtime needs the catalogue baked
// into the project's worker.ts, so the lazy setup pushes that once.

const MATRIX_EXAMPLES = ITX_EXAMPLES.filter(
  (example) =>
    example.runtimes.some((runtime) => (MATRIX_RUNTIMES as readonly string[]).includes(runtime)) &&
    EXAMPLE_CASES[example.id] !== undefined,
);
const matrixTest =
  process.env.OS_ITX_E2E_SKIP_MATRIX === "true"
    ? baseTest.skip
    : process.env.OS_ITX_E2E_MATRIX_CONCURRENT === "true"
      ? baseTest.concurrent
      : baseTest;
const matrixRunsConcurrently = process.env.OS_ITX_E2E_MATRIX_CONCURRENT === "true";
const test = process.env.OS_ITX_E2E_LIVE_CONCURRENT === "true" ? baseTest.concurrent : baseTest;
const solo = baseTest;

test("every catalogue example is either matrix-tested or explicitly excluded", () => {
  for (const example of ITX_EXAMPLES) {
    if (EXAMPLE_IDS_WITHOUT_CASES.has(example.id)) continue;
    expect(
      EXAMPLE_CASES[example.id],
      `example "${example.id}" needs a case in example-cases.ts (or an explicit exclusion)`,
    ).toBeDefined();
  }
});

const matrixSetupPromises = new Map<string, Promise<{ projectId: string }>>();
function ensureMatrixProject(
  example: (typeof MATRIX_EXAMPLES)[number],
): Promise<{ projectId: string }> {
  const matrixKey = matrixRunsConcurrently ? example.id : "shared";
  let matrixSetupPromise = matrixSetupPromises.get(matrixKey);
  if (!matrixSetupPromise) {
    matrixSetupPromise = (async () => {
      const matrixExamples = matrixRunsConcurrently ? [example] : MATRIX_EXAMPLES;
      using itx = connectGlobal();
      const project = (await itx.projects.create({
        slug: `${PROJECT_SLUG}-mx-${slugFragment(matrixKey)}`,
      })) as {
        id: string;
        slug: string;
      };
      createdProjectIds.push(project.id);
      await pushProjectRepoFiles({
        commitMessage: "bake catalogue examples into the project worker",
        files: {
          "worker.ts": projectWorkerRunnerSource(
            matrixExamples.filter((matrixExample) =>
              matrixExample.runtimes.includes("project-worker"),
            ),
          ),
        },
        projectId: project.id,
        projectSlug: project.slug,
      });
      return { projectId: project.id };
    })();
    matrixSetupPromises.set(matrixKey, matrixSetupPromise);
  }
  return matrixSetupPromise;
}

for (const example of MATRIX_EXAMPLES) {
  const exampleCase = EXAMPLE_CASES[example.id]!;
  // Cold isolates, a project-worker rebuild per call, and a spawned CLI per
  // cli-tagged example make these the slowest tests in the suite.
  matrixTest(
    `catalogue example "${example.id}" runs identically across runtimes`,
    {
      timeout: 240_000,
    },
    async () => {
      const { projectId } = await ensureMatrixProject(example);
      const runtimes = MATRIX_RUNTIMES.filter((runtime) => example.runtimes.includes(runtime));
      expect(runtimes.length).toBeGreaterThan(0);

      for (const runtime of runtimes) {
        const ctx = { marker: `${runtime}-${crypto.randomUUID().slice(0, 8)}`, projectId };
        const vars = exampleCase.vars?.(ctx) ?? {};
        try {
          const result = await runExampleCode(runtime, {
            code: example.code,
            id: example.id,
            projectId,
            vars,
          });
          exampleCase.assert(result, ctx);
        } catch (error) {
          throw new Error(
            `example "${example.id}" failed in the ${runtime} runtime: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      }
    },
  );
}

function slugFragment(value: string) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 32);
}

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

  // (2) provide it as a live capability on the project context — ONE verb: a live
  // stub is just another target, discriminated structurally from the
  // serializable rpc/url kinds. The provider implements call({ path, args })
  // itself — the one calling convention, no invoke flag anywhere.
  using projectItx = await itx.projects.get(project.id);
  await projectItx.provideCapability({
    name: "slack",
    capability: new FakeSlackSdk() as never,
  });

  // (3) Anyone holding a handle calls it through the fallthrough — zero
  // client code, the Slack SDK docs are the tool docs.
  const liveResult = (await (projectItx as never as Record<string, any>).slack.chat.postMessage({
    text: "hi from the live cap",
  })) as { method: string; provider: string };
  expect(liveResult).toMatchObject({ method: "chat.postMessage", provider: "node-live" });

  // (4) "I like this mount" → promote: durable means the code moves
  // server-side (provide an rpc/source address), not a flag on the live
  // stub. Source caps are member-shaped (the registry wraps the loader
  // entrypoint and replays the path); `types` documents the surface for
  // machines the way meta.instructions does for agents.
  const marker = `durable-${RUN_SUFFIX}`;
  const slackDurableTypes =
    "declare const chat: { postMessage(body: object): Promise<{ method: string }> };";
  await projectItx.provideCapability({
    name: "slackDurable",
    types: slackDurableTypes,
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
          cacheKey: crypto.randomUUID(),
          mainModule: "cap.js",
          modules: { "cap.js": slackShapedCapabilitySource({ marker }) },
        },
      },
    },
  });

  // (5) The SAME dotted call works from an itx script in other runtimes,
  // where the live provider (this Node process) is also still reachable.
  const callPathCapabilityCode = `return await itx[vars.capName].chat.postMessage({ text: vars.text });`;
  for (const runtime of ["node", "dynamic-worker"] as const) {
    const viaDurable = await runExampleCode(runtime, {
      code: callPathCapabilityCode,
      projectId: project.id,
      vars: { capName: "slackDurable", text: `via-${runtime}` },
    });
    expect(viaDurable).toMatchObject({ marker, method: "chat.postMessage" });
  }

  // Own rows carry NO provenance field — `from` marks inherited entries
  // only (defaults like `ai` appear with from: "defaults").
  // `types` is lifted from meta like instructions.
  const description = (await projectItx.describe()).capabilities as Array<{ from?: string }>;
  expect(description.filter((entry) => entry.from === undefined)).toMatchObject([
    { connected: true, kind: "live", name: "slack" },
    { kind: "rpc", name: "slackDurable", types: slackDurableTypes },
  ]);

  // The context's stream is the only authority: both provides — the LIVE
  // one included (the record outlives the session; only the stub is
  // in-memory) — are capability-provided events on the project context's
  // own stream (the project root, "/"), readable like any other stream.
  const journalEvents = (await projectItx.streams.get("/").getEvents()) as Array<{
    payload: { path?: string[]; kind?: string };
    type: string;
  }>;
  const provided = journalEvents.filter(
    (event) => event.type === "events.iterate.com/itx/capability-provided",
  );
  expect(provided.map((event) => ({ kind: event.payload.kind, path: event.payload.path }))).toEqual(
    [
      { kind: "live", path: ["slack"] },
      { kind: "rpc", path: ["slackDurable"] },
    ],
  );
});

test("platform bindings are dialable capabilities (raw + wrapped)", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-ai` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // (1) Raw binding ref: env.AI itself is the target; members replay applies
  // the dotted path straight onto it. models() is a free catalog read.
  await projectItx.provideCapability({
    meta: { instructions: "Workers AI. Use like the env.AI binding." },
    name: "ai",
    capability: { type: "rpc", worker: { binding: "AI", type: "binding" } },
  });
  const models = (await (projectItx as never as Record<string, any>).ai.models()) as unknown[];
  expect(Array.isArray(models)).toBe(true);
  expect(models.length).toBeGreaterThan(0);

  // (2) Wrapped via the BindingCapability loopback: same binding, reached
  // through the thin policy entrypoint (which implements call) — the §2
  // pattern.
  await projectItx.provideCapability({
    name: "aiWrapped",
    capability: {
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

  // (3) Allowlist: providing is STRUCTURAL only (the provide-time fail-fast
  // was deliberately dropped with the core extraction) — reachability is the
  // dial's authority, so a non-dialable binding/loopback/namespace refuses at
  // FIRST CALL instead.
  const handle = projectItx as never as Record<string, any>;
  await projectItx.provideCapability({
    name: "db",
    capability: { type: "rpc", worker: { binding: "DB", type: "binding" } },
  });
  await expect(handle.db.prepare("SELECT 1")).rejects.toThrow(/not dialable/);
  await projectItx.provideCapability({
    name: "sneaky",
    capability: { entrypoint: "ItxEntrypoint", type: "rpc", worker: { type: "loopback" } },
  });
  await expect(handle.sneaky.context()).rejects.toThrow(/not dialable/);
  // A typo'd serializable address still fails at provide (structural check) —
  // it must not register as a dead live cap.
  await expect(
    projectItx.provideCapability({
      name: "typoed",
      capability: { type: "rcp", worker: { binding: "AI", type: "binding" } } as never,
    }),
  ).rejects.toThrow(/unknown target type/);
  // Durable Object dials are name-scoped per project (itx:<projectId>:<name>),
  // but the namespace allowlist still defaults to empty — config has to opt in.
  await projectItx.provideCapability({
    name: "sneakyDo",
    capability: {
      type: "rpc",
      worker: { binding: "PROJECT", name: "someone-elses-project", type: "durable-object" },
    },
  });
  await expect(handle.sneakyDo.anything()).rejects.toThrow(/not dialable/);

  // describe() reports the new kinds and lifts instructions (own rows only —
  // they carry no `from`; the inherited defaults read from: "defaults").
  // The unreachable-but-provided rows from (3) appear too: provide is structural.
  const caps = (await projectItx.describe()).capabilities as Array<{ from?: string }>;
  expect(caps.filter((entry) => entry.from === undefined)).toMatchObject([
    { instructions: "Workers AI. Use like the env.AI binding.", kind: "rpc", name: "ai" },
    { kind: "rpc", name: "aiWrapped" },
    { kind: "rpc", name: "db" },
    { kind: "rpc", name: "sneaky" },
    { kind: "rpc", name: "sneakyDo" },
  ]);
});

// A remote MCP server to test against: explicit env wins; otherwise the mock
// provider worker (same source the inbound-MCP e2e suite uses), if deployed.
const MCP_TEST_SERVER_URL =
  process.env.OS_E2E_MCP_SERVER_URL?.trim() ||
  (process.env.MOCK_PROVIDER_BASE_URL
    ? `${process.env.MOCK_PROVIDER_BASE_URL.replace(/\/+$/, "")}/mcp`
    : "");

baseTest.skipIf(!MCP_TEST_SERVER_URL)(
  "the first-party McpClient cap bridges a remote MCP server",
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-mcp` })) as { id: string };
    createdProjectIds.push(project.id);
    using projectItx = await itx.projects.get(project.id);

    await projectItx.provideCapability({
      meta: { instructions: "Test MCP server. Call listTools() first." },
      name: "mcptest",
      capability: {
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

test("user-space caps: repo-sourced code is a first-class capability through the generic source dial", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-uw` })) as {
    id: string;
    slug: string;
  };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // (1) Ship user code: a MULTI-FILE capability module in the project's own
  // repo — the entry imports a sibling, so the provide exercises the real
  // chain end to end: repo readTree → @cloudflare/worker-bundler → R2 build
  // memo → Worker Loader. This is the §1 litmus test's user-space half:
  // same address shape as anything else, no forwarder, no special kind.
  const marker = `litmus-${RUN_SUFFIX}`;
  await pushProjectRepoFiles({
    commitMessage: "add petstore capability module",
    files: {
      "caps/petstore-data.js":
        `export const OPERATIONS = ["getPet", "listPets"];\n` +
        `export const MARKER = ${JSON.stringify(marker)};\n`,
      "caps/petstore.js": `import { WorkerEntrypoint } from "cloudflare:workers";
import { MARKER, OPERATIONS } from "./petstore-data.js";

export class PetstoreClient extends WorkerEntrypoint {
  async listOperations() {
    return { marker: MARKER, operations: OPERATIONS };
  }
  async echo(value) {
    return { marker: MARKER, value };
  }
}
`,
    },
    projectId: project.id,
    projectSlug: project.slug,
  });

  // (2) Provide it as an ordinary repo source. "latest" tracks the push;
  // the build happens per commit (memoized), never per call.
  await projectItx.provideCapability({
    meta: { instructions: "Petstore API. Call listOperations() first." },
    name: "petstore",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          bundle: {},
          commit: "latest",
          entrypoint: "PetstoreClient",
          path: "caps/petstore.js",
          repoPath: "/repos/project",
          type: "repo",
        },
      },
    },
  });

  // (3) Call it like any other capability. The first call may land inside
  // the 10s "latest" probe window of a pre-push head — poll briefly until
  // the freshly pushed module is what answers.
  const handle = projectItx as never as Record<string, any>;
  await waitForEqual(
    () => handle.petstore.listOperations().catch((error: unknown) => error),
    { marker, operations: ["getPet", "listPets"] },
    { intervalMs: 1_000, timeoutMs: 30_000 },
  );

  const echoed = (await handle.petstore.echo({ hello: 1 })) as Record<string, unknown>;
  expect(echoed).toEqual({ marker, value: { hello: 1 } });
});

test("the defaults arrive from the code-rooted chain end, and own rows shadow them", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-def` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // A fresh project has zero rows of its own, but `ai` is already there —
  // inherited from the code-defined parent context, labeled from: "defaults"
  // (the internal chain id never leaves the chain).
  type Described = { capabilities: Array<{ from?: string; name: string }> };
  const before = (await projectItx.describe()) as Described;
  expect(before.capabilities.find((entry) => entry.name === "ai")).toMatchObject({
    from: "defaults",
    kind: "rpc",
  });
  // The whole migrated kernel arrives the same way (§8: cap #0 disappears).
  for (const name of ["gmail", "repos", "streams", "workspace", "worker"]) {
    expect(before.capabilities.find((entry) => entry.name === name)).toMatchObject({
      from: "defaults",
    });
  }

  // Defaults cannot be revoked — succeeding would lie (the default keeps
  // serving). Shadowing is the override mechanism.
  await expect(projectItx.revokeCapability({ name: "ai" })).rejects.toThrow(
    /inherited from the defaults/,
  );

  // Shadowing is prototype semantics: a row of this context's own wins, and
  // describe() shows exactly one `ai` — an OWN entry, so no `from` field.
  class ShadowAi extends RpcTarget {
    async call({ path }: { path: string[]; args: unknown[] }) {
      return { method: path.join("."), provider: "shadow" };
    }
  }
  await projectItx.provideCapability({
    name: "ai",
    capability: new ShadowAi() as never,
  });
  const after = (await projectItx.describe()) as Described;
  const aiCaps = after.capabilities.filter((entry) => entry.name === "ai");
  expect(aiCaps).toHaveLength(1);
  expect(aiCaps[0]!.from).toBeUndefined();

  const handle = projectItx as never as Record<string, any>;
  expect(await handle.ai.run("model", { prompt: "hi" })).toEqual({
    method: "run",
    provider: "shadow",
  });
});

test("fetch is a shadowable capability: a live provider intercepts project egress", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-fetch` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // (1) Fresh project: `fetch` is a default, not kernel.
  type Described = { capabilities: Array<{ from?: string; name: string }> };
  const before = (await projectItx.describe()) as Described;
  expect(before.capabilities.find((entry) => entry.name === "fetch")).toMatchObject({
    from: "defaults",
  });

  // (2) A Node-side shadow provider: the whole intercept is ONE call method.
  // args[0] arrives as a Request (the iterate capnweb fork serializes
  // Request/Response by prototype), but read .url defensively in case a
  // transport hop degrades it to a plain object.
  class EgressInterceptor extends RpcTarget {
    async call({ args }: { path: string[]; args: unknown[] }) {
      const url = (args[0] as { url?: string })?.url ?? String(args[0]);
      return new Response(JSON.stringify({ intercepted: true, url }), {
        headers: { "content-type": "application/json" },
      });
    }
  }
  await projectItx.provideCapability({
    name: "fetch",
    capability: new EgressInterceptor() as never,
  });

  // (3) The explicit door: itx.fetch now lands on the provider, not the
  // network. The .invalid TLD guarantees NXDOMAIN, so a canned response can
  // only have come from the shadow.
  const intercepted = await projectItx.fetch("https://intercept-probe.invalid/x");
  expect(await intercepted.json()).toEqual({
    intercepted: true,
    url: "https://intercept-probe.invalid/x",
  });

  // (4) The implicit door: bare fetch() inside a platform-loaded isolate
  // (globalOutbound = ProjectEgress.fetch) routes registry-first too, so the
  // same shadow intercepts it — the loop-breaking property end to end.
  const bareFetchScript = async ({ itx: scriptItx }: { itx: Record<string, any> }) => {
    void scriptItx;
    const response = await fetch("https://intercept-probe.invalid/bare");
    return await response.json();
  };
  const scriptResponse = await fetch(new URL("/api/itx/run", baseUrl()), {
    body: JSON.stringify({ context: project.id, functionSource: bareFetchScript.toString() }),
    headers: authHeaders(),
    method: "POST",
  });
  const scriptBody = (await scriptResponse.json()) as { error?: string; result?: unknown };
  if (!scriptResponse.ok) throw new Error(`bare-fetch script failed: ${scriptBody.error}`);
  expect(scriptBody.result).toEqual({
    intercepted: true,
    url: "https://intercept-probe.invalid/bare",
  });

  // (5) Revoke the shadow: the default egress pipe resurfaces — a real
  // network fetch to the NXDOMAIN host now fails instead of returning the
  // canned response.
  await projectItx.revokeCapability({ name: "fetch" });
  const after = (await projectItx.describe()) as Described;
  expect(after.capabilities.find((entry) => entry.name === "fetch")).toMatchObject({
    from: "defaults",
  });
  await expect(projectItx.fetch("https://intercept-probe.invalid/x")).rejects.toThrow();

  // (6) Child contexts: a shadow defined on an EXTENSION intercepts that extension's
  // isolates too — ProjectEgress dispatches at the ORIGINATING context node,
  // so the child's chain (child shadow → project → defaults) resolves bare
  // fetch(), while the project context stays on the real pipe.
  using child = await projectItx.extend({ name: "fetch-shadow" });
  const childDescription = await child.describe();
  await child.provideCapability({
    name: "fetch",
    capability: new EgressInterceptor() as never,
  });
  const childScriptResponse = await fetch(new URL("/api/itx/run", baseUrl()), {
    body: JSON.stringify({
      context: String(childDescription.context),
      functionSource: bareFetchScript.toString(),
    }),
    headers: authHeaders(),
    method: "POST",
  });
  const childScriptBody = (await childScriptResponse.json()) as {
    error?: string;
    result?: unknown;
  };
  if (!childScriptResponse.ok) {
    throw new Error(`child bare-fetch script failed: ${childScriptBody.error}`);
  }
  expect(childScriptBody.result).toEqual({
    intercepted: true,
    url: "https://intercept-probe.invalid/bare",
  });
  await expect(projectItx.fetch("https://intercept-probe.invalid/x")).rejects.toThrow();

  // (7) No raw doors around the shadow: the Project DO's fetch/egressFetch
  // are masked on the cap-#0 surface — itx.fetch is THE egress door.
  const rawDoors = projectItx.project as unknown as {
    egressFetch(request: unknown): Promise<unknown>;
  };
  await expect(rawDoors.egressFetch("https://intercept-probe.invalid/x")).rejects.toThrow(
    /raw egress pipe/,
  );
});

test("absolute stream refs are sugar through the one access check", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-ref` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  // Absolute string ref from the admin global handle (access "all") writes
  // into the project stream scope…
  const marker = crypto.randomUUID().slice(0, 8);
  await itx.streams.get(`${project.id}:/itx-e2e/refs`).append({
    event: {
      payload: { marker },
      type: "events.iterate.test/itx/e2e",
    },
  });

  // …and the structured form on the project handle reads it back.
  const events = (await projectItx.streams
    .get({ projectId: project.id, path: "/itx-e2e/refs" })
    .getEvents()) as Array<{ payload: { marker?: string } }>;
  expect(events.map((event) => event.payload.marker)).toContain(marker);

  // A project handle cannot fully-qualify its way out of its access set —
  // masked as NOT_FOUND, indistinguishable from a project that exists.
  // Probed in-isolate (a script on the project context) where the throw is
  // synchronous: capnweb pipelining onto a rejected intermediate stub would
  // replace the real error with a local follow-up one.
  const probe = async ({ itx: scriptItx }: { itx: Record<string, any> }) => {
    try {
      await scriptItx.streams.get("global:/anything").runtimeState();
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
solo(
  "script executions leave a two-event record on the context's stream",
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
    const events = (await projectItx.streams.get("/").getEvents()) as Array<{
      payload: Record<string, unknown>;
      type: string;
    }>;
    const requested = events.find(
      (event) =>
        event.type === "events.iterate.com/itx/script-execution-requested" &&
        event.payload.executionId === body.executionId,
    );
    const completed = events.find(
      (event) =>
        event.type === "events.iterate.com/itx/script-execution-completed" &&
        event.payload.executionId === body.executionId,
    );
    expect(requested?.payload).toMatchObject({ context: `${project.id}:/` });
    expect(completed?.payload).toMatchObject({ ok: true, result: 42 });
  },
);

test("worker caps hold a correctly scoped itx of their own", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `${PROJECT_SLUG}-todo` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);

  await projectItx.provideCapability({
    name: "todo",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
          cacheKey: crypto.randomUUID(),
          mainModule: "cap.js",
          modules: { "cap.js": todoCapabilitySource() },
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
  const events = (await projectItx.streams.get("/itx-e2e/todos").getEvents()) as Array<{
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
  await projectItx.provideCapability({
    name: "kit",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
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
  await projectItx.provideCapability({
    name: "inventory",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
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
  await projectItx.provideCapability({
    name: "report",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
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
    projectItx.provideCapability({
      name: "then",
      capability: {
        type: "rpc",
        worker: {
          type: "source",
          source: {
            type: "inline",
            cacheKey: "x",
            mainModule: "cap.js",
            modules: { "cap.js": "export default {}" },
          },
        },
      },
    }),
  ).rejects.toThrow(/reserved/);

  // itx.project IS the full Project DO surface (D17) — except the node's
  // `itx()` core, which is node-to-node machinery: invoke carries the
  // trusted chain-delegation `origin`, so exposing it would let any handle
  // holder spoof another context's identity (a sibling fork's workspace).
  // The proxy masks the `itx` head; the core's reserved-segment gate stays
  // as defense in depth for paths arriving over the real chain.
  const projectDo = (projectItx as { project: unknown }).project as {
    itx(): Promise<unknown>;
  };
  await expect(projectDo.itx()).rejects.toThrow(/internal context-node plumbing/);
});

function authHeaders() {
  return {
    authorization: `Bearer ${adminApiSecret()}`,
    "content-type": "application/json",
  };
}

async function waitForEqual<T>(
  read: () => Promise<T>,
  expected: T,
  options: {
    intervalMs: number;
    timeoutMs: number;
  },
) {
  const deadline = Date.now() + options.timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    try {
      expect(last).toEqual(expected);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }
  expect(last).toEqual(expected);
}
