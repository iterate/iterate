// The itx example catalogue: one data structure that is BOTH the "Examples"
// panel in the REPL UI and the script set the e2e suite runs across every
// execution runtime (apps/os/src/itx/e2e/*). Each entry is a self-contained
// script body that runs with `itx` and `vars` in scope and uses an explicit
// `return` — exactly the shape every runtime accepts:
//
//   browser         the REPL (compileBrowserReplFunction wraps the body)
//   node            AsyncFunction("itx", "vars", code) on a Cap'n Web stub
//   run-script      itx.runScript(`async (itx) => { const vars = …; <body> }`)
//                   — the server-side script isolate agents use
//   project-worker  the body baked into the project repo's worker.js,
//                   executed against `await this.env.ITX.get()`
//
// Almost every example is written against a PROJECT itx (context: "project"):
// the harness — a project REPL, connectItx({ projectId }), runScript, or a
// dynamic worker's env.ITX — is already scoped into the project, and the
// script gets straight to work: itx.streams.get("/some/path").append(...).
// Global-context examples run against the Session catalog (the global/admin
// REPL) instead — that handle vends projects; it is not itself an itx.
//
// `runtimes` records where a snippet genuinely works unattended. Live
// capabilities (provideCapability with a `capability` value) are session-bound
// — the provider object lives in the calling process — so those entries stay
// browser/node/cli only. Everything else must stay runtime-agnostic: no
// pipelining tricks, plain serializable return values.

export const ITX_EXAMPLE_RUNTIMES = [
  "browser",
  "node",
  "cli",
  "run-script",
  "project-worker",
] as const;

export type ItxExampleRuntime = (typeof ITX_EXAMPLE_RUNTIMES)[number];

export type ItxExample = {
  /** Script body: `itx` and `vars` in scope, explicit `return`. */
  code: string;
  /** The handle the snippet expects: a project itx (the normal case) or the
   * global Session catalog (whoami / projects.list only). */
  context: "global" | "project";
  description: string;
  id: string;
  /** Runtimes the snippet runs unattended in (the e2e matrix honors this). */
  runtimes: ItxExampleRuntime[];
  title: string;
};

const ALL_RUNTIMES: ItxExampleRuntime[] = [...ITX_EXAMPLE_RUNTIMES];

/** Live providers must outlive the calls, so these stay in caller-owned sessions. */
const LIVE_SESSION_RUNTIMES: ItxExampleRuntime[] = ["browser", "node", "cli"];

export const ITX_EXAMPLES: ItxExample[] = [
  {
    id: "whoami",
    title: "Who am I? (global session)",
    description:
      "The global REPL holds a Session — the catalog authenticate() returned. whoami() reports the principal the socket carries; everything else you do is scoped by it.",
    context: "global",
    runtimes: ["browser", "node", "cli"],
    code: `
return await itx.whoami();
`.trim(),
  },
  {
    id: "list-projects",
    title: "List projects, then open one",
    description:
      "A Session vends itxs: projects.list() shows the project ids you can reach, and projects.get(id) returns the project-scoped itx — the same handle a project REPL holds. Every project-context example starts there.",
    context: "global",
    runtimes: ["browser", "node", "cli"],
    code: `
// Every project id you have access to (admins see all; users see their own).
const projectIds = await itx.projects.list();

// Open one. The result is an itx scoped to that project — the same shape a
// project REPL's \`itx\` has (streams, repo, workers, runScript, ...).
const pid = vars.projectId ?? projectIds[0];
if (!pid) throw new Error("Create a project first: await itx.projects.create({ slug: 'demo' })");
const project = await itx.projects.get(pid);

// describe() reports the project and its capability table.
return await project.describe();
`.trim(),
  },
  {
    id: "describe-project",
    title: "Describe the project's capability table",
    description:
      "describe() is the project's self-report: its id, name, and every capability reachable at this scope — built-ins (streams, repo, workers, ai, ...) plus anything mounted with provideCapability. Agents read this to learn what they can call.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const description = await itx.describe();

// Built-ins are always there; dynamic mounts carry type "live" or
// "itx-expression" plus the offset of the event that mounted them.
return {
  builtins: description.capabilities
    .filter((capability) => capability.type === "builtin")
    .map((capability) => capability.path.join(".")),
  projectId: description.projectId,
};
`.trim(),
  },
  {
    id: "append-and-read-stream",
    title: "Append to a project stream and read it back",
    description:
      "itx.streams is the project's durable event store. Append an event to a path, then read the path back — the same streams that agents, processors, and every other holder of this project's itx share.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// A stream is addressed by a path within the project. append() commits the
// events and returns them with their assigned offsets.
const stream = itx.streams.get(vars.path ?? "/repl/demo");
const [appended] = await stream.append({
  type: "events.iterate.repl/demo",
  payload: { note: vars.note ?? "hello from the REPL" },
});

// Read the whole path back. Streams also carry platform lifecycle events
// (stream/created, stream/woken, ...), so real code filters by type.
const events = await stream.getEvents();
return { appended, count: events.length };
`.trim(),
  },
  {
    id: "run-script",
    title: "Run a script server-side with itx.runScript",
    description:
      "runScript ships an `async (itx) => { … }` source string into the project's script isolate — the exact mechanism agent codemode uses. The execution leaves a two-event record (script-execution-requested/-completed) on the scope's stream.",
    context: "project",
    // Not "run-script": that runtime already wraps the body in runScript, and
    // a script starting another script execution mid-flight is recursion the
    // matrix should not depend on.
    runtimes: ["browser", "node", "cli", "project-worker"],
    code: `
const execution = await itx.runScript(\`async (itx) => {
  const description = await itx.describe();
  return { projectId: description.projectId, sum: 6 * 7 };
}\`);

// runScript returns the result plus the completed journal event.
return {
  completedEventType: execution.completedEvent.type,
  result: execution.result,
};
`.trim(),
  },
  {
    id: "provide-live-capability",
    title: "Provide a live capability — your object IS the capability",
    description:
      "provideCapability({ type: 'live', … }) mounts a plain object of functions (nested at any depth) on the project. Dotted calls replay onto its members, back in the provider's process — your browser tab or Node session. The returned provision owns the mount: provision.revoke() removes it. Live caps are session-bound: gone when this session disconnects.",
    context: "project",
    runtimes: LIVE_SESSION_RUNTIMES,
    code: `
// No wrapper, no registration ceremony — the object you already have is the
// capability. Its methods run HERE, in your process; the project calls back
// to you over the open session.
const provision = await itx.provideCapability({
  path: ["answer"],
  type: "live",
  instructions:
    "The answer to everything: itx.answer.ultimate(), or itx.answer.deep.thought(question).",
  capability: {
    ultimate: () => 42,
    deep: {
      thought: async (question) => ({ answer: 42, question }),
    },
  },
});

// Mounted names resolve on the same handle, at any depth.
const ultimate = await itx.answer.ultimate();
const deep = await itx.answer.deep.thought("life, the universe, everything");

// The provision is the ownership handle: revoke removes exactly this mount.
await provision.revoke();
const revoked = await itx.answer.ultimate().then(
  () => false,
  () => true,
);

return { deep, revoked, ultimate };
`.trim(),
  },
  {
    id: "provide-live-flattened",
    title: "Provide an SDK-shaped capability (flattened paths)",
    description:
      "flattenNestedPaths: true delivers the whole dotted path as data to ONE method, invokeCapability({ path, args }). This is how 'use itx.fakeSlack exactly like the Slack SDK' works — the public SDK docs become the tool docs, with a tiny forwarder.",
    context: "project",
    runtimes: LIVE_SESSION_RUNTIMES,
    code: `
// One method handles the entire method tree. itx.fakeSlack.chat.postMessage(x)
// arrives here as { path: ["chat","postMessage"], args: [x] } — the provider
// owns its whole method-tree semantics.
await itx.provideCapability({
  path: ["fakeSlack"],
  type: "live",
  flattenNestedPaths: true,
  capability: {
    invokeCapability({ args, path }) {
      return { args, method: path.join("."), provider: "live-session" };
    },
  },
});

// Call any depth — the path travels with the call.
return await itx.fakeSlack.chat.postMessage({ channel: "C123", text: "hi" });
`.trim(),
  },
  {
    id: "provide-itx-expression",
    title: "Provide a durable capability as an itx expression",
    description:
      "An itx-expression capability is a serializable recipe over the project's own surface — here an alias to a stream: ['streams', ['get', path]]. Unlike a live mount it survives this session; the engine evaluates the expression on demand. The same shape mounts dynamic workers (['workers', ['get', ref]]), MCP servers (['mcp', ['connect', { url }]]), and OpenAPI clients.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Mount itx.demoStream as an alias for a project stream. The recipe is data —
// it is recorded on the project's stream and needs no live provider.
await itx.provideCapability({
  expression: ["streams", ["get", vars.path ?? "/repl/expression-demo"]],
  instructions: "A demo stream alias: itx.demoStream.append({ type, payload }).",
  path: ["demoStream"],
  type: "itx-expression",
});

// The alias IS the stream capability.
const [event] = await itx.demoStream.append({
  type: "events.iterate.repl/expression-demo",
  payload: { note: vars.note ?? "hello through an expression" },
});
const described = await itx.describe();
const mount = described.capabilities.find(
  (capability) => capability.path.join(".") === "demoStream",
);
return { mountType: mount?.type, note: event.payload.note, offset: event.offset };
`.trim(),
  },
  {
    id: "dynamic-worker-stateless",
    title: "Load a stateless dynamic worker from inline source",
    description:
      "itx.workers.get() turns a declarative ref — module text plus an entrypoint — into a live RPC stub. Every public method on the WorkerEntrypoint is callable with zero extra wiring, and the worker's env.ITX is scoped to this project.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Await the ref before calling: script isolates reach itx over Workers RPC,
// which does not pipeline calls through an unresolved return value.
const greeter = await itx.workers.get({
  type: "stateless",
  entrypoint: "Greeter",
  path: "/",
  source: {
    type: "inline",
    mainModule: "greeter.js",
    modules: {
      "greeter.js": \`
        import { WorkerEntrypoint } from "cloudflare:workers";

        export class Greeter extends WorkerEntrypoint {
          hello({ name }) {
            return "hello, " + name;
          }

          add(a, b) {
            return a + b;
          }
        }
      \`,
    },
  },
});

return {
  greeting: await greeter.hello({ name: "world" }),
  sum: await greeter.add(2, 3),
};
`.trim(),
  },
  {
    id: "dynamic-worker-stateful",
    title: "A stateful dynamic worker with its own storage",
    description:
      "A stateful ref names a Durable Object class; durableWorkerKey is its durable identity under { project, path } — same key, same storage, across sessions and code changes. Its private storage needs zero provisioning.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const counter = await itx.workers.get({
  type: "stateful",
  className: "CounterDurableObject",
  // The durable identity: reuse the key to come back to the same state.
  durableWorkerKey: vars.counterKey ?? "repl-counter",
  path: "/",
  source: {
    type: "inline",
    mainModule: "counter.js",
    modules: {
      "counter.js": \`
        import { DurableObject } from "cloudflare:workers";

        export class CounterDurableObject extends DurableObject {
          async increment() {
            const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
            this.ctx.storage.kv.put("n", n);
            return n;
          }

          async current() {
            return this.ctx.storage.kv.get("n") ?? 0;
          }
        }
      \`,
    },
  },
});

await counter.increment();
await counter.increment();
return { current: await counter.current() }; // 2, and it persists under the key
`.trim(),
  },
  {
    id: "repo-commit-files",
    title: "Commit files into the project repo",
    description:
      "Every project has a git-backed repo (itx.repo is the one at path '/'). commitFiles writes a batch of changes as one commit — this is how agents keep durable notes, and how the project worker at worker.js gets updated (repo-sourced workers are late-bound: the next call sees the new commit).",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const commit = await itx.repo.commitFiles({
  message: "Add a note from the examples catalogue",
  changes: [
    {
      path: "notes/example.md",
      content: "# Example note\\n\\n" + (vars.note ?? "hello from the catalogue") + "\\n",
    },
  ],
});

// noChanges is true when the tree already matched — commits are idempotent.
return {
  branch: commit.branch,
  changedPaths: commit.changedPaths,
  noChanges: commit.noChanges,
};
`.trim(),
  },
  {
    id: "secrets-lifecycle",
    title: "Store a secret; describe() never shows the material",
    description:
      "Secrets are path-addressed write-only capabilities: update() stores material plus the egress URLs it may be substituted into, and describe() reports metadata only (hasMaterial, egress allowlist, usage audit). Egress requests carry getSecret({ path }) placeholders; substitution happens server-side.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const secret = itx.secrets.get(vars.secretPath ?? "/secrets/example");

// Store the material once, with the URLs it may be substituted into. From
// here on, egress headers reference it as: getSecret({ path: "..." }).
await secret.update({
  egress: { urls: ["https://postman-echo.com/"] },
  material: "demo-" + (vars.note ?? "material"),
});

// The secret processor folds the update asynchronously — poll describe().
let described = await secret.describe();
for (let attempt = 0; attempt < 50 && !described.hasMaterial; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  described = await secret.describe();
}

// Metadata only: hasMaterial, the egress allowlist, and the usage audit.
// The material itself has no read API.
return described;
`.trim(),
  },
  {
    id: "journal-is-the-record",
    title: "The stream IS the record: provide, revoke, read it back",
    description:
      "provideCapability and revokeCapability are appends to the scope's stream (the project root, '/'). Read the stream back and watch the record happen — there is no hidden registry to drift from it.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Use a unique mount path so the record slice below is unambiguous.
const capPath = vars.capPath ?? "journalDemo";

const provision = await itx.provideCapability({
  expression: ["streams", ["get", "/repl/journal-demo"]],
  path: [capPath],
  type: "itx-expression",
});
await provision.revoke();

// The scope's stream is an ordinary stream — same getEvents API as anything.
const events = await itx.streams.get("/").getEvents();
const record = events
  .filter((event) => Array.isArray(event.payload?.path) && event.payload.path.join(".") === capPath)
  .map((event) => event.type.split("/").pop());
return { record }; // ["capability-provided", "capability-revoked"]
`.trim(),
  },
  {
    id: "agent-send-message",
    title: "Send a message to an agent",
    description:
      "Agents live at /agents/<name> and are addressed through itx.agents.get(path). sendMessage appends the user-message event to the agent's stream and returns it; the agent's processors take it from there (use agent.ask({ message }) to wait for the reply when an LLM provider is configured).",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const agent = await itx.agents.get(vars.agentPath ?? "/agents/repl-demo");

// The returned value is the committed stream event — the durable record the
// agent loop reduces into its history.
const sent = await agent.sendMessage(vars.message ?? "Hello from the examples catalogue");
return { offset: sent.offset, payload: sent.payload, type: sent.type };
`.trim(),
  },
  {
    id: "ai-models",
    title: "Workers AI is a built-in capability",
    description:
      "itx.ai proxies the platform's Workers AI binding: models() lists the catalog, run(model, body) executes one. Model availability and latency depend on the deployment's upstream account, so this entry is reading material for the matrix — run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const models = await itx.ai.models();
const list = Array.isArray(models) ? models : [];
return {
  count: list.length,
  sample: list.slice(0, 5).map((model) => model?.name ?? model),
};
`.trim(),
  },
];
