/**
 * Stream worker: hosts every Stream Durable Object (journals, project event
 * streams, the global capture stream). Subscribers are dialed by env binding
 * name + DO name embedded in the subscription, so this worker carries
 * cross-script namespaces for every subscriber worker — including the ones
 * that bind STREAM back. Cyclic cross-script DO bindings are fine once both
 * scripts exist; see docs/worker-topology.md (bootstrap).
 */
export { Stream as StreamDurableObject } from "@iterate-com/streams/workers/durable-objects/stream";

export default {
  fetch: () => Response.json({ worker: "os-stream" }, { status: 404 }),
};
