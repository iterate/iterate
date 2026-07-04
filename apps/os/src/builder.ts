/**
 * The builder worker: bundles dynamic worker source into loader-ready
 * artifacts (src/domains/workers/builder-entrypoint.ts). The ONLY worker
 * whose script carries the bundler toolchain (esbuild-wasm); the os worker
 * calls it through the BUILDER service binding on artifact-cache misses and
 * stays lean itself.
 *
 * This is the "+1" in the single-worker topology: a pure build function
 * whose only binding is the artifact cache — no DOs, no service bindings,
 * no repo access, nothing that orders its deploy relative to the os worker
 * beyond "builder first". Deployed from its own generated wrangler config
 * (scripts/generate-wrangler-config.ts); quarantining the ~14MB wasm here
 * keeps the product script small. Slated for deletion when builds move into
 * the sandbox container (tasks/os-sandbox-worker-builds.md).
 */
import { BuilderEntrypoint } from "./domains/workers/builder-entrypoint.ts";

export default BuilderEntrypoint;
