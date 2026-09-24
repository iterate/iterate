import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { z } from "zod";
import { codedError, errorCode } from "iterate/lib";
import { platformAddressesOf } from "./app-config.ts";
import { GLOBAL_PROJECT_ID } from "./context/paths.ts";
import type { Env } from "./env.ts";
import { ControlPlane, type Reach } from "./control-plane/edge.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import type { Authorization } from "./oauth.ts";

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
const runInstructions = [
  "One tool, `run({ project?, script })`: evaluate a JavaScript function, `async (itx) => { ... }`, with the selected project's root `itx` handle at `/`. Pass a project slug or id when your token reaches several projects.",
  'Start by inspecting identity and capabilities:\n```json\n{"script":"async (itx) => ({ identity: await itx.whoami(), capabilities: await itx.rewriteRules.list() })"}\n```',
  'Use `itx.cd("/path")` to address another context in this project. Each call runs the complete script in a worker, for at most ten minutes; await operations and return JSON-serializable results. Carry state between calls in returned results or stored data. Requests and settlements are logged at `/`, attributed to your principal and grant; project rewrite rules apply.',
  'The config repo is `itx.repos.get("/repos/config")`. Use `listFiles()` and `readFile(path)` to inspect existing files, including `AGENTS.md` when present. Commit edits with `commitFiles({ message, changes: [{ path, content }] })`; file paths are repo-relative. A config-repo commit publishes the project worker.',
  `Read the current worker:
\`\`\`json
{"script":"async (itx) => itx.repos.get('/repos/config').readFile('worker.ts')"}
\`\`\``,
  `Commit a file (this writes to the repo; replace the example path and content with your intended edit):
\`\`\`json
{"script":"async (itx) => itx.repos.get('/repos/config').commitFiles({ message: 'Add a note', changes: [{ path: 'notes.txt', content: 'Hello from MCP' }] })"}
\`\`\``,
  'Website source must be valid JavaScript, including `worker.ts`; sibling modules use `.js`. Preview candidate modules with `itx.workers.get({ source: { "cap.js": candidateSource } }).fetch(new Request(projectUrl))`. After committing, fetch the `projectUrl` returned by `itx.whoami()` and verify the expected response before reporting publication success.',
  "Working examples: https://raw.githubusercontent.com/iterate/iterate/main/apps/os/e2e/mcp-project-root.e2e.test.ts — use the `async (itx) => ...` scripts and repo commit examples. The surrounding OAuth setup, project creation and assertions are the integration-test harness; your MCP connection supplies authentication and the project handle. Discover the live capabilities with `itx.rewriteRules.list()`.",
].join("\n\n");

/** Initialization includes usage guidance and the projects this token reaches, so the client can
 *  select one before running a script. Read from the control plane, like the tool's project check,
 *  and only for a request whose answer carries them (`answersWithInstructions`). */
async function serverInstructions(controlPlane: ControlPlane, reach: Reach): Promise<string> {
  const projects = await controlPlane.reachableProjects(reach);
  const reachable =
    projects.length === 0
      ? "This token reaches no project."
      : projects.length === 1
        ? `This token reaches one project, ${projects[0]!.slug} (${projects[0]!.id}) — \`project\` may be omitted.`
        : `This token reaches ${String(projects.length)} projects — pass \`project\` (slug or id): ${projects.map((project) => `${project.slug} (${project.id})`).join(", ")}.`;
  return [runInstructions, reachable].join("\n");
}

const validator = new CfWorkerJsonSchemaValidator();

/** A tool's input schema as `fromJsonSchema` takes it — the SDK's own JSON-Schema type. */
type JsonSchema = Parameters<typeof fromJsonSchema>[0];

async function buildServer(
  env: Env,
  authorization: Authorization,
  platformOrigin: string,
  instructed: boolean,
): Promise<McpServer> {
  const controlPlane = new ControlPlane(env.CONTROL_PLANE);
  const { reach, principal, grant } = authorization;
  const caller = { principal, grant: grant?.grantId, platformOrigin };
  const mcpServer = new McpServer(
    { name: "control-plane", version: "0.1.0" },
    instructed ? { instructions: await serverInstructions(controlPlane, reach) } : {},
  );

  mcpServer.registerTool(
    "run",
    {
      title: "Run a script",
      description: runInstructions,
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
        // Execute against the authorized root, through its rules, exactly as a project handle does.
        // The request carries the principal and grant; the root's runner records its settlement.
        const value = await env.ITERATE_CONTEXT.getByName(
          DurableObjectNameCodec.stringify({ projectId, path: "/" }),
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
    buildServer(env, authorization, platformAddressesOf(env, request).platformOrigin, instructed),
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
