import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";

// ---------------------------------------------------------------------------
// The /mcp control-plane surface — a SIBLING to /api (ADR 0022). Both are headless control-plane
// endpoints: /api speaks capnweb, /mcp speaks MCP. Both do the same job — authenticate via the wall,
// then list / create / reach projects through the directory. This is a protocol adapter over the same
// front desk the capnweb tree exposes (kernel.ts Session/ProjectCollection).
//
// Built on `@modelcontextprotocol/server` v2 (the official library; `workerd` export condition => pure-play
// safe, deps: zod + @modelcontextprotocol/core). `createMcpHandler` is STATELESS by default — one fresh
// server per request, single JSON response, GET/DELETE => 405 — exactly the kernel's contract. The wall
// auth happens in kernel.ts BEFORE this (the caller-scoped façades are passed in). The hand-rolled
// JSON-RPC switch this replaced is gone; only the tool definitions + façades remain.
// ---------------------------------------------------------------------------

// The cross-project operations MCP exposes — a thin façade the kernel builds over a Session's projects.
export interface McpProjects {
  list(): Promise<string[]>;
  create(slug: string, organizationSlug?: string): Promise<string>; // -> projectId
  get(slug: string): Promise<string>; // -> projectId (throws if prospective / not a member)
}

// Script-execution + dynamic-capability operations (the os `exec_typescript` model, control-plane-driven).
// Optional — a generic control plane may not expose scripting. All scoped to a project the caller resolved.
export interface McpScripting {
  runScript(projectId: string, code: string, args?: unknown): Promise<unknown>;
  provideCapability(projectId: string, name: string, code: string): Promise<void>;
  invokeCapability(projectId: string, name: string, args?: unknown): Promise<unknown>;
  listCapabilities(projectId: string): Promise<string[]>;
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
const asJson = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const str = (a: Record<string, unknown>, k: string) => String(a[k] ?? "");

function buildServer(
  serverInfo: { name: string; version: string },
  projects: McpProjects,
  scripting?: McpScripting,
): McpServer {
  const s = new McpServer(serverInfo);

  s.registerTool(
    "list_projects",
    { description: "List the projects you can reach in this deployment.", inputSchema: input({}) },
    async () => {
      const list = await projects.list();
      return text(list.length ? list.join("\n") : "(no projects yet — create one)");
    },
  );

  s.registerTool(
    "create_project",
    {
      description:
        "Create a new project and return its id — how you 'emerge with a project' when you have none.",
      inputSchema: input(
        {
          slug: { type: "string", description: "the project slug to create" },
          organizationSlug: {
            type: "string",
            description: "owning organization (required by the auth.iterate.com directory only)",
          },
        },
        ["slug"],
      ),
    },
    async (raw: unknown) => {
      const a = raw as Record<string, unknown>;
      try {
        const slug = str(a, "slug");
        if (!slug) return text("create_project needs a slug", true);
        const projectId = await projects.create(
          slug,
          a.organizationSlug ? str(a, "organizationSlug") : undefined,
        );
        return text(`created project '${projectId}'`);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );

  s.registerTool(
    "get_project",
    {
      description: "Resolve a project you can reach by slug, returning its id.",
      inputSchema: input({ slug: { type: "string" } }, ["slug"]),
    },
    async (raw: unknown) => {
      const a = raw as Record<string, unknown>;
      try {
        return text(await projects.get(str(a, "slug")));
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );

  // Scripting tools — only registered when the deployment provides a scripting façade.
  if (scripting) {
    s.registerTool(
      "run_script",
      {
        description:
          "Run an async script `itx => …` (or `(itx,args) => …`) against a project's ITX tree, confined. Returns its result.",
        inputSchema: input(
          {
            project: { type: "string", description: "project slug" },
            code: {
              type: "string",
              description: "an async function expression, e.g. `async (itx) => await itx.whoami()`",
            },
            args: { description: "optional JSON args passed as the 2nd parameter" },
          },
          ["project", "code"],
        ),
      },
      async (raw: unknown) => {
        const a = raw as Record<string, unknown>;
        try {
          return text(asJson(await scripting.runScript(str(a, "project"), str(a, "code"), a.args)));
        } catch (e) {
          return text(e instanceof Error ? e.message : String(e), true);
        }
      },
    );

    s.registerTool(
      "provide_capability",
      {
        description:
          "Register a named dynamic capability (a stored `(itx,args) => …` script) on a project. Cannot shadow a builtin.",
        inputSchema: input(
          { project: { type: "string" }, name: { type: "string" }, code: { type: "string" } },
          ["project", "name", "code"],
        ),
      },
      async (raw: unknown) => {
        const a = raw as Record<string, unknown>;
        try {
          await scripting.provideCapability(str(a, "project"), str(a, "name"), str(a, "code"));
          return text(`provided capability '${str(a, "name")}'`);
        } catch (e) {
          return text(e instanceof Error ? e.message : String(e), true);
        }
      },
    );

    s.registerTool(
      "invoke_capability",
      {
        description: "Invoke a previously-provided dynamic capability by name, with optional args.",
        inputSchema: input({ project: { type: "string" }, name: { type: "string" }, args: {} }, [
          "project",
          "name",
        ]),
      },
      async (raw: unknown) => {
        const a = raw as Record<string, unknown>;
        try {
          return text(
            asJson(await scripting.invokeCapability(str(a, "project"), str(a, "name"), a.args)),
          );
        } catch (e) {
          return text(e instanceof Error ? e.message : String(e), true);
        }
      },
    );

    s.registerTool(
      "list_capabilities",
      {
        description: "List the dynamic capabilities provided on a project.",
        inputSchema: input({ project: { type: "string" } }, ["project"]),
      },
      async (raw: unknown) => {
        const a = raw as Record<string, unknown>;
        const list = await scripting.listCapabilities(str(a, "project"));
        return text(list.length ? list.join("\n") : "(none)");
      },
    );
  }

  return s;
}

// STATELESS by default — a fresh server per request. The wall auth already ran in kernel.ts; the façades
// close over the authenticated caller.
export function handleMcpRequest(
  request: Request,
  projects: McpProjects,
  serverInfo: { name: string; version: string },
  scripting?: McpScripting,
): Promise<Response> {
  // `responseMode: "json"` => a single JSON body per request (never an SSE stream), matching the kernel's
  // stateless contract. (The client must still `Accept: application/json, text/event-stream` per spec.)
  return createMcpHandler(() => buildServer(serverInfo, projects, scripting), {
    responseMode: "json",
  }).fetch(request);
}
