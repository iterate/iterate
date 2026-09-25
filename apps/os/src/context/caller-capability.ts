// context/caller-capability.ts — WHOM A HOSTED SERVICE SERVES AS WHOM, pure (no I/O). H is the
// context that hosts a facet or a worker; O, the call's ORIGIN, is the context the platform stamped
// at the call's first hop (`Caller.path`, caller.ts), or H itself for a call that took none. A
// service that serves callers — a facet whose class lists `forCaller` in its `publicMethods`, a
// worker whose spec says `servesCallers: true` — serves a caller strictly beneath H as that caller:
// the platform calls `forCaller(caller)` first and walks the caller's steps on what it answers.
// `caller` is iterate/sdk's `ItxCaller`, `{ path: O, itx }`: O's own app handle, the `env.ITX` code
// loaded at O holds — walled at O (no `builtins`, `cd` down only, rows admitted against O) and
// resolved through O's live table, its masks included. Only downward, because whoever chose the
// code at H — H itself, or an ancestor through a row — already controls O's subtree: O's handle
// gives that code nothing its author did not hold, so a kept `caller.itx` needs no expiry.
// Any other caller — at H, above it, or beside it — is served as H: nothing it holds is handed to
// a service it never chose, and what the service writes is stamped as H (caller.ts `stampCaller`),
// so its readers know who spoke. A caller that spells `forCaller` itself is refused before this
// (facet-public-methods.ts rule 5, built-ins.ts `workers.get`). Rows of the table in
// caller-capability.test.ts.
import type { ItxExpression } from "iterate/expression";
import { isAtOrBeneath } from "iterate/stream/processor";
import type { ItxCaller } from "iterate/sdk";

/** The steps a caller's walk runs as on a service at `host` (the rules above); `callerAt` mints the
 *  capability only when one is handed over. */
export function stepsForCaller(args: {
  host: string;
  origin: string;
  /** The service serves callers: a facet's class lists `forCaller`, a worker's spec says so. */
  servesCallers: boolean;
  steps: ItxExpression;
  callerAt: (path: string) => ItxCaller;
}): ItxExpression {
  const { host, origin, steps } = args;
  if (!args.servesCallers || origin === host || !isAtOrBeneath(origin, host)) return steps;
  return [["forCaller", args.callerAt(origin)], ...steps];
}
