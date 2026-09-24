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
  async fetch() {
    const { projectSlug } = await this.env.ITX.get().whoami();
    return new Response("Homepage of project " + projectSlug + "\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
