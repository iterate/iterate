import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { newWorkersRpcResponse } from "capnweb";
import { env } from "cloudflare:workers";
import { StreamCapability } from "../../src/workers/stream-capability.ts";

export { Stream } from "../../src/workers/durable-objects/stream.ts";
export { StreamProcessorRunner } from "../../src/workers/durable-objects/stream-processor-runner.ts";

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/stream-processor-runner/")) {
      const name = decodeURIComponent(url.pathname.slice("/stream-processor-runner/".length));
      return env.STREAM_PROCESSOR_RUNNER.getByName(name).fetch(request);
    }

    if (url.pathname === "/api/streams" || url.pathname.startsWith("/api/streams/")) {
      const path =
        url.pathname === "/api/streams"
          ? "/"
          : decodeURIComponent(url.pathname.slice("/api/streams/".length));
      // Stream DOs are named `${namespace}:${path}`; the browser namespace is "default".
      return newWorkersRpcResponse(
        request,
        new StreamCapability(env.STREAM.getByName(`default:${path}`)),
      );
    }

    // No COOP/COEP on purpose: the browser SQLite mirror uses wa-sqlite's OPFSCoopSyncVFS,
    // which needs no SharedArrayBuffer and no cross-origin isolation. (Isolation is what
    // made @sqlite.org/sqlite-wasm auto-install its async-proxy OPFS VFS and deadlock in
    // production builds.) Leaving it off also keeps OPFS working the same way
    // across Chrome, Edge, Safari and mobile Safari.
    return handler.fetch(request);
  },
});
