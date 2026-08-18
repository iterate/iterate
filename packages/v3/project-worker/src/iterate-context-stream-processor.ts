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
import {
  apply,
  compareSpecificity,
  match,
  print,
  substitute,
  toExpression,
  usesCallerArgs,
  type Expression,
  type Match,
} from "./core/expression.ts";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "./core/processor.ts";

const ExpressionSchema = z.array(
  z.union([z.string(), z.tuple([z.string()]).rest(z.unknown())]),
) as z.ZodType<Expression>;

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
      payloadSchema: z.object({ pattern: ExpressionSchema, target: ExpressionSchema }),
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
  /** Config seeds (bottom of every stack). Targets here — and ONLY here — may reference `roots`. */
  readonly #seeds: { pattern: Expression; target: Expression }[];
  /** The privileged physical-layer root, in scope only for seed targets. */
  readonly #roots: unknown;

  constructor(args: {
    stream: ConstructorParameters<typeof StreamProcessor>[0]["stream"];
    path: string;
    projectId: string;
    seeds: { pattern: Expression; target: Expression }[];
    roots: unknown;
  }) {
    super(args);
    this.#seeds = args.seeds;
    this.#roots = args.roots;
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
  protected override processEvent(_args: ProcessEventArgs<State>): undefined {}

  /** Provide = append the mount event; the offset that comes back IS the mount's identity. */
  async provide(input: {
    pattern: string | Expression;
    target: string | Expression;
  }): Promise<{ providedAtOffset: number }> {
    const pattern = toExpression(input.pattern);
    const target = toExpression(input.target);
    if (target[0] === "roots")
      throw new Error(`a provided capability may not reference "roots" (config seeds only)`);
    assertMustUse(pattern, target);
    const [event] = await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-host/capability-provided",
        payload: { pattern, target },
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
   * Resolve + run one call against the CURRENT table state. The winner is the most specific
   * match; equal specificity → recency (event mounts by offset; seeds oldest of all); nothing
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
      throw new Error(
        `no capability matches ${JSON.stringify(print(expr))} (default-deny; mount one or add a seed)`,
      );
    const { row, m, provenance } = winner;
    const target = substitute(row.target, { args: m.boundaryArgs ?? [], captures: m.captures });
    // THE PROVENANCE GATE: `roots` exists in scope only for config seeds. Not policed — absent.
    const base = { itx: this.#itxAtDepth(depth + 1) };
    const scope = provenance === "config" ? { ...base, roots: this.#roots } : base;
    // Holes in the target SPEND the boundary args; a hole-free target receives them as a call.
    const boundaryArgs = usesCallerArgs(row.target) ? undefined : m.boundaryArgs;
    return await apply(scope, target, { remainder: m.remainder, boundaryArgs }, extraArgs);
  }

  /** THE FETCH LANE entry: resolve `expr.fetch` and call it with the live Request as a runtime
   *  arg (a Request is not expression data — it never passes through substitute's JSON walk).
   *  Everything stays in-isolate or on native stub hops, so a 101 flows back out untouched. */
  resolveFetch(state: State, expr: Expression, request: Request): Promise<unknown> {
    const last = expr.at(-1);
    // Normalize the terminal to a PROPERTY step `fetch` — a call-step's JSON args could never
    // carry the live Request; it always rides in as the runtime arg.
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
    let best: ReturnType<IterateContextStreamProcessor["route"]> = null;
    const consider = (
      row: Pick<MountRow, "pattern" | "target">,
      provenance: "config" | "event",
      providedAtOffset?: number,
    ) => {
      const m = match(row.pattern, call);
      if (!m) return;
      if (
        best === null ||
        compareSpecificity(m.specificity, best.m.specificity) > 0 ||
        (compareSpecificity(m.specificity, best.m.specificity) === 0 &&
          (providedAtOffset ?? -1) > (best.providedAtOffset ?? -1))
      )
        best = { row, m, provenance, providedAtOffset };
    };
    for (const seed of this.#seeds) consider(seed, "config");
    for (const mount of state.mounts) consider(mount, "event", mount.providedAtOffset);
    return best;
  }

  /** The `itx` scope symbol: dotted/called access re-enters `resolve` with the CURRENT state.
   *  This is what makes alias mounts compose and default routes forward whole calls. */
  get itx(): unknown {
    return this.#itxAtDepth(1);
  }

  /** The `itx` scope symbol at a given recursion depth — re-enters resolve carrying the depth. */
  #itxAtDepth(depth: number): unknown {
    const build = (steps: Expression): unknown =>
      new Proxy(function () {} as object, {
        get: (_t, p) =>
          p === "then" || typeof p === "symbol" ? undefined : build([...steps, p as string]),
        apply: (_t, _this, args) => {
          const last = steps.at(-1);
          if (typeof last !== "string") throw new Error("itx: cannot call a call result here");
          const expr: Expression = [...steps.slice(0, -1), [last, ...(args as unknown[])]];
          return this.resolveCurrent(expr, depth);
        },
      });
    return build(["itx"]);
  }

  /** Overridden by the host to hand `resolve` the current folded state. */
  resolveCurrent(_call: Expression, _depth = 0): Promise<unknown> {
    throw new Error("iterate-context: resolveCurrent not wired (host must bind it to its reads)");
  }
}

/** Registration-time must-use rule: a pattern that binds caller input (holes/captures) must have
 *  a target that references it — silently ignoring caller args is almost certainly a bug. */
function assertMustUse(pattern: Expression, target: Expression): void {
  const patternBinds = new Set<string | number>();
  walkHoles(pattern, (h) => patternBinds.add(h));
  if (patternBinds.size === 0) return;
  const used = new Set<string | number>();
  walkHoles(target, (h) => used.add(h));
  for (const bound of patternBinds) {
    if (typeof bound === "string" && !used.has(bound))
      throw new Error(`pattern binds ?${bound} but the target never uses it (must-use rule)`);
  }
}

function walkHoles(expr: Expression, visit: (hole: string | number) => void): void {
  const walkValue = (v: unknown): void => {
    if (typeof v === "object" && v !== null) {
      if (!Array.isArray(v) && Object.keys(v).length === 1 && "?" in (v as object)) {
        visit((v as { "?": string | number })["?"]);
        return;
      }
      for (const inner of Object.values(v)) walkValue(inner);
    }
  };
  for (const step of expr) if (Array.isArray(step)) step.slice(1).forEach(walkValue);
}
