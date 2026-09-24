// THE MINIMAL REPRO for Cloudflare (fresh-preview-repro.ts deploys it): one SQLite-backed Durable
// Object class, and a fetch handler that calls a Durable Object that never existed. Nothing else —
// no bindings but the one namespace, no dependencies — so what a brand-new Worker Preview answers
// in its first seconds is the platform's answer, not iterate's.
import { DurableObject } from "cloudflare:workers";

export class Pinger extends DurableObject {
  ping() {
    return "pong";
  }
}

export default {
  async fetch(_request: Request, env: { PINGER: DurableObjectNamespace<Pinger> }) {
    const started = Date.now();
    try {
      await env.PINGER.getByName(crypto.randomUUID()).ping();
      return Response.json({ ok: true, ms: Date.now() - started });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ms: Date.now() - started,
        },
        { status: 500 },
      );
    }
  },
};
