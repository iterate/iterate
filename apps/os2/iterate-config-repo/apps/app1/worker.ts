// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";

export class AppOne extends WorkerEntrypoint {
  async fetch() {
    return new Response("hello from app one", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-project-app": "app1",
      },
    });
  }
}
