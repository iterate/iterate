// Pure and runtime-neutral (no `cloudflare:workers`): unit tests import from
// here, the execution entrypoint wires it into the loader — the same split
// as search-corpus.ts vs search-index.ts.
import { transform } from "sucrase";

/**
 * Scripts are PROMISED as TypeScript (the agent prompt demands "one fenced
 * TypeScript code block"), but runScript's bundle-free fast path loads plain
 * JavaScript — so type syntax must be stripped at the seam, not rejected.
 * Sucrase's type-only transform is a few milliseconds and changes no runtime
 * semantics. If the code doesn't even parse, return it raw: the loader's own
 * syntax error feeds the existing corrective-retry lane, same as before.
 */
export function stripScriptTypes(code: string): string {
  try {
    return transform(code, { transforms: ["typescript"] }).code;
  } catch {
    return code;
  }
}
