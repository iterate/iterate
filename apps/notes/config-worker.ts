// Install this source as the project's itx.worker. The platform supplies processor.js.
// @ts-ignore -- This module exists inside the project worker loader.
import { ConfigWorker } from "./processor.js";

export default class extends ConfigWorker {
  async fetch(request: Request) {
    const denied = this.auth.require(request);
    if (denied) return denied;
    const url = new URL(request.url);
    url.protocol = "https:";
    url.host = "notes.iterate2.com";
    return fetch(new Request(url, new Request(request, { redirect: "manual" })));
  }
}
