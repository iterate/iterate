// The /mcp API route — the ONLY OAuth-protected boundary. The provider validated the bearer (an OAuth
// access token) BEFORE this runs and put the granted props on ctx.props; in `open` login mode index.ts
// short-circuits here with the anonymous identity. An MCP server (@modelcontextprotocol/server) mounts
// here, scoped to that identity: every tool acts as the USER the grant names (/authorize, app.ts).

import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { directory } from "./directory.ts";
import type { Env, Handler } from "./env.ts";

/** The props the provider put on ctx after validating the bearer: the user the grant names. */
interface AuthProps {
  sub: string;
  email: string;
}

const validator = new CfWorkerJsonSchemaValidator();
type JsonSchema = Parameters<typeof fromJsonSchema>[0];
const input = (properties: Record<string, unknown>, required: string[] = []) =>
  fromJsonSchema(
    { type: "object", properties, required, additionalProperties: false } as JsonSchema,
    validator,
  );
const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  isError,
});
const str = (a: Record<string, unknown>, k: string) => String(a[k] ?? "");

function buildServer(env: Env, props: AuthProps): McpServer {
  const dir = directory(env.DB);
  const s = new McpServer({ name: "control-plane", version: "0.1.0" });

  s.registerTool(
    "whoami",
    {
      description: "Who this token authenticates as: the user it was granted to at authorization.",
      inputSchema: input({}),
    },
    async () => text(JSON.stringify({ email: props.email, sub: props.sub }, null, 2)),
  );

  s.registerTool(
    "list_projects",
    { description: "List the projects you can reach in this deployment.", inputSchema: input({}) },
    async () => {
      const ps = await dir.listProjects(props.sub);
      return text(
        ps.length ? ps.map((p) => `${p.id}  (org ${p.orgId}, ${p.role})`).join("\n") : "(none yet)",
      );
    },
  );

  s.registerTool(
    "create_project",
    {
      description:
        "Create a new org + project and return it — how you 'emerge with a project' from MCP.",
      inputSchema: input({ slug: { type: "string" }, orgName: { type: "string" } }, ["slug"]),
    },
    async (raw: unknown) => {
      const a = raw as Record<string, unknown>;
      try {
        const slug = str(a, "slug");
        if (!slug) return text("create_project needs a slug", true);
        const org = await dir.ensureOrg(props.sub, str(a, "orgName") || `${props.email}'s org`);
        const project = await dir.createProject(org.id, slug);
        return text(`created project '${project.id}' in org '${org.name}' (${org.id})`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );

  return s;
}

export const mcpHandler: Handler = {
  async fetch(request, env, ctx) {
    const { props } = ctx as ExecutionContext & { props: AuthProps };
    // A fresh handler per request under the default response mode (`auto`: one JSON body unless a
    // notification precedes the result — these tools emit none). Not `responseMode: "json"`: the
    // SDK `console.warn`s on every handler built that way, which here would be every request.
    return createMcpHandler(() => buildServer(env, props)).fetch(request);
  },
};
