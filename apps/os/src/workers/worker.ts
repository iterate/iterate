/**
 * The worker worker: the single owner of dynamic workers. Its default
 * entrypoint (`DynamicWorkerEntrypoint`) runs stateless dynamic workers for
 * every other worker's `DYNAMIC_WORKERS` service binding, and
 * `StatefulWorkerDurableObject` hosts stateful (Durable Object class) dynamic
 * workers (per-DO worker topology — see docs/worker-topology.md). This is the
 * only worker with a `LOADER` (Worker Loader) binding.
 *
 * Every itx worker re-exports the shared loopback entrypoints so
 * `ctx.exports` resolves identically in all of them.
 */
import { DynamicWorkerEntrypoint } from "../domains/workers/dynamic-worker-entrypoint.ts";

export { StatefulWorkerDurableObject } from "../domains/workers/stateful-worker-durable-object.ts";
export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";

export default DynamicWorkerEntrypoint;
