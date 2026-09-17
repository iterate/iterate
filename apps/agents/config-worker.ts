// Install this source as the project's itx.worker, and point app labels at it, e.g.
//   itx.provide("itx.apps.agents", "itx.worker")
// so a request to agents--<project>.<base> reaches this worker with the app slug in the
// `x-iterate-app` header (the edge derives it from the itx.apps.<label> expression — apps/os's
// header). The platform supplies processor.js.
// @ts-ignore -- This module exists inside the project worker loader.
import { ConfigWorker } from "./processor.js";

export default class extends ConfigWorker {
  async fetch(request: Request) {
    const denied = this.auth.require(request);
    if (denied) return denied;
    // Route by the app slug, exactly like apps/os's config repo: the `agents` app fetches through to
    // the independently-deployed Agents worker (its own origin), so agents--<project>.<base> serves the
    // same app as dash.iterate2.com.
    if (request.headers.get("x-iterate-app") === "agents") {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.host = "dash.iterate2.com";
      return fetch(new Request(url, new Request(request, { redirect: "manual" })));
    }
    return new Response("Not found\n", { status: 404 });
  }
}
