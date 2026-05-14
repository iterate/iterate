// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";
import { fetch as fetchAppOne } from "./apps/app1/worker.ts";
import { fetch as fetchAppTwo } from "./apps/app2/worker.ts";
import { firstResponse } from "./lib/sdk.ts";

const appFetchers = [fetchAppOne, fetchAppTwo];

export default class Project extends WorkerEntrypoint {
  async fetch(request) {
    const appResponse = await firstResponse(appFetchers, request);
    if (appResponse) return appResponse;

    const url = new URL(request.url);
    const hostname = request.headers.get("x-iterate-ingress-hostname") ?? url.hostname;
    return new Response("Hello from the project config worker at " + hostname);
  }

  async afterAppend({ event }) {
    console.log("Project config worker afterAppend", event.type);
  }
}
