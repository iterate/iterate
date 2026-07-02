import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { newWorkersRpcResponse } from "capnweb";
import { parseStreamRpcRequest } from "./lib/stream-rpc.ts";
import { trustedInternalAuthContext } from "~/auth.ts";
import { StreamRpcTarget } from "~/rpc-targets.ts";
import { resolveStreamPath } from "~/domains/streams/utils.ts";
import type { Stream } from "~/types.ts";

export { StreamDurableObject } from "~/domains/streams/stream-durable-object.ts";

/**
 * The capnweb surface this playground serves at `/api/streams`.
 *
 * It wraps the itx `StreamRpcTarget` with `trustedInternalAuthContext()`:
 * the example app is an AUTH-LESS playground, so every caller gets the
 * trusted-internal (admin) authority instead of walking through the real
 * deployment's `UnauthenticatedItx.authenticate()` door.
 *
 * `kill()`/`reset()` are playground-only operator verbs on top of the public
 * `Stream` capability — the sidebar's restart/reset experiments need them, and
 * itx deliberately keeps them off the public contract.
 */
class PlaygroundStreamRpcTarget extends StreamRpcTarget {
  override at(path: Parameters<Stream["at"]>[0]) {
    return new PlaygroundStreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: resolveStreamPath(this.props.path, path),
    });
  }

  /** Abort the stream DO; the durable log is kept and a woken event is appended on restart. */
  kill() {
    return this.durableObjectStub.kill();
  }

  /** Wipe all stream DO storage, then abort — the next connection starts a fresh stream. */
  reset() {
    return this.durableObjectStub.reset();
  }
}

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/__internal/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/api/streams") {
      const { projectId, path } = parseStreamRpcRequest({ url });
      return newWorkersRpcResponse(
        request,
        new PlaygroundStreamRpcTarget({
          auth: trustedInternalAuthContext(),
          projectId,
          path,
        }),
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
