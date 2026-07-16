/**
 * Tiny loader-owning sidecar for itx script execution.
 *
 * It carries no product routes, Durable Object classes, compiler, bundler,
 * storage, or secrets. The host sends only durable scope coordinates; the
 * sidecar's cross-script namespaces mint the exact CapabilityHost and Project
 * stubs used for itx and egress. It loads the script as a Dynamic Worker and
 * returns the serializable result. Keeping this entrypoint out of the large OS
 * bundle removes the cold execution-isolate activation from runScript latency.
 */
import { ScriptExecutorEntrypoint } from "./domains/capability-host/script-executor-entrypoint.ts";

export default ScriptExecutorEntrypoint;
