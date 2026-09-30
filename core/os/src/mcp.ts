import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { z } from "zod";
import { codedError, errorCode, ITERATE_CAUSE_HEADER } from "iterate/lib";
import { platformAddressesOf } from "./app-config.ts";
import { GLOBAL_PROJECT_ID } from "./context/paths.ts";
import type { Env } from "./env.ts";
import { contextStub } from "./context-stub.ts";
import { ControlPlane, type Reach } from "./control-plane/edge.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import type { Authorization } from "./oauth.ts";
import { parseCause, type Cause } from "./cause.ts";

// MCP uses the same authorization and project root as a Cap’n Web project handle. The OAuth
// grant or personal access token limits which projects can be selected; each run is attributed to
// it on the root log. A connection is not a child sandbox with a second, narrower set of
// capabilities. The operator's bearer is refused here (oauth.ts `validateToken`): every caller is a
// person.

/** Resolve a project slug or id within this token's grant before obtaining its root context. */
async function projectOfToolCall(
  controlPlane: ControlPlane,
  reach: Reach,
  requested: string,
): Promise<string> {
  if (requested) {
    const { projectId, path } = DurableObjectNameCodec.parse(requested);
    if (path !== "/")
      throw new Error(
        `project: got a context name ${JSON.stringify(requested)} — pass the project and cd(path) in the expression`,
      );
    // the same refusal as projects.get (session.ts): the global namespace is no project
    if (projectId === GLOBAL_PROJECT_ID)
      throw codedError(
        "FORBIDDEN",
        `project ${JSON.stringify(requested)}: the deployment-global namespace is no project`,
      );
    const id = await controlPlane.reachableProjectId(reach, projectId);
    if (!id)
      throw codedError(
        "FORBIDDEN",
        `project ${JSON.stringify(requested)} is outside this token's grant`,
      );
    return id;
  }
  const reachable = (await controlPlane.reachableProjects(reach)).map((project) => project.id);
  if (reachable.length === 1) return reachable[0]!;
  throw new Error(
    reachable.length
      ? `pass project — this token reaches ${reachable.join(", ")}`
      : "this token reaches no project",
  );
}

// Shared by initialize and tools/list so clients receive the same usage guidance from either.
const runInstructionsOf = (platformOrigin: string) =>
  [
    "One tool, `run({ project?, script })`: evaluate a JavaScript function, `async (itx) => { ... }`, with the selected project's root `itx` handle at `/`. Pass a project slug or id when your token reaches several projects.",
    'Start by inspecting identity and capabilities:\n```json\n{"script":"async (itx) => ({ identity: await itx.whoami(), capabilities: await itx.rewriteRules.list() })"}\n```',
    'Use `itx.cd("/path")` to address another context in this project. Each call runs the complete script in a worker, for at most ten minutes; await operations and return JSON-serializable results. Carry state between calls in returned results or stored data. Requests and settlements are logged at `/`, attributed to your principal and grant, and what your script writes carries them too, as `source.onBehalfOf` (the script itself calls as the project\'s code), and a commit it makes is authored by you unless it names an `author`, is committed by iterate, and ends with an `Iterate-Run:` trailer; end your commit message with `Via: <your name>` (e.g. `Via: Claude Code`) so it says which agent did the work; project rewrite rules apply.',
    'The config repo is `itx.repos.get("/repos/config")`. Use `listFiles()` and `readFile(path)` to inspect existing files, including `AGENTS.md` when present. `commitFiles({ message, changes, parent? })` takes the whole new content of each changed file (`{ path, content }`, or `{ path, delete: true }`); there is no patch operation. To edit a file, change its text inside your script with any JavaScript (`replace`, a regular expression, split and join) and commit the result, passing the tip you read as `parent` so the commit is refused if main moved meanwhile; the file never has to pass through your context. File paths are repo-relative. A config-repo commit publishes the project worker a few seconds after it lands, and every commit gets one outcome event on the root: `const outcome = await itx.waitForEvent({ type: ["events.iterate.com/project/worker-updated", "events.iterate.com/project/worker-update-failed"], payload: { commitOid }, afterOffset: 0, timeoutMs: 120000 })`, then `outcome.payload.error` says why a `worker-update-failed` commit is not live.',
    `Read the current worker:
\`\`\`json
{"script":"async (itx) => itx.repos.get('/repos/config').readFile('worker.ts')"}
\`\`\``,
    `Edit a file in place (this writes to the repo; replace the example path and pattern with your intended edit):
\`\`\`json
{"script":"async (itx) => { const repo = itx.repos.get('/repos/config'); const tip = await repo.tip(); const source = await repo.readFile('worker.ts', { commitOid: tip }); const next = source.replace(/Homepage of project /, 'Welcome to '); if (next === source) throw new Error('the homepage text is not in worker.ts'); return repo.commitFiles({ message: 'Change the homepage greeting', parent: tip, changes: [{ path: 'worker.ts', content: next }] }); }"}
\`\`\``,
    `Add a file, or several in one commit:
\`\`\`json
{"script":"async (itx) => itx.repos.get('/repos/config').commitFiles({ message: 'Add a note', changes: [{ path: 'notes.txt', content: 'Hello from MCP' }] })"}
\`\`\``,
    'Website source is the config repo: `package.json` names its main module in `"main"` (`worker.ts`). Files may be TypeScript (types are stripped, not checked) or JavaScript and import each other by relative path. Import packages by name: `iterate/*` and `zod` come from the platform, any other package is listed in `package.json` `dependencies` and fetched from npm through esm.sh (packages that need Node.js builtins are refused). The default export of the main module is a class that extends `IterateConfigEntrypoint` from `iterate/sdk`; publication refuses any other. Preview a candidate with `itx.workers.get({ source: { ...(await itx.repos.get("/repos/config").modules()), "worker.ts": candidateSource } }).fetch(new Request(projectUrl))`: the repo\'s files under their repo paths, your edits over them. Once its outcome is `worker-updated`, the site serves it within 5 seconds: fetch the `projectUrl` returned by `itx.whoami()` and verify the expected response before reporting publication success.',
    "Working examples: https://raw.githubusercontent.com/iterate/iterate/main/test/vitest/os/mcp-project-root.e2e.test.ts — use the `async (itx) => ...` scripts and repo commit examples. The surrounding OAuth setup, project creation and assertions are the integration-test harness; your MCP connection supplies authentication and the project handle. Discover the live capabilities with `itx.rewriteRules.list()`.",
    `To connect a service to the project (an API key, an OAuth app, a hosted MCP server, an OpenAPI API), first read the whole guide at ${platformOrigin}/connect-a-service.md through this tool, \`async (itx) => (await itx.fetch(new Request("${platformOrigin}/connect-a-service.md"))).text()\`, then follow it step by step.`,
  ].join("\n\n");

/** Initialization includes usage guidance and the projects this token reaches, so the client can
 *  select one before running a script. Read from the control plane, like the tool's project check,
 *  and only for a request whose answer carries them (`answersWithInstructions`). */
async function serverInstructions(
  controlPlane: ControlPlane,
  reach: Reach,
  platformOrigin: string,
): Promise<string> {
  const projects = await controlPlane.reachableProjects(reach);
  const reachable =
    projects.length === 0
      ? "This token reaches no project."
      : projects.length === 1
        ? `This token reaches one project, ${projects[0]!.slug} (${projects[0]!.id}) — \`project\` may be omitted.`
        : `This token reaches ${String(projects.length)} projects — pass \`project\` (slug or id): ${projects.map((project) => `${project.slug} (${project.id})`).join(", ")}.`;
  return [runInstructionsOf(platformOrigin), reachable].join("\n");
}

const validator = new CfWorkerJsonSchemaValidator();

/** A tool's input schema as `fromJsonSchema` takes it — the SDK's own JSON-Schema type. */
type JsonSchema = Parameters<typeof fromJsonSchema>[0];

async function buildServer(
  env: Env,
  authorization: Authorization,
  platformOrigin: string,
  instructed: boolean,
  /** The chain the request resumes, when it carries our mark (cause.ts). */
  cause: Cause | undefined,
): Promise<McpServer> {
  const controlPlane = new ControlPlane(env);
  const { reach, principal, grant } = authorization;
  const caller = { principal, grant: grant?.grantId, platformOrigin, cause };
  const mcpServer = new McpServer(
    { name: "control-plane", version: "0.1.0" },
    instructed
      ? { instructions: await serverInstructions(controlPlane, reach, platformOrigin) }
      : {},
  );

  mcpServer.registerTool(
    "run",
    {
      title: "Run a script",
      description: runInstructionsOf(platformOrigin),
      inputSchema: fromJsonSchema(
        {
          type: "object",
          additionalProperties: false,
          required: ["script"],
          properties: {
            project: {
              type: "string",
              description:
                "The project — its slug or its id. Optional when this token reaches exactly one.",
            },
            script: {
              type: "string",
              minLength: 1,
              description:
                "The text of an async function of one parameter, `itx`: `async (itx) => { const n = Number(await itx.kv.get('n')) || 0; await itx.kv.put('n', String(n + 1)); return n + 1; }`. It bakes in its own values (there are no arguments — write the whole script). Return a JSON-serializable value (undefined, functions and live handles do not cross the boundary).",
            },
          },
        } as JsonSchema,
        validator,
      ),
    },
    async (raw: unknown) => {
      // fromJsonSchema's validator has checked `raw` against the schema above: `script` required,
      // nothing else but `project`
      const toolArguments = raw as { project?: string; script: string };
      try {
        const projectId = await projectOfToolCall(
          controlPlane,
          reach,
          toolArguments.project?.trim() ?? "",
        );
        // Execute against the authorized root, through its rules, exactly as a project handle does
        // (`contextStub`, which reads the run's settlement back). The request carries the principal
        // and grant; the root's runner records its settlement.
        const value = await contextStub(
          env.ITERATE_CONTEXT,
          DurableObjectNameCodec.address({ projectId, path: "/" }),
          "mcp",
        ).invoke(["itx", ["run", toolArguments.script]], [], caller);
        // THE JSON BOUNDARY: a round trip drops what JSON cannot carry and throws on what it refuses.
        const json = JSON.stringify(value) ?? "null";
        return {
          content: [{ type: "text" as const, text: json }],
          isError: false, // a success is an explicit non-error
          structuredContent: { result: JSON.parse(json) as unknown },
        };
      } catch (error) {
        // A tool FAILURE as the protocol's own channel — an isError result, never a thrown 500 — its
        // text led by the platform's error CODE (lib.ts: NO_ITX_EXPRESSION_MATCH, INVALID_CONTEXT, …)
        // when present so a client can classify it, then the message.
        const message = error instanceof Error ? error.message : String(error);
        const code = errorCode(error);
        return {
          content: [{ type: "text" as const, text: code ? `${code}: ${message}` : message }],
          isError: true,
        };
      }
    },
  );

  return mcpServer;
}

/** The shared bearer gate has established this principal and reach. Serving is stateless (the
 *  SDK's `createMcpHandler` builds a server per HTTP request), so each POST builds its own. */
export async function mcpResponse(request: Request, env: Env, authorization: Authorization) {
  const instructed = await answersWithInstructions(request);
  return createMcpHandler(() =>
    buildServer(
      env,
      authorization,
      platformAddressesOf(env, request).platformOrigin,
      instructed,
      parseCause(request.headers.get(ITERATE_CAUSE_HEADER)),
    ),
  ).fetch(request);
}

/** A JSON-RPC request whose answer carries the server's instructions: the 2025 handshake's
 *  `initialize` and the 2026-07-28 revision's `server/discover` (the SDK's `Server._oninitialize`
 *  and `_ondiscover`, @modelcontextprotocol/server 2.0.0). */
const InstructedRequest = z.object({ method: z.enum(["initialize", "server/discover"]) });

/** Whether `request` (a message or a batch) asks for an answer that carries the instructions: a
 *  tool call, a list or a notification does not, so it reads no project list. Read from a copy, so
 *  the SDK reads and refuses the body as it always does. */
async function answersWithInstructions(request: Request) {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return [body].flat().some((message) => InstructedRequest.safeParse(message).success);
}
