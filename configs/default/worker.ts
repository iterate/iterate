import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  async fetch() {
    const { projectSlug } = await this.env.ITX.get().whoami();
    return new Response("Homepage of project " + projectSlug + "\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  async processEventBatch() {}
}
