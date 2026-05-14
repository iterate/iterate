// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";

export { AppOne } from "./apps/app1/worker.ts";
export { AppTwo } from "./apps/app2/worker.ts";

export default class Project extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = request.headers.get("x-iterate-ingress-hostname") ?? url.hostname;
    const appSlug = appSlugFromHostname(hostname);

    if (appSlug === "app1") {
      return await this.ctx.exports.AppOne.fetch(request);
    }

    if (appSlug === "app2") {
      return await this.ctx.exports.AppTwo.fetch(request);
    }

    return new Response("Hello from the project config worker at " + hostname, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-project-ingress-runtime": "dynamic-worker-config-repo",
      },
    });
  }

  async afterAppend({ event }) {
    console.log("Project config worker afterAppend", event.type);
  }
}

function appSlugFromHostname(hostname) {
  const firstLabel = hostname.split(".")[0] ?? "";
  if (firstLabel === "app1" || firstLabel.startsWith("app1__")) return "app1";
  if (firstLabel === "app2" || firstLabel.startsWith("app2__")) return "app2";
  return null;
}
