import { newWorkersRpcResponse } from "capnweb";
import { PublicStreamRpcTarget } from "@iterate-com/streams/workers/durable-objects/stream";
import { getStreamDurableObjectName } from "~/domains/streams/stream-runtime.ts";
import { createOsIterateAuth, resolveRequestAuth } from "~/auth/middleware.ts";
import { requireProjectScopedAccess } from "~/orpc/project-access.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";
import type { RequestContext } from "~/request-context.ts";

const PROJECT_STREAM_RPC_PREFIX = "/api/project-streams";

/**
 * Serve capnweb workers-RPC sessions for a project stream at
 * `/api/project-streams/<projectSlugOrId>/<streamPath>`. Authenticates the
 * request itself because it runs before the TanStack Start middleware chain.
 */
export async function handleProjectStreamRpcFetch(input: {
  context: RequestContext;
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const route = parseProjectStreamRpcRoute(input.request);
  if (!route) return null;

  const auth = createOsIterateAuth(input.context, input.request);
  const resolvedAuth = await resolveRequestAuth({
    auth,
    context: input.context,
    request: input.request,
  });
  const context: RequestContext = {
    ...input.context,
    iterateAuthSession: resolvedAuth.session,
    principal: resolvedAuth.principal,
    rawRequest: input.request,
  };
  const project = await requireProjectScopedAccess({
    context,
    projectSlugOrId: route.projectSlugOrId,
  });
  const streamPath = resolveStreamPath(route.streamPath);
  const stream = input.env.STREAM.getByName(
    getStreamDurableObjectName({
      namespace: project.id,
      path: streamPath,
    }),
  );
  const response = await newWorkersRpcResponse(input.request, new PublicStreamRpcTarget(stream));
  const setCookie = resolvedAuth.responseHeaders.get("set-cookie");
  if (setCookie) response.headers.append("set-cookie", setCookie);
  return response;
}

function parseProjectStreamRpcRoute(request: Request): {
  projectSlugOrId: string;
  streamPath: string;
} | null {
  const url = new URL(request.url);
  if (
    url.pathname !== PROJECT_STREAM_RPC_PREFIX &&
    !url.pathname.startsWith(`${PROJECT_STREAM_RPC_PREFIX}/`)
  ) {
    return null;
  }

  const remainder = url.pathname.slice(PROJECT_STREAM_RPC_PREFIX.length);
  const match = /^\/([^/]+)(?:\/(.*))?$/.exec(remainder);
  if (!match) return null;
  const projectSlugOrId = decodeURIComponent(match[1] ?? "").trim();
  if (!projectSlugOrId) return null;
  const encodedStreamPath = match[2];
  return {
    projectSlugOrId,
    streamPath:
      encodedStreamPath == null || encodedStreamPath === ""
        ? "/"
        : decodeURIComponent(encodedStreamPath),
  };
}
