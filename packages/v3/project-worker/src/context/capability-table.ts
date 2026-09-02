// capability-table.ts — THE CAPABILITY TABLE: how the context's mounts are WRITTEN and READ. The
// mounts THEMSELVES are `core` state — stream/core-processor.ts reduces capability-provided/-revoked
// into `state.mounts` — so this module is the two COMMANDS that build those events and the READER
// that routes a call against them:
//
//   ┌───────────────── the capability table (per context) ─────────────────┐
//   │  BUILT-INS      (kv, append, read, cd, fetch, rpcStubs, facets, …;    │  built-ins first;
//   │                  resolved DIRECTLY — no mount; unshadowable)          │  then longest
//   │  userspace      (capability-provided/-revoked; SHADOW STACK: newest   │  path wins, ties
//   │  mounts          same-path wins; revoke-by-offset pops that entry)    │  → recency; else
//   └──────────────────────────────────────────────────────────────────────┘  DEFAULT-DENY
//
// A MOUNT binds a CAPABILITY PATH ("itx.chat") to a TARGET EXPRESSION — and nothing else. That is
// the whole event: `{ path, target }`. A LIVE capability (`itx.provide(path, stub)`) is no exception:
// the stub is parked in the `itx.rpcStubs` BUILT-IN (physical, keyed by the path string) and the
// mount's target is the ordinary expression `itx.rpcStubs.get('<path>')` — the log records the
// mount, never the socket. Subscriptions are NOT mounts: their own events, their own slice of core
// (stream/subscriptions.ts). STRING AT REST: the event stores both halves in the string half of the
// codec (the log reads like what a human wrote); the core reduce parses ONCE into the structured
// table. What a target EVALUATES to (a stub that is offline, a kv key that is gone) is the physical
// layer's business at call time.
//
// Resolution of a call `itx.<root>…`: a BUILT-IN root resolves directly against the built-ins record.
// Otherwise the winning userspace mount (longest path, then newest) names a target — itself an
// `itx.…` expression — which resolves through THIS SAME method one level deeper (so alias mounts
// compose and a default route forwards whole calls), and the call's steps after the mount replay on
// what came back. A target not rooted at `itx` matches nothing and default-denies.

import { codedError } from "../lib/errors.ts";
import { CoreContract, type Mount } from "../stream/core-processor.ts";
import type { StreamEventInput } from "../stream/events.ts";
import {
  parse,
  parseCapabilityPath,
  print,
  toExpression,
  type Expression,
  type ItxExpression,
} from "./expression.ts";
import { callOn, match, walkSteps } from "./dispatch.ts";

// ── the two COMMANDS: build the event, the caller appends it ──

/** `capability-provided`, STRING at rest — programmatic inputs are canonicalized through print. The
 *  target ROUND-TRIPS THE CODEC NOW (print, then parse the printed string): the reduce re-parses the
 *  stored string and SKIPS one that will not parse — a mount that silently never exists — so a target
 *  the parser refuses fails loud here, in the parser's own words. (A parsed path re-joined with dots
 *  is dotted names, which is exactly what `parseCapabilityPath` accepts — no round-trip to check.) */
export function capabilityProvidedEvent(input: {
  path: string;
  target: ItxExpression;
}): StreamEventInput {
  const path = parseCapabilityPath(input.path).join(".");
  const target = parse(print(toExpression(input.target)));
  if (target[0] !== "itx")
    throw new Error(
      `a provided capability's target must be rooted at "itx" (a bare built-in root is unspellable — targets resolve through the table)`,
    );
  return CoreContract.buildEvent({
    type: "events.iterate.com/capability-table/capability-provided",
    payload: { path, target: print(target) },
  });
}

/** `capability-revoked` by the mount's identity. Idempotent through the reduce (a second revoke
 *  filters a mount that is already gone), so no idempotencyKey. */
export function capabilityRevokedEvent(providedAtOffset: number): StreamEventInput {
  return CoreContract.buildEvent({
    type: "events.iterate.com/capability-table/capability-revoked",
    payload: { providedAtOffset },
  });
}

// ── the READER ──

/** Pure routing: the winning userspace mount for a call — with the call's args at the mount and its
 *  steps after the mount — or null (built-ins are resolved before this — see
 *  CapabilityResolver.resolve). Longest matching path wins; ties → newest mount (`providedAtOffset`). */
export function route(
  mounts: readonly Mount[],
  call: Expression,
): { mount: Mount; argsAtMount?: unknown[]; stepsAfterMount: Expression } | null {
  let best: { mount: Mount; argsAtMount?: unknown[]; stepsAfterMount: Expression } | null = null;
  for (const mount of mounts) {
    const m = match(mount.path, call);
    if (!m) continue;
    // match is all-or-nothing, so path.length IS "how much matched".
    if (
      best === null ||
      mount.path.length > best.mount.path.length ||
      (mount.path.length === best.mount.path.length &&
        mount.providedAtOffset > best.mount.providedAtOffset)
    )
      best = { mount, ...m };
  }
  return best;
}

/** THE DISPATCHER, parent-constructed over the physical built-ins and a reader of the CURRENT mounts. */
export class CapabilityResolver {
  /** The built-ins: a plain record whose keys (kv, append, read, cd, …) are the physical-layer
   *  roots. A call `itx.<root>…` resolves DIRECTLY against these (no config, no mount). Userspace
   *  mounts name NEW paths and their targets are `itx.…` expressions; they cannot spell a bare root,
   *  so the built-ins are unshadowable. */
  readonly #builtIns: Record<string, unknown>;
  /** The CURRENT mounts (the core reduced state's shadow stack), read at every resolution. */
  readonly #mounts: () => readonly Mount[];

  constructor(args: { builtIns: Record<string, unknown>; mounts: () => readonly Mount[] }) {
    this.#builtIns = args.builtIns;
    this.#mounts = args.mounts;
  }

  /** Resolve + run one call: built-in first, else the winning mount's target resolved one level
   *  deeper, then the call's steps after the mount, then any runtime `extraArgs` (the fetch lane hands
   *  the live Request in here — a Request is not expression data). Nothing matches → default-deny
   *  with a readable error naming the call. */
  async resolve(call: ItxExpression, extraArgs?: unknown[], depth = 0): Promise<unknown> {
    // Guard against self-referential mounts (itx.x ⇒ itx.x, or a default route whose target
    // re-misses): unbounded async recursion never overflows a stack, it just burns the DO.
    if (depth > 32)
      throw new Error(`capability resolution exceeded depth 32 — self-referential mount?`);
    const expr = toExpression(call);
    if (typeof expr[0] !== "string")
      throw new Error("cannot call the scope symbol itself — name a capability first");
    const root = Array.isArray(expr[1]) ? expr[1][0] : expr[1];
    let value: unknown;
    let receiver: unknown;
    let stepsAfterMount: Expression;
    if (expr[0] === "itx" && typeof root === "string" && Object.hasOwn(this.#builtIns, root)) {
      // BUILT-IN FIRST: `itx.<root>…` where `<root>` is a physical-layer built-in — as if by an
      // implicit mount `itx.<root> ⇒ <root>`: a call step at the root applies its args to the root.
      value = this.#builtIns[root];
      receiver = undefined;
      if (Array.isArray(expr[1])) value = await callOn(value, receiver, expr[1].slice(1));
      stepsAfterMount = expr.slice(2);
    } else {
      const winner = route(this.#mounts(), expr);
      if (!winner)
        throw codedError(
          "NO_CAPABILITY_MATCH",
          `no capability matches ${JSON.stringify(print(expr))} (default-deny; provide a capability first)`,
        );
      // The target is an `itx.…` expression: resolve it through THIS method one level deeper — a
      // built-in, or another mount (alias mounts compose). Args at the mount fold into the target's
      // final step when that step is a property (`itx.grok ⇒ itx.openai.chat`, called
      // `itx.grok({...})`, resolves `itx.openai.chat({...})`); a target that already ends in a call is
      // resolved as written and the args apply to what came back. A live capability's mount targets
      // `itx.rpcStubs.get('<path>')` — the built-in hands back the transport's pipelinable handle, so
      // the steps after the mount, root-calling (applyRoot) and the terminal-fetch rule all ride the
      // same walk as any expression mount. No transport ⇒ CONNECTION_OFFLINE at call time
      // (mounted-but-offline — a never-provided path already default-denied above).
      let { target } = winner.mount;
      let { argsAtMount } = winner;
      const last = target.at(-1);
      if (argsAtMount && typeof last === "string") {
        target = [...target.slice(0, -1), [last, ...argsAtMount]];
        argsAtMount = undefined;
      }
      value = await this.resolve(target, undefined, depth + 1);
      receiver = undefined;
      if (argsAtMount) value = await callOn(value, receiver, argsAtMount);
      stepsAfterMount = winner.stepsAfterMount;
    }
    ({ value, receiver } = await walkSteps({ value, receiver }, stepsAfterMount, "remainder"));
    if (extraArgs) value = await callOn(value, receiver, extraArgs);
    return await value;
  }
}
