import { ITX_API_DECLARATIONS } from "../../itx-api-graph.generated.ts";

/**
 * The public itx surface as ONE standalone TypeScript module: every
 * declaration of the Itx Type Graph joined in order — byte-identical to
 * itx-api.generated.ts's declarations (same generator run; freshness
 * enforced by itx-api.generated.test.ts). Import-free by construction, so it
 * drops into any virtual filesystem: the browser REPL's editor
 * (components/itx-repl-types.ts) and the typechecker's virtual project
 * (domains/typecheck/virtual-project.ts) both load exactly this text.
 */
export const itxTypesFileText: string = ITX_API_DECLARATIONS.map(
  (declaration) => declaration.sourceText,
).join("\n\n");
