/**
 * The typechecker worker: compiles virtual TypeScript projects and returns
 * diagnostics (src/domains/typecheck/typechecker-entrypoint.ts). The ONLY
 * worker whose script carries the TypeScript compiler (tswasm, typescript-go
 * as wasm); the os worker calls it through the TYPECHECKER service binding
 * for provide-time capability-types validation and `itx.docs.typecheck`.
 *
 * The second "+1" in the single-worker topology, cut from the builder's
 * pattern (src/builder.ts): a pure function worker — files in, diagnostics
 * out — with no bindings at all. Deployed from its own generated wrangler
 * config (scripts/generate-wrangler-config.ts); quarantining the ~7MB
 * (gzipped) wasm here keeps the product script small.
 */
import { TypecheckerEntrypoint } from "./domains/typecheck/typechecker-entrypoint.ts";

export default TypecheckerEntrypoint;
