// iterate-context-stream-processor.ts — the capability host as a STREAM PROCESSOR (one processor among
// many on a context's stream; apps/os runs its capability host the same way). Its reduced state
// IS the routing table:
//
//   ┌──────────────── the routing table (per context) ───────────────┐
//   │  event mounts   (capability-provided/-revoked; SHADOW STACK:   │   most-specific pattern
//   │                  newest same-pattern wins; revoke-by-offset    │   wins; equal specificity
//   │                  pops exactly that entry)                      │   → recency; one winner;
//   │  config seeds   (APP_CONFIG, bottom of every stack; the ONLY   │   no match = DEFAULT-DENY
//   │                  provenance whose targets may say `roots`)     │
//   └────────────────────────────────────────────────────────────────┘
//
// Resolution of a call: match every row → pick the winner (specificity, then recency, seeds
// last) → substitute the caller's args/captures into the target's holes → evaluate the target
// against the scope → replay the remainder on the result. The scope's `itx` symbol re-enters
// THIS resolver (so alias mounts compose, and a default route `itx ⇒ itx.os` forwards whole
// missed calls with zero special machinery); the `roots` symbol exists ONLY while resolving a
// config-provenance row — event rows literally cannot spell the physical layer.

import { z } from "zod";
import { codedError } from "./core/errors.ts";
import { deeper, defineProcessorContract } from "./core/events.ts";
import {
  apply,
  ExpressionSchema,
  holeKind,
  match,
  pathProxy,
  print,
  substitute,
  toExpression,
  type Expression,
  type Match,
} from "./core/expression.ts";
import { StreamProcessor, type ReduceArgs } from "./core/processor.ts";

export const IterateContextContract = defineProcessorContract({
  slug: "iterate-context",
  version: "1.0.0",
  description:
    "The context's routing table: folds capability-provided/-revoked into the mount stack that resolveCapability dispatches against.",
  stateSchema: z.object({
    mounts: z
      .array(
        z.object({
          pattern: ExpressionSchema,
          target: ExpressionSchema,
          /** The mount's identity — the offset of the capability-provided event (no synthetic ids). */
          providedAtOffset: z.number().int().positive(),
        }),
      )
      .default([]),
  }),
  events: {
    "events.iterate.com/capability-host/capability-provided": {
      description: "Mount `target` at `pattern`. Same-pattern mounts SHADOW (newest wins).",
      payloadSchema: z.object({
        pattern: ExpressionSchema,
        target: ExpressionSchema,
        /** SUBSCRIPTION rows only (pattern itx.subscribers.<name>): the delivery policy rides
         *  the SAME event as the grant — config is event-sourced, never silent kv. */
        delivery: z
          .object({
            consumes: z.array(z.string()).optional(),
            onFailingEvent: z.enum(["halt", "skip"]).optional(),
            maxAttempts: z.number().int().positive().optional(),
            start: z.enum(["beginning", "now"]).optional(),
            /** LIVE STATE mode: no cursor, no ladder — the key's change payloads
             *  ({key, from, to, patch}) are forwarded as they commit; the CLIENT chains
             *  revisions and re-reads the producer's door on any gap. */
            liveState: z.object({ key: z.string() }).optional(),
          })
          .optional(),
      }),
    },
    "events.iterate.com/capability-host/capability-revoked": {
      description:
        "Pop exactly the mount created at `providedAtOffset` (what's beneath is restored).",
      payloadSchema: z.object({ providedAtOffset: z.number().int().positive() }),
    },
  },
  consumes: [
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
  ],
  emits: [
    "events.iterate.com/capability-host/capability-provided",
    "events.iterate.com/capability-host/capability-revoked",
  ],
});

type State = z.infer<typeof IterateContextContract.stateSchema>;
type MountRow = State["mounts"][number];

export class IterateContextStreamProcessor extends StreamProcessor<State> {
  readonly contract = IterateContextContract;
  /** Config seeds (bottom of every stack). ONLY their targets see the host-scope roots. */
  readonly #seeds: { pattern: Expression; target: Expression }[];
  /** The host scope: a plain record whose keys (kv, stream, contexts, bindings, …) are the
   *  expression roots that exist only for config-provenance targets. Never contains `itx`. */
  readonly #hostScope: Record<string, unknown>;

  constructor(args: {
    stream: ConstructorParameters<typeof StreamProcessor>[0]["stream"];
    storage: ConstructorParameters<typeof StreamProcessor>[0]["storage"];
    path: string;
    projectId: string;
    seeds: { pattern: Expression; target: Expression }[];
    hostScope: Record<string, unknown>;
  }) {
    super(args);
    this.#seeds = args.seeds;
    this.#hostScope = args.hostScope;
  }

  // The routing table is pure fold — no side effects, so no processEvent needed.
  protected override reduce({ event, state }: ReduceArgs<State>): State | undefined {
    if (event.type === "events.iterate.com/capability-host/capability-provided") {
      const { pattern, target } = event.payload as { pattern: Expression; target: Expression };
      return { mounts: [...state.mounts, { pattern, target, providedAtOffset: event.offset }] };
    }
    if (event.type === "events.iterate.com/capability-host/capability-revoked") {
      const { providedAtOffset } = event.payload as { providedAtOffset: number };
      return { mounts: state.mounts.filter((m) => m.providedAtOffset !== providedAtOffset) };
    }
    return undefined;
  }

  /** Provide = append the mount event; the offset that comes back IS the mount's identity. */
  async provide(input: {
    pattern: string | Expression;
    target: string | Expression;
    delivery?: {
      consumes?: string[];
      onFailingEvent?: "halt" | "skip";
      maxAttempts?: number;
      start?: "beginning" | "now";
      liveState?: { key: string };
    };
  }): Promise<{ providedAtOffset: number }> {
    const pattern = toExpression(input.pattern);
    const target = toExpression(input.target);
    if (target[0] !== "itx")
      throw new Error(
        `a provided capability's target must be rooted at "itx" (host-scope roots are config-seed-only)`,
      );
    assertMustUse(pattern, target);
    const [event] = await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-host/capability-provided",
        payload: { pattern, target, ...(input.delivery ? { delivery: input.delivery } : {}) },
      }),
    );
    return { providedAtOffset: event.offset };
  }

  async revoke(input: { providedAtOffset: number }): Promise<void> {
    await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-host/capability-revoked",
        payload: { providedAtOffset: input.providedAtOffset },
        idempotencyKey: `iterate-context/revoke:${input.providedAtOffset}`,
      }),
    );
  }

  /**
   * Resolve + run one call against the CURRENT table state. The winner is the LONGEST matching
   * prefix; ties → recency (event mounts by offset; seeds oldest of all); nothing matches →
   * default-deny with a readable error naming the call.
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
        `no capability matches ${JSON.stringify(print(expr))} (default-deny; mount one or add a seed)`,
      );
    const { row, m, provenance } = winner;
    const { steps: target, spentArgs } = substitute(row.target, {
      args: m.boundaryArgs ?? [],
      captures: m.captures,
    });
    // THE PROVENANCE GATE is a scope-KEY-SET decision: seed targets see the host-scope roots,
    // event targets see only `itx`. Not policed — the keys are simply absent. `itx` spreads
    // LAST so no host-scope key can ever shadow the resolver's recursion symbol.
    const scope =
      provenance === "config"
        ? { ...this.#hostScope, itx: this.#itxAtDepth(depth + 1) }
        : { itx: this.#itxAtDepth(depth + 1) };
    // Holes in the target SPENT the boundary args; a hole-free target receives them as a call.
    const boundaryArgs = spentArgs ? undefined : m.boundaryArgs;
    return await apply(scope, target, { remainder: m.remainder, boundaryArgs }, extraArgs);
  }

  /** THE FETCH LANE entry: resolve `expr.fetch` and call it with the live Request as a runtime
   *  arg (a Request is not expression data — it never passes through substitute's JSON walk).
   *  Everything stays in-isolate or on native stub hops, so a 101 flows back out untouched. */
  resolveFetch(state: State, expr: Expression, request: Request): Promise<unknown> {
    const last = expr.at(-1);
    // Normalize the terminal to a PROPERTY step `fetch` — a call-step's JSON args could never
    // carry the live Request; it always rides in as the runtime arg. A fetch CALL that carries
    // expression args is a LOUD error (never the silent arg-drop this codebase rejects
    // everywhere else): the author meant something the lane cannot do.
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

  /** Pure routing (exposed for describe/debug): the winning row or null. */
  route(
    state: State,
    call: Expression,
  ): {
    row: Pick<MountRow, "pattern" | "target">;
    m: Match;
    provenance: "config" | "event";
    providedAtOffset?: number;
  } | null {
    // The structured half of the bare-call rule: a call whose first step invokes the scope
    // symbol itself ([["itx", …]]) is malformed — parser and pathProxy already reject it; this
    // closes the hand-crafted-Expression door.
    if (typeof call[0] !== "string")
      throw new Error("cannot call the scope symbol itself — name a capability first");
    let best: ReturnType<IterateContextStreamProcessor["route"]> = null;
    const consider = (
      row: Pick<MountRow, "pattern" | "target">,
      provenance: "config" | "event",
      providedAtOffset?: number,
    ) => {
      const m = match(row.pattern, call);
      if (!m) return;
      // THE ranking rule, whole: longest matching prefix wins; ties go to the newest mount.
      if (
        best === null ||
        m.matchedSteps > best.m.matchedSteps ||
        (m.matchedSteps === best.m.matchedSteps &&
          (providedAtOffset ?? -1) > (best.providedAtOffset ?? -1))
      )
        best = { row, m, provenance, providedAtOffset };
    };
    for (const seed of this.#seeds) consider(seed, "config");
    for (const mount of state.mounts) consider(mount, "event", mount.providedAtOffset);
    return best;
  }

  /** The `itx` scope symbol at a given recursion depth: dotted/called access re-enters `resolve`
   *  with the CURRENT state, carrying the depth. This is what makes alias mounts compose and
   *  default routes forward whole calls. (Bare `itx(...)` is a loud error — pathProxy rejects a
   *  zero-segment call, so `segments` is never empty here.) */
  #itxAtDepth(depth: number): unknown {
    return pathProxy((segments, args) => {
      const last = segments[segments.length - 1] as string;
      return this.resolveCurrent(["itx", ...segments.slice(0, -1), [last, ...args]], depth);
    });
  }

  /** Deliver a pushed window to ONE subscription mount BY ROW IDENTITY — never by name
   *  through the table (a broad default route must not intercept deliveries). The stored
   *  target is an ordinary event-provenance expression: hole-free → called with
   *  (events, window); hole-bearing → the holes reshape the delivery, adapter-free. */
  async deliverTo(state: State, providedAtOffset: number, args: unknown[]): Promise<unknown> {
    const row = state.mounts.find((m) => m.providedAtOffset === providedAtOffset);
    if (!row) throw new Error(`no subscription mount at offset ${providedAtOffset}`);
    const { steps, spentArgs } = substitute(row.target, { args, captures: {} });
    return apply({ itx: this.#itxAtDepth(1) }, steps, {
      boundaryArgs: spentArgs ? undefined : args,
      remainder: [],
    });
  }

  /** Overridden by the host to hand `resolve` the current folded state. */
  resolveCurrent(_call: Expression, _depth = 0): Promise<unknown> {
    throw new Error("iterate-context: resolveCurrent not wired (host must bind it to its reads)");
  }
}

/** Registration-time must-use rule: a pattern that binds caller input (holes/captures) must have
 *  a target that references it — silently ignoring caller args is almost certainly a bug. */
function assertMustUse(pattern: Expression, target: Expression): void {
  // Args bind at ONE call step only (owner's rule): a pattern must not collect caller input
  // across several invocation sites — one place binds, everything else is literal path.
  const bindingSteps = pattern.filter(
    (step) =>
      Array.isArray(step) &&
      step.slice(1).some((a) => holeKind(a) !== null && holeKind(a) !== "literal"),
  );
  if (bindingSteps.length > 1)
    throw new Error("a pattern may bind caller args at only ONE call step");
  const patternBinds = new Set<string>();
  walkNamedHoles(pattern, (h) => patternBinds.add(h));
  if (patternBinds.size === 0) return;
  const used = new Set<string>();
  walkNamedHoles(target, (h) => used.add(h));
  for (const bound of patternBinds) {
    if (!used.has(bound))
      throw new Error(`pattern binds ?${bound} but the target never uses it (must-use rule)`);
  }
}

/** NAMED captures only — a numeric hole in a pattern binds nothing (anonymous wildcard), so
 *  numeric must-use is meaningless, not merely unenforced. */
function walkNamedHoles(expr: Expression, visit: (hole: string) => void): void {
  const walkValue = (v: unknown, depth: number): void => {
    // Classify via holeKind, exactly as match/substitute do — a private detector here would
    // disagree with them about `$`-escapes ($-escaped data is inert; rest binds no name).
    const kind = holeKind(v);
    if (kind === "arg") {
      const h = (v as { "?": string | number })["?"];
      if (typeof h === "string") visit(h);
      return;
    }
    if (kind === "literal" || kind === "rest") return;
    if (typeof v === "object" && v !== null)
      for (const inner of Object.values(v)) walkValue(inner, deeper(depth, "must-use walk"));
  };
  for (const step of expr) if (Array.isArray(step)) step.slice(1).forEach((v) => walkValue(v, 0));
}
