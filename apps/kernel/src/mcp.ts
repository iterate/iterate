// ---------------------------------------------------------------------------
// The /mcp control-plane surface — a SIBLING to /api (ADR 0022). Both are headless control-plane
// endpoints: /api speaks capnweb, /mcp speaks MCP. Both do the same job — authenticate via the wall,
// then list / create / reach projects through the directory. This is a protocol adapter over the same
// front desk the capnweb tree exposes (kernel.ts Session/ProjectCollection). Design:
//   ../os/docs/simplification/wayfinder/questions/mcp-everywhere.md
//
// Transport: MCP Streamable HTTP, STATELESS — one POST per JSON-RPC message, a single JSON response
// (Content-Type application/json; the spec permits this in place of an SSE stream). No session id, no
// server→client stream (GET => 405). Pure-play: hand-rolled JSON-RPC, no @modelcontextprotocol/sdk.
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

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

const PROTOCOL_VERSION = "2025-06-18"; // echoed back; clients negotiate down if they must

const TOOLS = [
  {
    name: "list_projects",
    description: "List the projects you can reach in this deployment.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_project",
    description:
      "Create a new project and return its id — how you 'emerge with a project' when you have none.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "the project slug to create" },
        organizationSlug: {
          type: "string",
          description: "owning organization (required by the auth.iterate.com directory only)",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "get_project",
    description: "Resolve a project you can reach by slug, returning its id.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
] as const;

// Scripting tools — only advertised when the deployment provides a scripting facade.
const SCRIPTING_TOOLS = [
  {
    name: "run_script",
    description:
      "Run an async script `itx => …` (or `(itx,args) => …`) against a project's ITX tree, confined. Returns its result.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "project slug" },
        code: {
          type: "string",
          description: "an async function expression, e.g. `async (itx) => await itx.whoami()`",
        },
        args: { description: "optional JSON args passed as the 2nd parameter" },
      },
      required: ["project", "code"],
      additionalProperties: false,
    },
  },
  {
    name: "provide_capability",
    description:
      "Register a named dynamic capability (a stored `(itx,args) => …` script) on a project. Cannot shadow a builtin.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        name: { type: "string" },
        code: { type: "string" },
      },
      required: ["project", "name", "code"],
      additionalProperties: false,
    },
  },
  {
    name: "invoke_capability",
    description: "Invoke a previously-provided dynamic capability by name, with optional args.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        name: { type: "string" },
        args: {},
      },
      required: ["project", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_capabilities",
    description: "List the dynamic capabilities provided on a project.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" } },
      required: ["project"],
      additionalProperties: false,
    },
  },
] as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const rpcResult = (id: JsonRpcId, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) =>
  json({ jsonrpc: "2.0", id, error: { code, message } });
// A tool result surfaces failures as isError text (a protocol-level error would abort the tool call).
const toolText = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
});

export async function handleMcpRequest(
  request: Request,
  projects: McpProjects,
  serverInfo: { name: string; version: string },
  scripting?: McpScripting,
): Promise<Response> {
  // Streamable HTTP: the server→client SSE stream is optional; we're stateless, so GET has nothing to open.
  if (request.method !== "POST") return json({ error: "POST JSON-RPC to /mcp" }, 405);

  let msg: JsonRpcRequest;
  try {
    msg = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  const { id = null, method } = msg;

  // Notifications (no id) — e.g. notifications/initialized — are acknowledged with 202, no body.
  if (msg.id === undefined && method.startsWith("notifications/"))
    return new Response(null, { status: 202 });

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (msg.params?.protocolVersion as string | undefined) ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: scripting ? [...TOOLS, ...SCRIPTING_TOOLS] : TOOLS });
    case "tools/call": {
      const name = msg.params?.name as string | undefined;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const asJson = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
      try {
        if (name === "list_projects") {
          const list = await projects.list();
          return rpcResult(
            id,
            toolText(list.length ? list.join("\n") : "(no projects yet — create one)"),
          );
        }
        if (name === "create_project") {
          const slug = String(args.slug ?? "");
          if (!slug) return rpcResult(id, toolText("create_project needs a slug", true));
          const projectId = await projects.create(
            slug,
            args.organizationSlug ? String(args.organizationSlug) : undefined,
          );
          return rpcResult(id, toolText(`created project '${projectId}'`));
        }
        if (name === "get_project") {
          const projectId = await projects.get(String(args.slug ?? ""));
          return rpcResult(id, toolText(projectId));
        }
        if (scripting && name === "run_script") {
          const out = await scripting.runScript(String(args.project), String(args.code), args.args);
          return rpcResult(id, toolText(asJson(out)));
        }
        if (scripting && name === "provide_capability") {
          await scripting.provideCapability(
            String(args.project),
            String(args.name),
            String(args.code),
          );
          return rpcResult(id, toolText(`provided capability '${args.name}'`));
        }
        if (scripting && name === "invoke_capability") {
          const out = await scripting.invokeCapability(
            String(args.project),
            String(args.name),
            args.args,
          );
          return rpcResult(id, toolText(asJson(out)));
        }
        if (scripting && name === "list_capabilities") {
          const list = await scripting.listCapabilities(String(args.project));
          return rpcResult(id, toolText(list.length ? list.join("\n") : "(none)"));
        }
        return rpcResult(id, toolText(`unknown tool '${name}'`, true));
      } catch (e) {
        return rpcResult(id, toolText(e instanceof Error ? e.message : String(e), true));
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
