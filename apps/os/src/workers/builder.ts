/**
 * The builder worker: bundles dynamic worker source into loader-ready
 * artifacts (src/domains/workers/builder-entrypoint.ts). The ONLY worker
 * whose script carries the bundler toolchain (esbuild-wasm); the worker
 * worker calls it through the BUILDER service binding on artifact-cache
 * misses and stays lean itself.
 */
import { BuilderEntrypoint } from "../domains/workers/builder-entrypoint.ts";

export default BuilderEntrypoint;
