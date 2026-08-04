// A second workerd worker: a capnweb server the gateway connects to as a CLIENT
// (proving workerd→workerd capnweb). Serves a project host at /api.

import { newWorkersRpcResponse } from "capnweb";
import { buildGraph } from "./graph.mjs";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api") {
      const project = buildGraph({
        egressFetch: async (u) => ({ status: 200, body: `pong from peer for ${u}` }),
      }).project;
      return newWorkersRpcResponse(request, project);
    }
    return new Response("peer: not found\n", { status: 404 });
  },
};
