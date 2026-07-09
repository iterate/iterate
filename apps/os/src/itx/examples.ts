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
//   project-worker  the body baked into the config repo's worker.ts,
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
    title: "Create a sandbox and run shell commands in it",
    description:
      "A sandbox is a real Linux container, kept like a project pet: it exists only after itx.sandboxes.create({ name, instanceType? }) (names are one path segment — the path is /sandboxes/<name>; instance types are Cloudflare's — lite, basic (default), standard-1..4 — fixed for life), and itx.sandboxes.get(path) then returns the bare Cloudflare Sandbox SDK surface (exec, readFile/writeFile, startProcess, gitCheckout, tunnels, … — https://developers.cloudflare.com/sandbox/api/) plus start()/sleep()/destroy(). The first command boots the container (can take a minute cold); after idle it is snapshotted and shut down — files under /workspace come back on the next start, everything else resets. The image is the stock Cloudflare one (Ubuntu, Node, Bun, git): install what you need, and clone repos with gitCheckout (GH_TOKEN is planted automatically when the project has a GitHub connection). Prefer reusing an existing sandbox (itx.sandboxes.list()) over creating more.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Reuse the sandbox if it exists, create it otherwise. The name IS the
// identity, verbatim — no normalization anywhere: same name, same sandbox
// (and its /workspace) until destroy(). create is strict, so a concurrent
// creator can win the race — swallow the create error and let the second
// get() be the arbiter.
const name = vars.sandboxName ?? "example";
const path = "/sandboxes/" + name;
const sandbox = await itx.sandboxes.get(path).catch(async () => {
  await itx.sandboxes.create({ name, instanceType: vars.instanceType }).catch(() => {});
  return itx.sandboxes.get(path);
});

// exec runs a shell command; the first one boots the container.
const uname = await sandbox.exec("uname -s");

// Only /workspace survives stop/idle (snapshot-restored) — keep durable
// work there.
const marker = await sandbox.exec("echo hello > /workspace/marker && cat /workspace/marker");

return {
  os: uname.stdout.trim(), // "Linux"
  marker: marker.stdout.trim(), // "hello"
  exitCode: marker.exitCode,
};
`.trim(),
  },
  {
    id: "workspace-edit-and-push",
    title: "Edit files in a workspace, then publish its branch",
    description:
      'A workspace is an instant copy-on-write overlay over the config repo\'s latest main, in a durable virtual filesystem (no container, no clone, always warm) — the fastest place for multi-step file reading and editing. In an agent scope `itx.workspace` is YOUR workspace (mounted at birth); itx.workspaces.get("/workspaces/<name>") addresses any other, and itx.workspaces.get("/") is the shared read-only root (always latest main). Reads see latest main until a local write shadows a path. Changes stay private until git.commit({ message }) publishes the whole overlay as ONE snapshot commit on the workspace\'s OWN branch (workspaces/<path>), never main — use itx.repo.edit/commitFiles when a change should go live on main.',
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// The path IS the identity: same path, same filesystem. An agent's own
// workspace is itx.workspace — for the example we address one by path.
const workspace = itx.workspaces.get(vars.workspacePath ?? "/workspaces/example");

// Reads fall through to the repo's latest main until shadowed by a write.
// Paths are absolute; "/" is the repo root.
const readme = await workspace.readFile("/README.md");

// Write and edit freely — the overlay is a private working tree.
await workspace.writeFile("/notes/workspace-example.md", "status: draft\\n");
const edited = await workspace.edit({
  path: "/notes/workspace-example.md",
  oldString: "status: draft",
  newString: "status: reviewed",
});

// What changed vs main, and one-call publish to the workspace's own branch
// (a snapshot commit — no add/push dance, .gitignored files are skipped).
const changes = await workspace.git.status();
const published = await workspace.git.commit({ message: "Workspace example note" });

return {
  readmePresent: readme !== null,
  edited,
  changes,
  commitOid: published.commitOid,
  publishedBranch: published.branch,
};
`.trim(),
  },
  {
    id: "workspace-files-transfer",
    title: "Move bytes between itx.files and a workspace",
    description:
      "itx.files (R2-backed project file storage: uploads, attachments, signed URLs) and workspaces (repo checkouts) compose through bytes: files.get(path).bytes() → workspace.writeFileBytes pulls a stored file into the checkout; workspace.readFileBytes → files.get(path).put({ data, contentType }) publishes a checkout file to storage (e.g. to mint a signed URL). Gotcha: files.put string data must be base64 — encode plain text with new TextEncoder().encode(text).",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const workspace = itx.workspaces.get(vars.workspacePath ?? "/workspaces/example");

// files -> workspace: pull a stored file into the checkout. put() string data
// must be base64, so encode plain text as bytes instead.
await itx.files.get("/examples/transfer.txt").put({
  data: new TextEncoder().encode(vars.note ?? "born in itx.files"),
  contentType: "text/plain",
});
const stored = await itx.files.get("/examples/transfer.txt").bytes();
await workspace.writeFileBytes("/imported/transfer.txt", stored);
const inWorkspace = await workspace.readFile("/imported/transfer.txt");

// workspace -> files: publish a checkout file (here the seeded package.json)
// to project file storage and mint a shareable signed URL.
const packageJsonBytes = await workspace.readFileBytes("/package.json");
const published = await itx.files.get("/examples/package-from-workspace.json").put({
  data: packageJsonBytes,
  contentType: "application/json",
});
const url = await itx.files.get("/examples/package-from-workspace.json").url();

return {
  inWorkspace,
  published,
  urlHost: new URL(url).host,
};
`.trim(),
  },
  {
    id: "repo-commit-files",
    title: "Commit files into the config repo",
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
    title: "Read a file from the config repo",
    description:
      "Read committed file contents from the config repo. readFile returns the HEAD commit oid, normalized path, and content, or null when the file does not exist.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const path = vars.path ?? "README.md";
const repo = itx.repos.get(vars.repoPath ?? "/repos/config");
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
    title: "Read then edit a config repo file",
    description:
      "Use readFile to inspect the current content, then edit to replace an exact string and commit the change. edit is safe for coding-agent workflows: oldString must match exactly once unless replaceAll is true.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const path = vars.path ?? "notes/edit-example.md";
const repo = itx.repos.get(vars.repoPath ?? "/repos/config");
const beforeText = "status: draft\\n";
const afterText = "status: reviewed\\n";

// Path-scoped repos need first-use creation; the default config repo already exists.
if (vars.repoPath) await repo.create();

// Seed a known starting point. Agents can skip this when editing an existing file.
await repo.commitFiles({
  message: "Seed edit example",
  changes: [{ path, content: "# Edit example\\n\\n" + beforeText }],
});

// commitFiles is durable when it returns, but a freshly-created repo's first
// reads can race its bootstrap; poll briefly rather than flake.
let before = await repo.readFile({ path });
for (let attempt = 0; attempt < 25 && before === null; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  before = await repo.readFile({ path });
}
if (before === null) throw new Error("Expected seeded file to exist.");

const edit = await repo.edit({
  path,
  message: "Mark edit example reviewed",
  oldString: beforeText,
  newString: afterText,
});

// The same bootstrap race can serve a pre-edit snapshot right after the
// commit; poll until the read reflects the edit.
let after = await repo.readFile({ path });
for (let attempt = 0; attempt < 25 && (after === null || after.content === before.content); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  after = await repo.readFile({ path });
}
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
      "Secrets are path-addressed write-only capabilities: update() stores material plus the egress URLs it may be substituted into, and describe() reports metadata only (hasMaterial, egress allowlist, usage audit). Egress requests carry getSecret(path) placeholders; substitution happens server-side.",
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
let described = await secret.__describe();
for (let attempt = 0; attempt < 50 && !described.hasMaterial; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  described = await secret.__describe();
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
      "Stores a secret with Postman Echo on its egress allowlist, sends a request through itx.egress.fetch with a getSecret(path) header placeholder, and verifies that Postman Echo saw the substituted value while describe() still never exposes the material. External service, so run it interactively.",
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
let before = await secret.__describe();
for (let attempt = 0; attempt < 50 && !before.hasMaterial; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  before = await secret.__describe();
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
const after = await secret.__describe();
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
      "Agents live at /agents/<name> and are addressed through itx.agents.get(path). message() appends the unified message-received event to the agent's stream and returns it — the sender is derived from your scope; the agent's processors take it from there (use agent.ask({ message }) to wait for the reply when an LLM provider is configured).",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const agent = await itx.agents.get(vars.agentPath ?? "/agents/repl-demo");

// The returned value is the committed stream event — the durable record the
// agent loop reduces into its history.
const sent = await agent.message(vars.message ?? "Hello from the examples catalogue");
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
    id: "files-roundtrip",
    title: "Store, read, and share a project file",
    description:
      "itx.files.get(path) is project file storage (R2-backed, mutable paths): put({ data, contentType }) stores bytes — base64 strings (what itx.ai.run image models return), Uint8Array, Blob, or a stream — bytes() reads them back, url() mints a signed public link any HTTP client can fetch (default expiry 7 days), delete() removes the file. On agent scopes prefer itx.agent.addFiles: one call that stores AND attaches files to the conversation.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const path = vars.path ?? "/repl/files-demo.txt";
const file = itx.files.get(path);

// Strings are decoded as base64 — exactly the shape Workers AI image models
// return in response.image.
const note = vars.note ?? "hello project files";
const stored = await file.put({ contentType: "text/plain", data: btoa(note) });

// Read the bytes back over itx.
const bytes = await file.bytes();
const text = new TextDecoder().decode(new Uint8Array(bytes));

// Mint a signed public URL and fetch it like any HTTP client would — this is
// the link you paste into chat or hand to a vision model.
const url = await file.url();
const served = await fetch(url);
const servedText = await served.text();

return { servedStatus: served.status, servedText, size: stored.size, text, url };
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
      "itx.ai proxies the platform's Workers AI binding: models() lists the catalog, run(model, body) executes one, toMarkdown() converts documents. Model availability and latency depend on the deployment's upstream account, so this entry is reading material for the matrix — run it interactively.",
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
    id: "github-list-repos",
    title: "List repositories through the built-in GitHub integration",
    description:
      'itx.integrations.github["<connection>"] IS a real Octokit (@octokit/rest): rest.<namespace>.<method>(params), the request(route, params) escape hatch, graphql(query, variables), and paginate(route, params) all work. There is NO generic api.request({ method, path }) shape. The connection acts as a GitHub App installation, so repos are enumerated with rest.apps.listReposAccessibleToInstallation() — user-scoped ...ForAuthenticatedUser endpoints answer 403. Resolve the connection name from itx.integrations.list() first. Needs a connected GitHub installation, so run it interactively.',
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const connections = await itx.integrations.list();
const github = connections.find((entry) => entry.integration === "github");
if (!github) return { error: "No GitHub connection — connect one from the dashboard integrations page." };

// The connection is a GitHub App installation: this endpoint (not the
// user-scoped listForAuthenticatedUser, which 403s) enumerates its repos.
const repos = await itx.integrations.github[github.connection].rest.apps.listReposAccessibleToInstallation({
  per_page: Number(vars.count ?? 5),
});

return repos.data.repositories.map((repo) => ({ fullName: repo.full_name, updatedAt: repo.updated_at }));
`.trim(),
  },
  {
    id: "github-read-file",
    title: "Read a file from a repo through the built-in GitHub integration",
    description:
      "Fetch file contents with Octokit's request() escape hatch: the raw media type returns the file body as a string (no base64 decode). rest.repos.getContent({ owner, repo, path }) is the JSON alternative — its data.content is base64. Needs a connected GitHub installation with access to the repo, so run it interactively.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const connections = await itx.integrations.list();
const github = connections.find((entry) => entry.integration === "github");
if (!github) return { error: "No GitHub connection — connect one from the dashboard integrations page." };

const owner = vars.owner ?? "octocat";
const repo = vars.repo ?? "hello-world";
// README shortcut; use "GET /repos/{owner}/{repo}/contents/{path}" with a path param for any file.
const readme = await itx.integrations.github[github.connection].request(
  "GET /repos/{owner}/{repo}/readme",
  { owner, repo, headers: { accept: "application/vnd.github.raw+json" } },
);

return { firstLines: String(readme.data).split("\\n").slice(0, 10), owner, repo };
`.trim(),
  },
  {
    id: "github-backed-repo",
    title: "Back a project repo with a real GitHub repository",
    description:
      "linkGithub({ connection, owner, repo }) makes GitHub a mirror of a project repo: the GitHub repository is created (private) if the installation can create org repos, every later commit is mirrored automatically, and GitHub webhooks about that repository are cross-posted onto the repo's own stream. syncFromGithub() adopts commits made directly on GitHub (fast-forward only; force discards local-only commits). Needs a connected GitHub installation, so run it interactively.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const connections = await itx.integrations.list();
const github = connections.find((entry) => entry.integration === "github");
if (!github) return { error: "No GitHub connection — connect one from the dashboard integrations page." };

const owner = vars.owner; // an org the GitHub App is installed on
const repoName = vars.repo ?? "iterate-linked-repo-demo";
if (!owner) return { error: "Pass vars.owner (the GitHub org)." };

const repo = itx.repo; // or itx.repos.get("/repos/<path>") for a path-scoped repo
const link = await repo.linkGithub({ connection: github.connection, owner, repo: repoName });
// link.initialPush reports the seeding push; a commit now mirrors automatically:
await repo.commitFiles({
  message: "Hello from iterate",
  changes: [{ path: "hello.md", content: "Mirrored to GitHub.\\n" }],
});
// Webhooks about the repository (pushes, PRs, issues) now land on the repo's
// own stream as events.iterate.com/github/webhook-received — including the
// echo of the mirror pushes themselves.
const state = await repo.processor.snapshot();
return { link, github: state.state.github, lastGithubPush: state.state.lastGithubPush };
`.trim(),
  },
  {
    id: "stream-cross-post",
    title: "Cross-post matching events between streams",
    description:
      "stream.crossPostTo({ path, eventTypes, condition? }) copies every later matching event onto the target stream — sugar over a durable push subscription targeting the destination's acceptCrossPost sink, so copies are at-least-once. The optional condition is a JSONata expression over the whole event that must evaluate to exactly true. Copies carry source.crossPostedFrom (the full hop chain), cross-posts never copy into a stream already on the chain (cycles are safe), and removeCrossPost({ path }) removes one.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const source = itx.streams.get(vars.source ?? "/examples/cross-post/source");
const target = itx.streams.get(vars.target ?? "/examples/cross-post/target");

await source.crossPostTo({
  path: vars.target ?? "/examples/cross-post/target",
  eventTypes: ["events.iterate.example/note"],
  condition: 'payload.importance = "high"', // JSONata over the event; optional
});

await source.append(
  { type: "events.iterate.example/note", payload: { importance: "low", text: "ignored" } },
  { type: "events.iterate.example/note", payload: { importance: "high", text: "copied" } },
);

const copied = await target.waitForEvent({
  eventTypes: ["events.iterate.example/note"],
  afterOffset: 0,
  timeoutMs: 10_000,
});
return { copied: copied.payload, provenance: copied.source?.crossPostedFrom };
`.trim(),
  },
  {
    id: "gmail-search-inbox",
    title: "Search the inbox through the built-in Gmail integration",
    description:
      'itx.integrations.google["<connection>"].gmail.request({ path, query, method, headers, body }) proxies the Gmail REST API — paths relative to https://gmail.googleapis.com/gmail/v1. List matching message ids first, then fan out metadata fetches in one Promise.all. Reads real mail, so run it interactively.',
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const connections = await itx.integrations.list();
const google = connections.find((entry) => entry.integration === "google");
if (!google) return { error: "No Google connection — connect one from the dashboard integrations page." };

const gmail = itx.integrations.google[google.connection].gmail;
const inbox = await gmail.request({
  path: "/users/me/messages",
  query: { maxResults: 5, q: vars.q ?? "in:inbox is:unread" },
});

const messages = await Promise.all(
  (inbox.data.messages ?? []).map((message) =>
    gmail.request({
      path: "/users/me/messages/" + message.id,
      query: { format: "metadata", metadataHeaders: "Subject" },
    }),
  ),
);

return {
  resultSizeEstimate: inbox.data.resultSizeEstimate,
  subjects: messages.map((m) => m.data.payload?.headers?.find((h) => h.name === "Subject")?.value),
};
`.trim(),
  },
  {
    id: "slack-post-message",
    title: "Post a message through the built-in Slack integration",
    description:
      'itx.integrations.slack["<connection>"] IS a real Slack WebClient (@slack/web-api): any Web API method as a dotted path, always ONE body object — chat.postMessage({ channel, text }), conversations.list({ limit }), users.info({ user }). Posts to a real workspace, so run it interactively.',
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const connections = await itx.integrations.list();
const slack = connections.find((entry) => entry.integration === "slack");
if (!slack) return { error: "No Slack connection — connect one from the dashboard integrations page." };

const client = itx.integrations.slack[slack.connection];
// Find a channel to talk in; vars.channel (an id like C0123...) skips the lookup.
const channels = await client.conversations.list({ exclude_archived: true, limit: 20, types: "public_channel" });
const channel = vars.channel ?? channels.channels?.[0]?.id;
if (!channel) return { error: "No channel found", channels };

const posted = await client.chat.postMessage({ channel, text: vars.text ?? "Hello from itx!" });
return { channel, ok: posted.ok, ts: posted.ts };
`.trim(),
  },
  {
    id: "github-mcp-connect",
    title: "GitHub's MCP server as a provided integration",
    description:
      'The provided-integration lane, using GitHub\'s official MCP server: store a fine-grained PAT as a project secret, mount the server into the collection with one durable provideCapability, and call it at the same fully qualified connection address a builtin uses. The PAT rides as a getSecret placeholder substituted at project egress — no isolate ever holds it. (The BUILT-IN github integration — dashboard connect, the wrapped Octokit at itx.integrations.github["<connection>"], sandbox gh — is separate; this mounts under the github-mcp slug because built-in slugs cannot be shadowed.) Needs a real PAT in vars.githubPat, so run it interactively.',
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const connection = vars.connection ?? "main";
const tokenPath = \`/secrets/integrations/github-mcp/\${connection}/token\`;

// 1. The PAT lives in a Secret DO with a GitHub-only egress allowlist.
const secret = itx.secrets.get(tokenPath);
await secret.update({
  egress: { urls: ["https://api.githubcopilot.com/", "https://api.github.com/"] },
  material: vars.githubPat,
});
let described = await secret.__describe();
for (let attempt = 0; attempt < 50 && !described.hasMaterial; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  described = await secret.__describe();
}

// 2. One durable mount makes GitHub part of the integrations collection. The
// itx-expression is a journaled recipe: replayed per call, revocable,
// enumerated by itx.integrations.list(). Mount at the PROJECT ROOT:
// itx.integrations.* resolves through the project capability table, so an
// own-scope itx.provideCapability from an agent is unreachable there.
const rootHost = await itx.capabilityHosts.get("/");
await rootHost.provideCapability({
  path: ["integrations", "github-mcp", connection],
  type: "itx-expression",
  instructions:
    "GitHub via the official MCP server: create_issue({ owner, repo, title }), list_pull_requests, get_file_contents, search_code, ...",
  expression: [
    "mcp",
    [
      "connect",
      {
        url: "https://api.githubcopilot.com/mcp/",
        headers: { authorization: \`Bearer getSecret({ path: "\${tokenPath}" })\` },
      },
    ],
  ],
});

// 3. Same address shape as a builtin — {slug}.{connection}.{method}.
const me = await itx.integrations["github-mcp"][connection].get_me({});
return { login: me?.login ?? me, listed: await itx.integrations.list() };
`.trim(),
  },
  {
    id: "github-webhooks-project-worker",
    title: "GitHub webhooks land on the project's own host",
    description:
      "Per-project webhook ingress already exists: every project host routes to the repo-backed worker.ts, whose fetch can append inbound deliveries to the connection's /integrations/github/{connection} journal — where a configured worker or agent subscriber picks them up. Point the GitHub repo/app webhook URL at https://<project-slug>.<base>/webhooks/github/<random-token> (the unguessable token in the path is the auth — worker code cannot hold the HMAC signing secret, by design). MUTATING: this REPLACES the seeded worker.ts (homepage + app router) wholesale — merge the route into your existing fetch instead if you have one. Run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const connection = vars.connection ?? "main";
const urlToken = vars.urlToken ?? crypto.randomUUID();
const journalPath = \`/integrations/github/\${connection}\`;

await itx.repo.commitFiles({
  message: "Receive GitHub webhooks on the project host",
  changes: [
    {
      path: "worker.ts",
      content: \`
import { WorkerEntrypoint } from "cloudflare:workers";

export default class ProjectWorker extends WorkerEntrypoint {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/webhooks/github/\${urlToken}" && req.method === "POST") {
      const project = await this.env.ITX.get();
      await project.streams.get("\${journalPath}").append({
        type: "events.iterate.com/github/webhook-received",
        idempotencyKey: "github:" + (req.headers.get("x-github-delivery") ?? crypto.randomUUID()),
        payload: {
          delivery: req.headers.get("x-github-delivery"),
          event: req.headers.get("x-github-event"),
          body: await req.json(),
        },
      });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  processEventBatch() {}
}
\`,
    },
  ],
});

return {
  webhookPathOnProjectHost: \`/webhooks/github/\${urlToken}\`,
  journalPath,
  note: "Set the GitHub webhook URL to the project host + that path; deliveries land on the journal, where itx.integrations.list() enumerates the connection.",
};
`.trim(),
  },
  {
    id: "cf-ai-to-markdown",
    title: "Convert a document to Markdown with Workers AI",
    description:
      "Cloudflare Workers AI Markdown Conversion is available as itx.integrations.cf.ai.toMarkdown() and the root shortcut itx.ai.toMarkdown(). Call with no args for supported formats. Uses Cloudflare AI infrastructure, so run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const supported = await itx.ai.toMarkdown();
const csv = new Blob(["name,value\\nalpha,1\\nbeta,2\\n"], { type: "text/csv" });
const converted = await itx.integrations.cf.ai.toMarkdown({ name: "sample.csv", blob: csv });
return { supported: supported.slice(0, 10), converted };
`.trim(),
  },
  {
    id: "ai-generate-image",
    title: "Generate an image with a Workers AI model",
    description:
      "Runs Cloudflare-hosted FLUX.2 [klein] 9B through itx.ai.run(). The model accepts multipart input and returns a base64 image in image. First-party docs: https://developers.cloudflare.com/ai/models/%40cf/black-forest-labs/flux-2-klein-9b/ . Uses paid/remote AI infrastructure, so run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const form = new FormData();
form.append("prompt", "A compact product photo of a brushed steel desk lamp on a white background");
form.append("width", "512");
form.append("height", "512");

const formResponse = new Response(form);
const response = await itx.ai.run("@cf/black-forest-labs/flux-2-klein-9b", {
  multipart: {
    body: formResponse.body,
    contentType: formResponse.headers.get("content-type"),
  },
});

return {
  docs: "https://developers.cloudflare.com/ai/models/%40cf/black-forest-labs/flux-2-klein-9b/",
  imageBytesApprox: response?.image ? Math.floor((response.image.length * 3) / 4) : null,
  response,
};
`.trim(),
  },
  {
    id: "ai-generate-audio",
    title: "Generate speech audio with a Workers AI model",
    description:
      "Runs xAI Grok TTS through itx.ai.run(). The model returns a hosted MP3 URL in result.audio. ElevenLabs is available through Cloudflare AI Gateway provider-native calls with an ElevenLabs token, not this zero-key env.AI.run path. First-party docs: https://developers.cloudflare.com/ai/models/xai/grok-tts/ . Uses paid/remote AI infrastructure, so run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const response = await itx.ai.run("xai/grok-tts", {
  text: "Hello from ITX. This audio was generated with a Cloudflare Workers AI speech model.",
  voice_id: "ara",
  language: "en",
  output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 192000 },
});

return {
  docs: "https://developers.cloudflare.com/ai/models/xai/grok-tts/",
  audioUrl: response?.result?.audio,
  response,
};
`.trim(),
  },
  {
    id: "ai-transcribe-audio",
    title: "Transcribe audio with a Workers AI model",
    description:
      "Runs xAI Grok STT through itx.ai.run() against a small public MP3 URL and returns the transcription. First-party docs: https://developers.cloudflare.com/ai/models/xai/grok-stt/ . Uses paid/remote AI infrastructure and a public fetch, so run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const response = await itx.ai.run("xai/grok-stt", {
  url: "https://storage.googleapis.com/cloud-samples-data/speech/brooklyn_bridge.mp3",
  language: "en",
  format: true,
});

return {
  docs: "https://developers.cloudflare.com/ai/models/xai/grok-stt/",
  text: response?.result?.text,
  language: response?.result?.language,
  duration: response?.result?.duration,
  wordCount: response?.result?.words?.length,
  response,
};
`.trim(),
  },
  {
    id: "ai-generate-video",
    title: "Generate video with a Workers AI model",
    description:
      "Runs xAI Grok Imagine Video through itx.ai.run(). The model returns a hosted MP4 URL in result.video. First-party docs: https://developers.cloudflare.com/ai/models/xai/grok-imagine-video/ . Uses paid/remote AI infrastructure, so run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const response = await itx.ai.run("xai/grok-imagine-video", {
  prompt: "A slow cinematic dolly shot across a clean workspace with a glowing laptop screen",
  aspect_ratio: "16:9",
  duration: 5,
  resolution: "720p",
});

return {
  docs: "https://developers.cloudflare.com/ai/models/xai/grok-imagine-video/",
  videoUrl: response?.result?.video,
  response,
};
`.trim(),
  },
  {
    id: "cf-browser-markdown",
    title: "Render a page to Markdown with Browser Run",
    description:
      "Cloudflare Browser Run quick actions are available as itx.browser.quickAction() and itx.integrations.cf.browser.quickAction(). This renders a real page and converts it to Markdown. External service, so run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const resp = await itx.browser.quickAction("markdown", {
  url: "https://developers.cloudflare.com/browser-run/quick-actions/",
});
return await resp.json();
`.trim(),
  },
  {
    id: "cf-images-transform",
    title: "Resize and convert an image with Cloudflare Images",
    description:
      "Cloudflare Images transformations are available as itx.integrations.cf.images.transform({ image, transforms, output }). It accepts private streams too, not just public URLs. External fetch + Images binding, so run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const source = await fetch("https://developers.cloudflare.com/img/logo-cloudflare-dark.svg");
const output = await itx.integrations.cf.images.transform({
  image: source.body,
  transforms: [{ width: 256 }],
  output: { format: "image/webp", quality: 85 },
});
return {
  contentType: output.headers.get("content-type"),
  bytes: (await output.arrayBuffer()).byteLength,
};
`.trim(),
  },
  {
    id: "cf-videos-frame",
    title: "Extract a video frame with Media Transformations",
    description:
      "Cloudflare Media Transformations are available as itx.integrations.cf.videos.transform({ video, transform, output }). Use output.mode = frame, spritesheet, audio, or video. External fetch + Media binding, so run it interactively.",
    context: "project",
    runtimes: ["browser", "node", "cli"],
    code: `
const source = await fetch("https://pub-d9fcbc1abcd244c1821f38b99017347f.r2.dev/aus-mobile.mp4");
const frame = await itx.integrations.cf.videos.transform({
  video: source.body,
  transform: { width: 480, fit: "scale-down" },
  output: { mode: "frame", time: "1s", format: "jpg" },
});
return {
  contentType: frame.headers.get("content-type"),
  bytes: (await frame.arrayBuffer()).byteLength,
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
  {
    id: "scheduler-basics",
    title: "Schedule an itx script (set, list, cancel)",
    description:
      "itx.scheduler runs itx scripts on a schedule: set() upserts by key with recurrence { cron, timezone? } | { every: seconds } | { at: ISO } | { in: seconds }, list() reads the reduced state, cancel(key) removes. The script is a STRING (no closures — bake values in) invoked later as fn(itx, schedule, trigger) with project-root authority, at least once per Trigger. Every set, trigger, and outcome is an event on the /scheduler/primary stream — the complete audit log.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
// Upsert by key: re-setting the same key replaces the schedule. Returns after
// the scheduler has durably ingested it (read-your-writes), with the computed
// next occurrence.
const key = vars.schedulerKey ?? "examples/daily-report";
const view = await itx.scheduler.set({
  key,
  recurrence: { cron: "0 9 * * MON-FRI", timezone: "Europe/London" },
  // The script runs later in its own isolate. schedule = { key, path,
  // recurrence, metadata?, setAt }; trigger = { executionId, scheduledFor,
  // requestedAt, runCount }. Inside it, \`await itx.projectId\` and
  // \`await itx.capabilityHost.path\` identify where it is running.
  script: \`async (itx, schedule, trigger) => {
    // At-least-once delivery: key appends by trigger.executionId so a
    // crash-retry cannot double-write.
    await itx.streams.get("/reports/daily").append({
      type: "com.example/report-requested",
      idempotencyKey: "report:" + trigger.executionId,
      payload: { scheduledFor: trigger.scheduledFor, runCount: trigger.runCount },
    });
    return "requested"; // recorded in the trigger-completed event
  }\`,
  metadata: { owner: "examples" },
});

const schedules = await itx.scheduler.list(); // every schedule, straight from reduced state

// Clean up so this example leaves nothing behind (an emptied scheduler
// deletes its alarm and sleeps).
await itx.scheduler.cancel(key);
return { found: schedules.some((s) => s.key === key), nextTriggerAt: view.nextTriggerAt };
`.trim(),
  },
  {
    id: "scheduler-agent-checkin",
    title: "Give an agent a recurring task",
    description:
      "The scheduler + agents flywheel: schedule a script that sends an agent a message, and the agent wakes on cadence, does the work, and reports in its own chat. Sending to a fresh /agents/** path births that agent on first use — so a schedule targeting a date-stamped path creates a NEW agent per occurrence.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const key = vars.schedulerKey ?? "examples/agent-checkin";
const view = await itx.scheduler.set({
  key,
  recurrence: { every: 3600 }, // seconds; re-anchors on each trigger
  script: \`async (itx, schedule, trigger) => {
    // A fixed path = one long-lived agent accumulating context. For a fresh
    // agent per occurrence use a derived path instead, e.g.
    // "/agents/standup-" + trigger.scheduledFor.slice(0, 10).
    await itx.agents.get("/agents/checkin").message(
      "Scheduled check-in #" + trigger.runCount + ": summarize anything new since last time."
    );
  }\`,
});

// Run it once right now without waiting for the hour (advances the clock):
// await itx.scheduler.trigger(key);

// Keep this example inert:
await itx.scheduler.cancel(key);
return { nextTriggerAt: view.nextTriggerAt };
`.trim(),
  },
];
