// A project config worker that serves the Notes app on its `notes` routing slug:
// notes--<project>.<base> under subdomains, <platform>/projects/<project>/notes/ under paths, where
// the edge strips that base path and says it in `x-iterate-base-path`, which rides through to Notes
// (packages/ui/src/apps/base-path.ts). Every host of the project reaches this worker's fetch (published with
// `itx/ingress-configured`); the platform says which host in the `x-iterate-routing-slug` header
// (absent on the apex) — the platform's header, never a visitor's. The loader links `iterate/sdk`
// to the platform's own SDK build.
import { IterateConfigEntrypoint } from "iterate/sdk";

export default class extends IterateConfigEntrypoint {
  async fetch(request: Request) {
    const denied = this.auth.require(request);
    if (denied) return denied;
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    // The `notes` routing slug fetches through to the Notes Worker (envs.ts `notesEnvs`), which
    // serves the app's pages and files and signs no one in: this host's sign-in is the platform's.
    if (routingSlug === "notes") {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.host = "notes.iterate.com";
      return fetch(new Request(url, new Request(request, { redirect: "manual" })));
    }
    return new Response("Not found\n", { status: 404 });
  }
}
