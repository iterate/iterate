export const AGENT_APP_BUNDLE = /* js */ `
import { DurableObject } from "cloudflare:workers";

export class StreamProcessor extends DurableObject {
  async fetch(req) {
    const evt = await req.json();
    console.log("[StreamProcessor] streamPath=" + evt.streamPath);
    const n = (this.ctx.storage.kv.get("count") ?? 0) + 1;
    this.ctx.storage.kv.put("count", n);
    console.log("[StreamProcessor] count=" + n);
    return Response.json({ layer: 3, streamPath: evt.streamPath, count: n });
  }
}

export class AgentApp extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/probe") {
      // Return diagnostic info about what's available
      const exportsInfo = {};
      for (const [key, val] of Object.entries(this.ctx.exports)) {
        exportsInfo[key] = {
          type: typeof val,
          constructorName: val?.constructor?.name,
        };
      }
      return Response.json({
        ctxOwnKeys: Object.getOwnPropertyNames(this.ctx),
        exportsInfo,
        note: "Use this.ctx.exports.ClassName (LoopbackDurableObjectClass) instead of bare class refs for facets.get()",
      });
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const evt = await req.clone().json();
      const streamPath = evt.streamPath || "default";
      console.log("[AgentApp] received event, streamPath=" + streamPath);

      // KEY INSIGHT: Use this.ctx.exports.StreamProcessor (LoopbackDurableObjectClass)
      // NOT the bare StreamProcessor class reference
      const proc = this.ctx.facets.get("stream:" + streamPath, async () => ({
        class: this.ctx.exports.StreamProcessor,
      }));

      console.log("[AgentApp] forwarding to StreamProcessor facet");
      const inner = await proc.fetch(new Request("http://localhost/event", {
        method: "POST",
        body: JSON.stringify(evt),
      }));
      const innerJson = await inner.json();
      console.log("[AgentApp] response from StreamProcessor:", JSON.stringify(innerJson));
      return Response.json({ layer: 2, from: "AgentApp", inner: innerJson });
    }

    return new Response("AgentApp: try POST /events or GET /probe", { status: 404 });
  }
}
`;
