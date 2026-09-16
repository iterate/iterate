import { DurableObject, tracing } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    if (request.headers.get("x-probe-key") !== env.PROBE_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    const traceparent = request.headers.get("traceparent");
    return tracing.enterSpan("probe.worker", async (span) => {
      span.setAttribute("probe.traceparent", traceparent || "absent");
      console.log({ message: "probe.worker", traceparent });
      const object = new URL(request.url).searchParams.get("object") || "stateless";
      const result = await env.PROBE.getByName(object).ping(traceparent);
      return Response.json(result);
    });
  },
};

export class Probe extends DurableObject {
  async ping(traceparent) {
    return tracing.enterSpan("probe.durable-object", (span) => {
      span.setAttribute("probe.traceparent", traceparent || "absent");
      console.log({ message: "probe.durable-object", traceparent });
      return { ok: true, traceparent };
    });
  }
}
