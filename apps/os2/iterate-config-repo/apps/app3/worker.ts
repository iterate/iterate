import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    if (request.headers.get("x-iterate-app-slug") !== "app3") return;
    const counter = await env.DURABLE_OBJECTS.get({
      className: "CounterServer",
      name: "main",
    });
    return await counter.fetch(request);
  },
};

export class CounterServer extends DurableObject {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/counter") {
      return new Response("Counter route not found", { status: 404 });
    }

    const value = (this.ctx.storage.kv.get("value") || 0) + 1;
    this.ctx.storage.kv.put("value", value);
    return Response.json({ value });
  }
}
