// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";

export default class Project extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = request.headers.get("x-iterate-ingress-hostname") ?? url.hostname;
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
