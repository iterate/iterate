/**
 * Next-engine project worker: hosts ProjectDurableObject (coexistence deployment —
 * see the itx-v4 replacement plan). Every next-engine worker re-exports the
 * shared loopback entrypoints so `ctx.exports` resolves identically in all
 * of them.
 */
export { ProjectDurableObject } from "../domains/projects/project-durable-object.ts";
export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";

export default {
  fetch: () => Response.json({ worker: "os-next-project" }, { status: 404 }),
};
