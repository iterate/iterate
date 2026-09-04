// context/built-in-roots.ts — THE RESERVED ROOT'S KEYS, as one constant. `itx.builtins.<root>` is
// the physical scope (context/built-ins.ts `BuiltInScope` — kv, append, rpcStubs, facets, …), and
// every short name `itx.<root>` is the IMPLICIT PLATFORM ROW `itx.<root> ⇒ itx.builtins.<root>`
// (context/itx-expression-rewriting.ts, rule 5). A LEAF module on purpose: the core reduce
// (stream/core-processor.ts) needs this list to tell a MASK (`itx.kv ⇒ null`, kept — it shadows a
// platform row) from a plain deletion, and the DO's `rewriteRules.list()` needs it to show the
// platform rows; neither may import the record itself (it closes over bindings and the loader).
// built-ins.ts asserts, at the type level, that this list and `keyof BuiltInScope` are the same set.

export const BUILT_IN_ROOTS = [
  "whoami",
  "kv",
  "append",
  "read",
  "waitForEvent",
  "cd",
  "fetch",
  "rpcStubs",
  "rewriteRules",
  "facets",
  "subscriptions",
  "workers",
  "runScript",
] as const;

export type BuiltInRoot = (typeof BUILT_IN_ROOTS)[number];

const BUILT_IN_ROOT_SET: ReadonlySet<string> = new Set<string>(BUILT_IN_ROOTS);

/** Is `root` one of the reserved root's keys — i.e. does `itx.<root>` have a platform row? */
export function isBuiltInRoot(root: unknown): root is BuiltInRoot {
  return typeof root === "string" && BUILT_IN_ROOT_SET.has(root);
}
