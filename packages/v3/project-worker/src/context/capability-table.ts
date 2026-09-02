// capability-table.ts — THE CAPABILITY TABLE as a reduce-only stream processor, run
// INLINE at the stream's commit point (one processor among many; apps/os runs its capability
// host the same way). Its reduced state IS the table:
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
// mount, never the socket. Subscriptions are NOT mounts: they are the layer above, with their own
// events (subscriptions.ts). STRING AT REST: the event payload stores both halves in the string half
// of the codec (the log reads like what a human wrote); reduce parses ONCE into the structured
// in-memory table. Replaying the log rebuilds the table exactly; what a target EVALUATES to (a stub
// that is offline, a kv key that is gone) is the physical layer's business at call time.
//
// Resolution of a call: `itx.<root>…` where `<root>` is a BUILT-IN resolves directly against the
// physical scope (as if by an implicit mount `itx.<root> ⇒ <root>`). Otherwise, match every
// userspace mount's path → pick the winner (longest, then newest) → evaluate the target against
// `{ itx }` → apply boundary args → replay the remainder. The scope's `itx` symbol re-enters THIS
// resolver (so alias mounts compose); a userspace target names a built-in by recursing through it.

import { z } from "zod";
import { codedError } from "../lib/errors.ts";
import { expressionEndingInFetch } from "../fetch/fetch-capabilities.ts";
import { createLogger } from "../lib/logs.ts";
import { defineProcessorContract } from "../stream/events.ts";
import { StreamProcessor, type ProcessorStream, type ReduceArgs } from "../stream/processor.ts";
import {
  parse,
  parseCapabilityPath,
  print,
  toExpression,
  type CapabilityPath,
  type Expression,
  type ItxExpression,
} from "./expression.ts";
import { apply, match, type Match } from "./dispatch.ts";
import { InvokeHandle } from "./invoke-handle.ts";

const tableLog = createLogger("capability-table");

const CapabilityTableContract = defineProcessorContract({
  slug: "capability-table",
  version: "5.0.0",
  description:
    "The context's capability table: reduces capability-provided/-revoked events into the mount stack that every call resolves against.",
  stateSchema: z.object({
    mounts: z
      .array(
        z.object({
          /** The capability path, parsed (segments). The EVENT stores the string. */
          path: z.array(z.string()),
          /** The target expression, parsed. The EVENT stores the string. */
          target: z.custom<Expression>(() => true),
          /** The mount's identity — the offset of its capability-provided event. */
          providedAtOffset: z.number().int().positive(),
        }),
      )
      .default([]),
  }),
  events: {
    "events.iterate.com/capability-table/capability-provided": {
      description:
        "Mount a capability at `path` → a `target` expression (string half of the codec — the log stays human-readable; same-path mounts SHADOW, newest wins). That is the whole event. A live stub's mount targets `itx.rpcStubs.get('<path>')`.",
      payloadSchema: z.object({ path: z.string(), target: z.string() }),
    },
    "events.iterate.com/capability-table/capability-revoked": {
      description:
        "Pop exactly the mount created at `providedAtOffset` (what's beneath is restored).",
      payloadSchema: z.object({ providedAtOffset: z.number().int().positive() }),
    },
  },
  consumes: [
    "events.iterate.com/capability-table/capability-provided",
    "events.iterate.com/capability-table/capability-revoked",
  ],
  emits: [
    "events.iterate.com/capability-table/capability-provided",
    "events.iterate.com/capability-table/capability-revoked",
  ],
});

export type CapabilityTable = z.infer<typeof CapabilityTableContract.stateSchema>;
type State = CapabilityTable;

/** The capability table as a REDUCE-ONLY processor: pure reduce (the table) + the resolver
 *  methods the parent calls against that reduced state. Hosted INLINE at the parent's commit
 *  point (zero distance — no chain, no cursor, no facet); the provide/revoke side effects live
 *  in the VERBS below, which simply append. */
export class CapabilityTableProcessor extends StreamProcessor<State> {
  readonly contract = CapabilityTableContract;
  /** The parent's own append/read, in-process. */
  readonly stream: ProcessorStream;
  /** The built-ins: a plain record whose keys (kv, append, read, cd, …) are the physical-layer
   *  roots. A call `itx.<root>…` resolves DIRECTLY against these (no config, no mount) — see
   *  `resolve`. Userspace `provide` mounts (event-sourced) name NEW paths and their targets recurse
   *  through the `itx` symbol; they cannot spell a bare root, so the built-ins are unshadowable. */
  readonly #builtIns: Record<string, unknown>;
  /** Resolve one call against the CURRENT reduced table — the host's own dispatch. The `itx`
   *  recursion symbol re-enters through this, so alias mounts compose and default routes forward
   *  whole calls. A constructor dependency (not a reassigned stub): there is no un-wired state. */
  readonly #resolveCurrent: (call: Expression, depth?: number) => Promise<unknown>;

  constructor(args: {
    stream: ProcessorStream;
    builtIns: Record<string, unknown>;
    resolveCurrent: (call: Expression, depth?: number) => Promise<unknown>;
  }) {
    super();
    this.stream = args.stream;
    this.#builtIns = args.builtIns;
    this.#resolveCurrent = args.resolveCurrent;
  }

  // The capability table is pure reduce — no side effects (which is exactly what qualifies it
  // for inline hosting). Ephemeral capability events are IGNORED (they would vanish from any
  // rebuild); a malformed payload is SKIPPED loudly — one bad hand-appended event must not
  // wedge every later resolve. The STRING halves are parsed HERE, once, into the structured
  // in-memory table.
  override reduce({ event, state }: ReduceArgs<State>): State | undefined {
    if (event.ephemeral) return undefined;
    if (event.type === "events.iterate.com/capability-table/capability-provided") {
      const { path, target } = event.payload as { path: string; target: string };
      let parsed: { path: CapabilityPath; target: Expression };
      try {
        parsed = { path: parseCapabilityPath(path), target: parse(target) };
      } catch (error) {
        tableLog.warn("skipping malformed capability-provided", {
          event: "capability-table.malformed-mount.skipped",
          offset: event.offset,
          error,
        });
        return undefined;
      }
      return { mounts: [...state.mounts, { ...parsed, providedAtOffset: event.offset }] };
    }
    if (event.type === "events.iterate.com/capability-table/capability-revoked") {
      const { providedAtOffset } = event.payload as { providedAtOffset: number };
      return { mounts: state.mounts.filter((m) => m.providedAtOffset !== providedAtOffset) };
    }
    return undefined;
  }

  /** Provide = append the mount event (STRING at rest — programmatic inputs are canonicalized
   *  through print). The offset that comes back IS the mount's identity. */
  async provide(input: {
    path: string;
    target: ItxExpression;
  }): Promise<{ providedAtOffset: number }> {
    const path = parseCapabilityPath(input.path);
    const target = toExpression(input.target);
    if (target[0] !== "itx")
      throw new Error(
        `a provided capability's target must be rooted at "itx" (a bare built-in root is unspellable — targets recurse through the itx symbol)`,
      );
    // ROUND-TRIP THE STORED STRINGS NOW. The event stores strings; reduce re-parses them and
    // SKIPS anything that won't parse (a bad object key, an exponent number) — which would make
    // provide() report a providedAtOffset for a capability that silently never exists. Fail loud
    // at the door instead: parse what we are about to store and demand it survives.
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
    const [event] = await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-table/capability-provided",
        payload: { path: pathString, target: targetString },
      }),
    );
    return { providedAtOffset: event.offset };
  }

  async revoke(input: { providedAtOffset: number }): Promise<void> {
    // No idempotencyKey: revoke-by-offset is already idempotent through the reduce (a second revoked
    // event filters a mount that is already gone).
    await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-table/capability-revoked",
        payload: { providedAtOffset: input.providedAtOffset },
      }),
    );
  }

  /**
   * Resolve + run one call against the CURRENT table state. The winner is the LONGEST matching
   * path; ties → recency (newest mount by offset); nothing
   * matches → default-deny with a readable error naming the call.
   */
  async resolve(
    state: State,
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
    // the winning USERSPACE `provide` mount, against `{ itx }` alone (a bare root is unspellable).
    const root = Array.isArray(expr[1]) ? expr[1][0] : expr[1];
    let scope: Record<string, unknown>, target: Expression, m: Match;
    if (expr[0] === "itx" && typeof root === "string" && Object.hasOwn(this.#builtIns, root)) {
      scope = { ...this.#builtIns, itx };
      target = [root];
      m = match(["itx", root], expr)!;
    } else {
      const winner = this.#route(state, expr);
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
  resolveFetch(state: State, expr: Expression, request: Request): Promise<unknown> {
    // Doctrine point 1 (fetch/fetch-capabilities.ts): fetch-shaped capabilities are always called
    // via the terminal `fetch`, with the live Request as the one runtime arg.
    return this.resolve(state, expressionEndingInFetch(expr), [request]);
  }

  /** Pure routing: the winning userspace `provide` mount ROW for a call, or null (built-ins are
   *  resolved before this — see `resolve`). Longest matching path wins; ties → newest mount
   *  (`providedAtOffset`). */
  #route(state: State, call: Expression): { mount: State["mounts"][number]; m: Match } | null {
    if (typeof call[0] !== "string")
      throw new Error("cannot call the scope symbol itself — name a capability first");
    let best: { mount: State["mounts"][number]; m: Match } | null = null;
    for (const mount of state.mounts) {
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

  /** The `itx` scope symbol at a given recursion depth: dotted/called access re-enters
   *  `resolve` with the CURRENT state, carrying the depth. This is what makes alias mounts
   *  compose and default routes forward whole calls. An `InvokeHandle` (the ONE dotted-fold
   *  primitive). */
  #itxAtDepth(depth: number): unknown {
    return new InvokeHandle((segments, args) => {
      const last = segments[segments.length - 1] as string;
      return this.#resolveCurrent(["itx", ...segments.slice(0, -1), [last, ...args]], depth);
    });
  }
}
