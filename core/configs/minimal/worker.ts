import { IterateConfigEntrypoint, type IterateConfigProcessEventArgs } from "iterate/sdk";

export default class extends IterateConfigEntrypoint {
  // Every durable event of the project, and the init case: AGENTS.md.
  async processEvent(_args: IterateConfigProcessEventArgs) {}

  // Every host of the project, routed on `x-iterate-routing-slug`: AGENTS.md.
  async fetch(request: Request) {
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (!routingSlug) {
      using itx = this.getItx();
      const { projectSlug } = await itx.whoami();
      return new Response("Homepage of project " + projectSlug + "\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found\n", { status: 404 });
  }
}
