// The /mcp API route — the ONLY OAuth-protected boundary (design §2). The provider validated the bearer
// (an OAuth access token OR an API key via resolveExternalToken) BEFORE this runs and put the granted props
// on ctx.props. A real MCP server (@modelcontextprotocol/server) mounts here, scoped to that identity.
//
// The headline proof lives in `whoami`: after the OAuth dance where the caller created an org+project at
// /authorize, the token's props carry that projectId — so whoami reflects the just-emerged project.

import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { directory, type Grant } from "./directory.ts";
import type { Env, Handler } from "./env.ts";

/** The props the provider put on ctx after validating the bearer. */
interface AuthProps {
  sub: string;
  email: string;
  projectId?: string;
  grants?: Grant[];
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
      description:
        "Who this token authenticates as, and the org/project it was granted at authorization.",
      inputSchema: input({}),
    },
    async () =>
      text(
        JSON.stringify(
          {
            email: props.email,
            sub: props.sub,
            projectId: props.projectId ?? null,
            grants: props.grants ?? [],
          },
          null,
          2,
        ),
      ),
  );

  s.registerTool(
    "list_projects",
    { description: "List the projects you can reach in this deployment.", inputSchema: input({}) },
    async () => {
      const ps = await dir.listProjects(props.sub);
      return text(
        ps.length
          ? ps.map((p) => `${p.slug}  (org ${p.orgId}, ${p.role})`).join("\n")
          : "(none yet)",
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
        const { org, project } = await dir.emerge(
          props.sub,
          str(a, "orgName") || `${props.email}'s org`,
          slug,
        );
        return text(`created project '${project.slug}' in org '${org.name}' (${org.id})`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );

  return s;
}

export const mcpHandler: Handler = {
  async fetch(request, env, ctx) {
    const props = (ctx as ExecutionContext & { props?: AuthProps }).props ?? { sub: "", email: "" };
    // responseMode: "json" => a single JSON body per request (client must still Accept both json + SSE).
    return createMcpHandler(() => buildServer(env, props), { responseMode: "json" }).fetch(request);
  },
};
