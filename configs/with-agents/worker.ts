import { installAgents } from "@iterate-com/agents/install";
import { ConfigWorker, z, type ConfigEventArgs } from "iterate/sdk";

const CommitCompleted = z.object({
  path: z.string(),
  commitOid: z.string(),
  changedPaths: z.array(z.string()),
});

export default class extends ConfigWorker {
  // The agents app runs from agents/ in this repo: its package.json pins @iterate-com/agents and its
  // index.ts re-exports the app's classes. It is installed when the project is created, and again
  // from every commit that changes agents/ (a new version is an upgrade).
  async processEvent({ event, itx }: ConfigEventArgs) {
    let commitOid: string | undefined;
    if (event.type === "events.iterate.com/repo/commit-completed") {
      const commit = CommitCompleted.parse(event.payload);
      if (commit.path !== "/repos/config") return;
      if (!commit.changedPaths.some((path) => path.startsWith("agents/"))) return;
      commitOid = commit.commitOid;
    } else if (event.type !== "events.iterate.com/project/created") return;
    const repo = itx.repos.get("/repos/config");
    await installAgents(itx, await repo.modules({ dir: "agents", commitOid }));
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
