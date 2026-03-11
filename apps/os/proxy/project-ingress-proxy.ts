import { DurableObject } from "cloudflare:workers";
import type { ProxyWorkerBindings } from "./worker.ts";

export class ProjectIngressProxy extends DurableObject {
  declare env: ProxyWorkerBindings;
  count = 0;

  fetch(request: Request): Response | Promise<Response> {
    const domain = new URL(request.url).hostname;
    return Response.json({
      message: "Hello, from Durable Object!",
      domain,
      requestCount: this.count++,
    });
  }
}
