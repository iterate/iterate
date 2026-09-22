import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { errorCode } from "iterate/next/lib";
import { appConfigOf, platformOriginOf } from "./app-config.ts";
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

/** What the client learns at `initialize` — the one place it can read anything without a script:
 *  which projects this token reaches (so `project` is spelled right the first time) and where its
 *  scripts run. Read once per request from the directory, like the tool's own project check. */
async function serverInstructions(d1Directory: Directory, reach: Reach): Promise<string> {
  const where = [
    "One tool, `run`: a script — the text of `async (itx) => { … }` — evaluated with the authorized project’s root `itx` handle.",
    'Discover the current capabilities with `await itx.rewriteRules.list()`. The config repo is `itx.repos.get("/repos/config")`; use `readFile(path)` and `commitFiles({ message, changes })`. A config-repo commit publishes the project worker.',
    "Every run is on the project root’s log (`context/run-requested` / `run-settled`), attributed to you and this grant. Project rewrite rules still apply.",
  ];
  if (reach === "every")
    return [
      ...where,
      "This token is the admin secret: pass `project` (slug or id) on every call.",
    ].join("\n");
  const projects = await d1Directory.reachableProjects(reach);
  const reachable =
    projects.length === 0
      ? "This token reaches no project."
      : projects.length === 1
        ? `This token reaches one project, ${projects[0]!.slug} (${projects[0]!.id}) — \`project\` may be omitted.`
        : `This token reaches ${String(projects.length)} projects — pass \`project\` (slug or id): ${projects.map((project) => `${project.slug} (${project.id})`).join(", ")}.`;
  return [...where, reachable].join("\n");
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
      description:
        'Run an async function with the authorized project’s root `itx` handle: `async (itx) => { ... }`. The script runs once in a confined worker and returns a JSON-serializable value. It has the project root’s capabilities and can navigate project contexts with `itx.cd(path)`. Start with `await itx.rewriteRules.list()` for the current capability tree. Read the config repo with `itx.repos.get("/repos/config").readFile("worker.ts")`; `commitFiles({ message, changes })` publishes changes. Every run is logged on the project root and attributed to your principal and OAuth grant.',
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
    buildServer(env, authorization, platformOriginOf(appConfigOf(env), request)),
  ).fetch(request);
}
