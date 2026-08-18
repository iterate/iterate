// hello-files.ts — the v1 "file reader" behind `itx.files.read` — provides hello modules (no
// repo/bundler yet). A real repo-read-at-a-ref later slots in behind the SAME capability + source
// expressions. Its own module so BOTH hosts of the iterate-context processor (the Stream DO and
// the built-in ProcessorFacet) import it without a cycle.

export const HELLO_FILES: Record<string, string> = {
  "/hello.js": `export default (itx, name) => "hello " + (name ?? "world");`,
  "/counter.js": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment(by) { const n = ((await this.ctx.storage.get("n")) ?? 0) + by; await this.ctx.storage.put("n", n); return n; }
  async value() { return (await this.ctx.storage.get("n")) ?? 0; }
  async whoAmI() { return await this.env.ITX.invokeCapability("itx.whoami", []); }
  // A NESTED surface — proves the runner's deep dotted dispatch.
  get counters() {
    const self = this;
    return { async add(by) { return self.increment(by); } };
  }
}`,
  // A USERSPACE facet processor (duck-typed contract: configure/deliver/snapshot) — hosted as a
  // workerd facet on the Stream DO via enableProcessor(slug, { source, className }). It keeps its
  // own cursor + counts in its OWN facet storage; snapshot catches up from the stream via env.ITX
  // (the parent stub) so reads are never stale even though drives are fire-and-forget.
  "/user-tally.js": `import { DurableObject } from "cloudflare:workers";
export class UserTally extends DurableObject {
  configure() {} // identity unused — env.ITX already IS this stream
  #fold(events) {
    let offset = this.ctx.storage.kv.get("offset") ?? 0;
    const counts = this.ctx.storage.kv.get("counts") ?? {};
    for (const e of events)
      if (e.offset > offset) { counts[e.type] = (counts[e.type] ?? 0) + 1; offset = e.offset; }
    this.ctx.storage.kv.put("counts", counts);
    this.ctx.storage.kv.put("offset", offset);
    return { offset, state: { counts } };
  }
  deliver(events) { this.#fold(events); }
  async snapshot() {
    return this.#fold(await this.env.ITX.read(this.ctx.storage.kv.get("offset") ?? 0));
  }
}`,
  // A fetch-serving stateless worker: an HTTP page AND a WebSocket upgrade (101) — the stand-in
  // for "a device presents a website with WebSocket functionality", reached on the fetch lane.
  "/site.js": `export default {
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("site-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("<!doctype html><title>dynamic site</title><h1>hello from a dynamic web capability</h1>", { headers: { "content-type": "text/html" } });
  }
};`,
};
