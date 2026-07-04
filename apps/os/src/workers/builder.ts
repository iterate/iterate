/**
 * The builder worker: bundles dynamic worker source into loader-ready
 * artifacts (src/domains/workers/builder-entrypoint.ts). The ONLY worker
 * whose script carries the bundler toolchain (esbuild-wasm); the worker
 * worker calls it through the BUILDER service binding on artifact-cache
 * misses and stays lean itself.
 *
 * Deliberately the minimum possible worker: a pure build function whose only
 * binding is the artifact cache — no DOs, no service bindings, no repo
 * access. If the apps/os worker split ever collapses into a single worker
 * (#1636), this script drops unchanged into a "1 + 1" topology as the lone
 * sidecar quarantining the wasm.
 */
import { BuilderEntrypoint } from "../domains/workers/builder-entrypoint.ts";

export default BuilderEntrypoint;
