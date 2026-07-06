// The itx example catalogue: one data structure that is BOTH the "Examples"
// panel in the REPL UI and the script set the e2e suite runs across every
// execution runtime (apps/os/e2e/examples/*). Each entry is a self-contained
// script body that runs with `itx` and `vars` in scope and uses an explicit
// `return` — exactly the shape every runtime accepts:
//
//   browser         the REPL (compileBrowserReplFunction wraps the body)
//   node            AsyncFunction("itx", "vars", code) on a Cap'n Web stub
//   run-script      itx.capabilityHost.runScript(`async (itx) => { const vars = …; <body> }`)
//                   — the server-side script isolate agents use
//   project-worker  the body baked into the project repo's worker.ts,
//                   executed against `await this.env.ITX.get()`
//
// Almost every example is written against a PROJECT itx (context: "project"):
// the harness — a project REPL, connectItxBrowser({ projectId }), runScript, or a
// dynamic worker's env.ITX — is already scoped into the project, and the
// script gets straight to work: itx.streams.get("/some/path").append(...).
// Session-context examples run against the OS Session (what authenticate()
// returns) instead — a session vends project itxs; it is not itself an itx.
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
   * OS Session — what authenticate() returns, not an itx (__describe /
   * projects.list only). */
  context: "project" | "session";
  description: string;
  id: string;
  /** Runtimes the snippet runs unattended in (the e2e matrix honors this). */
  runtimes: ItxExampleRuntime[];
  title: string;
};

/** One example without its code — what `itx.examples.list()` returns. */
export type ItxExampleSummary = {
  description: string;
  id: string;
  title: string;
};

/** One example with its full script body — what `itx.examples.get({ id })` returns. */
export type ItxExampleWithCode = ItxExampleSummary & { code: string };

const ALL_RUNTIMES: ItxExampleRuntime[] = [...ITX_EXAMPLE_RUNTIMES];

/** Live providers must outlive the calls, so these stay in caller-owned sessions. */
const LIVE_SESSION_RUNTIMES: ItxExampleRuntime[] = ["browser", "node", "cli"];

export const ITX_EXAMPLES: ItxExample[] = [
  {
    id: "whoami",
    title: "Who am I? (OS session)",
    description:
      "The top-level REPL holds the OS Session — the catalog authenticate() returned; it is not an itx. __describe() works on every node; on a Session its `principal` is who the socket carries.",
    context: "session",
    runtimes: ["browser", "node", "cli"],
    code: `
const description = await itx.__describe();
return description.principal;
`.trim(),
  },
  {
    id: "list-projects",
    title: "List projects, then open one",
    description:
      "A Session vends itxs: projects.list() shows the projects you can reach (id, slug, org, deployment status), and projects.get(id) returns the project-scoped itx — the same handle a project REPL holds. Every project-context example starts there.",
    context: "session",
    runtimes: ["browser", "node", "cli"],
    code: `
// Every project you have access to (admins see all; users see their own):
// { id, slug, organizationId, organizationName, deploymentStatus }.
const projects = await itx.projects.list();

// Open one. The result is an itx scoped to that project — the same shape a
// project REPL's \`itx\` has (streams, repo, workers, runScript, ...).
const pid = vars.projectId ?? projects[0]?.id;
if (!pid) throw new Error("Create a project first: await itx.projects.create({ slug: 'demo' })");
const project = await itx.projects.get(pid);

// describe() reports the project and its capability table.
return await project.__describe();
`.trim(),
  },
  {
    id: "describe-project",
    title: "Describe the project (its __describe)",
    description:
      "__describe() works on EVERY node and is the project's self-report: its id, name, a one-line blip per child member (`children`), and every capability reachable at this scope — built-ins plus anything mounted via a capability host. Agents read this to learn what they can call.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const description = await itx.__describe();

// Built-ins are always there; dynamic mounts carry type "live" or
// "itx-expression" plus the offset of the event that mounted them.
return {
  builtins: description.capabilities
    .filter((capability) => capability.type === "builtin")
    .map((capability) => capability.path.join(".")),
  children: Object.keys(description.children),
  projectId: description.projectId,
};
`.trim(),
  },
  {
    id: "discover-tree",
    title: "Discover the capability tree by walking __describe()",
    description:
      "The canonical discovery walk: every node answers __describe() with { instructions, types, children, parent }, so a map of the whole surface is 'read children, recurse into the ones you care about'. Mounted capabilities answer from their durable provide-time metadata — the walk never dials a live target.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// High-level map: one __describe gives the blips for every child.
const root = await itx.__describe();

// Deep discovery: recurse into the children you care about.
const [host, integrations] = await Promise.all([
  itx.capabilityHost.__describe(),
  itx.integrations.__describe(),
]);

return {
  rootChildren: root.children,
  scope: host.path,
  mounts: host.capabilities
    .filter((capability) => capability.type !== "builtin")
    .map((capability) => ({
      path: capability.path.join("."),
      scope: capability.scope,
      blip: capability.instructions ?? null,
    })),
  integrationsChildren: integrations.children,
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
const execution = await itx.capabilityHost.runScript(\`async (itx) => {
  const description = await itx.__describe();
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
      "An itx-expression capability is a serializable recipe over the project's own surface — here an alias to a stream: ['streams', ['get', path]]. Unlike a live mount it survives this session; itx evaluates the expression on demand. The same shape mounts dynamic workers (['workers', ['get', ref]]), MCP servers (['mcp', ['connect', { url }]]), and OpenAPI clients.",
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
const described = await itx.__describe();
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
    files: {
      type: "inline",
      files: {
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
    // Plain JavaScript with bundling off loads directly; TypeScript or
    // multi-file sources drop bundle: false and go through the build pipeline.
    options: { bundle: false, entryPoint: "greeter.js" },
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
    files: {
      type: "inline",
      files: {
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
    options: { bundle: false, entryPoint: "counter.js" },
  },
});

await counter.increment();
await counter.increment();
return { current: await counter.current() }; // 2, and it persists under the key
`.trim(),
  },
  {
    id: "sandbox-exec",
    title: "Run shell commands in a sandbox (project repo included)",
    description:
      'A sandbox is a real Linux container addressed by path — any non-root path, nested fine. In an agent scope `itx.sandbox` is YOUR sandbox (a capability mounted at birth, backed by the sandbox at your own agent path) — call it dotted: `await itx.sandbox.exec(...)`. itx.sandboxes.get(path) addresses any other (standalone ones conventionally under /sandboxes/cloudflare/<anything>). Either way you get the bare Cloudflare Sandbox SDK surface: exec, readFile/writeFile, startProcess, gitCheckout, exposePort, destroy, … The first command boots the container (can take a minute cold) and it sleeps after idle. The project repo is ALWAYS checked out at /workspace/repos/project (with working git credentials), which is also the default working directory — a bare exec("ls") lists the project; no ensureProjectRepo() call needed first.',
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// The path IS the identity: same path, same sandbox (and its filesystem)
// until you destroy() it. Different paths are different containers.
const sandbox = await itx.sandboxes.get(vars.sandboxPath ?? "/sandboxes/cloudflare/example");

// exec runs a shell command; the first one boots the container.
const uname = await sandbox.exec("uname -s");

// The project repo is ALWAYS checked out at /workspace/repos/project, which is
// also the default working directory — so a bare "ls" lists the project. Every
// command awaits provisioning internally; no ensureProjectRepo() call needed.
const repo = await sandbox.exec("ls");

return {
  os: uname.stdout.trim(), // "Linux"
  repoFiles: repo.stdout.trim().split("\\n"),
  exitCode: repo.exitCode,
};
`.trim(),
  },
  {
    id: "repo-commit-files",
    title: "Commit files into the project repo",
    description:
      "Every project has a git-backed repo (itx.repo is the one at path '/'). commitFiles writes a batch of changes as one commit — this is how agents keep durable notes, and how the project worker at worker.ts gets updated (repo-sourced workers are late-bound: the next call sees the new commit).",
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
    id: "repo-read-file",
    title: "Read a file from the project repo",
    description:
      "Read committed file contents from the project repo. readFile returns the HEAD commit oid, normalized path, and content, or null when the file does not exist.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const path = vars.path ?? "README.md";
const repo = itx.repos.get(vars.repoPath ?? "/");
const file = await repo.readFile({ path });

if (file === null) {
  return { exists: false, path };
}

return {
  exists: true,
  commitOid: file.commitOid,
  path: file.path,
  preview: file.content.slice(0, 120),
};
`.trim(),
  },
  {
    id: "repo-edit-file",
    title: "Read then edit a project repo file",
    description:
      "Use readFile to inspect the current content, then edit to replace an exact string and commit the change. edit is safe for coding-agent workflows: oldString must match exactly once unless replaceAll is true.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const path = vars.path ?? "notes/edit-example.md";
const repo = itx.repos.get(vars.repoPath ?? "/");
const beforeText = "status: draft\\n";
const afterText = "status: reviewed\\n";

// Path-scoped repos need first-use creation; the default project repo already exists.
if (vars.repoPath) await repo.create();

// Seed a known starting point. Agents can skip this when editing an existing file.
await repo.commitFiles({
  message: "Seed edit example",
  changes: [{ path, content: "# Edit example\\n\\n" + beforeText }],
});

const before = await repo.readFile({ path });
if (before === null) throw new Error("Expected seeded file to exist.");

const edit = await repo.edit({
  path,
  message: "Mark edit example reviewed",
  oldString: beforeText,
  newString: afterText,
});

const after = await repo.readFile({ path });
if (after === null) throw new Error("Expected edited file to exist.");

return {
  before: before.content,
  after: after.content,
  changedPaths: edit.changedPaths,
  occurrenceCount: edit.occurrenceCount,
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
    id: "secret-postman-echo",
    title: "Use a stored secret in a Postman Echo request",
    description:
      "Stores a secret with Postman Echo on its egress allowlist, sends a request through itx.egress.fetch with a getSecret({ path }) header placeholder, and verifies that Postman Echo saw the substituted value while describe() still never exposes the material. External service, so run it interactively.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const secretPath = vars.secretPath ?? "/secrets/postman-echo";
const material = "demo-" + (vars.note ?? "postman-echo-secret");
const secret = itx.secrets.get(secretPath);

await secret.update({
  // Egress checks origins, so this allows any path on postman-echo.com.
  egress: { urls: ["https://postman-echo.com/"] },
  material,
});

// update() is durable immediately, but the secret processor folds the stream
// asynchronously. Wait until the request path can see the new material.
let before = await secret.describe();
for (let attempt = 0; attempt < 50 && !before.hasMaterial; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  before = await secret.describe();
}

const response = await itx.egress.fetch(
  new Request("https://postman-echo.com/get?source=itx-secret-example", {
    headers: {
      "x-itx-secret": \`Bearer getSecret({ path: "\${secretPath}" })\`,
    },
  }),
);
if (!response.ok) {
  throw new Error(\`Postman Echo returned \${response.status}: \${await response.text()}\`);
}

const body = await response.json();
const after = await secret.describe();
const echoedSecret = body?.headers?.["x-itx-secret"];

return {
  echoedSecretMatches: echoedSecret === \`Bearer \${material}\`,
  hasMaterial: after.hasMaterial,
  materialLeakedInDescription: JSON.stringify(after).includes(material),
  usedCount: after.audit.usedCount,
};
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
    id: "browse-examples",
    title: "Browse this catalogue through itx.examples",
    description:
      "The catalogue itself is a built-in capability: list() returns every project-context entry without its code (cheap to skim), get({ id }) returns one with the full script body. Agents use this to copy working patterns instead of guessing at the surface. Session-context entries are excluded — an itx holder has no Session.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const summaries = await itx.examples.list();

// Summaries carry { id, title, description } — no code. Fetch one entry's
// full script body by id.
const example = await itx.examples.get({ id: vars.exampleId ?? "describe-project" });

return {
  count: summaries.length,
  hasCode: typeof example.code === "string" && example.code.length > 0,
  id: example.id,
};
`.trim(),
  },
  {
    id: "exa-web-search",
    title: "Web search through the built-in Exa MCP server",
    description:
      "itx.mcp.exa is a pre-connected MCP client for Exa's public server (https://mcp.exa.ai/mcp): web_search_exa({ query, numResults }) searches, web_fetch_exa({ urls }) reads pages as markdown. Tool names are flat calls on the client — the same shape any itx.mcp.connect({ url }) client has. External service, so run it interactively.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Fan independent lookups out in parallel — each tool call is one round trip.
const [search, pages] = await Promise.all([
  itx.mcp.exa.web_search_exa({ query: vars.query ?? "Cloudflare Durable Objects", numResults: 3 }),
  itx.mcp.exa.web_fetch_exa({ urls: [vars.url ?? "https://developers.cloudflare.com/durable-objects/"], maxCharacters: 2000 }),
]);

return { pages, search };
`.trim(),
  },
  {
    id: "connect-public-mcp",
    title: "Connect a public MCP server, then mount it",
    description:
      "itx.mcp.connect({ url }) opens any reachable MCP server as an ad-hoc capability target. Tool names become flat method calls on the returned client. Mount the same connection recipe as an itx-expression when you want agents and future sessions to discover it through describe() and call it as itx.publicMcp.<tool>(). External service, so run it interactively.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const mcpUrl = vars.mcpUrl ?? "https://mcp.exa.ai/mcp";

// Ad-hoc client: no mount, no project event. You can call MCP tools directly
// by their tool name on the returned client.
const mcp = await itx.mcp.connect({ url: mcpUrl });
const search = await mcp.web_search_exa({
  query: vars.query ?? "Cloudflare Workers RPC capabilities",
  numResults: 2,
});

// Durable mount: this records a capability recipe on the project scope so
// describe() can teach agents that itx.publicMcp.web_search_exa(...) exists.
await itx.provideCapability({
  expression: ["mcp", ["connect", { url: mcpUrl }]],
  instructions:
    "Public MCP search client. Call itx.publicMcp.web_search_exa({ query, numResults }) or itx.publicMcp.web_fetch_exa({ urls, maxCharacters }).",
  path: ["publicMcp"],
  type: "itx-expression",
});

const mountedSearch = await itx.publicMcp.web_search_exa({
  query: vars.query ?? "OpenAPI operationId example",
  numResults: 1,
});
const mount = (await itx.__describe()).capabilities.find(
  (capability) => capability.path.join(".") === "publicMcp",
);

return {
  adHocCalled: Boolean(search),
  mountType: mount?.type,
  mountedCalled: Boolean(mountedSearch),
};
`.trim(),
  },
  {
    id: "connect-openapi-petstore",
    title: "Connect OpenAPI Petstore, then mount it",
    description:
      "itx.openapi.connect({ specUrl }) fetches an OpenAPI document through project egress and returns a client whose methods are the spec's flat operationIds. This calls Swagger Petstore's findPetsByStatus operation, then registers the same OpenAPI connection as a durable capability at itx.petstore. External service, so run it interactively.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const petstoreSpecUrl =
  vars.specUrl ?? "https://petstore3.swagger.io/api/v3/openapi.json";

// Await the OpenAPI client, then call operationIds as methods. This is the
// same operation as:
//   await (await itx.openapi.connect({ specUrl: petstoreSpecUrl }))
//     .findPetsByStatus({ status: "available" })
const petstore = await itx.openapi.connect({ specUrl: petstoreSpecUrl });
const availablePets = await petstore.findPetsByStatus({ status: "available" });

// Mount the recipe when the client should become a named project capability.
await itx.provideCapability({
  expression: ["openapi", ["connect", { specUrl: petstoreSpecUrl }]],
  instructions:
    "Swagger Petstore OpenAPI client. Call itx.petstore.findPetsByStatus({ status: 'available' }) or any other operationId from the spec.",
  path: ["petstore"],
  type: "itx-expression",
});

const soldPets = await itx.petstore.findPetsByStatus({ status: "sold" });
const mount = (await itx.__describe()).capabilities.find(
  (capability) => capability.path.join(".") === "petstore",
);

return {
  availableCount: Array.isArray(availablePets) ? availablePets.length : null,
  firstAvailableName: Array.isArray(availablePets) ? availablePets[0]?.name : undefined,
  mountType: mount?.type,
  soldCount: Array.isArray(soldPets) ? soldPets.length : null,
};
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
  {
    id: "email-send",
    title: "Send an email from the project's address",
    description:
      "itx.email.send() delivers real mail through Cloudflare Email Service from the project's own address (<slug>@<hostname base>); an explicit `from` must match it. Needs the deployment's sender domain onboarded for Email Sending, and it emails a real recipient — run it interactively with an address you own.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const receipt = await itx.email.send({
  to: "you@example.com", // a mailbox you own — this sends real mail
  subject: "Hello from itx",
  text: "Sent by an agent through Cloudflare Email Service.",
});
return receipt; // { from: "<slug>@<hostname base>", messageId }
`.trim(),
  },
];
