// context/caller-capability.ts — WHOM A HOSTED FACET SERVES, pure (no I/O). H is the context that
// hosts the facet; O, the call's ORIGIN, is the context the platform stamped at the call's first hop
// (`Caller.path`, caller.ts), or H itself for a call that took none. A facet whose class lists
// `forCaller` in its `publicMethods` serves a caller only as that caller:
//   1. O is H or an ancestor of H: the caller's walk runs on the facet. The caller already holds H.
//   2. O is strictly beneath H: the platform calls `forCaller(caller)` first and walks the caller's
//      steps on what it answers. `caller` is iterate/sdk's `ItxCaller`, `{ path: O, itx }`: O's own
//      app handle, the `env.ITX` code loaded at O holds — walled at O (no `builtins`, `cd` down only,
//      rows admitted against O) and resolved through O's live table, its masks included.
//   3. O is beside H: FORBIDDEN. Nothing gave H's code any say over O.
// Only upward, because whoever chose the code at H — H itself, or an ancestor through a row — already
// controls O's subtree: O's handle gives that code nothing its author did not hold. A facet that lists
// no `forCaller` is called as its host from anywhere, and a caller that spells `forCaller` itself is
// refused before this (facet-public-methods.ts rule 5). Rows of the table in caller-capability.test.ts.
import { codedError } from "iterate/lib";
import type { ItxExpression } from "iterate/expression";
import type { ItxCaller } from "iterate/sdk";

const isStrictlyBeneath = (path: string, ancestor: string) =>
  path !== ancestor && path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);

/** The steps a caller's walk runs as on the facet `facet` at `host` (the rules above); `callerAt`
 *  mints the capability only when one is handed over. */
export function stepsForCaller(args: {
  facet: string;
  host: string;
  origin: string;
  /** The facet's class lists `forCaller`. */
  servesCallers: boolean;
  steps: ItxExpression;
  callerAt: (path: string) => ItxCaller;
}): ItxExpression {
  const { facet, host, origin, steps } = args;
  if (!args.servesCallers || origin === host || isStrictlyBeneath(host, origin)) return steps;
  if (!isStrictlyBeneath(origin, host))
    throw codedError(
      "FORBIDDEN",
      `facet "${facet}" at ${JSON.stringify(host)} serves its context, the contexts above it and the contexts beneath it — ${JSON.stringify(origin)} is beside it`,
    );
  return [["forCaller", args.callerAt(origin)], ...steps];
}
