import { WorkerEntrypoint } from "cloudflare:workers";
import { installAgents } from "./agents.js";

export default class extends WorkerEntrypoint {
  async processEventBatch(events) {
    for (const event of events) {
      if (event.type !== "events.iterate.com/project/created") continue;
      const itx = this.env.ITX.get();
      try {
        const source = await itx.repos.get("/repos/config").readFile("agents.js");
        if (!source) throw new Error("The agents template is missing agents.js");
        await installAgents(itx, source);
      } finally {
        itx[Symbol.dispose]?.();
      }
    }
  }
  // Every host of the project reaches this fetch. The platform names the host's routing slug in
  // `x-iterate-routing-slug` (`blog` for `blog--<project>.<base>`; absent on the apex): route on it.
  async fetch(request) {
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (routingSlug === null) {
      const { projectSlug } = await this.env.ITX.get().whoami();
      return new Response("Homepage of project " + projectSlug + "\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found\n", { status: 404 });
  }
}
