import { ConfigWorker, type ConfigEventArgs } from "iterate/sdk";
import { installAgents } from "./agents/install.ts";

export default class extends ConfigWorker {
  async processEvent({ event, itx }: ConfigEventArgs) {
    if (event.type !== "events.iterate.com/project/created") return;
    // The agents app runs from its own source in this repo: the files of agents/, index.ts its entry.
    await installAgents(itx, await itx.repos.get("/repos/config").modules({ dir: "agents" }));
  }
  // Every host of the project reaches this fetch. The platform names the host's routing slug in
  // `x-iterate-routing-slug` (`blog` for `blog--<project>.<base>`; absent on the apex): route on it.
  async fetch(request: Request) {
    // Fetch routes first (`iterate tunnel` sets one): a matched request goes to its route's target.
    const route = await this.withItx((itx) =>
      itx.fetchRoutes.match({ url: request.url, headers: request.headers }),
    );
    if (route?.authRequirement && !request.headers.has("x-itx-principal"))
      return new Response("Sign in\n", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
      });
    if (route) {
      const headers = new Headers(request.headers);
      headers.set("x-itx-expression", JSON.stringify(route.target));
      return this.env.ITX.fetch(new Request(request, { headers }));
    }
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
