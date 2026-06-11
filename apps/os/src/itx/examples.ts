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
//   config-worker   the body baked into a project's iterate-config worker.js,
//                   executed against env.ITERATE.context
//
// Almost every example is written against a PROJECT-scoped handle (context:
// "project"): the harness — a project REPL, connectItx({ context }), a
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
    id: "provide-live-capability",
    title: "Provide a live, browser-owned capability",
    description:
      "Registers a browser-owned object as a LIVE capability on the project (session-bound — it lives only while this REPL tab is connected), then calls it straight back through the itx fallthrough as itx.answer.run().",
    context: "project",
    runtimes: ["browser"],
    code: `
// A live capability is just an object you own. Its methods run HERE, in
// the browser tab — the project calls back to you over the open session.
const answer = {
  async run() {
    alert("The answer is 42");
    return "alerted";
  },
};

// provideCapability() is THE verb: a live stub is just another capability.
// asPathCallable() makes a plain object-of-methods speak the one calling
// convention (call({ path, args }) replayed back here on your object). A
// live cap disappears when this tab disconnects; reconnect and
// provideCapability() again to restore it.
await itx.provideCapability({ name: "answer", capability: asPathCallable(answer) });

// Unknown names on the handle fall through to the capability table, so the cap is
// callable as if it were built in.
return await itx.answer.run();
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
    title: "Extend the context (a session) with its own caps",
    description:
      "itx.extend() makes a cheap, disposable child context under the project — an agent session or scratchpad. Its caps SHADOW the parent's; names it doesn't provide delegate up the chain. describe() shows the merged view with provenance.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
// A cap on the project — visible to every child through the chain.
await itx.provideCapability({
  name: "shared",
  capability: new (class extends RpcTarget {
    async call({ path }) { return { from: "project", method: path.join(".") }; }
  })(),
});

// Extend a child. It's a full itx handle on a new itx_… context.
const child = await itx.extend({ name: "repl-scratch" });

// The child can shadow 'shared' with its own definition...
await child.provideCapability({
  name: "shared",
  capability: new (class extends RpcTarget {
    async call({ path }) { return { from: "child", method: path.join(".") }; }
  })(),
});

// ...so the child sees its own, while the project still sees its own.
return {
  fromChild: await child.shared.ping(),
  capabilities: (await child.describe()).capabilities, // merged chain, child entries first
};
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
    authorization: 'Bearer getSecret({ key: "example.egress_api_key" })',
  },
});
const body = await response.json();
return { status: response.status, sawSubstitutedHeader: body.headers };
`.trim(),
  },
  {
    id: "http-cap-and-share-url",
    title: "Serve a capability over HTTP + a shareable link",
    description:
      "A cap whose fetch() is exposed (meta.http.expose) gets its own hostname: {cap}--{project}.<base>. Routable ≠ public — it's admin-gated by default. itx.shareUrl() mints a signed, expiring link: 'let me show you something real quick.'",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
await itx.provideCapability({
  name: "hello",
  meta: { http: { expose: true } },   // routable; still admin-gated
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

// A signed link anyone can open for the next hour (no further auth needed).
return { shareUrl: await itx.shareUrl({ name: "hello", path: "/demo", ttlSeconds: 3600 }) };
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
