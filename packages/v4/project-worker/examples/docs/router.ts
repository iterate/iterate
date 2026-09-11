// A project-owned ingress router. Install its fetch with a durable
// `itx/rewrite-rule-configured` fact for `itx.fetch`; platform ingress has already selected the
// root project from the hostname before this code runs. It must not be lent with `itx.provide()`:
// that deliberately recalls its rule when the provider session ends.
import { WorkerEntrypoint } from "cloudflare:workers";

const DOCS_HOSTS = new Set(["docs--v4-demo.iterate2.app", "v4-custom.iterate2.app"]);

export default class DocsIngressRouter extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const itx = await this.env.ITX.get();
    if (DOCS_HOSTS.has(new URL(request.url).hostname)) return itx.docs.fetch(request);

    // Only the physical terminal owns project-secret substitution and external egress. A project
    // alias for `itx.fetch` must never turn this fallback into another user-defined hop.
    return itx.builtins.fetch(request);
  }
}
