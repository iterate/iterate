// The itx example catalogue: one data structure that is BOTH the "Examples"
// panel in the REPL UI and the script set the e2e suite runs across every
// execution runtime (apps/os/src/itx/e2e/*). Each entry is a self-contained
// script body that runs with `itx` and `vars` in scope and uses an explicit
// `return` — exactly the shape every runtime accepts:
//
//   browser         the REPL (compileBrowserReplFunction wraps the body)
//   node            AsyncFunction("itx", "vars", code) on a Cap'n Web stub
//   cli             `pnpm cli itx run -e <code>` (same Node eval, spawned)
//   dynamic-worker  POST /api/itx/run with `async ({ itx, vars }) => { code }`
//   config-worker   the body baked into the project repo's worker.js,
//                   executed against env.ITERATE.context
//
// Almost every example is written against a PROJECT-scoped handle (context:
// "project"): the harness — a project REPL, withItx({ context }), a
// /api/itx/run body with `context`, or a worker's env.ITERATE.context —
// connects into the project, and the script gets straight to work:
// itx.streams.get("/some/path").append(...). Only narrowing itself is a
// global-context example.
//
// `runtimes` records where a snippet genuinely works unattended. Browser-only
// entries lean on session-bound powers (live RpcTargets, alert, esm.sh
// imports); everything else must stay runtime-agnostic: no pipelining tricks,
// plain serializable return values.

export const ITX_EXAMPLE_RUNTIMES = [
  "browser",
  "node",
  "cli",
  "dynamic-worker",
  "config-worker",
] as const;

export type ItxExampleRuntime = (typeof ITX_EXAMPLE_RUNTIMES)[number];

export type ItxExample = {
  /** Script body: `itx` and `vars` in scope, explicit `return`. */
  code: string;
  /** The handle the snippet expects: a project context (the normal case) or
   * the global one (narrowing is the only global move worth showing). */
  context: "global" | "project";
  description: string;
  id: string;
  /** Runtimes the snippet runs unattended in (the e2e matrix honors this). */
  runtimes: ItxExampleRuntime[];
  title: string;
};

const ALL_RUNTIMES: ItxExampleRuntime[] = [...ITX_EXAMPLE_RUNTIMES];

export const ITX_EXAMPLES: ItxExample[] = [
  {
    id: "list-and-describe-project",
    title: "List projects, then narrow and describe one",
    description:
      "The one global-context move: itx.projects.list() shows what you can reach, and itx.projects.get(id) NARROWS to a project context (Law 4 — narrowing is construction). The returned handle is the same shape as a project REPL's itx — every other example starts there.",
    context: "global",
    runtimes: ALL_RUNTIMES,
    code: `
// Every project you have access to (admins see all; users see their own).
const page = await itx.projects.list({ limit: 10 });

// Narrow to one project. The result is a fresh itx handle scoped to it —
// itx.projects.get(id).streams === a project REPL's itx.streams.
const pid =
  (typeof vars === "object" && vars !== null && vars.projectId) ||
  (typeof projectId === "string" && projectId) ||
  page.projects[0]?.id;
if (!pid) throw new Error("Create a project first: await itx.projects.create({ slug: 'demo' })");
const project = await itx.projects.get(pid);

// describe() reports the context, its access, and its registered caps.
return await project.describe();
`.trim(),
  },
  {
    id: "append-and-read-stream",
    title: "Append to a project stream and read it back",
    description:
      "itx.streams is the project's event store. Append an event to a path, then read the path back — the same streams agents, caps, and every other holder of a handle on this project share.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// A stream is addressed by a path within the project. Appending returns the
// stored event (with its assigned offset).
const stream = itx.streams.get("/repl/demo");
const appended = await stream.append({
  type: "events.iterate.repl/demo",
  payload: { note: vars.note ?? "hello from the REPL", at: Date.now() },
});

// Read the whole path back. Streams also carry platform events, so in real
// code you'd filter by type.
const events = await stream.read();
return { appended, count: events.length };
`.trim(),
  },
  {
    id: "provide-plain-object",
    title: "Provide a plain object — it IS the capability",
    description:
      "You pass your object; there is no client library between you and the capability table. A plain object of functions (nested at any depth) is a live capability: dotted calls replay onto its members, back in the provider's process — your browser tab or Node session. Live caps are session-bound: gone when the session disconnects, back when you reconnect and provide again.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
// No wrapper, no base class, no registration ceremony — the object you
// already have is the capability. Its methods run HERE, in your process;
// the project calls back to you over the open session.
const answer = {
  ultimate: () => 42,
  deep: {
    thought: async (question) => ({ answer: 42, question }),
  },
};

await itx.provideCapability({
  name: "answer",
  instructions:
    "The answer to everything: itx.answer.ultimate(), or itx.answer.deep.thought(question).",
  capability: answer,
});

// Unknown names on the handle fall through to the capability table, so the
// cap is callable as if it were built in — at any depth; each call runs
// back here, where the object lives. (A live cap disappears when this
// session disconnects; reconnect and provideCapability() again to restore it.)
return {
  ultimate: await itx.answer.ultimate(),
  deep: await itx.answer.deep.thought("life, the universe, everything"),
};
`.trim(),
  },
  {
    id: "provide-path-call-sdk",
    title: "Provide a live SDK-shaped capability (path-call)",
    description:
      "A path-call capability implements ONE method, call({ path, args }), and receives the whole dotted path as data. This is how 'use itx.slack exactly like @slack/web-api' works — the public SDK docs become the tool docs, with a ~10-line forwarder.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
// One method handles the entire method tree. itx.fakeSlack.chat.postMessage(x)
// arrives here as { path: ["chat","postMessage"], args: [x] } — call({ path,
// args }) IS the calling convention, so a provider that implements it owns
// its whole method-tree semantics.
class FakeSlackSdk extends RpcTarget {
  async call({ path, args }) {
    return { method: path.join("."), args, provider: "live-session" };
  }
}

await itx.provideCapability({
  name: "fakeSlack",
  capability: new FakeSlackSdk(),
});

// Call any depth — the path is accumulated locally and sent once.
return await itx.fakeSlack.chat.postMessage({ channel: "C123", text: "hi" });
`.trim(),
  },
  {
    id: "provide-durable-worker-cap",
    title: "Provide a durable worker capability from source",
    description:
      "A serializable address stores source code as a DURABLE capability (a stateless dynamic worker), loaded on demand. Unlike a live provider stub, it survives this session. Every public method on the WorkerEntrypoint is auto-proxied — add a method, call it instantly.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// The source exports a WorkerEntrypoint. Its env.ITERATE is a project-scoped
// itx, so the cap can use streams/fetch/other caps — but never reach beyond
// its project. The loader caches the built worker by cacheKey, so treat it as
// a content version: keep it stable while the source is unchanged (re-running
// this snippet reuses the loaded worker) and bump it whenever you edit the
// module text.
await itx.provideCapability({
  name: "greeter",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        type: "inline",
        cacheKey: "itx-example-greeter-v1",
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              hello({ name }) { return "hello, " + name; }
              add({ a, b }) { return a + b; }
            }
          \`,
        },
      },
    },
  },
});

// Both methods are callable with zero extra wiring.
return {
  greeting: await itx.greeter.hello({ name: "world" }),
  sum: await itx.greeter.add({ a: 2, b: 3 }),
};
`.trim(),
  },
  {
    id: "repo-sourced-capability",
    title: "Code in your repo as a capability, built per commit",
    description:
      "The project's own git repo is a capability source: commit a module, then provide a { type: 'repo' } address pointing at the file. The platform builds it per COMMIT (memoized), never per call — 'latest' tracks pushes; a pinned sha makes the provided address fully determine behavior. The `worker` default is exactly this pattern.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// (1) Commit a capability module into the project's own repo (the shared
// workspace speaks git; repo.token authenticates the push).
const { project } = await itx.describe();
const repo = await itx.repos.ensureProjectRepoInfo({ projectSlug: project.slug });
const url = new URL(repo.remote);
url.username = "x";
url.password = repo.token.split("?")[0];
const dir = "/repo-cap-demo";
await itx.workspace.gitClone({ branch: repo.defaultBranch, depth: 1, dir, url: url.toString() });
await itx.workspace.writeFile(dir + "/caps/greeter.js", \`
import { WorkerEntrypoint } from "cloudflare:workers";
export class Greeter extends WorkerEntrypoint {
  hello({ name }) { return "hello from the repo, " + name; }
}
\`);
await itx.workspace.gitAdd({ dir, filepath: "caps/greeter.js" });
await itx.workspace.gitCommit({
  author: { email: "examples@iterate.com", name: "itx example" },
  dir,
  message: "add greeter capability",
});
await itx.workspace.gitPush({ dir, ref: repo.defaultBranch, remote: "origin" });

// (2) The address points at the FILE; "latest" tracks pushes. (A fresh
// push can take ~10s to be picked up by the "latest" probe.)
await itx.provideCapability({
  name: "repoGreeter",
  instructions:
    "Greeter built from caps/greeter.js in the project repo: itx.repoGreeter.hello({ name }).",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        type: "repo",
        repo: "project",
        commit: "latest",
        path: "caps/greeter.js",
        entrypoint: "Greeter",
        bundle: {},
      },
    },
  },
});

// (3) Call it like any other capability.
return await itx.repoGreeter.hello({ name: "world" });
`.trim(),
  },
  {
    id: "worker-cap-uses-its-own-itx",
    title: "A worker capability using its own scoped itx",
    description:
      "A durable cap gets env.ITERATE.context — its OWN itx, scoped to the project it lives in. Here a tiny todo tool writes to and reads from a project stream, proving caps compose with the rest of the platform (and can never escape their project).",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
await itx.provideCapability({
  name: "todo",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        type: "inline",
        cacheKey: "itx-example-todo-v1",
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            const STREAM = "/repl/todos";
            const TYPE = "events.iterate.repl/todo";
            export default class extends WorkerEntrypoint {
              async add({ text }) {
                const itx = await this.env.ITERATE.context;     // the cap's own handle
                const e = await itx.streams.get(STREAM).append({ type: TYPE, payload: { text } });
                return { offset: e.offset, text };
              }
              async list() {
                const itx = await this.env.ITERATE.context;
                const events = await itx.streams.get(STREAM).read();
                return events.filter((e) => e.type === TYPE).map((e) => e.payload.text);
              }
            }
          \`,
        },
      },
    },
  },
});

await itx.todo.add({ text: "ship the capability layer" });
await itx.todo.add({ text: "delete the mounts" });
return await itx.todo.list();
`.trim(),
  },
  {
    id: "deep-auto-proxy",
    title: "Auto-proxying: any public method/getter, any depth",
    description:
      "There is no method list anywhere. A members cap exposes a method AND a getter returning a nested RpcTarget; itx proxies the whole surface — itx.kit.echo(...) and itx.kit.math.add(...) — with no declarations.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
await itx.provideCapability({
  name: "kit",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        type: "inline",
        cacheKey: "itx-example-kit-v1",
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
            class Math extends RpcTarget { add({ a, b }) { return a + b; } }
            export default class extends WorkerEntrypoint {
              echo(input) { return { echoed: input }; }
              get math() { return new Math(); }   // nested surface, also proxied
            }
          \`,
        },
      },
    },
  },
});

return {
  echo: await itx.kit.echo({ hi: 1 }),
  // getter -> nested RpcTarget -> method, all proxied with zero wiring:
  sum: await itx.kit.math.add({ a: 2, b: 3 }),
};
`.trim(),
  },
  {
    id: "worker-to-worker",
    title: "One worker capability calling another",
    description:
      "Capabilities compose: a 'report' worker reaches an 'inventory' worker purely through its own env.ITERATE.context (itx.inventory.count(), itx.inventory.skus.priceOf(...)). Worker→worker proxying, no wiring between them.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Provider cap.
await itx.provideCapability({
  name: "inventory",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        type: "inline",
        cacheKey: "itx-example-inventory-v1",
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
            class Skus extends RpcTarget { priceOf({ sku }) { return sku === "ABC" ? 42 : 0; } }
            export default class extends WorkerEntrypoint {
              count() { return 7; }
              get skus() { return new Skus(); }
            }
          \`,
        },
      },
    },
  },
});

// Consumer cap — a different dynamic worker that calls the first via itx.
await itx.provideCapability({
  name: "report",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        type: "inline",
        cacheKey: "itx-example-report-v1",
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              async build({ sku }) {
                const itx = await this.env.ITERATE.context;
                const count = await itx.inventory.count();
                const price = await itx.inventory.skus.priceOf({ sku });
                return { count, price, total: count * price };
              }
            }
          \`,
        },
      },
    },
  },
});

return await itx.report.build({ sku: "ABC" });
`.trim(),
  },
  {
    id: "stateful-facet-cap",
    title: "A stateful capability with its own database (facet)",
    description:
      "exportType: 'durable-object' instantiates a Durable Object as a child of the project — its own private SQLite, zero provisioning. State persists across calls and survives code upgrades. The class MUST be a named export.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
await itx.provideCapability({
  name: "counter",
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        type: "inline",
        cacheKey: "itx-example-counter-v1",
        entrypoint: "Counter",   // named export required for facets
        exportType: "durable-object",
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { DurableObject } from "cloudflare:workers";
            export class Counter extends DurableObject {
              async increment() {
                const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
                await this.ctx.storage.put("n", n);   // this.ctx.storage is YOURS alone
                return n;
              }
              async current() { return (await this.ctx.storage.get("n")) ?? 0; }
            }
          \`,
        },
      },
    },
  },
});

await itx.counter.increment();
await itx.counter.increment();
return { current: await itx.counter.current() };   // 2, and it persists
`.trim(),
  },
  {
    id: "extend-child-context",
    title: "Extend the context with its own caps",
    description:
      "itx.extend() makes a cheap, disposable child context under the project — an agent session or scratchpad. Its caps SHADOW the parent's; names it doesn't provide delegate up the chain. describe() shows the merged view: own entries plain, inherited ones labeled from: <context>.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
// A cap on the project — visible to every child through the chain. A plain
// object is all a live capability takes.
await itx.provideCapability({
  name: "shared",
  capability: { whoami: () => "project" },
});

// Extend a child. It's a full itx handle on a new itx_… context.
const child = await itx.extend({ name: "repl-scratch" });

// The child can shadow 'shared' with its own object...
await child.provideCapability({
  name: "shared",
  capability: { whoami: () => "child" },
});

// ...so the child sees its own, while the project still sees its own.
// In the merged describe(), the child's entries carry no provenance field;
// inherited ones say from: <context> ("defaults" for the defaults).
return {
  fromChild: await child.shared.whoami(),
  capabilities: (await child.describe()).capabilities, // merged chain, child entries first
};
`.trim(),
  },
  {
    id: "fetch-middleware",
    title: "Middleware: shadow fetch, delegate via itx.super",
    description:
      "The middleware story in five lines: shadow `fetch` on an extended child with a plain function that stamps a header, then delegates to the parent chain's unshadowed pipe via itx.super.fetch. Bare fetch() inside the child's isolates flows through the same shadow; the parent is untouched.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const session = await itx.extend({ name: "traced" });

// The shadow is a PLAIN FUNCTION; itx.super is "call next()" — the parent
// chain, where fetch is still the real egress pipe.
await session.provideCapability({
  name: "fetch",
  instructions: "Project egress with an x-trace-id header stamped on every request.",
  capability: async (request) => {
    const traced = new Request(request.url ?? String(request), request);
    traced.headers.set("x-trace-id", "itx-example-trace");
    return await session.super.fetch(traced);
  },
});

// Every egress on the session now carries the header. Revoke the shadow
// and the real pipe resurfaces — middleware is just shadowing plus super.
const echoed = await (await session.fetch("https://postman-echo.com/get")).json();
return { traceHeaderSeen: echoed.headers["x-trace-id"] };
`.trim(),
  },
  {
    id: "journal-is-the-record",
    title: "The stream IS the record: provide, revoke, read it back",
    description:
      "A context IS a stream coordinate — the project context lives on the project's root stream. provideCapability and revokeCapability are appends; read the stream back and watch the record happen. There is no hidden registry to drift from it.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Use a unique name so the record slice below is unambiguous.
const name = vars.capName ?? "ephemeral";

await itx.provideCapability({
  name,
  capability: { type: "rpc", worker: { type: "binding", binding: "AI" } },
});
await itx.revokeCapability({ name });

// The context's stream is an ordinary stream — same read API as anything.
const events = await itx.streams.get("/").read();
const record = events
  .filter((e) => Array.isArray(e.payload?.path) && e.payload.path.join(".") === name)
  .map((e) => e.type.split("/").pop());
return { record }; // ["capability-provided", "capability-revoked"]
`.trim(),
  },
  {
    id: "mcp-client",
    title: "Connect a public MCP server",
    description:
      "Any remote MCP server (streamable HTTP) becomes a capability via the first-party McpClient: listTools() discovers the surface, and every tool is a dotted call. Cloudflare's docs server is public — no credentials needed. All transport HTTP rides the project egress pipe.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
await itx.provideCapability({
  name: "cfdocs",
  instructions: "Cloudflare's documentation MCP server. Call listTools() first.",
  capability: {
    type: "rpc",
    worker: { type: "loopback" },
    entrypoint: "McpClient",
    props: { serverUrl: "https://docs.mcp.cloudflare.com/mcp" },
  },
});

// Tools are dotted calls; listTools() is the discovery door.
const { tools } = await itx.cfdocs.listTools();
const answer = await itx.cfdocs.search_cloudflare_documentation({
  query: "durable objects",
});
return { tools: tools.map((tool) => tool.name), snippet: String(answer).slice(0, 200) };
`.trim(),
  },
  {
    id: "mcp-authenticated",
    title: "An authenticated MCP server via a project secret",
    description:
      "Connect a remote MCP server that needs an Authorization header — without the credential ever leaving the platform. The token lives as a PROJECT SECRET; the capability address carries only a getSecret(...) placeholder; substitution happens server-side on the egress path. This session, describe(), and the record never see the material.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Store the credential ONCE as a project secret (Settings → Secrets), e.g.
// key "CLOUDFLARE_API_TOKEN". From here on, only the key travels.
await itx.provideCapability({
  path: ["mcp", "cloudflare"],
  instructions: "Cloudflare's MCP server, authenticated via a project secret.",
  capability: {
    type: "rpc",
    worker: { type: "loopback" },
    entrypoint: "McpClient",
    props: {
      serverUrl: "https://bindings.mcp.cloudflare.com/mcp",
      headers: { authorization: 'Bearer getSecret({ key: "CLOUDFLARE_API_TOKEN" })' },
    },
  },
});

// Every MCP request rides the project egress pipe, where the placeholder
// becomes the real token — the connected agent/isolate never sees it.
const { tools } = await itx.mcp.cloudflare.listTools();
return tools.map((tool) => tool.name);
`.trim(),
  },
  {
    id: "openapi-client",
    title: "Any OpenAPI API as an ergonomic capability",
    description:
      "Point OpenApiClient at an OpenAPI 3.x spec and every operation becomes a dotted call: itx.petstore.findPetsByStatus({ status }). One input object merges path params, query params, and body. The provider self-describes at provide time — describe() carries TypeScript declarations derived from the spec, with zero callsite ceremony. Auth headers take getSecret(...) placeholders, substituted on egress like everything else.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
await itx.provideCapability({
  name: "petstore",
  capability: {
    type: "rpc",
    worker: { type: "loopback" },
    entrypoint: "OpenApiClient",
    props: {
      specUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
      // For authenticated APIs, add headers with a secret placeholder:
      // headers: { authorization: 'Bearer getSecret({ key: "API_TOKEN" })' },
    },
  },
});

// Flat operationIds, one merged input object, through project egress.
const pets = await itx.petstore.findPetsByStatus({ status: "available" });

// listOperations() enumerates the surface the spec describes.
const operations = await itx.petstore.listOperations();
return { count: pets.length, operations: operations.slice(0, 3) };
`.trim(),
  },
  {
    id: "egress-with-secret-substitution",
    title: "Egress with server-side secret substitution",
    description:
      "itx.fetch() routes outbound HTTP through the project's egress path. A getSecret(...) placeholder in a header is replaced with the real secret INSIDE the worker — the secret never reaches the browser. Every project ships with an example secret.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// The placeholder is substituted server-side; this tab never sees the value.
const response = await itx.fetch("https://postman-echo.com/get", {
  headers: {
    authorization: 'Bearer getSecret({ key: "example/egress-api-key" })',
  },
});
const body = await response.json();
return { status: response.status, sawSubstitutedHeader: body.headers };
`.trim(),
  },
  {
    id: "secrets-and-egress",
    title: "Store a secret, then fetch with it",
    description:
      "The full credential lifecycle in one script: itx.secrets.set() journals material in the project's Secret store, and from then on a getSecret(...) placeholder in any egress header becomes the real value server-side — the script itself never round-trips the material again. This is how authenticated MCP/OpenAPI capability addresses stay credential-free.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// (1) Journal the credential once. describe() returns material-free state.
await itx.secrets.set({ slug: "demo/api-key", material: "demo-" + crypto.randomUUID() });

// (2) Use it by SLUG: the placeholder substitutes inside the egress pipe.
const response = await itx.fetch("https://postman-echo.com/get", {
  headers: { "x-api-key": 'getSecret({ key: "demo/api-key" })' },
});
const echoed = await response.json();

// (3) The echo saw the real material; this script only ever saw the slug.
return { status: response.status, echoedKeyHeader: echoed.headers["x-api-key"] };
`.trim(),
  },
  {
    id: "http-cap",
    title: "Serve a capability over HTTP",
    description:
      "A cap whose fetch() is exposed (meta.http.expose) gets its own hostname: {cap}--{project}.<base>. Exposed means public — anyone can open the URL; unexposed caps don't exist as hostnames.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
await itx.provideCapability({
  name: "hello",
  meta: { http: { expose: true } },   // routable at its own hostname, public
  capability: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        type: "inline",
        cacheKey: "itx-example-hello-http-v1",
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              async fetch(request) {
                const url = new URL(request.url);
                return new Response("hello from a routable cap at " + url.pathname);
              }
            }
          \`,
        },
      },
    },
  },
});

// The cap's own hostname: {cap}-- prefixed onto the project's ingress host.
const url = new URL(await itx.project.ingressUrl());
url.hostname = "hello--" + url.hostname;
url.pathname = "/demo";
return { url: url.toString() };
`.trim(),
  },
  {
    id: "import-npm-via-esm-sh",
    title: "Import an npm package (via esm.sh)",
    description:
      "Top-level import statements work in the REPL: bare specifiers are rewritten to dynamic imports from https://esm.sh, so any npm package loads straight into this browser session. (Server-side runtimes don't rewrite imports — this trick is REPL-only.)",
    context: "project",
    runtimes: ["browser"],
    code: `
import { z } from "zod";

// Validate live platform data with a real npm package, loaded on the fly.
const Description = z.object({
  context: z.string(),
  project: z.object({ id: z.string(), slug: z.string() }).nullable(),
});

return Description.parse(await itx.describe());
`.trim(),
  },
];
