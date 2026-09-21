import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { errorCode } from "iterate/next/lib";
import type { Env } from "./control-plane.ts";
import { directory, type Directory, type Reach } from "./directory.ts";
import { DurableObjectNameCodec } from "./iterate-context.ts";
import type { Authorization } from "./oauth.ts";

// MCP uses the same verified authorization as Cap’n Web. It exposes ONE tool, `run`: a script
// evaluated under that principal in THE CONNECTION'S OWN CONTEXT of a project — `/mcp/inbound/<grantId>`,
// the grant being the connection (the 2026-07-28 revision is per-request: no session id, and the
// same OAuth grant is what every call of one client carries) — so every script a client ever ran is
// that context's log, `context/run-requested` + `run-settled` stamped with who and through which
// grant (the audit lives where it happened); the project root is `itx.cd('/')`, and kv, files, repos,
// secrets are the project's wherever the script runs. `run(script)` when the token reaches exactly
// one project, `run(project, script)` otherwise. The project's catalog lists every client that
// connected (src/project/: `project/mcp-client-connected`, appended to `/` on a grant's first use).
// Everything else a caller might read (who am I, which projects) is the server's own `instructions`
// or a one-line script; project creation is the public Session's.

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
    "One tool, `run`: a script — the text of `async (itx) => { … }` — evaluated in YOUR CONNECTION'S context of a project, `/mcp/inbound/<your grant>`.",
    "`itx.kv`, `itx.files`, `itx.repos`, `itx.agents`, `itx.secrets` are the project's wherever a script runs; `itx.append` / `itx.readEvents` / `itx.provide` are your connection's own context; the project root is `itx.cd('/')`.",
    "Every run is on your connection's log (`context/run-requested` / `run-settled`), attributed to you and this grant.",
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

async function buildServer(env: Env, authorization: Authorization): Promise<McpServer> {
  const d1Directory = directory(env.DB);
  const { reach, principal, grant } = authorization;
  // THE CONNECTION: the grant (a personal token, a Claude Code sign-in); the admin secret has none,
  // so every admin client shares one context per project.
  const connectionPath = `/mcp/inbound/${grant?.grantId ?? "admin"}`;
  const caller = { principal, grant: grant?.grantId };
  const mcpServer = new McpServer(
    { name: "control-plane", version: "0.1.0" },
    { instructions: await serverInstructions(d1Directory, reach) },
  );

  mcpServer.registerTool(
    "run",
    {
      title: "Run a script",
      description:
        "Run a script in your connection's context of a project (`/mcp/inbound/<your grant>`), under this token's principal — THE way to do work in a project over MCP. The script is the text of an async function of one parameter, `itx`: `async (itx) => { ... }` — a coding agent's whole output, an alternative to a tool call, its values baked in (no arguments). It is evaluated once in a confined worker with `itx` bound to that context (`itx.kv`, `itx.files`, `itx.repos`, `itx.agents` are the project's; `itx.append`/`itx.readEvents` are the connection's own log; the project root is `itx.cd('/')`) and returns a JSON-serializable value. Every run is logged there, attributed to you. This is `itx.run`. `await itx.rewriteRules.list()` is the tree — every capability this context can spell, each with a one-line description and the context it comes from; read it first.",
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
        // THE CATALOG learns of this connection once: the project root's `mcp-client-connected`,
        // idempotent on the grant (a dedupe hit writes nothing), before the first script runs.
        await env.ITERATE_CONTEXT.getByName(
          DurableObjectNameCodec.stringify({ projectId, path: "/" }),
        ).invoke(
          [
            "itx",
            [
              "append",
              {
                type: "events.iterate.com/project/mcp-client-connected",
                idempotencyKey: `mcp-client-connected/${grant?.grantId ?? "admin"}`,
                payload: { grantId: grant?.grantId ?? "admin", path: connectionPath },
              },
            ],
          ],
          [],
          caller,
        );
        // `itx.run(script)` in the connection's context, under this caller: the request lands on
        // that log with the principal and grant, the context runs it, the settlement answers.
        const value = await env.ITERATE_CONTEXT.getByName(
          DurableObjectNameCodec.stringify({ projectId, path: connectionPath }),
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
  return createMcpHandler(() => buildServer(env, authorization)).fetch(request);
}
