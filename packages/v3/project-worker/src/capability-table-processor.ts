// capability-table-processor.ts — THE CAPABILITY TABLE as a reduce-only stream processor, run
// INLINE at the stream's commit point (one processor among many; apps/os runs its capability
// host the same way). Its reduced state IS the table:
//
//   ┌───────────────── the capability table (per context) ─────────────────┐
//   │  BUILT-INS      (kv, stream, cd, rpcStubs, …; resolved DIRECTLY —     │  built-ins first;
//   │                  no mount, no config; unshadowable physical layer)    │  then longest
//   │  userspace      (capability-provided/-revoked; SHADOW STACK: newest   │  path wins, ties
//   │  mounts          same-path wins; revoke-by-offset pops that entry)    │  → recency; else
//   └──────────────────────────────────────────────────────────────────────┘  DEFAULT-DENY
//
// A MOUNT binds a CAPABILITY PATH ("itx.chat") to a TARGET EXPRESSION, optionally carrying a
// DELIVERY policy (subscriptions) or a PROCESSOR policy (facet-processor enablement) — every
// userspace attachment to a stream is a mount, all event-sourced, all shadowable/revocable. STRING
// AT REST: the event payload stores both sides in the string half of the codec (the log reads like
// what a human wrote); reduce parses ONCE into the structured in-memory table.
//
// Resolution of a call: `itx.<root>…` where `<root>` is a BUILT-IN resolves directly against the
// physical scope (as if by an implicit mount `itx.<root> ⇒ <root>`). Otherwise, match every
// userspace mount's path → pick the winner (longest, then newest) → evaluate the target against
// `{ itx }` → apply boundary args → replay the remainder. The scope's `itx` symbol re-enters THIS
// resolver (so alias mounts compose); a userspace target names a built-in by recursing through it.

import { z } from "zod";
import { codedError } from "./core/errors.ts";
import { createLogger } from "./core/logs.ts";
import {
  defineProcessorContract,
  type DeliveryPolicy,
  type SubscriptionLane,
} from "./core/events.ts";
import {
  parse,
  parseCapabilityPath,
  print,
  toExpression,
  type CapabilityPath,
  type Expression,
} from "./core/expression.ts";
import { apply, match, pathProxy, type Match } from "./core/dispatch.ts";
import type { ProcessorStream, ReduceArgs, ReduceOnlyProcessor } from "./core/processor.ts";

const tableLog = createLogger("capability-table");

/** Per-instance facet-processor enablement policy — rides the mount event like `delivery`. */
export type ProcessorPolicy = {
  /** Userspace source expression (string half), resolved to modules at materialization.
   *  Absent = a built-in facet class named by the mount's slug. */
  source?: string;
  /** Which exported class of the userspace modules is the StreamProcessor subclass — the SAME
   *  `className` a stateful `itx.facets.get({ source, className })` names, unified deliberately:
   *  enabling a processor is loading a class as a facet, plus driving it with this stream's
   *  commits. Defaults to the module's default export. */
  className?: string;
  /** Per-instance configuration, handed to the processor's constructor. Event-sourced:
   *  re-enabling with different props SHADOWS the old configuration. */
  props?: Record<string, unknown>;
};

const CapabilityTableContract = defineProcessorContract({
  slug: "capability-table",
  version: "2.0.0",
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
          delivery: z.record(z.string(), z.unknown()).optional(),
          processor: z.record(z.string(), z.unknown()).optional(),
          /** SUBSCRIPTION mounts only — the declared delivery lane (see `SubscriptionLane`). */
          lane: z.enum(["reduce", "connected", "durable"]).optional(),
        }),
      )
      .default([]),
  }),
  events: {
    "events.iterate.com/capability-table/capability-provided": {
      description:
        "Mount `target` at `path` (both in the STRING half of the codec — the log stays human-readable). Same-path mounts SHADOW (newest wins).",
      payloadSchema: z.object({
        path: z.string(),
        target: z.string(),
        /** SUBSCRIPTION mounts only (path itx.subscribers.<name>). */
        delivery: z
          .object({
            consumes: z.array(z.string()).optional(),
            maxAttempts: z.number().int().positive().optional(),
            start: z.enum(["beginning", "now"]).optional(),
            /** LIVE STATE mode: the key's state change events are forwarded as they commit;
             *  the CLIENT chains revisions and re-reads the producer's door on any gap. */
            liveState: z.object({ key: z.string() }).optional(),
          })
          .optional(),
        /** PROCESSOR policy — rides a facet-target subscriber mount
         *  (`itx.subscribers.<slug> → itx.facets.get('<slug>')`): the class that facet loads. */
        processor: z
          .object({
            source: z.string().optional(),
            className: z.string().optional(),
            props: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
        /** The delivery lane, stamped ONCE here (see `SubscriptionLane`) — every reader reads it
         *  instead of re-inferring from the target's shape. Subscriber mounts only. */
        lane: z.enum(["reduce", "connected", "durable"]).optional(),
      }),
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
type CapabilityMount = State["mounts"][number];

/** The capability table as a REDUCE-ONLY processor: pure reduce (the table) + the resolver
 *  methods the parent calls against that reduced state. Hosted INLINE at the parent's commit
 *  point (zero distance — no chain, no cursor, no facet); the provide/revoke side effects live
 *  in the VERBS below, which simply append. */
export class CapabilityTableProcessor implements ReduceOnlyProcessor<State> {
  readonly contract = CapabilityTableContract;
  /** The parent's own append/read, in-process. */
  readonly stream: ProcessorStream;
  /** The built-ins: a plain record whose keys (kv, stream, cd, rpcStubs, …) are the physical-layer
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
    this.stream = args.stream;
    this.#builtIns = args.builtIns;
    this.#resolveCurrent = args.resolveCurrent;
  }

  // The capability table is pure reduce — no side effects (which is exactly what qualifies it
  // for inline hosting). Ephemeral capability events are IGNORED (they would vanish from any
  // rebuild); a malformed payload is SKIPPED loudly — one bad hand-appended event must not
  // wedge every later resolve. The STRING halves are parsed HERE, once, into the structured
  // in-memory table.
  reduce({ event, state }: ReduceArgs<State>): State | undefined {
    if (event.ephemeral) return undefined;
    if (event.type === "events.iterate.com/capability-table/capability-provided") {
      const { path, target, delivery, processor, lane } = event.payload as {
        path: string;
        target: string;
        delivery?: Record<string, unknown>;
        processor?: Record<string, unknown>;
        lane?: "reduce" | "connected" | "durable";
      };
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
      return {
        mounts: [
          ...state.mounts,
          {
            ...parsed,
            providedAtOffset: event.offset,
            ...(delivery ? { delivery } : {}),
            ...(processor ? { processor } : {}),
            ...(lane ? { lane } : {}),
          },
        ],
      };
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
    path: string | CapabilityPath;
    target: string | Expression;
    delivery?: DeliveryPolicy;
    processor?: ProcessorPolicy;
    /** The delivery lane, stamped on the event (see `SubscriptionLane`). The host computes it once
     *  at the provide door; every reader reads it back rather than re-inferring from the target. */
    lane?: SubscriptionLane;
  }): Promise<{ providedAtOffset: number }> {
    const path = typeof input.path === "string" ? parseCapabilityPath(input.path) : input.path;
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
      if (
        reparsedPath.length !== path.length || // a pre-split array like ["itx.kv"] re-splits — reject
        reparsedPath.join(".") !== pathString ||
        print(parse(targetString)) !== targetString
      )
        throw new Error("re-parse diverged");
    } catch (cause) {
      throw new Error(
        `provide: capability ${JSON.stringify(pathString)} → ${JSON.stringify(targetString)} does not round-trip (${cause instanceof Error ? cause.message : cause}); it would be stored and then silently dropped`,
      );
    }
    const [event] = await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-table/capability-provided",
        payload: {
          path: path.join("."),
          target: print(target),
          ...(input.delivery ? { delivery: input.delivery } : {}),
          ...(input.processor ? { processor: input.processor } : {}),
          ...(input.lane ? { lane: input.lane } : {}),
        },
      }),
    );
    return { providedAtOffset: event.offset };
  }

  async revoke(input: { providedAtOffset: number }): Promise<void> {
    // No idempotencyKey: a deterministic one (`capability-table/revoke:<offset>`) was a public
    // squat vector — an outside append under that key made the real revoke IDEMPOTENCY_CONFLICT
    // and left the capability unrevocable forever (defect 34/46). Revoke-by-offset is already
    // idempotent through the reduce (a second revoked event filters a mount that's already gone),
    // so the key bought nothing but the attack surface.
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
    call: string | Expression,
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
      scope = { itx };
      target = winner.target;
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
    const last = expr.at(-1);
    // Normalize the terminal to a PROPERTY step `fetch` — a call-step's JSON args could never
    // carry the live Request; it always rides in as the runtime arg. A fetch CALL that carries
    // expression args is a LOUD error: the author meant something the lane cannot do.
    if (Array.isArray(last) && last[0] === "fetch" && last.length > 1)
      throw new Error(
        `fetch takes no expression args — the live Request rides in as the runtime arg (got ${JSON.stringify(last.slice(1))})`,
      );
    const call: Expression =
      last === "fetch"
        ? expr
        : Array.isArray(last) && last[0] === "fetch"
          ? [...expr.slice(0, -1), "fetch"]
          : [...expr, "fetch"];
    return this.resolve(state, call, [request]);
  }

  /** Pure routing: the winning userspace `provide` mount for a call, or null (built-ins are
   *  resolved before this — see `resolve`). Longest matching path wins; ties → newest mount. */
  #route(state: State, call: Expression): { target: Expression; m: Match } | null {
    if (typeof call[0] !== "string")
      throw new Error("cannot call the scope symbol itself — name a capability first");
    // `providedAtOffset` is the tie-breaker (newest same-length mount wins) — needed WHILE ranking,
    // not by the caller, so it stays local and the return is just the winner's target + match.
    let best: { target: Expression; m: Match; providedAtOffset: number } | null = null;
    for (const mount of state.mounts) {
      const m = match(mount.path, call);
      if (!m) continue;
      if (
        best === null ||
        m.matchedSegments > best.m.matchedSegments ||
        (m.matchedSegments === best.m.matchedSegments &&
          mount.providedAtOffset > best.providedAtOffset)
      )
        best = { target: mount.target, m, providedAtOffset: mount.providedAtOffset };
    }
    return best && { target: best.target, m: best.m };
  }

  /** The `itx` scope symbol at a given recursion depth: dotted/called access re-enters
   *  `resolve` with the CURRENT state, carrying the depth. This is what makes alias mounts
   *  compose and default routes forward whole calls. */
  #itxAtDepth(depth: number): unknown {
    return pathProxy((segments, args) => {
      const last = segments[segments.length - 1] as string;
      return this.#resolveCurrent(["itx", ...segments.slice(0, -1), [last, ...args]], depth);
    });
  }

  /** Deliver to ONE subscription mount BY ROW IDENTITY — never by name through the table (a
   *  broad default route must not intercept deliveries). The target is evaluated and called
   *  with the delivery args (an event batch + its ScannedOffsetRange, or a state change
   *  payload). */
  async deliverTo(state: State, providedAtOffset: number, args: unknown[]): Promise<unknown> {
    const row = state.mounts.find((m) => m.providedAtOffset === providedAtOffset);
    if (!row) throw new Error(`no subscription mount at offset ${providedAtOffset}`);
    return apply({ itx: this.#itxAtDepth(1) }, row.target, { boundaryArgs: args, remainder: [] });
  }
}
