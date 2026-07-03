/**
 * The capability-host worker: hosts CapabilityHostDurableObject (per-DO worker
 * topology — see docs/worker-topology.md). Every itx worker re-exports the
 * shared loopback entrypoints so `ctx.exports` resolves identically in all
 * of them.
 */
export { CapabilityHostDurableObject } from "../domains/capability-host/capability-host-durable-object.ts";
export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";

export default {
  fetch: () => Response.json({ worker: "os-capability-host" }, { status: 404 }),
};
