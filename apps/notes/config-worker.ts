// Install this source as the project's itx.worker, and point app labels at it, e.g.
//   itx.provide("itx.apps.notes", "itx.worker")
// so a request to notes--<project>.<base> reaches this worker with the app slug in the
// `x-iterate-app` header (the edge derives it from the itx.apps.<label> expression — apps/os's
// header). The platform supplies processor.js.
// @ts-ignore -- This module exists inside the project worker loader.
import { ConfigWorker } from "./processor.js";

export default class extends ConfigWorker {
  async fetch(request: Request) {
    const denied = this.auth.require(request);
    if (denied) return denied;
    // Route by the app slug, exactly like apps/os's config repo: the `notes` app fetches through to
    // the independently-deployed Notes worker (its own origin), so notes--<project>.<base> serves the
    // same app as notes.iterate.workers.dev.
    if (request.headers.get("x-iterate-app") === "notes") {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.host = "notes.iterate.workers.dev";
      return fetch(new Request(url, new Request(request, { redirect: "manual" })));
    }
    return new Response("Not found\n", { status: 404 });
  }
}
