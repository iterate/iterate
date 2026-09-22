import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { errorCode } from "iterate/next/lib";
import { platformAddressesOf } from "./app-config.ts";
import type { Env } from "./control-plane.ts";
import { directory, type Directory, type Reach } from "./directory.ts";
import { DurableObjectNameCodec } from "./iterate-context.ts";
import type { Authorization } from "./oauth.ts";

// MCP uses the same authorization and project root as a Cap’n Web project handle. The OAuth
// grant limits which projects can be selected; each run is attributed to that grant on the root
// log. A connection is not a child sandbox with a second, narrower set of capabilities.

/** Resolve a project slug or id within this token's grant before obtaining its root context. */
async function projectOfToolCall(
  d1Directory: Directory,
  reach: Reach,
  requested: string,
): Promise<string> {
  if (requested) {
    const { projectId, path } = DurableObjectNameCodec.parse(requested);
    if (path !== "/")
      throw new Error(
        `project: got a context name ${JSON.stringify(requested)} — pass the project and cd(path) in the expression`,
      );
    const id = await d1Directory.projectIdOf(projectId);
    if (!(await d1Directory.reachesProject(reach, id)))
      throw new Error(`project ${JSON.stringify(requested)} is outside this token's grant`);
    return id;
  }
  if (reach === "every") throw new Error("the admin secret reaches every project — pass project");
  const reachable = (await d1Directory.reachableProjects(reach)).map((project) => project.id);
  if (reachable.length === 1) return reachable[0]!;
  throw new Error(
    reachable.length
      ? `pass project — this token reaches ${reachable.join(", ")}`
      : "this token reaches no project",
  );
}

// Shared by initialize and tools/list so clients receive the same usage guidance from either.
const runInstructions = [
  "One tool, `run({ project?, script })`: evaluate a JavaScript function, `async (itx) => { ... }`, with the selected project's root `itx` handle at `/`. Pass a project slug or id when your grant reaches several projects; the admin secret always requires it.",
  'Start by inspecting identity and capabilities:\n```json\n{"script":"async (itx) => ({ identity: await itx.whoami(), capabilities: await itx.rewriteRules.list() })"}\n```',
  'Use `itx.cd("/path")` to address another context in this project. Each call runs the complete script in a worker; await operations and return JSON-serializable results. Carry state between calls in returned results or stored data. Requests and settlements are logged at `/`, attributed to your principal and grant; project rewrite rules apply.',
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
  "Working examples: https://raw.githubusercontent.com/iterate/iterate/main/apps/os-next/e2e/mcp-project-root.e2e.test.ts — use the `async (itx) => ...` scripts and repo commit examples. The surrounding OAuth setup, project creation and assertions are the integration-test harness; your MCP connection supplies authentication and the project handle. Discover the live capabilities with `itx.rewriteRules.list()`.",
].join("\n\n");

/** Initialization includes usage guidance and the projects this token reaches, so the client can
 *  select one before running a script. Read from the directory, like the tool's project check. */
async function serverInstructions(d1Directory: Directory, reach: Reach): Promise<string> {
  if (reach === "every")
    return [
      runInstructions,
      "This token is the admin secret: pass `project` (slug or id) on every call.",
    ].join("\n");
  const projects = await d1Directory.reachableProjects(reach);
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
): Promise<McpServer> {
  const d1Directory = directory(env.DB);
  const { reach, principal, grant } = authorization;
  const caller = { principal, grant: grant?.grantId, platformOrigin };
  const mcpServer = new McpServer(
    { name: "control-plane", version: "0.1.0" },
    { instructions: await serverInstructions(d1Directory, reach) },
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
                "The project — its slug or its id. Optional when this token reaches exactly one; required for the admin secret.",
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
      const toolArguments = raw as { project?: string; script: string };
      try {
        const projectId = await projectOfToolCall(
          d1Directory,
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
          isError: false, // a success is an explicit non-error, mirroring the failure() channel
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

/** The shared bearer gate has established this principal and reach. */
export function mcpResponse(request: Request, env: Env, authorization: Authorization) {
  return createMcpHandler(() =>
    buildServer(env, authorization, platformAddressesOf(env, request).platformOrigin),
  ).fetch(request);
}
