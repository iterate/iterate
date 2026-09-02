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
// the stub is lent to the `itx.rpcStubs` BUILT-IN (physical, keyed by the path string) and the
// mount's target is the ordinary expression `itx.rpcStubs.get('<path>')` — the log records the
// mount, never the socket. Subscriptions are NOT mounts: their own events, their own slice of core
// (stream/subscriptions.ts). STRING AT REST: the event stores both halves in the string half of the
// codec (the log reads like what a human wrote); the core reduce parses ONCE into the structured
// table. What a target EVALUATES to (a stub that is offline, a kv key that is gone) is the physical
// layer's business at call time.
//
// Resolution of a call `itx.<root>…`: a BUILT-IN root resolves directly against the built-ins record.
// Otherwise the winning userspace mount (longest path, then newest) names a target — itself an
// `itx.…` expression — which resolves through THIS SAME method one level deeper (so a mount whose target names another mount
// compose and a default route forwards whole calls), and the call's steps after the mount replay on
// what came back. A target not rooted at `itx` matches nothing and default-denies.

import { CoreContract, type Mount } from "../stream/core-processor.ts";
import type { StreamEventInput } from "../stream/events.ts";
import {
  parse,
  parseItxExpressionPrefix,
  print,
  toItxExpression,
  type ItxExpressionInput,
} from "./expression.ts";
import { callOn, walkSteps } from "./dispatch.ts";
import { routeCall } from "./routing.ts";

// ── the two COMMANDS: build the event, the caller appends it ──

/** `capability-provided`, STRING at rest — programmatic inputs are canonicalized through print. The
 *  target ROUND-TRIPS THE CODEC NOW (print, then parse the printed string): the reduce re-parses the
 *  stored string and SKIPS one that will not parse — a mount that silently never exists — so a target
 *  the parser refuses fails loud here, in the parser's own words. (A parsed path re-joined with dots
 *  is dotted names, which is exactly what `parseItxExpressionPrefix` accepts — no round-trip to check.) */
export function capabilityProvidedEvent(input: {
  path: string;
  target: ItxExpressionInput;
}): StreamEventInput {
  const path = print(parseItxExpressionPrefix(input.path)); // canonical: dotted names, pinned args as JSON5 literals
  const target = parse(print(toItxExpression(input.target)));
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
  /** Resolve + run one call: rewrite it through the mounts to a built-in-rooted call (routing.ts —
   *  default-deny and the depth budget live there), then evaluate that call against the physical
   *  scope: the root, its args if the root step is a call, the remaining steps (dispatch.ts walkSteps),
   *  and finally any runtime `extraArgs` (the fetch lane hands the live Request in here — a Request
   *  is not expression data). */
  async resolve(call: ItxExpressionInput, extraArgs?: unknown[]): Promise<unknown> {
    const routed = routeCall(this.#mounts(), toItxExpression(call), (root) =>
      Object.hasOwn(this.#builtIns, root),
    );
    const rootStep = routed[1] as string | [string, ...unknown[]];
    let value: unknown = this.#builtIns[Array.isArray(rootStep) ? rootStep[0] : rootStep];
    let receiver: unknown = undefined;
    if (Array.isArray(rootStep)) value = await callOn(value, receiver, rootStep.slice(1));
    ({ value, receiver } = await walkSteps({ value, receiver }, routed.slice(2), "remainder"));
    if (extraArgs) value = await callOn(value, receiver, extraArgs);
    return await value;
  }
}
