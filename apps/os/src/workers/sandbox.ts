/**
 * The sandbox worker: hosts CloudflareSandboxDurableObject — the
 * `@cloudflare/sandbox` container class — under the per-DO worker topology
 * (docs/worker-topology.md). Every itx worker re-exports the shared
 * loopback entrypoints so `ctx.exports` resolves identically in all of them.
 */
export { CloudflareSandboxDurableObject } from "../domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";
// The container-outbound gateway. `@cloudflare/containers` dials it through
// `ctx.exports.ContainerProxy` to route intercepted egress; every sandbox
// container's outbound HTTP(S) reaches it before anything leaves the account
// (see CloudflareSandboxDurableObject's `outbound` handler).
export { ContainerProxy } from "@cloudflare/containers";

export default {
  fetch: () => Response.json({ worker: "os-sandbox" }, { status: 404 }),
};
