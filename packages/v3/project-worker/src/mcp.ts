import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { Env } from "./control-plane.ts";
import { directory, type Directory, type Reach } from "./directory.ts";
import { DurableObjectNameCodec } from "./iterate-context.ts";
import { errorCode } from "./lib.ts";
import type { Authorization } from "./oauth.ts";

// MCP uses the same verified authorization as Cap’n Web. It exposes ONE tool, `run`: a script
// evaluated in a project's context under that principal (itx.run) — `run(script)` when the token
// reaches exactly one project, `run(project, script)` otherwise. Everything a caller might read
// (who am I, which projects) is a one-line script; project creation is the public Session's.

/** The project a tool call runs in (apps/os `resolveToolProject`): `project`, when named, is a
 *  project — a context name is refused, as `projects.get` refuses it (session.ts): the expression
 *  reaches the project's other contexts through `itx.cd(path)` — and must be within the grant;
 *  omitted, it is the one project the bearer reaches — the admin secret reaches every project, so
 *  it must name one. */
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
    if (!(await d1Directory.reachesProject(reach, projectId)))
      throw new Error(`project ${JSON.stringify(requested)} is outside this token's grant`);
    return projectId;
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

const validator = new CfWorkerJsonSchemaValidator();
/** A tool's input schema as `fromJsonSchema` takes it — the SDK's own JSON-Schema type. */
type JsonSchema = Parameters<typeof fromJsonSchema>[0];
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  fromJsonSchema(
    { type: "object", properties, required, additionalProperties: false } as JsonSchema,
    validator,
  );
const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  isError,
});
/** A tool FAILURE as the protocol's own channel — an `isError` result, never a thrown error and
 *  never a 500 — its text led by the platform's CODE when the error carries one (lib.ts —
 *  `NO_ITX_EXPRESSION_MATCH`, `INVALID_CONTEXT`, …), the machine-readable channel a client
 *  classifies by, then the message. */
const failure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return textResult(code ? `${code}: ${message}` : message, true);
};

const PROJECT_INPUT = {
  type: "string",
  description:
    "The project (its id/slug). Optional when this token reaches exactly one; required for the admin secret.",
};

function buildServer(env: Env, authorization: Authorization): McpServer {
  const d1Directory = directory(env.DB);
  const { reach, principal } = authorization;
  const mcpServer = new McpServer({ name: "control-plane", version: "0.1.0" });

  mcpServer.registerTool(
    "run",
    {
      title: "Run a script",
      description:
        "Run a script in a project's context, under this token's principal — THE way to do work in a project over MCP. The script is the text of an async function of one parameter, `itx`: `async (itx) => { ... }` — a coding agent's whole output, an alternative to a tool call, its values baked in (no arguments). It is evaluated once in a confined worker with `itx` bound to the project (`itx.kv`, `itx.append`, `itx.readEvents`, `itx.connectToMcp`, `itx.workers.get`, …) and returns a JSON-serializable value. This is `itx.run`.",
      inputSchema: objectSchema(
        {
          project: PROJECT_INPUT,
          script: {
            type: "string",
            minLength: 1,
            description:
              "The text of an async function of one parameter, `itx`: `async (itx) => { const n = Number(await itx.kv.get('n')) || 0; await itx.kv.put('n', String(n + 1)); return n + 1; }`. It bakes in its own values (there are no arguments — write the whole script). Return a JSON-serializable value (undefined, functions and live handles do not cross the boundary).",
          },
        },
        ["script"],
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
        // `itx.run(script)` at the project root, under this principal — the loaded script's own
        // `env.ITX` is the project (principal-less: loaded code speaks for the project, library.ts).
        const value = await env.ITERATE_CONTEXT.getByName(
          DurableObjectNameCodec.stringify({ projectId, path: "/" }),
        ).invokeAs(principal, ["itx", ["run", toolArguments.script]]);
        // THE JSON BOUNDARY: a round trip drops what JSON cannot carry and throws on what it refuses.
        const json = JSON.stringify(value) ?? "null";
        return {
          content: [{ type: "text" as const, text: json }],
          structuredContent: { result: JSON.parse(json) as unknown },
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  return mcpServer;
}

/** The shared bearer gate has established this principal and reach. */
export function mcpResponse(request: Request, env: Env, authorization: Authorization) {
  return createMcpHandler(() => buildServer(env, authorization)).fetch(request);
}
