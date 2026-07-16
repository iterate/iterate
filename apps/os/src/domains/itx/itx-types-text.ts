import { ITX_API_DECLARATIONS } from "../../itx-api-graph.generated.ts";

/**
 * The public itx surface as ONE standalone TypeScript module: every
 * declaration of the Itx Type Graph joined in order — byte-identical to
 * itx-api.generated.ts's declarations (same generator run; freshness
 * enforced by itx-api.generated.test.ts). Import-free by construction, so it
 * drops into any virtual filesystem. The browser REPL's editor loads it
 * exactly; the resource-bounded in-Worker typechecker replaces only the
 * exact Octokit import with a compiler-only structural view so unrelated
 * script checks do not load the vendor package's full transitive type graph.
 */
export const itxTypesFileText: string = ITX_API_DECLARATIONS.map(
  (declaration) => declaration.sourceText,
).join("\n\n");
