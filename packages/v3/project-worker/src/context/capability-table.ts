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
// Resolution of a call: `itx.<root>…` where `<root>` is a BUILT-IN resolves directly against the
// physical scope (as if by an implicit mount `itx.<root> ⇒ <root>`). Otherwise, match every
// userspace mount's path → pick the winner (longest, then newest) → evaluate the target against
// `{ itx }` → apply boundary args → replay the remainder. The scope's `itx` symbol re-enters THIS
// resolver (so alias mounts compose); a userspace target names a built-in by recursing through it.

import { codedError } from "../lib/errors.ts";
import { expressionEndingInFetch } from "../fetch/fetch-capabilities.ts";
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
import { apply, match, type Match } from "./dispatch.ts";
import { InvokeHandle } from "./invoke-handle.ts";

// ── the two COMMANDS: build the event, the caller appends it ──

/** `capability-provided`, STRING at rest — programmatic inputs are canonicalized through print.
 *  ROUND-TRIPS THE STORED STRINGS NOW: the reduce re-parses them and SKIPS anything that won't parse
 *  (a bad object key, an exponent number), which would make a provide report an identity for a
 *  capability that silently never exists. Fail loud at the door instead. */
export function capabilityProvidedEvent(input: {
  path: string;
  target: ItxExpression;
}): StreamEventInput {
  const path = parseCapabilityPath(input.path);
  const target = toExpression(input.target);
  if (target[0] !== "itx")
    throw new Error(
      `a provided capability's target must be rooted at "itx" (a bare built-in root is unspellable — targets recurse through the itx symbol)`,
    );
  const pathString = path.join(".");
  const targetString = print(target);
  try {
    const reparsedPath = parseCapabilityPath(pathString);
    if (reparsedPath.join(".") !== pathString || print(parse(targetString)) !== targetString)
      throw new Error("re-parse diverged");
  } catch (cause) {
    throw new Error(
      `provide: capability ${JSON.stringify(pathString)} → ${JSON.stringify(targetString)} does not round-trip (${cause instanceof Error ? cause.message : cause}); it would be stored and then silently dropped`,
    );
  }
  return CoreContract.buildEvent({
    type: "events.iterate.com/capability-table/capability-provided",
    payload: { path: pathString, target: targetString },
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

/** Pure routing: the winning userspace mount ROW for a call, or null (built-ins are resolved before
 *  this — see CapabilityResolver.resolve). Longest matching path wins; ties → newest mount
 *  (`providedAtOffset`). */
export function route(
  mounts: readonly Mount[],
  call: Expression,
): { mount: Mount; m: Match } | null {
  if (typeof call[0] !== "string")
    throw new Error("cannot call the scope symbol itself — name a capability first");
  let best: { mount: Mount; m: Match } | null = null;
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
      best = { mount, m };
  }
  return best;
}

/** THE DISPATCHER, parent-constructed: resolve + run one call against the CURRENT mounts. Holds the
 *  two things routing cannot be pure about — the physical built-ins and the host's own re-entry. */
export class CapabilityResolver {
  /** The built-ins: a plain record whose keys (kv, append, read, cd, …) are the physical-layer
   *  roots. A call `itx.<root>…` resolves DIRECTLY against these (no config, no mount). Userspace
   *  mounts name NEW paths and their targets recurse through the `itx` symbol; they cannot spell a
   *  bare root, so the built-ins are unshadowable. */
  readonly #builtIns: Record<string, unknown>;
  /** Resolve one call against the CURRENT mounts — the host's own dispatch. The `itx` recursion
   *  symbol re-enters through this, so alias mounts compose and default routes forward whole calls. */
  readonly #resolveCurrent: (call: Expression, depth?: number) => Promise<unknown>;

  constructor(args: {
    builtIns: Record<string, unknown>;
    resolveCurrent: (call: Expression, depth?: number) => Promise<unknown>;
  }) {
    this.#builtIns = args.builtIns;
    this.#resolveCurrent = args.resolveCurrent;
  }

  /** Resolve + run one call. The winner is the LONGEST matching path; ties → recency (newest mount
   *  by offset); nothing matches → default-deny with a readable error naming the call. */
  async resolve(
    mounts: readonly Mount[],
    call: ItxExpression,
    extraArgs?: unknown[],
    depth = 0,
  ): Promise<unknown> {
    // Guard against self-referential mounts (itx.x ⇒ itx.x, or a default route whose target
    // re-misses): unbounded async recursion never overflows a stack, it just burns the DO.
    if (depth > 32)
      throw new Error(`capability resolution exceeded depth 32 — self-referential mount?`);
    const expr = toExpression(call);
    if (typeof expr[0] !== "string")
      throw new Error("cannot call the scope symbol itself — name a capability first");
    const itx = this.#itxAtDepth(depth + 1);
    // Pick the scope + target + match, then ONE apply. BUILT-IN FIRST: `itx.<root>…` where `<root>`
    // is a physical-layer built-in resolves DIRECTLY — as if by an implicit mount `itx.<root> ⇒
    // <root>` (`match` consumes boundary/remainder the same way a userspace mount does), against
    // `{ ...builtIns, itx }` (`itx` spreads LAST so no root shadows the recursion symbol). Otherwise
    // the winning USERSPACE mount, against `{ itx }` alone (a bare root is unspellable).
    const root = Array.isArray(expr[1]) ? expr[1][0] : expr[1];
    let scope: Record<string, unknown>, target: Expression, m: Match;
    if (expr[0] === "itx" && typeof root === "string" && Object.hasOwn(this.#builtIns, root)) {
      scope = { ...this.#builtIns, itx };
      target = [root];
      m = match(["itx", root], expr)!;
    } else {
      const winner = route(mounts, expr);
      if (!winner)
        throw codedError(
          "NO_CAPABILITY_MATCH",
          `no capability matches ${JSON.stringify(print(expr))} (default-deny; provide a capability first)`,
        );
      // A live capability's mount targets `itx.rpcStubs.get('<path>')` — the built-in hands back
      // the transport's pipelinable handle, so boundary-arg callOn (applyRoot), remainder replay,
      // and the fetch-shaped rule ride the SAME apply as any expression mount. No transport ⇒
      // CONNECTION_OFFLINE at call time (mounted-but-offline — a never-provided path already
      // default-denied above).
      scope = { itx };
      target = winner.mount.target;
      m = winner.m;
    }
    return await apply(
      scope,
      target,
      { boundaryArgs: m.boundaryArgs, remainder: m.remainder },
      extraArgs,
    );
  }

  /** THE FETCH LANE entry: resolve `expr.fetch` and call it with the live Request as a runtime
   *  arg (a Request is not expression data). Everything stays in-isolate or on native stub
   *  hops, so a 101 flows back out untouched. */
  resolveFetch(mounts: readonly Mount[], expr: Expression, request: Request): Promise<unknown> {
    // Doctrine point 1 (fetch/fetch-capabilities.ts): fetch-shaped capabilities are always called
    // via the terminal `fetch`, with the live Request as the one runtime arg.
    return this.resolve(mounts, expressionEndingInFetch(expr), [request]);
  }

  /** The `itx` scope symbol at a given recursion depth: dotted/called access re-enters
   *  `resolve` with the CURRENT mounts, carrying the depth. This is what makes alias mounts
   *  compose and default routes forward whole calls. An `InvokeHandle` (the ONE dotted-reduce
   *  primitive). */
  #itxAtDepth(depth: number): unknown {
    return new InvokeHandle((segments, args) => {
      const last = segments[segments.length - 1] as string;
      return this.#resolveCurrent(["itx", ...segments.slice(0, -1), [last, ...args]], depth);
    });
  }
}
