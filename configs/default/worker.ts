import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  // Every host of the project reaches this fetch. The platform names the host's routing slug in
  // `x-iterate-routing-slug` (`blog` for `blog--<project>.<base>`; absent on the apex): route on it.
  async fetch(request) {
    // The project's ingress routes first (`itx.ingressRoutes`; `iterate tunnel` sets one per tunnel):
    // a matched request goes to its route's target, a private route's anonymous visitor to sign in.
    const itx = this.env.ITX.get();
    let route;
    try {
      route = await itx.ingressRoutes.match({
        method: request.method,
        url: request.url,
        headers: request.headers,
      });
    } finally {
      itx[Symbol.dispose]?.();
    }
    if (route) {
      if (route.authRequirement && !request.headers.get("x-itx-principal"))
        return new Response("Sign in\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
        });
      const headers = new Headers(request.headers);
      headers.set(
        "x-itx-expression",
        `itx.ingressRoutes.fetch(${JSON.stringify(route.ingressRouteName)})`,
      );
      return this.env.ITX.fetch(new Request(request, { headers }));
    }
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (routingSlug === null) {
      const { projectSlug } = await this.env.ITX.get().whoami();
      return new Response("Homepage of project " + projectSlug + "\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found\n", { status: 404 });
  }
  async processEventBatch() {}
}
