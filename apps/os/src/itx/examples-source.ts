// The itx example catalogue, AUTHORED AS TYPED FUNCTIONS: the entries in
// ITX_EXAMPLE_SOURCES just below ARE this file — edit them there. The
// artifact the app ships (src/itx/examples.generated.ts, re-exported through
// src/itx/examples.ts) is derived from THIS file's source text by
// scripts/generate-itx-examples.ts (`pnpm generate:itx-examples`), which
// extracts each `fn` body verbatim as the entry's plain-JS `code` string.
// The authoring rules, the per-context helpers (projectExample & co.), and
// the shared type machinery live at the BOTTOM of this file, below the
// entries.

import type {
  Agent,
  AgentChat,
  CapabilityProvision,
  DynamicWorkerRef,
  FileData,
  FileHandle,
  Project,
  SandboxCreateInput,
  Session,
  Stream,
  Workspace,
} from "../itx-api.generated.ts";
import type { ItxExample, ItxExampleRuntime } from "./examples.ts";

// The only bindings the array evaluation needs before it (const initializers
// do not hoist); the helper FUNCTIONS the entries call are declared below the
// array and do.
const ALL_RUNTIMES: ItxExampleRuntime[] = [
  "browser",
  "node",
  "cli",
  "run-script",
  "project-worker",
];

/** Live providers must outlive the calls, so these stay in caller-owned sessions. */
const LIVE_SESSION_RUNTIMES: ItxExampleRuntime[] = ["browser", "node", "cli"];

export const ITX_EXAMPLE_SOURCES: ItxExampleSource[] = [
  sessionExample({
    id: "whoami",
    e2eProven: false,
    title: "Who am I? (OS session)",
    description:
      "The top-level REPL holds the OS Session — the catalog authenticate() returned; it is not an itx. __describe() works on every node; on a Session its `principal` is who the socket carries.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
      const description = await itx.__describe();
      return description.principal;
    },
  }),
  // String-authored: the closing line pipelines __describe() onto the
  // un-awaited result of projects.get() — a capnweb idiom the published
  // Promise-based types cannot express (`Promise<Project>` has no
  // `__describe`), and the pipelining IS the teaching point.
  stringExample({
    id: "list-projects",
    e2eProven: false,
    title: "List projects, then open one",
    description:
      "A Session vends itxs: projects.list() shows the projects you can reach (id, slug, org, deployment status), and projects.get(id) returns the project-scoped itx — the same handle a project REPL holds. Every project-context example starts there.",
    context: "session",
    runtimes: LIVE_SESSION_RUNTIMES,
    code: `
// Every project you have access to (admins see all; users see their own):
// { id, slug, organizationId, organizationName, deploymentStatus }.
const projects = await itx.projects.list();

// Open one. The result is an itx scoped to that project — the same shape a
// project REPL's \`itx\` has (streams, repo, workers, runScript, ...).
const pid = vars.projectId ?? projects[0]?.id;
if (!pid) throw new Error("Create a project first: await itx.projects.get('demo').create({})");

// describe() reports the project and its capability table. Method-returned
// surfaces pipeline, so the get() needs no intermediate await.
return await itx.projects.get(pid).__describe();
`.trim(),
  }),
  projectExample({
    id: "describe-project",
    title: "Describe the project (its __describe)",
    description:
      "__describe() works on EVERY node and is the project's self-report: its id, name, a one-line blip per built-in member (`children`), and the dynamic capabilities mounted at this scope (`capabilities`). Agents read this to learn what they can call.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx) => {
      const description = await itx.__describe();

      // Built-ins are the children map; dynamic mounts appear in capabilities
      // with type "live" or "itx-call" plus the offset of the event that
      // mounted them.
      return {
        builtins: Object.keys(description.children),
        mounted: description.capabilities.map((capability) => capability.path.join(".")),
        projectId: description.projectId,
      };
    },
  }),
  projectExample({
    id: "discover-tree",
    title: "Discover the capability tree by walking __describe()",
    description:
      "The canonical discovery walk: every node answers __describe() with { instructions, types, children, parent }, so a map of the whole surface is 'read children, recurse into the ones you care about'. Mounted capabilities answer from their durable provide-time metadata — the walk never dials a live target.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx) => {
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
    },
  }),
  projectExample({
    id: "append-and-read-stream",
    title: "Append to a project stream and read it back",
    description:
      "itx.streams is the project's durable event store. Append an event to a path, then read the path back — the same streams that agents, processors, and every other holder of this project's itx share.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { path?: string; note?: string }) => {
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
    },
  }),
  projectExample({
    id: "notify-mobile-device",
    e2eProven: false,
    title: "Discover and notify an enrolled phone",
    description:
      "Every phone enrolled for this project is a durable itx.devices member. List safe metadata, choose a device, then append the ordinary notification-requested event. The server-side device processor calls Expo/APNs while the app is suspended and journals ticket, receipt, expiry, rejection, or uncertain outcomes on /devices/<deviceId>.",
    runtimes: ["browser", "node", "cli", "run-script", "project-worker"],
    fn: async (
      itx,
      vars: { body?: string; deviceId?: string; operationId?: string; title?: string },
    ) => {
      const devices = await itx.devices.list();
      const deviceId = vars.deviceId || devices[0]?.deviceId;
      if (!deviceId) {
        throw new Error("Open this project in the iterate development build to enroll a phone.");
      }
      const operationId = vars.operationId || crypto.randomUUID();
      const [requested] = await itx.devices.get(deviceId).append({
        type: "events.iterate.com/device/notification-requested",
        idempotencyKey: `device-notification-requested:${operationId}`,
        payload: {
          title: vars.title || "Reminder from iterate",
          body: vars.body || "This notification was sent by an itx script.",
          destination: { kind: "project" },
          expiresAt: Date.now() + 5 * 60_000,
        },
      });
      return { deviceId, requestOffset: requested.offset };
    },
  }),
  projectExample({
    id: "ephemeral-events",
    title: "Ephemeral events: transient signals whose durable truth lands separately",
    description:
      "append({ ephemeral: true }) commits a transient event: callbacks already opened with openConnection() see it, getEvents() skips it unless includeEphemeral is true, and durable subscriptions never deliver it. Use them for high-volume signals such as LLM chunks and progress ticks, then append the durable fact as its own ordinary event.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { path?: string }) => {
      // Transient signal: callbacks already open see it; product state never will.
      const stream = itx.streams.get(vars.path ?? "/repl/ephemeral-demo");
      const operationId = crypto.randomUUID();
      const [tick] = await stream.append({
        type: "events.iterate.repl/progress-ticked",
        idempotencyKey: `ephemeral-events:${operationId}:progress-ticked`,
        ephemeral: true,
        payload: { percent: 50 },
      });

      // The durable truth is its own ordinary event — THIS is what processors fold.
      const [done] = await stream.append({
        type: "events.iterate.repl/work-completed",
        idempotencyKey: `ephemeral-events:${operationId}:work-completed`,
        payload: { result: "ok" },
      });

      const defaults = await stream.getEvents({ afterOffset: tick.offset - 1 });
      const raw = await stream.getEvents({ afterOffset: tick.offset - 1, includeEphemeral: true });
      return {
        tickOffset: tick.offset, // ephemeral rows consume offsets like any commit
        doneOffset: done.offset, // the durable event landed right after it
        defaultOffsets: defaults.map((e) => e.offset), // [done.offset] — the tick is excluded
        rawOffsets: raw.map((e) => e.offset), // [tick.offset, done.offset]
      };
    },
  }),
  projectExample({
    id: "run-script",
    title: "Run a script server-side with itx.runScript",
    description:
      "runScript ships an `async (itx) => { … }` source string into the project's script isolate — the exact mechanism agent codemode uses. The execution leaves a two-event record (script-run-requested/-completed) on the scope's stream.",
    runtimes: ["browser", "node", "cli", "project-worker"],
    fn: async (itx) => {
      const execution = await itx.capabilityHost.runScript(`async (itx) => {
  const description = await itx.__describe();
  return { projectId: description.projectId, sum: 6 * 7 };
}`);

      // runScript returns the result plus the completed journal event.
      return {
        completedEventType: execution.completedEvent.type,
        result: execution.result,
      };
    },
  }),
  projectExample<
    Live<
      "answer",
      {
        ultimate(): number;
        deep: { thought(question: string): Promise<{ answer: number; question: string }> };
      }
    >
  >({
    id: "provide-live-capability",
    title: "Provide a live capability — your object IS the capability",
    description:
      "provideCapability({ type: 'live', … }) mounts a plain object of functions (nested at any depth) on the project. Dotted calls replay onto its members, back in the provider's process — your browser tab or Node session. The returned provision owns the mount: provision.revoke() removes it. Live caps are session-bound: gone when this session disconnects.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
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
    },
  }),
  projectExample<
    Live<
      "fakeSlack",
      {
        invokeCapability(call: { args: unknown[]; path: string[] }): {
          args: unknown[];
          method: string;
          provider: string;
        };
      },
      // flattenNestedPaths rewires the mounted method tree, so the mounted
      // shape is declared explicitly instead of Remoted<Impl>.
      {
        chat: {
          postMessage(message: {
            channel: string;
            text: string;
          }): Promise<{ args: unknown[]; method: string; provider: string }>;
        };
      }
    >
  >({
    id: "provide-live-flattened",
    title: "Provide an SDK-shaped capability (flattened paths)",
    description:
      "flattenNestedPaths: true delivers the whole dotted path as data to ONE method, invokeCapability({ path, args }). This is how 'use itx.fakeSlack exactly like the Slack SDK' works — the public SDK docs become the tool docs, with a tiny forwarder.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
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
    },
  }),
  projectExample<{ demoStream: Stream }>({
    id: "provide-itx-expression",
    title: "Provide a durable capability as an itx expression",
    description:
      "An itx-expression capability is a serializable recipe over the project's own surface — here an alias to a stream: ['streams', ['get', path]]. Unlike a live mount it survives this session; itx evaluates the expression on demand. The same shape mounts dynamic workers (['workers', ['get', ref]]), MCP servers (['mcp', ['connect', { url }]]), and OpenAPI clients.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { path?: string; note?: string }) => {
      // Mount itx.demoStream as an alias for a project stream. The recipe is data —
      // it is recorded on the project's stream and needs no live provider.
      await itx.provideCapability({
        expression: ["streams", ["get", vars.path ?? "/repl/expression-demo"]],
        instructions: "A demo stream alias: itx.demoStream.append({ type, payload }).",
        path: ["demoStream"],
        type: "itx-call",
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
      return { mountType: mount?.type, note: event.payload?.note, offset: event.offset };
    },
  }),
  projectExample<{
    workers: {
      get(ref: DynamicWorkerRef): {
        hello(input: { name: string }): Promise<string>;
        add(a: number, b: number): Promise<number>;
      };
    };
  }>({
    id: "dynamic-worker-stateless",
    title: "Load a stateless dynamic worker from inline source",
    description:
      "itx.workers.get() turns a declarative ref — module text plus an entrypoint — into a live RPC stub. Every public method on the WorkerEntrypoint is callable with zero extra wiring, and the worker's env.ITX is scoped to this project.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx) => {
      // A handle is kept here because the worker is called twice below; one-off
      // calls pipeline in a single expression: await itx.workers.get(ref).hello().
      const greeter = await itx.workers.get({
        type: "stateless",
        entrypoint: "Greeter",
        path: "/",
        source: {
          createWorker: {
            bundle: false,
            entryPoint: "greeter.js",
            files: {
              type: "inline",
              files: {
                "greeter.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";

          export class Greeter extends WorkerEntrypoint {
            hello({ name }) {
              return "hello, " + name;
            }

            add(a, b) {
              return a + b;
            }
          }
        `,
              },
            },
          },
          // Plain JavaScript with bundling off loads directly; TypeScript or
          // multi-file sources drop bundle: false and go through the build pipeline.
        },
      });

      const [greeting, sum] = await Promise.all([
        greeter.hello({ name: "world" }),
        greeter.add(2, 3),
      ]);
      return { greeting, sum };
    },
  }),
  projectExample<{
    workers: {
      get(ref: DynamicWorkerRef): {
        increment(): Promise<number>;
        current(): Promise<number>;
      };
    };
  }>({
    id: "dynamic-worker-stateful",
    title: "A stateful dynamic worker with its own storage",
    description:
      "A stateful ref names a Durable Object class; durableWorkerKey is its durable identity under { project, path } — same key, same storage, across sessions and code changes. Its private storage needs zero provisioning.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { counterKey?: string }) => {
      // Sequential dependent calls: keep the handle (un-awaited — calls pipeline
      // through it), await each step because the next depends on it.
      const counter = itx.workers.get({
        type: "stateful",
        className: "CounterDurableObject",
        // The durable identity: reuse the key to come back to the same state.
        durableWorkerKey: vars.counterKey ?? "repl-counter",
        path: "/",
        source: {
          createWorker: {
            bundle: false,
            entryPoint: "counter.js",
            files: {
              type: "inline",
              files: {
                "counter.js": `
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
        `,
              },
            },
          },
        },
      });

      await counter.increment();
      await counter.increment();
      return { current: await counter.current() }; // 2, and it persists under the key
    },
  }),
  projectExample({
    id: "sandbox-exec",
    title: "Create a sandbox and run shell commands in it",
    description:
      "A sandbox is a real Linux container, kept like a project pet: address it with itx.sandboxes.get('/sandboxes/<name>'), then explicitly birth it with handle.create({ instanceType? }). Instance types are Cloudflare's — lite, basic (default), standard-1..4 — and fixed for life. The handle exposes the Cloudflare Sandbox SDK surface (exec, readFile/writeFile, startProcess, gitCheckout, tunnels, … — https://developers.cloudflare.com/sandbox/api/) plus start()/sleep()/destroy(). The first command boots the container (can take a minute cold); after idle it is snapshotted and shut down — files under /workspace come back on the next start, everything else resets. The image is the stock Cloudflare one (Ubuntu, Node, Bun, git): install what you need, and clone repos with gitCheckout (GH_TOKEN is planted automatically when the project has a GitHub connection). Prefer reusing an existing sandbox (itx.sandboxes.list()) over creating more.",
    runtimes: ALL_RUNTIMES,
    fn: async (
      itx,
      vars: { sandboxName?: string; instanceType?: SandboxCreateInput["instanceType"] },
    ) => {
      // The path IS the identity, verbatim: same path, same sandbox (and its
      // /workspace) until destroy(). Addressing is pure; create appends the
      // complete birth batch and returns this same handle.
      const name = vars.sandboxName ?? "example";
      const path = "/sandboxes/" + name;
      const sandbox = itx.sandboxes.get(path);
      await sandbox.create({
        ...(vars.instanceType === undefined ? {} : { instanceType: vars.instanceType }),
      });

      // exec runs a shell command; the first one boots the container.
      const uname = await sandbox.exec("uname -s", { timeout: 15_000 });
      if (!uname.success) {
        throw new Error(`uname failed with exit ${uname.exitCode}: ${uname.stderr}`);
      }

      // Only /workspace survives stop/idle (snapshot-restored) — keep durable
      // work there.
      const marker = await sandbox.exec("echo hello > /workspace/marker && cat /workspace/marker", {
        timeout: 15_000,
      });
      if (!marker.success) {
        throw new Error(`marker write failed with exit ${marker.exitCode}: ${marker.stderr}`);
      }

      return {
        os: uname.stdout.trim(), // "Linux"
        marker: marker.stdout.trim(), // "hello"
        exitCode: marker.exitCode,
      };
    },
  }),
  projectExample({
    id: "workspace-edit-and-push",
    title: "Edit files in a workspace, then commit them to main",
    description:
      'A workspace is a mount-routed, copy-on-write filesystem in a Durable Object (no container, no clone, always warm) — the fastest place for multi-step file reading and editing. Address it with itx.workspaces.get("/workspaces/<name>"), then call handle.create({ mounts? }) explicitly; addressing alone never births it. By default the config repo is mounted at "/", so reads see its latest main until a local write shadows a path. Changes stay private until git.commit({ message }) — which commits ONE mount\'s changes straight to that repo\'s MAIN branch (the project worker/website redeploys automatically; no branches, no push step) and clears just that subtree. More repos mount into the tree via configure({ config: { mounts } }); commits never span mounts (pass { scope } when several are dirty).',
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { workspacePath?: string }) => {
      // The path IS the identity: same path, same filesystem. An agent's own
      // workspace is itx.workspace — for the example we address one by path.
      const workspace = itx.workspaces.get(vars.workspacePath ?? "/workspaces/example");
      await workspace.create({});

      // Reads fall through to the repo's latest main until shadowed by a write.
      // Paths are absolute; "/" is the repo root.
      const readme = await workspace.readFile("/README.md");

      // Write and edit freely — the overlay is a private working tree.
      await workspace.writeFile("/notes/workspace-example.md", "status: draft\n");
      const edited = await workspace.edit({
        path: "/notes/workspace-example.md",
        oldString: "status: draft",
        newString: "status: reviewed",
      });

      // What changed (grouped by owning mount), then one call ships it:
      // commit() lands the changes on the mounted repo's MAIN branch — the
      // project worker/website redeploys automatically (no add/push dance,
      // .gitignored files are skipped; scope is optional with one dirty mount).
      const status = await workspace.git.status();
      const committed = await workspace.git.commit({ message: "Workspace example note" });

      return {
        readmePresent: readme !== null,
        edited,
        status,
        commitOid: committed.commitOid,
        committedTo: committed.branch,
        committedMount: committed.mount,
      };
    },
  }),
  projectExample<{
    // bytes()/readFileBytes() are `Uint8Array | null` on the generated
    // surfaces (missing files); this entry just wrote both files, so read
    // them back non-null.
    files: { get(path: string): { bytes(): Promise<Uint8Array> } & FileHandle };
    workspaces: {
      get(path: string): { readFileBytes(path: string): Promise<Uint8Array> } & Workspace;
    };
  }>({
    id: "workspace-files-transfer",
    title: "Move bytes between itx.files and a workspace",
    description:
      "itx.files (R2-backed project file storage: uploads, attachments, signed URLs) and workspaces (repo checkouts) compose through bytes: files.get(path).bytes() → workspace.writeFileBytes pulls a stored file into the checkout; workspace.readFileBytes → files.get(path).put({ data, contentType }) publishes a checkout file to storage (e.g. to mint a signed URL). Gotcha: files.put string data must be base64 — encode plain text with new TextEncoder().encode(text).",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { workspacePath?: string; note?: string }) => {
      const workspace = itx.workspaces.get(vars.workspacePath ?? "/workspaces/example");
      await workspace.create({});

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
    },
  }),
  projectExample({
    id: "repo-commit-files",
    title: "Commit files into the config repo",
    description:
      "Every project has a git-backed repo (itx.repo is the one at path '/'). commitFiles writes a batch of changes as one commit — this is how agents keep durable notes, and how the project worker at worker.ts gets updated (repo-sourced workers are late-bound: the next call sees the new commit).",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { note?: string }) => {
      const commit = await itx.repo.commitFiles({
        message: "Add a note from the examples catalogue",
        changes: [
          {
            path: "notes/example.md",
            content: "# Example note\n\n" + (vars.note ?? "hello from the catalogue") + "\n",
          },
        ],
      });

      // noChanges is true when the tree already matched — commits are idempotent.
      return {
        branch: commit.branch,
        changedPaths: commit.changedPaths,
        noChanges: commit.noChanges,
      };
    },
  }),
  projectExample({
    id: "repo-read-file",
    title: "Read a file from the config repo",
    description:
      "Read committed file contents from the config repo. readFile returns the HEAD commit oid, normalized path, and content, or null when the file does not exist.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { path?: string; repoPath?: string }) => {
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
    },
  }),
  projectExample({
    id: "repo-edit-file",
    title: "Read then edit a config repo file",
    description:
      "Use readFile to inspect the current content, then edit to replace an exact string and commit the change. edit is safe for coding-agent workflows: oldString must match exactly once unless replaceAll is true.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { path?: string; repoPath?: string }) => {
      const path = vars.path ?? "notes/edit-example.md";
      const repo = itx.repos.get(vars.repoPath ?? "/repos/config");
      const beforeText = "status: draft\n";
      const afterText = "status: reviewed\n";

      // Path-scoped repos need first-use creation; the default config repo already exists.
      if (vars.repoPath) await repo.create({ type: "empty" });

      // Seed a known starting point. Agents can skip this when editing an existing file.
      await repo.commitFiles({
        message: "Seed edit example",
        changes: [{ path, content: "# Edit example\n\n" + beforeText }],
      });

      // create waits for repos/created, and commitFiles is a read-your-write boundary.
      const before = await repo.readFile({ path });
      if (before === null) throw new Error("Expected seeded file to exist.");

      const edit = await repo.edit({
        path,
        message: "Mark edit example reviewed",
        oldString: beforeText,
        newString: afterText,
      });

      // edit has the same read-your-write guarantee.
      const after = await repo.readFile({ path });
      if (after === null) throw new Error("Expected edited file to exist.");

      return {
        before: before.content,
        after: after.content,
        changedPaths: edit.changedPaths,
        occurrenceCount: edit.occurrenceCount,
      };
    },
  }),
  projectExample({
    id: "secrets-lifecycle",
    title: "Store a secret; describe() never shows the material",
    description:
      "Secrets are path-addressed write-only capabilities: create() stores the initial material plus the egress URLs it may be substituted into, update() changes an existing secret, and describe() reports metadata only (hasMaterial, egress allowlist, usage audit). Egress requests carry getSecret(path) placeholders; substitution happens server-side.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { secretPath?: string; note?: string }) => {
      const secret = itx.secrets.get(vars.secretPath ?? "/secrets/example");

      // Store the material once, with the URLs it may be substituted into. From
      // here on, egress headers reference it as: getSecret("...").
      await secret.create({
        egress: { urls: ["https://postman-echo.com/"] },
        material: "demo-" + (vars.note ?? "material"),
      });

      // Metadata only: hasMaterial, the egress allowlist, and the usage audit.
      // The material itself has no read API.
      return await secret.__describe();
    },
  }),
  projectExample({
    id: "egress-fetch",
    e2eProven: false,
    title: "Make a plain HTTP request through project egress",
    description:
      "itx.egress.fetch(request) is the raw outbound HTTP door: call an external API, download a file, GET or POST anything — every request project-attributed. It takes ONE argument, a Request (build headers/method/body onto it). Choosing a door: egress.fetch is the plain request; itx.browser.quickAction renders a JS-heavy page and can return markdown; itx.ai.toMarkdown converts documents. Secret placeholders in headers and URL paths substitute at egress; exact JSON string values also substitute when x-iterate-secret-template: json is set (see secret-postman-echo). External service — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { url?: string }) => {
      const url = vars.url ?? "https://example.com/";

      // egress.fetch takes ONE argument — a Request. Options like headers
      // ride on the Request itself (a second fetch-style init is ignored).
      const response = await itx.egress.fetch(
        new Request(url, { headers: { accept: "text/html" } }),
      );
      const body = await response.text();

      return { status: response.status, bodyStart: body.slice(0, 200) };
    },
  }),
  projectExample({
    id: "egress-rules-configured",
    title: "Hold outbound requests to a host for human approval",
    description:
      "Egress rules are project state: append egress-rules-configured with a `hold` rule and any future request to a matching host — itx.egress.fetch, or an agent's own fetch inside its turn, same door either way — parks instead of completing, appending human-approval-requested. A human grants or rejects on the project stream (`iterate approve`, the mobile app's Approvals screen, or a raw grant/reject append) and the held call resolves or refuses. The event REPLACES the project's whole rule list (not a merge) — pass every rule you want kept, not just the new one. Run this once to seed a rule, then trigger a hold with egress-fetch (or just ask an agent to fetch the same host).",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { host?: string; ruleKey?: string; approvalTimeoutMs?: number }) => {
      const host = vars.host ?? "httpbin.org";
      const ruleKey = vars.ruleKey ?? "repl-demo-hold";
      const [appended] = await itx.streams.get("/").append({
        type: "events.iterate.com/project/egress-rules-configured",
        payload: {
          rules: [
            {
              ruleKey,
              description: `Outbound requests to ${host} need a human`,
              match: { hosts: [host] },
              verdict: "hold",
              approvalTimeoutMs: vars.approvalTimeoutMs ?? 600_000,
            },
          ],
        },
      });
      return { host, ruleKey, offset: appended.offset };
    },
  }),
  projectExample({
    id: "grouped-approvals-demo",
    e2eProven: false,
    title: "Grouped approvals demo: a 12-request burst, ONE approval",
    description:
      'DESTRUCTIVE: REPLACES this project\'s egress rules — run it in a disposable project. Installs one `hold` rule on dummy-petshop.iterate.com (our deployed fake pet-shop service), waits for the egress gate to see it, then fires 12 GETs in one Promise.all burst. The egress door coalesces the burst into ONE approval batch event and ONE push ("Script run waiting: 12 requests (12x dummy-petshop.iterate.com)") that deep-links to the batch — Approve all is a single Face ID and a single signed decision, and the script then resolves with every status code. Holds expire after 10 minutes. Interactive by definition: it blocks on a human.',
    runtimes: ["run-script"],
    fn: async (itx, vars: { requests?: number; url?: string }) => {
      // The grouping needs script-execution provenance, which only the
      // run-script isolate mints — hence the single runtime. The target is
      // our own deployed dummy service: harmless, stable, fine with a dozen
      // GETs.
      const url = vars.url || "https://dummy-petshop.iterate.com/";
      const count = vars.requests || 12;

      // REPLACE the project's egress rules with one hold on the demo host.
      const [configured] = await itx.streams.get("/").append({
        type: "events.iterate.com/project/egress-rules-configured",
        payload: {
          rules: [
            {
              ruleKey: "grouped-approvals-demo",
              description: "Grouped-approvals demo: pet-shop GETs need a human",
              match: { hosts: [new URL(url).hostname], methods: ["GET"] },
              verdict: "hold",
              approvalTimeoutMs: 600_000,
            },
          ],
        },
      });

      // Read-your-writes on the fold, then outwait the egress gate's ~5s
      // rules cache (project-durable-object.ts #egressRules) so no request
      // of the burst can slip through pre-hold.
      await itx.processor.waitUntilProcessed({ offset: configured.offset, timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 6_000));

      // The burst. Every fetch parks behind a human decision; expect ONE
      // push, approve all from it, and these promises resolve for real.
      const responses = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          fetch(url + "?grouped-approvals-demo=" + index, { method: "GET" }),
        ),
      );
      return { statuses: responses.map((response) => response.status) };
    },
  }),
  projectExample({
    id: "secret-postman-echo",
    e2eProven: false,
    title: "Use a stored secret in a Postman Echo request",
    description:
      "Stores a secret with Postman Echo on its egress allowlist, sends a request through itx.egress.fetch with an exact getSecret(path) JSON value, and verifies that Postman Echo saw the substituted value while describe() still never exposes the material. External service — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { secretPath?: string; note?: string }) => {
      const secretPath = vars.secretPath ?? "/secrets/postman-echo";
      const material = "demo-" + (vars.note ?? "postman-echo-secret");
      const secret = itx.secrets.get(secretPath);

      await secret.create({
        // Egress checks origins, so this allows any path on postman-echo.com.
        egress: { urls: ["https://postman-echo.com/"] },
        material,
      });

      const response = await itx.egress.fetch(
        new Request("https://postman-echo.com/post?source=itx-secret-example", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-iterate-secret-template": "json",
          },
          body: JSON.stringify({
            secret: `getSecret("${secretPath}")`,
          }),
        }),
      );
      if (!response.ok) {
        throw new Error(`Postman Echo returned ${response.status}: ${await response.text()}`);
      }

      // json() resolves the honest `unknown`; parsing the text keeps this
      // plain-JS body's dynamic reads over the echoed shape typecheckable.
      const body = JSON.parse(await response.text());
      const after = await secret.__describe();
      const echoedSecret = body?.json?.secret;

      return {
        echoedSecretMatches: echoedSecret === material,
        hasMaterial: after.hasMaterial,
        materialLeakedInDescription: JSON.stringify(after).includes(material),
        usedCount: after.audit.usedCount,
      };
    },
  }),
  agentExample({
    id: "secret-collect-from-user",
    e2eProven: false,
    title: "Connect to an API that needs a key: collect the secret from the user",
    description:
      "The full flow for connecting to an external API (an OpenAPI server, a REST endpoint, anything) that needs a bearer token or API key only the user has. NEVER ask for credentials in chat — chat is not a secret store, and you must never see the value. itx.secrets.collectFromUser mints a deep link to a minimal form; the user enters the value there, it is stored write-only and pinned to the egress hosts you chose, and YOU get a message the moment they submit. Also the rotation path: it works on existing secrets (the page warns before replacing). If the user pastes a key into chat instead, use it — unblocking them comes first — but advise rolling it and collecting the replacement here. Needs a human to click the link — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { secretPath?: string; apiOrigin?: string }) => {
      // Scenario: the user said "connect me to https://api.somewhere.com" (spec at
      // /openapi.json) and the API wants "authorization: Bearer <key>".
      //
      // ---- TURN 1: mint the collection link, send it, END YOUR TURN ----
      const secretPath = vars.secretPath ?? "/secrets/somewhere-api";
      const apiOrigin = vars.apiOrigin ?? "https://api.somewhere.com";

      const link = await itx.secrets.collectFromUser({
        path: secretPath,
        egress: { urls: [apiOrigin] },
        description: "API key for " + apiOrigin + " (sent as a Bearer token)",
      });

      await itx.chat.sendMessage(
        "That API needs an API key. [Click here to enter it](" +
          link.url +
          ") — " +
          "it is stored write-only and can only ever be sent to " +
          apiOrigin +
          ". " +
          "I can't see the value; I'll pick up automatically once you've saved it.",
      );
      // End the turn WITHOUT waiting: because you called collectFromUser from your
      // agent scope, the page messages you when the user submits, and that message
      // starts your next turn.
      return;

      // ---- TURN 2 (after 'I submitted the secret at "..."' arrives) ----
      // The value never reaches you. Reference it with a getSecret placeholder —
      // substituted server-side at egress, only toward the pinned hosts:
      //
      // const api = await itx.openapi.connect({
      //   specUrl: apiOrigin + "/openapi.json",
      //   headers: { authorization: 'Bearer getSecret("' + secretPath + '")' },
      // });
      // return await api.__describe(); // operations list — then call them by operationId
      //
      // The same placeholder works on raw requests: itx.egress.fetch(new Request(
      //   apiOrigin + "/v1/me",
      //   { headers: { authorization: 'Bearer getSecret("' + secretPath + '")' } },
      // ));
      //
      // If the user PASTES the key into chat instead of using the link: that is fine —
      // create the secret and proceed (itx.secrets.get(secretPath).create({ material, egress: { urls: [apiOrigin] } })),
      // unblocking them comes first. But the pasted value sat in the transcript, so advise
      // them to roll the key with the provider and collect the replacement via
      // collectFromUser — the same call updates the existing secret in place.
    },
  }),
  projectExample({
    id: "journal-is-the-record",
    title: "The stream IS the record: provide, revoke, read it back",
    description:
      "provideCapability and revokeCapability are appends to the scope's stream (the project root, '/'). Read the stream back and watch the record happen — there is no hidden registry to drift from it.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { capPath?: string }) => {
      // Use a unique mount path so the record slice below is unambiguous.
      const capPath = vars.capPath ?? "journalDemo";

      const provision = await itx.provideCapability({
        expression: ["streams", ["get", "/repl/journal-demo"]],
        path: [capPath],
        type: "itx-call",
      });
      await provision.revoke();

      // The scope's stream is an ordinary stream — same getEvents API as anything.
      const events = await itx.streams.get("/").getEvents();
      const record = events
        .filter(
          (event) => Array.isArray(event.payload?.path) && event.payload.path.join(".") === capPath,
        )
        .map((event) => event.type.split("/").pop());
      return { record }; // ["capability-provided", "capability-revoked"]
    },
  }),
  projectExample({
    id: "agent-send-message",
    title: "Create an agent, then send it a message",
    description:
      "Agents live at /agents/<name> and are addressed through itx.agents.get(path). create() explicitly appends the agent and capability-host birth certificates, setup, and subscriptions, then waits for both processors. message() requires that birth and appends an agents/context-added item — the sender and user/developer role are derived from your scope. Put everything a delegated child needs in its first message.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { agentPath?: string; message?: string }) => {
      const agent = itx.agents.get(vars.agentPath ?? "/agents/repl-demo");
      const snapshot = await agent.processor.snapshot();
      if (snapshot.state.birthCertificate === null) await agent.create();
      // The returned value is the committed stream event — the durable record
      // the agent loop reduces into its context projection.
      const sent = await agent.message(vars.message ?? "Hello from the examples catalogue");
      return { offset: sent.offset, payload: sent.payload, type: sent.type };
    },
  }),
  projectExample({
    id: "docs-search-and-get",
    title: "Find working code + types through itx.docs",
    description:
      "The docs door answers \"how do I X?\": search({ q }) over e2e-tested example scripts (this catalogue), type declarations, and this scope's mounted capabilities; get({ name }) fetches one — an example's full script body, or a type declaration with its referenced types. Matching is dumb word overlap, so pass MANY related words: recall comes from the query.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { name?: string }) => {
      // MANY related words per query — the search is dumb word matching, so
      // synonyms are what buy recall.
      const hits = await itx.docs.search({ q: "repo file edit commit write change" });

      // Hits are { kind: "example" | "type" | "capability", name, summary, fetchCall };
      // each hit's fetchCall field is the literal next call. Example hits are
      // working scripts — copy those first.
      const example = await itx.docs.get({ name: vars.name ?? "describe-project" });
      // Example scripts come back paste-ready: a complete async (itx) => { ... }
      // with the annotation and a vars stub INSIDE the function.

      // Type declarations come back as TypeScript source, ending with a comment
      // naming anything that did not fit (and how to fetch it).
      const streamTypes = await itx.docs.get({ name: "Stream", maxTokens: 800 });

      return {
        hitCount: hits.length,
        firstHit: hits[0] ?? null,
        examplePasteReady: example.startsWith("async (itx) => {") && example.includes("// EXAMPLE"),
        streamTypesIncludeAppend: streamTypes.includes("append("),
      };
    },
  }),
  agentExample({
    id: "chat-message-with-files",
    e2eProven: false,
    title: "Send a chat message with an attached image or file",
    description:
      "itx.chat.sendMessage accepts attachments: files: [{ filename, contentType, data }] where data is a Blob, Uint8Array, or base64 string (what itx.ai.run image models return). One call stores the bytes in project file storage AND attaches them to the message — attached images render inline in the chat and stay visible to you on later turns. Agent-scope only (itx.chat is the agent's conversation); needs a live agent conversation to observe, so run it interactively.",
    runtimes: ALL_RUNTIMES,
    fn: async (
      itx,
      vars: { caption?: string; filename?: string; contentType?: string; data?: FileData },
    ) => {
      // vars.data can be raw bytes or a base64 string — e.g. the b64_json an
      // ai-generate-image run returned. NEVER paste base64 into message text;
      // attach it and let the platform store + render it.
      const sent = await itx.chat.sendMessage(vars.caption ?? "Here you go!", {
        files: [
          {
            filename: vars.filename ?? "picture.png",
            contentType: vars.contentType ?? "image/png",
            data: vars.data ?? new Blob(["hello from the examples catalogue"]),
          },
        ],
      });
      return { offset: sent.offset, type: sent.type };
    },
  }),
  projectExample({
    id: "files-roundtrip",
    title: "Store, read, and share a project file",
    description:
      "itx.files.get(path) is project file storage (R2-backed, mutable paths): put({ data, contentType }) stores bytes — base64 strings (what itx.ai.run image models return), Uint8Array, Blob, or a stream — bytes() reads them back, url() mints a signed public link any HTTP client can fetch (default expiry 7 days), delete() removes the file. Use it to save, keep, or persist data for later and remember state between runs (files hold bytes; streams hold structured events). On agent scopes prefer itx.agent.addFiles: one call that stores AND attaches files to the conversation.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { path?: string; note?: string }) => {
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
    },
  }),
  projectExample<{
    mcp: {
      exa: {
        web_search_exa(input: { query: string; numResults?: number }): Promise<unknown>;
        web_fetch_exa(input: { urls: string[]; maxCharacters?: number }): Promise<unknown>;
      };
    };
  }>({
    id: "exa-web-search",
    e2eProven: false,
    title: "Web search through the built-in Exa MCP server",
    description:
      "itx.mcp.exa is a pre-connected MCP client for Exa's public server (https://mcp.exa.ai/mcp): web_search_exa({ query, numResults }) searches, web_fetch_exa({ urls }) reads pages as markdown. Tool names are flat calls on the client — the same shape any itx.mcp.connect({ url }) client has. External service — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { query?: string; url?: string }) => {
      // Fan independent lookups out in parallel — each tool call is one round trip.
      const [search, pages] = await Promise.all([
        itx.mcp.exa.web_search_exa({
          query: vars.query ?? "Cloudflare Durable Objects",
          numResults: 3,
        }),
        itx.mcp.exa.web_fetch_exa({
          urls: [vars.url ?? "https://developers.cloudflare.com/durable-objects/"],
          maxCharacters: 2000,
        }),
      ]);

      return { pages, search };
    },
  }),
  // String-authored: connect() returns Promise<McpClientRpc> and the first
  // call pipelines a dynamically-named tool onto the un-awaited promise —
  // untypeable in the published surface (tool names come from the server),
  // and itx.publicMcp is a mount this very body creates.
  stringExample({
    id: "connect-public-mcp",
    e2eProven: false,
    title: "Connect a public MCP server, then mount it",
    description:
      "itx.mcp.connect({ url }) opens any reachable MCP server as an ad-hoc capability target. Tool names become flat method calls on the returned client. Mount the same connection recipe as an itx-expression when you want agents and future sessions to discover it through describe() and call it as itx.publicMcp.<tool>(). External service — interactive-only.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const mcpUrl = vars.mcpUrl ?? "https://mcp.exa.ai/mcp";

// Ad-hoc client: no mount, no project event. Tool names are methods on the
// returned client, and connect() pipelines — one expression end to end.
const search = await itx.mcp.connect({ url: mcpUrl }).web_search_exa({
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
  type: "itx-call",
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
  }),
  agentExample({
    id: "connect-mcp-oauth",
    e2eProven: false,
    title: "Connect an OAuth-protected MCP server (the sign-in flow)",
    description:
      'The full flow for an MCP server that needs OAuth — one whose unauthenticated request answers 401 with a WWW-Authenticate challenge (Cloudflare\'s mcp.cloudflare.com, the dummy petshop /mcp, most hosted MCP servers). There is no token to paste: the user must sign in at the provider. itx.mcp.beginOAuth({ url }) discovers the server\'s OAuth endpoints, registers a client, and returns { authorizationUrl, path } — send authorizationUrl to the user ("click here to connect"). When they sign in, the token is stored write-only at `path` and, because you called it from your agent scope, you are messaged so you continue. Then connect like any bearer MCP, referencing the token with a getSecret placeholder on field "accessToken". (If a plain bearer token you already hold is enough, use itx.secrets.collectFromUser instead.) Needs a human to sign in — interactive-only.',
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { mcpUrl?: string; path?: string }) => {
      // Scenario: the user said "connect me to the Cloudflare MCP server". Trying to
      // connect first fails with an auth challenge — that means OAuth, not a token
      // you can ask for.
      //
      // ---- TURN 1: mint the sign-in link, send it, END YOUR TURN ----
      const mcpUrl = vars.mcpUrl ?? "https://mcp.cloudflare.com/mcp";

      // You choose where the token lands (like a secret path); pick something memorable.
      const { authorizationUrl, path } = await itx.mcp.beginOAuth({
        url: mcpUrl,
        path: vars.path ?? "/secrets/mcp/cloudflare",
      });

      await itx.chat.sendMessage(
        "That server uses OAuth. [Click here to sign in](" +
          authorizationUrl +
          ") — " +
          "you authorize it on the provider's own page; I never see your password or token. " +
          "I'll continue automatically once you're done.",
      );
      // End the turn WITHOUT waiting: signing in messages you back, which starts
      // your next turn. Return `path` so the transcript remembers where the token
      // lives (it is /secrets/mcp/<host> unless you passed one).
      return { path };

      // ---- TURN 2 (after "The OAuth connection to ... is done" arrives) ----
      // The token is stored write-only and auto-refreshes. Connect referencing it
      // with a getSecret placeholder — note field: "accessToken" (the material is a
      // token bundle, not a bare string):
      //
      // const cf = await itx.mcp.connect({
      //   url: mcpUrl,
      //   headers: { authorization: 'Bearer getSecret("' + path + '", { field: "accessToken" })' },
      // });
      // return await cf.__describe(); // the server's tools — then call them by name
      //
      // To make it durable (discoverable + callable as itx.cloudflare.<tool>() by
      // future turns), mount the same recipe:
      // await itx.provideCapability({
      //   expression: ["mcp", ["connect", { url: mcpUrl,
      //     headers: { authorization: 'Bearer getSecret("' + path + '", { field: "accessToken" })' } }]],
      //   instructions: "Cloudflare MCP server (OAuth). Tool names discovered from the server.",
      //   path: ["cloudflare"],
      //   type: "itx-call",
      // });
    },
  }),
  projectExample({
    id: "typed-capability-mount",
    title: "Mount a capability with types, then discover and typecheck against it",
    description:
      "provideCapability's `types` field is a TypeScript declaration for the mounted value (first export = the mount's type; bare platform names like Stream resolve). It is validated at provide time, indexed by docs.search, returned by docs.get with the platform declarations it references, and joined into the scope's surface for docs.typecheck — so a script's typo against the mount is a compiler error before it costs a run.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx) => {
      await itx.provideCapability({
        expression: ["streams", ["get", "/"]],
        instructions: "The project root stream, mounted at rootStream.",
        path: ["rootStream"],
        type: "itx-call",
        types: "export type RootStream = Stream;",
      });

      // The types metadata is part of the search haystack, so method names and
      // type text match too — pass MANY related words as always.
      const hits = await itx.docs.search({ q: "rootStream root stream mounted events" });
      const hit = hits.find((h) => h.kind === "capability" && h.name === "rootStream");

      // docs.get on a mount's dotted path returns its instructions and types plus
      // the platform declarations those types reference (Stream here — big enough
      // to need a raised maxTokens; the default 1500 would list it as frontier).
      const entry = await itx.docs.get({ name: "rootStream", maxTokens: 4000 });

      // docs.typecheck compiles a script against this scope's surface — platform
      // types AND typed mounts — without running it.
      const good = await itx.docs.typecheck({
        code: "async (itx) => { return await itx.rootStream.getEvents(); }",
      });
      const typo = await itx.docs.typecheck({
        code: "async (itx) => { return await itx.rootStream.appendd(); }",
      });

      return {
        searchFoundMount: Boolean(hit),
        entryIncludesStreamDeclaration: entry.includes("export interface Stream"),
        goodScriptOk: good.ok,
        typoCaught: typo.ok === false && typo.problems[0]?.includes("appendd"),
      };
    },
  }),
  // String-authored: same pipelining reason as connect-public-mcp —
  // operationIds are methods on the un-awaited Promise<OpenApiRpc>, and
  // itx.petstore is a mount this body creates.
  stringExample({
    id: "connect-openapi-petstore",
    e2eProven: false,
    title: "Connect OpenAPI Petstore, then mount it",
    description:
      "itx.openapi.connect({ specUrl }) fetches an OpenAPI document through project egress and returns a client whose methods are the spec's flat operationIds. This calls Swagger Petstore's findPetsByStatus operation, then registers the same OpenAPI connection as a durable capability at itx.petstore. External service — interactive-only.",
    context: "project",
    runtimes: ALL_RUNTIMES,
    code: `
const petstoreSpecUrl = vars.specUrl ?? "https://petstore3.swagger.io/api/v3/openapi.json";

// operationIds are methods on the connected client, and connect() pipelines
// — call straight through it in one expression.
const availablePets = await itx.openapi
  .connect({ specUrl: petstoreSpecUrl })
  .findPetsByStatus({ status: "available" });

// Mount the recipe when the client should become a named project capability.
await itx.provideCapability({
  expression: ["openapi", ["connect", { specUrl: petstoreSpecUrl }]],
  instructions:
    "Swagger Petstore OpenAPI client. Call itx.petstore.findPetsByStatus({ status: 'available' }) or any other operationId from the spec.",
  path: ["petstore"],
  type: "itx-call",
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
  }),
  projectExample({
    id: "ai-models",
    e2eProven: false,
    title: "Workers AI is a built-in capability",
    description:
      "itx.ai proxies the platform's Workers AI binding: models() lists the catalog, run(model, body) executes one, toMarkdown() converts documents. Model availability and latency depend on the deployment's upstream account, so this entry is reading material for the matrix — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
      const models = await itx.ai.models();
      const list = Array.isArray(models) ? models : [];
      return {
        count: list.length,
        sample: list.slice(0, 5).map((model) => model?.name ?? model),
      };
    },
  }),
  projectExample({
    id: "github-list-repos",
    e2eProven: false,
    title: "List repositories through the built-in GitHub integration",
    description:
      'itx.integrations.github.get().octokit is the all-in-one Octokit from the `octokit` package, with iterate supplying GitHub App installation auth and transport. Its normal `.rest.*`, `.graphql(...)`, and `.request(...)` calls work; pagination uses `.paginate("GET /...", params)` because RPC arguments must be serializable. See https://github.com/octokit/octokit.js/. The `.octokit` segment is mandatory. get() selects the first connected installation; pass a slug only when a specific installation matters. Do not use repo.data.permissions to decide whether an installation is read-only: that user-style field can contain all false even when installation writes work. Attempt the requested operation and use GitHub\'s real error if denied. Needs a connected GitHub installation — interactive-only.',
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { count?: number | string }) => {
      // The connection is a GitHub App installation: this endpoint (not the
      // user-scoped listForAuthenticatedUser, which 403s) enumerates its repos.
      const repos = await itx.integrations.github
        .get()
        .octokit.rest.apps.listReposAccessibleToInstallation({
          per_page: Number(vars.count ?? 5),
        });

      return repos.data.repositories.map((repo) => ({
        fullName: repo.full_name,
        updatedAt: repo.updated_at,
      }));
    },
  }),
  projectExample({
    id: "github-read-file",
    e2eProven: false,
    title: "Read a file from a repo through the built-in GitHub integration",
    description:
      "Fetch file contents with Octokit's request() escape hatch: the raw media type returns the file body as a string (no base64 decode). rest.repos.getContent({ owner, repo, path }) is the JSON alternative — its data.content is base64. Needs a connected GitHub installation with access to the repo — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { owner?: string; repo?: string }) => {
      const owner = vars.owner ?? "octocat";
      const repo = vars.repo ?? "hello-world";
      // README shortcut; use "GET /repos/{owner}/{repo}/contents/{path}" with a path param for any file.
      const readme = await itx.integrations.github
        .get()
        .octokit.request("GET /repos/{owner}/{repo}/readme", {
          owner,
          repo,
          headers: { accept: "application/vnd.github.raw+json" },
        });

      return { firstLines: String(readme.data).split("\n").slice(0, 10), owner, repo };
    },
  }),
  projectExample({
    id: "github-backed-repo",
    e2eProven: false,
    title: "Back a project repo with a real GitHub repository",
    description:
      "linkGithub({ connection, owner, repo }) backs a project repo with GitHub: the GitHub repository is created (private) if the installation can create org repos, later commits mirror out automatically, and fast-forward default-branch pushes on GitHub import through Cloudflare Artifacts. GitHub webhooks are also delivered to the repo's own stream. syncFromGithub() remains the manual repair/forced-adoption verb. Needs a connected GitHub installation — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { owner?: string; repo?: string }) => {
      const connections = await itx.integrations.list();
      const github = connections.find((entry) => entry.integration === "github");
      if (!github?.connection)
        return {
          error: "No GitHub connection — connect one from the dashboard integrations page.",
        };

      const owner = vars.owner; // an org the GitHub App is installed on
      const repoName = vars.repo ?? "iterate-linked-repo-demo";
      if (!owner) return { error: "Pass vars.owner (the GitHub org)." };

      const repo = itx.repo; // or itx.repos.get("/repos/<path>") for a path-scoped repo
      const link = await repo.linkGithub({ connection: github.connection, owner, repo: repoName });
      // link.initialPush reports the seeding push; a commit now mirrors automatically:
      await repo.commitFiles({
        message: "Hello from iterate",
        changes: [{ path: "hello.md", content: "Mirrored to GitHub.\n" }],
      });
      // Webhooks about the repository (pushes, PRs, issues) now land on the repo's
      // own stream as events.iterate.com/github/webhook-received — including the
      // echo of the mirror pushes themselves.
      const state = await repo.processor.snapshot();
      return { link, github: state.state.github, lastGithubPush: state.state.lastGithubPush };
    },
  }),
  projectExample({
    id: "stream-receive-events-from",
    title: "Receive matching events from another stream",
    description:
      "receiver.subscribeToEventsFrom({ sourceStreamPath: source, subscriptionKey, filter?, jsonataTransform?, description? }) starts durable copying from the named source into this receiving stream. filter.eventTypes selects event types and filter.jsonataCondition is a JSONata expression over the whole event that must evaluate to exactly true. jsonataTransform is a JSONata constructor shaping what this stream commits ({ type?, payload?, metadata? }; omitted fields copy verbatim) while provenance and dedupe stay keyed to the source event. Each received event records every stream hop in source.copiedFrom; self-receive is rejected and multi-hop cycles stop before appending to a stream already in that list.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { source?: string; target?: string }) => {
      const source = itx.streams.get(vars.source ?? "/examples/receive-events/source");
      const target = itx.streams.get(vars.target ?? "/examples/receive-events/target");

      await target.subscribeToEventsFrom({
        sourceStreamPath: vars.source ?? "/examples/receive-events/source",
        subscriptionKey: "example/high-importance-notes",
        description: "Demo: high-importance notes land on the target stream.",
        filter: {
          eventTypes: ["events.iterate.example/note"],
          jsonataCondition: 'payload.importance = "high"', // JSONata over the event; optional
        },
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
      return { copied: copied.payload, copiedFrom: copied.source?.copiedFrom };
    },
  }),
  projectExample<{
    // `data` is caller-typed on the surface (request<T = unknown>); a plain-JS
    // body cannot instantiate T, so the shapes this body reads (the message
    // list, then per-message metadata) are declared here instead.
    integrations: {
      gmail: {
        get(connection?: string): {
          request(input: { path: string; query?: Record<string, unknown> }): Promise<{
            data: {
              messages?: Array<{ id: string }>;
              resultSizeEstimate?: number;
              payload?: { headers?: Array<{ name: string; value?: string }> };
            };
          }>;
        };
      };
    };
  }>({
    id: "gmail-search-inbox",
    e2eProven: false,
    title: "Search the inbox through the built-in Gmail integration",
    description:
      "itx.integrations.gmail.get().request({ path, query, method, headers, body }) proxies the Gmail REST API — paths relative to https://gmail.googleapis.com/gmail/v1. get() selects the first connected account; pass a slug only for a specific account. List matching message ids first, then fan out metadata fetches in one Promise.all. Reads real mail — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { q?: string }) => {
      const gmail = itx.integrations.gmail.get();
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
        subjects: messages.map(
          (m) => m.data.payload?.headers?.find((h) => h.name === "Subject")?.value,
        ),
      };
    },
  }),
  projectExample({
    id: "slack-post-message",
    e2eProven: false,
    title: "Post a message through the built-in Slack integration",
    description:
      "itx.integrations.slack.get() IS a real Slack WebClient (@slack/web-api): any Web API method as a dotted path, always ONE body object — chat.postMessage({ channel, text }), conversations.list({ limit }), users.info({ user }). get() selects the first connected workspace; pass a slug only for a specific workspace. Posts to a real workspace — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { channel?: string; text?: string }) => {
      const client = itx.integrations.slack.get();
      // Find a channel to talk in; vars.channel (an id like C0123...) skips the lookup.
      const channels = await client.conversations.list({
        exclude_archived: true,
        limit: 20,
        types: "public_channel",
      });
      const channel = vars.channel ?? channels.channels?.[0]?.id;
      if (!channel) return { error: "No channel found", channels };

      const posted = await client.chat.postMessage({
        channel,
        text: vars.text ?? "Hello from itx!",
      });
      return { channel, ok: posted.ok, ts: posted.ts };
    },
  }),
  projectExample<{
    // Provided integrations resolve through the capability table at runtime;
    // the static ProjectIntegrations only knows the built-in families.
    integrations: {
      "github-mcp": { get(connection?: string): { get_me(input: object): Promise<any> } };
    };
  }>({
    id: "github-mcp-connect",
    e2eProven: false,
    title: "GitHub's MCP server as a provided integration",
    description:
      "The provided-integration lane, using GitHub's official MCP server: store a fine-grained PAT as a project secret, mount the server into the collection with one durable provideCapability, and call it through the same `.get(connection?)` selector a builtin uses. The PAT rides as a getSecret placeholder substituted at project egress — no isolate ever holds it. (The BUILT-IN github integration — dashboard connect, the wrapped Octokit at itx.integrations.github.get(), sandbox gh — is separate; this mounts under the github-mcp slug because built-in slugs cannot be shadowed.) Needs a real PAT in vars.githubPat — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx, vars: { connection?: string; githubPat?: string }) => {
      const connection = vars.connection ?? "main";
      const tokenPath = `/secrets/integrations/github-mcp/${connection}/token`;

      // 1. The PAT lives in a Secret DO with a GitHub-only egress allowlist.
      const secret = itx.secrets.get(tokenPath);
      await secret.create({
        egress: { urls: ["https://api.githubcopilot.com/", "https://api.github.com/"] },
        material: vars.githubPat,
      });

      // 2. One durable mount makes GitHub part of the integrations collection. The
      // itx-expression is a journaled recipe: replayed per call, revocable,
      // enumerated by itx.integrations.list(). Mount at the PROJECT ROOT:
      // itx.integrations.* resolves through the project capability table, so an
      // own-scope itx.provideCapability from an agent is unreachable there.
      await itx.capabilityHosts.get("/").provideCapability({
        path: ["integrations", "github-mcp", connection],
        type: "itx-call",
        instructions:
          "GitHub via the official MCP server: create_issue({ owner, repo, title }), list_pull_requests, get_file_contents, search_code, ...",
        expression: [
          "mcp",
          [
            "connect",
            {
              url: "https://api.githubcopilot.com/mcp/",
              headers: { authorization: `Bearer getSecret("${tokenPath}")` },
            },
          ],
        ],
      });

      // 3. Same selector shape as a builtin — {slug}.get(connection).{method}.
      const me = await itx.integrations["github-mcp"].get(connection).get_me({});
      return { login: me?.login ?? me, listed: await itx.integrations.list() };
    },
  }),
  projectExample({
    id: "github-webhooks-project-worker",
    e2eProven: false,
    title: "GitHub webhooks land on the project's own host",
    description:
      "Per-project webhook ingress already exists: every project host routes to the repo-backed worker.ts, whose fetch can append inbound requests to the connection's /integrations/github/{connection} stream. A configured worker or agent processor then receives those events. Point the GitHub repo/app webhook URL at https://<project-slug>.<base>/webhooks/github/<random-token> (the unguessable token in the path is the auth — worker code cannot hold the HMAC signing secret, by design). MUTATING: this REPLACES the seeded worker.ts (homepage + app router) wholesale — merge the route into your existing fetch instead if you have one. Run it interactively.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx, vars: { connection?: string; urlToken?: string }) => {
      const connection = vars.connection ?? "main";
      const urlToken = vars.urlToken ?? crypto.randomUUID();
      const journalPath = `/integrations/github/${connection}`;

      await itx.repo.commitFiles({
        message: "Receive GitHub webhooks on the project host",
        changes: [
          {
            path: "worker.ts",
            content: `
import { WorkerEntrypoint } from "cloudflare:workers";

export default class ProjectWorker extends WorkerEntrypoint {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/webhooks/github/${urlToken}" && req.method === "POST") {
      const project = await this.env.ITX.get();
      await project.streams.get("${journalPath}").append({
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
`,
          },
        ],
      });

      return {
        webhookPathOnProjectHost: `/webhooks/github/${urlToken}`,
        journalPath,
        note: "Set the GitHub webhook URL to the project host + that path; deliveries land on the journal, where itx.integrations.list() enumerates the connection.",
      };
    },
  }),
  projectExample({
    id: "cf-ai-to-markdown",
    e2eProven: false,
    title: "Convert a document to Markdown with Workers AI",
    description:
      "Cloudflare Workers AI Markdown Conversion is available as itx.integrations.cf.ai.toMarkdown() and the root shortcut itx.ai.toMarkdown(). Call with no args for supported formats. Uses Cloudflare AI infrastructure — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
      const supported = await itx.ai.toMarkdown();
      const csv = new Blob(["name,value\nalpha,1\nbeta,2\n"], { type: "text/csv" });
      const converted = await itx.integrations.cf.ai.toMarkdown({ name: "sample.csv", blob: csv });
      return { supported: supported.slice(0, 10), converted };
    },
  }),
  projectExample<{
    // run's output is caller-typed (run<T = unknown>) and a plain-JS body
    // cannot instantiate T, so each ai entry declares the shape it reads.
    // Text-generation models answer in `response`.
    ai: { run(model: string, body: unknown): Promise<{ response?: string }> };
  }>({
    id: "ai-generate-text",
    e2eProven: false,
    title: "Generate or summarize text with a hosted LLM",
    description:
      "The most common model task: summarize, draft, classify, extract, rewrite, or answer questions by running a 'Text Generation' model through itx.ai.run() with { messages } (chat shape) and reading result.response. itx.ai.models() lists the catalog with prices. Uses paid/remote AI infrastructure — interactive-only.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { text?: string }) => {
      const text =
        vars.text ?? "Cloudflare Workers run JavaScript close to users in hundreds of cities.";

      const result = await itx.ai.run("@cf/meta/llama-3.2-3b-instruct", {
        messages: [
          { role: "system", content: "Summarize the user's text in one short sentence." },
          { role: "user", content: text },
        ],
      });

      // Text models answer in result.response.
      return { summary: result.response };
    },
  }),
  projectExample<{
    // Same run<T> rationale as ai-generate-text; FLUX answers with a
    // base64 image in `image`.
    ai: { run(model: string, body: unknown): Promise<{ image?: string }> };
  }>({
    id: "ai-generate-image",
    e2eProven: false,
    title: "Generate an image with a Workers AI model",
    description:
      "Generates an image with Cloudflare-hosted FLUX.2 [klein] 9B through itx.ai.run(). The model accepts multipart input and returns a base64 image in image. First-party docs: https://developers.cloudflare.com/ai/models/%40cf/black-forest-labs/flux-2-klein-9b/ . Uses paid/remote AI infrastructure — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
      const form = new FormData();
      form.append(
        "prompt",
        "A compact product photo of a brushed steel desk lamp on a white background",
      );
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
    },
  }),
  projectExample<{
    // Same run<T> rationale as ai-generate-text; Grok TTS answers with a
    // hosted MP3 URL in `result.audio`.
    ai: { run(model: string, body: unknown): Promise<{ result?: { audio?: string } }> };
  }>({
    id: "ai-generate-audio",
    e2eProven: false,
    title: "Generate speech audio with a Workers AI model",
    description:
      "Speaks text with xAI Grok TTS via itx.ai.run(). The model returns a hosted MP3 URL in result.audio. ElevenLabs is available through Cloudflare AI Gateway provider-native calls with an ElevenLabs token, not this zero-key env.AI.run path. First-party docs: https://developers.cloudflare.com/ai/models/xai/grok-tts/ . Uses paid/remote AI infrastructure — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
      const response = await itx.ai.run("xai/grok-tts", {
        text: "Hello from itx. This audio was generated with a Cloudflare Workers AI speech model.",
        voice_id: "ara",
        language: "en",
        output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 192000 },
      });

      return {
        docs: "https://developers.cloudflare.com/ai/models/xai/grok-tts/",
        audioUrl: response?.result?.audio,
        response,
      };
    },
  }),
  projectExample<{
    // Same run<T> rationale as ai-generate-text; Grok STT answers with the
    // transcription fields under `result`.
    ai: {
      run(
        model: string,
        body: unknown,
      ): Promise<{
        result?: { text?: string; language?: string; duration?: number; words?: unknown[] };
      }>;
    };
  }>({
    id: "ai-transcribe-audio",
    e2eProven: false,
    title: "Transcribe audio with a Workers AI model",
    description:
      "Transcribes audio with xAI Grok STT via itx.ai.run() against a small public MP3 URL and returns the transcription. First-party docs: https://developers.cloudflare.com/ai/models/xai/grok-stt/ . Uses paid/remote AI infrastructure and a public fetch — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
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
    },
  }),
  projectExample<{
    // Same run<T> rationale as ai-generate-text; Grok Imagine Video answers
    // with a hosted MP4 URL in `result.video`.
    ai: { run(model: string, body: unknown): Promise<{ result?: { video?: string } }> };
  }>({
    id: "ai-generate-video",
    e2eProven: false,
    title: "Generate video with a Workers AI model",
    description:
      "Runs xAI Grok Imagine Video through itx.ai.run(). The model returns a hosted MP4 URL in result.video. First-party docs: https://developers.cloudflare.com/ai/models/xai/grok-imagine-video/ . Uses paid/remote AI infrastructure — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
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
    },
  }),
  projectExample<{
    // quickAction's return is action-shaped (`unknown`); markdown is a string.
    browser: { quickAction(action: "markdown", options: { url: string }): Promise<string> };
  }>({
    id: "cf-browser-markdown",
    e2eProven: false,
    title: "Render a page to Markdown with Browser Run",
    description:
      "Cloudflare Browser Run quick actions are available as itx.browser.quickAction() and itx.integrations.cf.browser.quickAction(). This renders a real page and converts it to Markdown. External service — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
      const markdown = await itx.browser.quickAction("markdown", {
        url: "https://developers.cloudflare.com/browser-run/quick-actions/",
      });
      return markdown.slice(0, 4_000);
    },
  }),
  projectExample<{
    // The binding accepts a body stream; the generated input type is stricter
    // (non-null) than the fetch body the entry pipes in.
    integrations: {
      cf: {
        images: {
          transform(input: {
            image: any;
            transforms: unknown[];
            output?: unknown;
          }): Promise<Response>;
        };
      };
    };
  }>({
    id: "cf-images-transform",
    e2eProven: false,
    title: "Resize and convert an image with Cloudflare Images",
    description:
      "Cloudflare Images transformations are available as itx.integrations.cf.images.transform({ image, transforms, output }). It accepts private streams too, not just public URLs. External fetch + Images binding — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
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
    },
  }),
  projectExample<{
    // Same nullability gap as cf-images-transform, for the video stream.
    integrations: {
      cf: {
        videos: {
          transform(input: {
            video: any;
            transform?: unknown;
            output?: unknown;
          }): Promise<Response>;
        };
      };
    };
  }>({
    id: "cf-videos-frame",
    e2eProven: false,
    title: "Extract a video frame with Media Transformations",
    description:
      "Cloudflare Media Transformations are available as itx.integrations.cf.videos.transform({ video, transform, output }). Use output.mode = frame, spritesheet, audio, or video. External fetch + Media binding — interactive-only.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
      const source = await fetch(
        "https://pub-d9fcbc1abcd244c1821f38b99017347f.r2.dev/aus-mobile.mp4",
      );
      const frame = await itx.integrations.cf.videos.transform({
        video: source.body,
        transform: { width: 480, fit: "scale-down" },
        output: { mode: "frame", time: "1s", format: "jpg" },
      });
      return {
        contentType: frame.headers.get("content-type"),
        bytes: (await frame.arrayBuffer()).byteLength,
      };
    },
  }),
  projectExample({
    id: "email-send",
    e2eProven: false,
    title: "Send an email from the project's address",
    description:
      "itx.email.send() delivers real mail through Cloudflare Email Service from the project's own address (<slug>@<hostname base>); an explicit `from` must match it. Needs the deployment's sender domain onboarded for Email Sending, and it emails a real recipient — interactive-only, with an address you own.",
    runtimes: LIVE_SESSION_RUNTIMES,
    fn: async (itx) => {
      const receipt = await itx.email.send({
        to: "you@example.com", // a mailbox you own — this sends real mail
        subject: "Hello from itx",
        text: "Sent by an agent through Cloudflare Email Service.",
      });
      return receipt; // { from: "<slug>@<hostname base>", messageId }
    },
  }),
  projectExample({
    id: "scheduler-basics",
    title: "Schedule an itx script (set, list, cancel)",
    description:
      "itx.scheduler runs itx scripts on a schedule: set() upserts by key with recurrence { cron, timezone? } | { every: seconds } | { at: ISO } | { in: seconds }, list() reads the reduced state, cancel(key) removes. Use it to wait, delay, or defer work — do something later, tomorrow, at a specific time, or on a recurring cadence — and to give agents reminders. The script is a STRING (no closures — bake values in) invoked later as fn(itx, schedule, trigger) with project-root authority, at least once per Trigger. Every set, trigger, and outcome is an event on the /scheduler/primary stream — the complete audit log.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { schedulerKey?: string }) => {
      // Upsert by key: re-setting the same key replaces the schedule. Returns after
      // the scheduler has durably ingested it (read-your-writes), with the computed
      // next occurrence.
      const key = vars.schedulerKey ?? "examples/daily-report";
      const view = await itx.scheduler.set({
        key,
        recurrence: { cron: "0 9 * * MON-FRI", timezone: "Europe/London" },
        // The script runs later in its own isolate. schedule = { key, path,
        // recurrence, metadata?, setAt }; trigger = { executionId, scheduledFor,
        // requestedAt, runCount }. Inside it, `await itx.projectId` and
        // `await itx.capabilityHost.path` identify where it is running.
        script: `async (itx, schedule, trigger) => {
    // At-least-once delivery: key appends by trigger.executionId so a
    // crash-retry cannot double-write.
    await itx.streams.get("/reports/daily").append({
      type: "com.example/report-requested",
      idempotencyKey: "report:" + trigger.executionId,
      payload: { scheduledFor: trigger.scheduledFor, runCount: trigger.runCount },
    });
    return "requested"; // recorded in the trigger-completed event
  }`,
        metadata: { owner: "examples" },
      });

      const schedules = await itx.scheduler.list(); // every schedule, straight from reduced state

      // Clean up so this example leaves nothing behind (an emptied scheduler
      // deletes its alarm and sleeps).
      await itx.scheduler.cancel(key);
      return { found: schedules.some((s) => s.key === key), nextTriggerAt: view.nextTriggerAt };
    },
  }),
  projectExample({
    id: "scheduler-agent-checkin",
    title: "Give an agent a recurring task",
    description:
      "The scheduler + agents flywheel: schedule a script that explicitly creates an agent when its birth certificate is absent, sends it a message, and the agent wakes on cadence, does the work, and reports in its own chat. A fixed path reuses one agent; a date-stamped path creates a new agent per occurrence.",
    runtimes: ALL_RUNTIMES,
    fn: async (itx, vars: { schedulerKey?: string }) => {
      const key = vars.schedulerKey ?? "examples/agent-checkin";
      const view = await itx.scheduler.set({
        key,
        recurrence: { every: 3600 }, // seconds; re-anchors on each trigger
        script: `async (itx, schedule, trigger) => {
    // A fixed path = one long-lived agent accumulating context. For a fresh
    // agent per occurrence use a derived path instead, e.g.
    // "/agents/standup-" + trigger.scheduledFor.slice(0, 10).
    const agent = itx.agents.get("/agents/checkin");
    const snapshot = await agent.processor.snapshot();
    if (snapshot.state.birthCertificate === null) await agent.create();
    await agent.message(
      "Scheduled check-in #" + trigger.runCount + ": summarize anything new since last time."
    );
  }`,
      });

      // Run it once right now without waiting for the hour (advances the clock):
      // await itx.scheduler.trigger(key);

      // Keep this example inert:
      await itx.scheduler.cancel(key);
      return { nextTriggerAt: view.nextTriggerAt };
    },
  }),
];

// ─────────────────────────────────────────────────────────────────────────────
// MACHINERY — the types and helpers the entries above are authored with, and
// the rules for writing new ones.
// ─────────────────────────────────────────────────────────────────────────────
//
// Why functions here but strings in the artifact: authored functions give
// the catalogue real types (a typo against the itx surface is a compile
// error in THIS file), while every runtime consumes plain-JS body strings
// (the REPL, AsyncFunction in node, runScript, worker.ts baking). Deriving
// the string at GENERATION time in Node is load-bearing: production bundles
// minify, so `fn.toString()` in the built app would return mangled code —
// never derive catalogue strings in the browser.
//
// Authoring rules (the generator enforces the mechanical ones):
// - `fn` must be a BLOCK-BODIED arrow: `async (itx) => { … }` or
//   `async (itx, vars: { … }) => { … }`, with an explicit `return`.
// - The BODY must be plain JavaScript — no annotations, casts, `satisfies`,
//   or non-null `!` inside (the generator parses the body with the JS-only
//   AsyncFunction constructor and fails on TS residue). TypeScript lives in
//   the parameter annotations and the per-entry widenings, which the
//   generator never emits.
// - Bodies must be SELF-CONTAINED: only `itx`, `vars`, and runtime globals
//   exist where they run. The typecheck guard (examples-typecheck.test.ts)
//   fails on a body that reaches for module scope.
// - Dynamic capabilities an entry provides and then calls (`itx.answer.…`)
//   are typed per entry via the helper's `Extra` widening — the mount types
//   double as documentation.
// - `vars` is JSON-serialized into the script by every runtime; type exactly
//   what the body reads (all fields optional — the REPL runs entries with no
//   vars at all), loose only where genuinely dynamic.
// - Entries that CANNOT be expressed as a typed function without changing
//   their body text go through `stringExample` with a comment saying why —
//   the recurring reason is capnweb promise pipelining (`connect(...).tool()`
//   chains a call onto an un-awaited Promise, which the published
//   Promise-based types cannot express).
//
// Catalogue semantics (what the fields mean, which runtimes run what) are
// documented on the public types in src/itx/examples.ts.

/** A typed catalogue entry: the metadata of {@link ItxExample} with the
 * script authored as a function (`fn`) or, for entries the type surface
 * cannot express, as the literal body string (`code`). Exactly one of the
 * two is present; the generator derives the artifact's `code` from `fn`'s
 * original source text. */
type ItxExampleSource = Omit<ItxExample, "code"> & {
  fn?: (itx: never, vars: never) => Promise<unknown>;
  code?: string;
};

type ExampleMeta = Omit<ItxExampleSource, "context" | "fn" | "code">;

/** A project-context entry. `Extra` types the dynamic capabilities the body
 * itself mounts and then calls — intersected FIRST so its signatures win. */
function projectExample<Extra extends object = {}>(
  entry: ExampleMeta & { fn: (itx: Extra & Project, vars: never) => Promise<unknown> },
): ItxExampleSource {
  return { ...entry, context: "project" };
}

/** An agent-scoped itx: the project surface with the agent-only members
 * guaranteed present (`Project` declares `agent`/`chat` optional because
 * they exist only on itxs scoped under /agents/**). The agent's
 * birth-mounted `itx.workspace` is a dynamic capability with no static
 * member — an entry using it would widen via `Extra`. */
function agentExample<Extra extends object = {}>(
  entry: ExampleMeta & {
    fn: (itx: Extra & Project & { agent: Agent; chat: AgentChat }, vars: never) => Promise<unknown>;
  },
): ItxExampleSource {
  return { ...entry, context: "agent" };
}

// The OS Session (what `authenticate()` returns): NOT an itx — a catalog
// that vends project itxs (`__describe` with `principal`, `projects`).
// eslint-disable-next-line iterate/no-single-use-helpers -- one of the catalogue's three uniform per-context authoring doors; only one session entry is currently fn-authored (list-projects is string-authored), but the pattern is the API.
function sessionExample(
  entry: ExampleMeta & { fn: (itx: Session, vars: never) => Promise<unknown> },
): ItxExampleSource {
  return { ...entry, context: "session" };
}

/** The escape hatch: a string-authored entry, for bodies the published types
 * cannot express without changing their text (each use says why). */
function stringExample(
  entry: ExampleMeta & { context: ItxExample["context"]; code: string },
): ItxExampleSource {
  return entry;
}

/** A live provider object as its callers see it: every function, at any
 * depth, comes back promise-wrapped (calls replay over the open session). */
type Remoted<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : Remoted<T[K]>;
};

/** Types one live mount end to end: the provideCapability call that installs
 * `Impl` (as written locally — the published input type leaves the live arm's
 * `capability` as `unknown`, so the entry's declared shape is the doc) and
 * the mounted member at `Name`, whose calls come back promise-wrapped. Pass
 * `Mounted` explicitly when `flattenNestedPaths` makes the mounted method
 * tree differ from `Impl`. */
type Live<Name extends string, Impl, Mounted = Remoted<Impl>> = Record<Name, Mounted> & {
  provideCapability(input: {
    capability: Impl;
    flattenNestedPaths?: true;
    instructions?: string;
    path: [Name];
    type: "live";
  }): Promise<CapabilityProvision>;
};
