// A project config worker that serves the Docs app on its `docs` routing slug:
// docs--<project>.<base> under subdomains, <platform>/projects/<project>/docs/ under paths, where
// the edge strips that base path and says it in `x-iterate-base-path`, which rides through to Docs
// (packages/ui/src/apps/base-path.ts). Every host of the project reaches this worker's fetch
// (published with `itx/ingress-configured`); the platform says which host in the
// `x-iterate-routing-slug` header (absent on the apex). A project's real config worker adds this
// route to its own. The loader links `iterate/sdk` to the platform's own SDK build.
import { ConfigWorker } from "iterate/sdk";

export default class extends ConfigWorker {
  async fetch(request: Request) {
    const denied = this.auth.require(request);
    if (denied) return denied;
    // The `docs` routing slug fetches through to the Docs Worker (envs.ts `docsEnvs`), which serves
    // the app's pages and files and signs no one in: this host's sign-in is the platform's.
    if (request.headers.get("x-iterate-routing-slug") === "docs") {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.host = "docs.iterate.workers.dev";
      return fetch(new Request(url, new Request(request, { redirect: "manual" })));
    }
    return new Response("Not found\n", { status: 404 });
  }
}
