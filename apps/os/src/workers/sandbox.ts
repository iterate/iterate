/**
 * The sandbox worker: hosts CloudflareSandboxDurableObject — the
 * `@cloudflare/sandbox` container class — under the per-DO worker topology
 * (docs/worker-topology.md). Every itx worker re-exports the shared
 * loopback entrypoints so `ctx.exports` resolves identically in all of them.
 */
export { CloudflareSandboxDurableObject } from "../domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";

export default {
  fetch: () => Response.json({ worker: "os-sandbox" }, { status: 404 }),
};
