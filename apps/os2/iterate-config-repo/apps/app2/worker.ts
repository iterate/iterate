// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";

export class AppTwo extends WorkerEntrypoint {
  async fetch() {
    return new Response("hello from app two", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-project-app": "app2",
      },
    });
  }
}
