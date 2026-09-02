// context/routing.ts — HOW A CALL FINDS ITS TARGET, pure and total. A mount is a REWRITE RULE:
// `{ path, target }` says "a call that starts with `path` is the same call with `path` replaced by
// `target`". `routeCall` rewrites a call through the mounts until its root is a built-in (the
// physical scope: kv, whoami, rpcStubs, load, …) — that call is what actually runs. Nothing here
// evaluates anything; ./dispatch.ts walks the result. Every rule is one table row in routing.test.ts.
//
// THE RULES
//   1. A path is dotted names; any step may be a CALL STEP pinning literal args: `itx.ai.run('gpt-5')`.
//   2. A name step matches the same property — or, as the path's FINAL step, a call of that name (all
//      of its args are unpinned). A call step matches a call of that name whose leading args EQUAL the
//      pinned literals (structurally). Pinned args are CONSUMED. Unpinned args beyond them are the call
//      on the target when the step is final; on a non-final step they are a non-match (the target
//      replaces every matched step, so a residual would have nowhere to go).
//   3. The most SPECIFIC matching mount wins: longest path, then most pinned args, then newest.
//   4. The rewrite: the target, then the unpinned args — folded into the target's final step when
//      that step is a name (`itx.grok ⇒ itx.openai.chat`, `itx.grok({…})` ⇒ `itx.openai.chat({…})`),
//      else an ANONYMOUS call on the target's result (`itx.cam ⇒ itx.rpcStubs.get('cam')`, `itx.cam(1)`
//      ⇒ `itx.rpcStubs.get('cam')(1)`) — then the call's steps after the mount.
//   5. Rewriting repeats until the root is a built-in; 32 rewrites is the budget (a self-referential
//      mount errors, never spins); a call no mount matches is refused (default-deny).

import { jsonEqual } from "../lib/patch.ts";
import { codedError } from "../lib/errors.ts";
import type { Mount } from "../stream/core-processor.ts";
import { print, type CapabilityPath, type Expression } from "./expression.ts";

/** What `matchMount` claims: the final step's unpinned args (present when the final path step
 *  matched a call step) and the call's steps after the mount. */
export type MountMatch = { unpinnedArgs?: unknown[]; stepsAfterMount: Expression };

/** Rule 2: claim `call` with `path`, step by step from the start — or null. */
export function matchMount(path: CapabilityPath, call: Expression): MountMatch | null {
  let unpinnedArgs: unknown[] | undefined;
  for (let i = 0; i < path.length; i++) {
    const pathStep = path[i];
    const callStep = call[i];
    const final = i === path.length - 1;
    if (callStep === undefined) return null; // the path is longer than the call
    if (typeof pathStep === "string") {
      if (typeof callStep === "string") {
        if (callStep !== pathStep) return null;
      } else if (callStep[0] !== pathStep || !final) return null;
      else unpinnedArgs = callStep.slice(1);
    } else {
      if (typeof callStep === "string" || callStep[0] !== pathStep[0]) return null;
      const pinned = pathStep.slice(1);
      const args = callStep.slice(1);
      if (args.length < pinned.length || !pinned.every((p, k) => jsonEqual(p, args[k])))
        return null;
      const residual = args.slice(pinned.length);
      if (final) unpinnedArgs = residual;
      else if (residual.length > 0) return null;
    }
  }
  return { unpinnedArgs, stepsAfterMount: call.slice(path.length) };
}

const pinnedArgCount = (path: CapabilityPath): number =>
  path.reduce<number>((n, step) => n + (Array.isArray(step) ? step.length - 1 : 0), 0);

/** Rule 3: the most specific matching mount — or null. */
export function pickMount(
  mounts: readonly Mount[],
  call: Expression,
): { mount: Mount; match: MountMatch } | null {
  let best: { mount: Mount; match: MountMatch } | null = null;
  const moreSpecific = (a: Mount, b: Mount): boolean =>
    a.path.length !== b.path.length
      ? a.path.length > b.path.length
      : pinnedArgCount(a.path) !== pinnedArgCount(b.path)
        ? pinnedArgCount(a.path) > pinnedArgCount(b.path)
        : a.providedAtOffset > b.providedAtOffset;
  for (const mount of mounts) {
    const match = matchMount(mount.path, call);
    if (match && (best === null || moreSpecific(mount, best.mount))) best = { mount, match };
  }
  return best;
}

/** Rule 4: the call with the matched prefix replaced by the target. */
export function rewriteCall(target: Expression, match: MountMatch): Expression {
  const { unpinnedArgs, stepsAfterMount } = match;
  if (!unpinnedArgs) return [...target, ...stepsAfterMount];
  const last = target.at(-1);
  return typeof last === "string"
    ? [...target.slice(0, -1), [last, ...unpinnedArgs], ...stepsAfterMount]
    : [...target, ["", ...unpinnedArgs], ...stepsAfterMount];
}

/** Rules 3–5 together: rewrite `call` through `mounts` until its root is a built-in (`isBuiltInRoot`);
 *  the result is what runs. Throws NO_CAPABILITY_MATCH when no mount matches (default-deny) and a
 *  depth error after 32 rewrites. */
export function routeCall(
  mounts: readonly Mount[],
  call: Expression,
  isBuiltInRoot: (root: string) => boolean,
): Expression {
  let current = call;
  for (let rewrites = 0; ; rewrites++) {
    if (typeof current[0] !== "string")
      throw new Error("cannot call the scope symbol itself — name a capability first");
    const rootStep = current[1];
    const root = Array.isArray(rootStep) ? rootStep[0] : rootStep;
    if (current[0] === "itx" && typeof root === "string" && isBuiltInRoot(root)) return current;
    if (rewrites >= 32)
      throw new Error(`capability resolution exceeded depth 32 — self-referential mount?`);
    const winner = pickMount(mounts, current);
    if (!winner)
      throw codedError(
        "NO_CAPABILITY_MATCH",
        `no capability matches ${JSON.stringify(print(current))} (default-deny; provide a capability first)`,
      );
    current = rewriteCall(winner.mount.target, winner.match);
  }
}
