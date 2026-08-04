// The workerd worker. Same capability-host + graph code as Node — imported, not forked.
//
// Proves, in REAL workerd:
//   • /api            — Node client → workerd capnweb server (project host is the localMain).
//   • /test/native    — gateway isolate → DO isolate over NATIVE Workers RPC, then pipeline
//                       `proj.iterate.flavor.flavorPrompt()` etc. through the returned host.
//                       This is the brand-check boundary spike 1 couldn't reach.
//   • /test/capnweb   — workerd client → workerd capnweb server (gateway → PEER over a
//                       service-binding WebSocket).
//   • /egress-target  — the real destination the control-plane egress capability fetches.

import { newWorkersRpcResponse, newWebSocketRpcSession } from "capnweb";
import { DurableObject } from "cloudflare:workers";
import { buildGraph, runDemo, checkDemo } from "./graph.mjs";

// Real outbound fetch, mediated by the control-plane egress capability. Uses the SELF
// service binding so it's a genuine workerd subrequest to /egress-target.
function makeEgressFetch(env) {
  return async (url) => {
    const res = await env.SELF.fetch(url);
    return { status: res.status, body: await res.text() };
  };
}
const projectHost = (env) => buildGraph({ egressFetch: makeEgressFetch(env) }).project;

// The capability host as a Durable Object — reached over NATIVE Workers RPC.
export class HostDO extends DurableObject {
  // Returns the project host (an RpcTarget) across the native boundary; the caller
  // pipelines `.iterate.flavor.flavorPrompt()` / `.egress.fetch()` onto it.
  project() {
    return projectHost(this.env);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Node client → workerd capnweb server.
    if (url.pathname === "/api") {
      return newWorkersRpcResponse(request, projectHost(env));
    }

    // The real egress destination.
    if (url.pathname === "/egress-target") {
      return new Response("pong from egress target (real workerd fetch)", { status: 200 });
    }

    // NATIVE boundary: gateway isolate → DO isolate, pipeline through the returned host.
    if (url.pathname === "/test/native") {
      const proj = env.HOST_DO.getByName("singleton").project(); // native RPC, pipelined
      const r = await runDemo(proj);
      const problems = checkDemo(r);
      return Response.json({
        ok: problems.length === 0,
        transport: "native Workers RPC (DO)",
        problems,
        r,
      });
    }

    // workerd client → workerd capnweb server (gateway → PEER over a service-binding WS).
    if (url.pathname === "/test/capnweb") {
      const resp = await env.PEER.fetch("https://peer/api", { headers: { Upgrade: "websocket" } });
      const ws = resp.webSocket;
      if (!ws)
        return Response.json({
          ok: false,
          error: "no webSocket from PEER (status " + resp.status + ")",
        });
      ws.accept();
      const proj = newWebSocketRpcSession(ws); // returns the remote-main stub directly
      try {
        const r = await runDemo(proj);
        const problems = checkDemo(r);
        return Response.json({
          ok: problems.length === 0,
          transport: "capnweb worker→worker (WS over service binding)",
          problems,
          r,
        });
      } finally {
        ws.close();
      }
    }

    return new Response("not found\n", { status: 404 });
  },
};
