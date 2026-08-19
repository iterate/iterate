// capability-table-processor.ts — THE CAPABILITY TABLE as a reduce-only stream processor, run
// INLINE at the stream's commit point (one processor among many; apps/os runs its capability
// host the same way). Its reduced state IS the table:
//
//   ┌───────────────── the capability table (per context) ─────────────────┐
//   │  event mounts   (capability-provided/-revoked; SHADOW STACK:         │  longest path wins;
//   │                  newest same-path wins; revoke-by-offset pops        │  ties → recency;
//   │                  exactly that entry)                                 │  one winner;
//   │  config mounts  (APP_CONFIG, bottom of every stack; the ONLY         │  no match =
//   │                  provenance whose targets may name the built-ins)    │  DEFAULT-DENY
//   └──────────────────────────────────────────────────────────────────────┘
//
// A MOUNT binds a CAPABILITY PATH ("itx.chat") to a TARGET EXPRESSION, optionally carrying a
// DELIVERY policy (subscriptions) or a PROCESSOR policy (facet-processor enablement) — every
// attachment to a stream is a mount, all event-sourced, all shadowable/revocable. STRING AT
// REST: the event payload stores both sides in the string half of the codec (the log reads like
// what a human wrote); reduce parses ONCE into the structured in-memory table.
//
// Resolution of a call: match every mount's path → pick the winner (longest, then newest,
// config mounts last) → evaluate the target against the scope → apply the caller's boundary
// args → replay the remainder on the result. The scope's `itx` symbol re-enters THIS resolver
// (so alias mounts compose, and a default route `itx ⇒ itx.os` forwards whole missed calls with
// zero special machinery); the built-ins exist ONLY while resolving a config-provenance mount —
// event mounts literally cannot spell the physical layer.

import { z } from "zod";
import { codedError } from "./core/errors.ts";
import { defineProcessorContract, type DeliveryPolicy } from "./core/events.ts";
import {
  apply,
  match,
  parse,
  parseCapabilityPath,
  pathProxy,
  print,
  toExpression,
  type CapabilityPath,
  type Expression,
  type Match,
} from "./core/expression.ts";
import type { ProcessorStream, ReduceArgs, ReduceOnlyProcessor } from "./core/processor.ts";

/** Per-instance facet-processor enablement policy — rides the mount event like `delivery`. */
export type ProcessorPolicy = {
  /** Userspace source expression (string half), resolved to modules at materialization.
   *  Absent = a built-in facet class named by the mount's slug. */
  source?: string;
  /** Which export of the userspace modules is the StreamProcessor subclass. */
  export?: string;
  /** Per-instance configuration, handed to the processor's constructor. Event-sourced:
   *  re-enabling with different props SHADOWS the old configuration. */
  props?: Record<string, unknown>;
};

export const CapabilityTableContract = defineProcessorContract({
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
            onFailingEvent: z.enum(["halt", "skip"]).optional(), // dies with the pump (increment 56)
            maxAttempts: z.number().int().positive().optional(),
            start: z.enum(["beginning", "now"]).optional(),
            /** LIVE STATE mode: the key's state change events are forwarded as they commit;
             *  the CLIENT chains revisions and re-reads the producer's door on any gap. */
            liveState: z.object({ key: z.string() }).optional(),
          })
          .optional(),
        /** PROCESSOR mounts only (path itx.processors.<slug>). */
        processor: z
          .object({
            source: z.string().optional(),
            export: z.string().optional(),
            props: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
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
export type CapabilityMount = State["mounts"][number];

/** The capability table as a REDUCE-ONLY processor: pure reduce (the table) + the resolver
 *  methods the parent calls against that reduced state. Hosted INLINE at the parent's commit
 *  point (zero distance — no chain, no cursor, no facet); the provide/revoke side effects live
 *  in the VERBS below, which simply append. */
export class CapabilityTableProcessor implements ReduceOnlyProcessor<State> {
  readonly contract = CapabilityTableContract;
  /** The parent's own append/read, in-process. */
  readonly stream: ProcessorStream;
  /** Config mounts (bottom of every stack). ONLY their targets see the built-ins. */
  readonly #configMounts: { path: CapabilityPath; target: Expression }[];
  /** The built-ins: a plain record whose keys (kv, stream, contexts, connections, …) are the
   *  expression roots that exist only for config-provenance targets. Never contains `itx`. */
  readonly #builtIns: Record<string, unknown>;

  constructor(args: {
    stream: ProcessorStream;
    configMounts: { path: CapabilityPath; target: Expression }[];
    builtIns: Record<string, unknown>;
  }) {
    this.stream = args.stream;
    this.#configMounts = args.configMounts;
    this.#builtIns = args.builtIns;
  }

  // The capability table is pure reduce — no side effects (which is exactly what qualifies it
  // for inline hosting). Ephemeral capability events are IGNORED (they would vanish from any
  // rebuild); a malformed payload is SKIPPED loudly — one bad hand-appended event must not
  // wedge every later resolve. The STRING halves are parsed HERE, once, into the structured
  // in-memory table.
  reduce({ event, state }: ReduceArgs<State>): State | undefined {
    if (event.ephemeral) return undefined;
    if (event.type === "events.iterate.com/capability-table/capability-provided") {
      const { path, target, delivery, processor } = event.payload as {
        path: string;
        target: string;
        delivery?: Record<string, unknown>;
        processor?: Record<string, unknown>;
      };
      let parsed: { path: CapabilityPath; target: Expression };
      try {
        parsed = { path: parseCapabilityPath(path), target: parse(target) };
      } catch (error) {
        console.error(
          `capability-table: skipping malformed capability-provided at ${event.offset}`,
          error,
        );
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
  }): Promise<{ providedAtOffset: number }> {
    const path = typeof input.path === "string" ? parseCapabilityPath(input.path) : input.path;
    const target = toExpression(input.target);
    if (target[0] !== "itx")
      throw new Error(
        `a provided capability's target must be rooted at "itx" (the built-ins are config-mount-only)`,
      );
    const [event] = await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-table/capability-provided",
        payload: {
          path: path.join("."),
          target: print(target),
          ...(input.delivery ? { delivery: input.delivery } : {}),
          ...(input.processor ? { processor: input.processor } : {}),
        },
      }),
    );
    return { providedAtOffset: event.offset };
  }

  async revoke(input: { providedAtOffset: number }): Promise<void> {
    await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-table/capability-revoked",
        payload: { providedAtOffset: input.providedAtOffset },
        idempotencyKey: `capability-table/revoke:${input.providedAtOffset}`,
      }),
    );
  }

  /**
   * Resolve + run one call against the CURRENT table state. The winner is the LONGEST matching
   * path; ties → recency (event mounts by offset; config mounts oldest of all); nothing
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
    const winner = this.route(state, expr);
    if (!winner)
      throw codedError(
        "NO_CAPABILITY_MATCH",
        `no capability matches ${JSON.stringify(print(expr))} (default-deny; mount one or add a config mount)`,
      );
    const { row, m, provenance } = winner;
    // THE PROVENANCE GATE is a scope-KEY-SET decision: config-mount targets see the built-ins,
    // event-mount targets see only `itx`. Not policed — the keys are simply absent. `itx`
    // spreads LAST so no built-in key can ever shadow the resolver's recursion symbol.
    const scope =
      provenance === "config"
        ? { ...this.#builtIns, itx: this.#itxAtDepth(depth + 1) }
        : { itx: this.#itxAtDepth(depth + 1) };
    return await apply(
      scope,
      row.target,
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

  /** Pure routing (exposed for describe/debug): the winning mount or null. */
  route(
    state: State,
    call: Expression,
  ): {
    row: Pick<CapabilityMount, "path" | "target">;
    m: Match;
    provenance: "config" | "event";
    providedAtOffset?: number;
  } | null {
    // A call whose first step invokes the scope symbol itself ([["itx", …]]) is malformed —
    // parser and pathProxy already reject it; this closes the hand-crafted-Expression door.
    if (typeof call[0] !== "string")
      throw new Error("cannot call the scope symbol itself — name a capability first");
    let best: ReturnType<CapabilityTableProcessor["route"]> = null;
    const consider = (
      row: Pick<CapabilityMount, "path" | "target">,
      provenance: "config" | "event",
      providedAtOffset?: number,
    ) => {
      const m = match(row.path, call);
      if (!m) return;
      // THE ranking rule, whole: longest matching path wins; ties go to the newest mount.
      if (
        best === null ||
        m.matchedSegments > best.m.matchedSegments ||
        (m.matchedSegments === best.m.matchedSegments &&
          (providedAtOffset ?? -1) > (best.providedAtOffset ?? -1))
      )
        best = { row, m, provenance, providedAtOffset };
    };
    for (const configMount of this.#configMounts) consider(configMount, "config");
    for (const mount of state.mounts) consider(mount, "event", mount.providedAtOffset);
    return best;
  }

  /** The `itx` scope symbol at a given recursion depth: dotted/called access re-enters
   *  `resolve` with the CURRENT state, carrying the depth. This is what makes alias mounts
   *  compose and default routes forward whole calls. */
  #itxAtDepth(depth: number): unknown {
    return pathProxy((segments, args) => {
      const last = segments[segments.length - 1] as string;
      return this.resolveCurrent(["itx", ...segments.slice(0, -1), [last, ...args]], depth);
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

  /** Overridden by the host to hand `resolve` the current reduced state. */
  resolveCurrent(_call: Expression, _depth = 0): Promise<unknown> {
    throw new Error("capability-table: resolveCurrent not wired (host must bind it to its reads)");
  }
}
