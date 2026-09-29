import { IterateConfigEntrypoint, type IterateConfigProcessEventArgs } from "iterate/sdk";

export default class extends IterateConfigEntrypoint {
  // Every durable event of every context of the project, one at a time, in no particular order and
  // at least once: make each reaction idempotent. `itx` is the project's root; `itx.cd(event.path)`
  // is the context the event happened in. The `events.iterate.com/project/worker-updated` case,
  // which runs after every published commit, is the place for init.
  async processEvent(_args: IterateConfigProcessEventArgs) {}

  // Every host of the project reaches this fetch, but for what a fetch route takes (`iterate
  // tunnel` sets one). The platform names the host's routing slug in `x-iterate-routing-slug`
  // (`blog` for `blog--<project>.<base>`; absent on the apex): route on it.
  async fetch(request: Request) {
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (!routingSlug) {
      const { projectSlug } = await this.withItx((itx) => itx.whoami());
      return new Response("Homepage of project " + projectSlug + "\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found\n", { status: 404 });
  }
}
