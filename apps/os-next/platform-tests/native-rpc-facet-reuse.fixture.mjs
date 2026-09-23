// Deploy only to the dedicated native-RPC reproducer. This is deliberately not OS data.
import { DurableObject } from "cloudflare:workers";

export const FIXTURE_BUILD = "native-rpc-facet-reuse-v1";

export class Repo extends DurableObject {
  ping() {
    return "repo-pong";
  }
}

export class Caller extends DurableObject {
  ping(name) {
    // Intentionally obtain the same named first-party exported facet afresh on
    // every Caller RPC. The next call is the native-runtime regression probe.
    return this.ctx.facets
      .get(name, () => ({ class: this.ctx.exports.Repo({ props: { name } }) }))
      .ping();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parent = url.searchParams.get("parent");
    const name = url.searchParams.get("name");
    if (!parent || !name) return new Response("parent and name are required", { status: 400 });
    try {
      return Response.json({
        fixtureBuild: FIXTURE_BUILD,
        result: await env.CALLER.get(env.CALLER.idFromName(parent)).ping(name),
      });
    } catch (error) {
      // Preserve the native reference for the manual probe instead of replacing
      // it with the edge's generic 1101 page.
      return Response.json({ fixtureBuild: FIXTURE_BUILD, error: String(error) }, { status: 500 });
    }
  },
};
