import { newWorkersRpcResponse } from "capnweb";
import type { Env } from "./env.ts";
import { authenticate, authorizeProjectAccess } from "./auth.ts";
import { formatDurableObjectName, PLATFORM_PROJECT_ID } from "./domains/durable-object-names.ts";
import { AgentDurableObject } from "./domains/agents/agent-durable-object.ts";
import { ProjectDurableObject } from "./domains/projects/project-durable-object.ts";
import { RepoDurableObject } from "./domains/repos/repo-durable-object.ts";
import { StreamDurableObject } from "./domains/streams/stream-durable-object.ts";
import { ItxEntrypoint } from "./itx/entrypoint.ts";
import { pathInvokerToProxy } from "./itx/path-invoker.ts";
import { RootItx } from "./itx/root.ts";

export {
  ItxEntrypoint,
  ProjectDurableObject,
  AgentDurableObject,
  RepoDurableObject,
  StreamDurableObject,
};

async function readScriptCode(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code !== "string")
      throw new Error('JSON body must contain string field "code".');
    return body.code;
  }
  return await request.text();
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const pathProjectMatch = url.pathname.match(/^\/api\/itx\/([^/]+)$/);
    const projectId = decodeURIComponent(pathProjectMatch?.[1] ?? "");

    if (!projectId && url.pathname === "/api/itx") {
      const principal = authenticate(request);
      if (!principal) return new Response("missing or invalid token", { status: 401 });
      if (principal.access !== "all") {
        return new Response("root ITX is admin-only in the reference implementation", {
          status: 403,
        });
      }
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      return newWorkersRpcResponse(request, pathInvokerToProxy(new RootItx(env)));
    }

    if (!projectId) {
      return new Response("minimal-itx: connect to /api/itx/<projectId> or /api/itx for admins", {
        status: 404,
      });
    }

    if (projectId === PLATFORM_PROJECT_ID) {
      return new Response(`"${PLATFORM_PROJECT_ID}" is not a connectable context; use /api/itx`, {
        status: 404,
      });
    }

    const auth = authorizeProjectAccess(request, projectId);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const path = "/";
    const project = env.PROJECT.getByName(formatDurableObjectName({ projectId, path }));
    const itx = pathInvokerToProxy(project);

    if (request.method === "POST") {
      try {
        const code = await readScriptCode(request);
        const run = (await itx.runScript({ code })) as Record<string, unknown>;
        return json({
          context: formatDurableObjectName({ projectId, path }),
          ...run,
          describe: await itx.describe(),
        });
      } catch (error: unknown) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    }

    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    return newWorkersRpcResponse(request, itx);
  },
};
