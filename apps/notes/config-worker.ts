// A project config worker that serves the Notes app on notes--<project>.<base>. Every host of the
// project reaches this worker's fetch (published with `project/ingress-configured`); the platform
// says which host in the `x-iterate-routing-slug` header (absent on the apex) — the platform's
// header, never a visitor's. The platform supplies processor.js.
import { ConfigWorker } from "./processor.js";

export default class extends ConfigWorker {
  async fetch(request: Request) {
    const denied = this.auth.require(request);
    if (denied) return denied;
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    // The `notes` routing slug fetches through to the independently-deployed Notes worker (its own
    // origin), so notes--<project>.<base> serves the same app as notes.iterate.com.
    if (routingSlug === "notes") {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.host = "notes.iterate.com";
      return fetch(new Request(url, new Request(request, { redirect: "manual" })));
    }
    return new Response("Not found\n", { status: 404 });
  }
}
