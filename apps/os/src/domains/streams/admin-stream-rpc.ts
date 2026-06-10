import { newWorkersRpcResponse } from "capnweb";
import { PublicStreamRpcTarget } from "@iterate-com/streams/workers/durable-objects/stream";
import { StreamNamespace } from "@iterate-com/shared/streams/types";
import { authenticateCapnwebAdmin } from "~/itx/admin-auth-cookie.ts";
import { createOsIterateAuth, resolveRequestAuth } from "~/auth/middleware.ts";
import { principalIsAdmin } from "~/auth/principal.ts";
import { getStreamDurableObjectName } from "~/domains/streams/stream-runtime.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";
import type { AppConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";

const ADMIN_STREAM_RPC_PREFIX = "/api/admin-streams";

/**
 * Admin-only Cap'n Web sessions for arbitrary stream namespaces.
 *
 * This powers the admin stream explorer without minting project-scoped auth.
 * The namespace is explicit in the URL because admin is intentionally not
 * limited to project namespaces.
 */
export async function handleAdminStreamRpcFetch(input: {
  config: AppConfig;
  context: RequestContext;
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const route = parseAdminStreamRpcRoute(input.request);
  if (!route) return null;

  const auth = await authenticateAdminStreamRequest(input);
  if (!auth.ok) return new Response("Unauthorized", { status: 401 });

  const namespace = StreamNamespace.parse(route.namespace);
  const streamPath = resolveStreamPath(route.streamPath);
  const stream = input.env.STREAM.getByName(
    getStreamDurableObjectName({
      namespace,
      path: streamPath,
    }),
  );
  return await newWorkersRpcResponse(input.request, new PublicStreamRpcTarget(stream));
}

function parseAdminStreamRpcRoute(request: Request): {
  namespace: string;
  streamPath: string;
} | null {
  const url = new URL(request.url);
  if (
    url.pathname !== ADMIN_STREAM_RPC_PREFIX &&
    !url.pathname.startsWith(`${ADMIN_STREAM_RPC_PREFIX}/`)
  ) {
    return null;
  }

  const remainder = url.pathname.slice(ADMIN_STREAM_RPC_PREFIX.length);
  const match = /^\/([^/]+)(?:\/(.*))?$/.exec(remainder);
  if (!match) return null;
  const namespace = decodeURIComponent(match[1] ?? "").trim();
  if (!namespace) return null;
  const encodedStreamPath = match[2];
  return {
    namespace,
    streamPath:
      encodedStreamPath == null || encodedStreamPath === ""
        ? "/"
        : decodeURIComponent(encodedStreamPath),
  };
}

async function authenticateAdminStreamRequest(input: {
  config: AppConfig;
  context: RequestContext;
  request: Request;
}) {
  const capnwebAdmin = authenticateCapnwebAdmin({ config: input.config, request: input.request });
  if (capnwebAdmin) return { ok: true };

  const resolvedAuth = await resolveRequestAuth({
    auth: createOsIterateAuth(input.context, input.request),
    context: input.context,
    request: input.request,
  });
  return { ok: resolvedAuth.principal ? principalIsAdmin(resolvedAuth.principal) : false };
}
