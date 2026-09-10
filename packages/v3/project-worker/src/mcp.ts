import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { Env, Handler } from "./control-plane.ts";
import { directory, reachOf, type Directory, type Reach } from "./directory.ts";
import { DurableObjectNameCodec } from "./iterate-context.ts";
import { errorCode } from "./lib.ts";
import type { Principal } from "./principal.ts";
import {
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
} from "./context/expression.ts";

// ── mcp ── /mcp: the ONE MCP server, for every project — the only OAuth-protected boundary. The
// provider validated the bearer BEFORE this runs and put the granted props on ctx.props: an OAuth
// access token's (the user and the projects chosen at consent — `authorize`, the app section below)
// or, through `resolveExternalToken`, the admin secret's or a project secret's. An MCP server
// (@modelcontextprotocol/server) mounts here with three tools; `itx.invoke` runs an expression
// through a named project's context IN-PROCESS under the bearer's principal (the DO's `invokeAs`),
// so MCP is not a parallel capability API: a tool call reaches what an expression reaches, for any
// project the bearer names. The project is resolved as apps/os's `resolveToolProject` does:
// optional when the bearer reaches exactly one, required for the admin secret, refused outside the
// grant. No tool creates a project: a project is created on the console or over `/api`
// (`projects.create`) — a bearer that chose its projects at consent is bound to them.

/** What the provider puts on `ctx.props` once the bearer is validated — WHO the tools act as (the
 *  principal `invokeAs` stamps on every event) and WHICH projects they reach, `reachOf`'s answer:
 *  `projects` names them outright and binds the bearer to them whoever it is — an OAuth grant's,
 *  chosen at consent (`authorize`); a project secret's or a project token's one
 *  (`resolveExternalToken`, the admin's own token included); absent — a user who had no project to
 *  choose from — the projects of the user's orgs, read per call; the admin secret's
 *  `{ actor: "admin" }` reaches every project, so its tool calls must name one. */
export type McpProps = Principal & { projects?: string[] };

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

/** The tool's expression as ONE expression for `invokeAs`: either codec half normalized (a string
 *  parsed, an array shape-checked — refused in the parser's words), rooted at `itx`, with `args`
 *  appended to its terminal call — a terminal NAME becomes that call: `itx.kv.get` + `["k"]` is
 *  `itx.kv.get("k")`. */
function itxExpressionWithArgs(input: ItxExpressionInput, args: unknown[]): ItxExpression {
  const expression = normalizedItxExpression(input);
  const [root, ...steps] = expression;
  if (root !== "itx")
    throw new Error(`an itx expression is rooted at itx, not ${JSON.stringify(root)}`);
  const last = steps.at(-1);
  if (args.length === 0 || last === undefined) return expression;
  return [
    "itx",
    ...steps.slice(0, -1),
    typeof last === "string" ? [last, ...args] : [...last, ...args],
  ];
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

function buildServer(env: Env, props: McpProps): McpServer {
  const d1Directory = directory(env.DB);
  const reach = reachOf(props);
  const mcpServer = new McpServer({ name: "control-plane", version: "0.1.0" });

  mcpServer.registerTool(
    "whoami",
    {
      description:
        "Who this token authenticates as and which projects it reaches: the user and the projects chosen at authorization; the admin secret (every project); a project token (its one project); a project secret (its one project — the secret names it with ?project=<id> on the /mcp URL).",
      inputSchema: objectSchema({}),
    },
    async () => textResult(JSON.stringify(props, null, 2)),
  );

  mcpServer.registerTool(
    "list_projects",
    {
      description: "List the projects this token reaches (the admin secret: every project).",
      inputSchema: objectSchema({}),
    },
    async () => {
      const projects = await d1Directory.reachableProjects(reach);
      return textResult(
        projects.length
          ? projects
              .map(
                (project) =>
                  `${project.id}  (org ${project.orgId}${project.role ? `, ${project.role}` : ""})`,
              )
              .join("\n")
          : "(none yet)",
      );
    },
  );

  mcpServer.registerTool(
    "itx.invoke",
    {
      title: "Invoke itx",
      description:
        "Evaluate one itx expression in a project's context, exactly as itx evaluates it (through the project's rewrite rules), under this token's principal: a dotted string such as itx.kv.get('k'), or its parsed form; args are appended to the terminal call. Returns the result as JSON.",
      inputSchema: objectSchema(
        {
          project: PROJECT_INPUT,
          expression: {
            description:
              'An itx expression: a dotted string such as itx.kv.get(\'k\') or itx.append({ type: \'note\' }) (call args are JSON5), or its parsed form ["itx","kv",["get","k"]] for anything large.',
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "array", minItems: 1 },
            ],
          },
          args: {
            type: "array",
            description:
              "Appended to the expression's terminal call (a terminal name becomes that call) — an argument that is awkward to spell inline rides here as plain JSON.",
          },
        },
        ["expression"],
      ),
    },
    async (raw: unknown) => {
      const toolArguments = raw as {
        project?: string;
        expression: ItxExpressionInput;
        args?: unknown[];
      };
      const { projects: _grantedProjects, ...principal } = props; // the stamp is the principal, never its grant
      try {
        const projectId = await projectOfToolCall(
          d1Directory,
          reach,
          toolArguments.project?.trim() ?? "",
        );
        const value = await env.ITERATE_CONTEXT.getByName(
          DurableObjectNameCodec.stringify({ projectId, path: "/" }),
        ).invokeAs(
          principal,
          itxExpressionWithArgs(toolArguments.expression, toolArguments.args ?? []),
        );
        // THE JSON BOUNDARY: a round trip drops what JSON cannot carry (undefined members, a
        // function-valued handle's members) and throws on what it refuses (a cycle, a BigInt).
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

export const mcpHandler: Handler = {
  async fetch(request, env, ctx) {
    const { props } = ctx as ExecutionContext & { props: McpProps };
    // A fresh handler per request under the default response mode (`auto`: one JSON body unless a
    // notification precedes the result — these tools emit none). Not `responseMode: "json"`: the
    // SDK `console.warn`s on every handler built that way, which here would be every request.
    return createMcpHandler(() => buildServer(env, props)).fetch(request);
  },
};
