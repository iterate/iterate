import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { newWorkersRpcResponse } from "capnweb";
import { env } from "cloudflare:workers";
import { parseStreamRpcRequest, streamDurableObjectName } from "./lib/stream-rpc.ts";
import { PublicStreamRpcTarget } from "~/domains/streams/engine/workers/durable-objects/stream.ts";

export { Stream } from "~/domains/streams/engine/workers/durable-objects/stream.ts";
export { StreamProcessorRunner } from "~/domains/streams/engine/workers/durable-objects/stream-processor-runner.ts";

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/__internal/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname.startsWith("/stream-processor-runner/")) {
      const name = decodeURIComponent(url.pathname.slice("/stream-processor-runner/".length));
      return env.STREAM_PROCESSOR_RUNNER.getByName(name).fetch(request);
    }

    if (url.pathname === "/api/streams") {
      const { namespace, path } = parseStreamRpcRequest({ url });
      return newWorkersRpcResponse(
        request,
        new PublicStreamRpcTarget(
          env.STREAM.getByName(streamDurableObjectName({ namespace, path })),
        ),
      );
    }

    // No COOP/COEP on purpose: the browser SQLite mirror uses wa-sqlite's OPFSCoopSyncVFS,
    // which needs no SharedArrayBuffer and no cross-origin isolation. (Isolation is what
    // made @sqlite.org/sqlite-wasm auto-install its async-proxy OPFS VFS and deadlock in
    // production builds.) Leaving it off also keeps OPFS working the same way
    // across Chrome, Edge, Safari and mobile Safari.
    return handler.fetch(request, { context: {} });
  },
});
