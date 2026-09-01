// capability-table-processor.ts — THE CAPABILITY TABLE as a reduce-only stream processor, run
// INLINE at the stream's commit point (one processor among many; apps/os runs its capability
// host the same way). Its reduced state IS the table:
//
//   ┌───────────────── the capability table (per context) ─────────────────┐
//   │  BUILT-INS      (kv, append, read, cd, …; resolved DIRECTLY —        │  built-ins first;
//   │                  no mount, no config; unshadowable physical layer)    │  then longest
//   │  userspace      (capability-provided/-revoked; SHADOW STACK: newest   │  path wins, ties
//   │  mounts          same-path wins; revoke-by-offset pops that entry)    │  → recency; else
//   └──────────────────────────────────────────────────────────────────────┘  DEFAULT-DENY
//
// A MOUNT binds a CAPABILITY PATH ("itx.chat") to a TARGET EXPRESSION — or, for a LIVE capability
// (`itx.provide(path, stub)`), to the live stub parked at that same path (`live: true` on the
// event; no durable target exists — the transport table is consulted at resolve time). Mounts
// optionally carry a DELIVERY policy (subscriptions) or a PROCESSOR policy (facet-processor
// enablement) — every userspace attachment to a stream is a mount, all event-sourced, all
// shadowable/revocable. STRING AT REST: the event payload stores both halves in the string half of
// the codec (the log reads like what a human wrote); reduce parses ONCE into the structured
// in-memory table. LIVE rows are per-path singletons (a live provide SUPERSEDES the incumbent live
// row — the provided event IS the reconnect record); expression mounts shadow-stack as ever.
//
// Resolution of a call: `itx.<root>…` where `<root>` is a BUILT-IN resolves directly against the
// physical scope (as if by an implicit mount `itx.<root> ⇒ <root>`). Otherwise, match every
// userspace mount's path → pick the winner (longest, then newest) → evaluate the target against
// `{ itx }` → apply boundary args → replay the remainder. The scope's `itx` symbol re-enters THIS
// resolver (so alias mounts compose); a userspace target names a built-in by recursing through it.

import { z } from "zod";
import { codedError } from "./core/errors.ts";
import { expressionEndingInFetch } from "./core/fetch-capabilities.ts";
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
  type ItxExpression,
} from "./core/expression.ts";
import { apply, match, type Match } from "./core/dispatch.ts";
import { InvokeHandle } from "./core/invoke-handle.ts";
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
};

const CapabilityTableContract = defineProcessorContract({
  slug: "capability-table",
  version: "3.0.0",
  description:
    "The context's capability table: reduces capability-provided/-revoked events into the mount stack that every call resolves against.",
  stateSchema: z.object({
    mounts: z
      .array(
        z.object({
          /** The capability path, parsed (segments). The EVENT stores the string. */
          path: z.array(z.string()),
          /** The target expression, parsed (EXPRESSION mounts only — a live row has none; the
           *  transport table, keyed by the same path, is its target). The EVENT stores the string. */
          target: z.custom<Expression>(() => true).optional(),
          /** LIVE row: the mount's target is the live stub parked at this path (see `live` on the
           *  provided event). At most ONE live row per path — a live provide SUPERSEDES it. */
          live: z.literal(true).optional(),
          /** The mount's identity — the offset of its capability-provided event. */
          providedAtOffset: z.number().int().positive(),
          delivery: z.record(z.string(), z.unknown()).optional(),
          processor: z.record(z.string(), z.unknown()).optional(),
          /** SUBSCRIPTION mounts only — the declared delivery lane (see `SubscriptionLane`). */
          lane: z.enum(["facet", "connected", "durable"]).optional(),
        }),
      )
      .default([]),
  }),
  events: {
    "events.iterate.com/capability-table/capability-provided": {
      description:
        "Mount a capability at `path`: EITHER a `target` expression (string half of the codec — the log stays human-readable; same-path mounts SHADOW, newest wins) OR `live: true` (the target is the live stub parked at the path; at most one live row per path — a live provide SUPERSEDES the incumbent live row in place).",
      payloadSchema: z
        .object({
          path: z.string(),
          /** EXPRESSION mounts only — exactly one of `target` / `live`. */
          target: z.string().optional(),
          /** LIVE mounts only — the provided capability is the live stub parked at `path` (no
           *  durable target expression exists; this flag is the truth). */
          live: z.literal(true).optional(),
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
            })
            .optional(),
          /** The delivery lane, stamped ONCE here (see `SubscriptionLane`) — every reader reads it
           *  instead of re-inferring from the target's shape. Subscriber mounts only. */
          lane: z.enum(["facet", "connected", "durable"]).optional(),
        })
        // Exactly one of target/live — enforced AT THE DOOR (buildEvent parses this schema), and
        // load-bearing: z.object STRIPS unknown keys, so a missing schema field would silently
        // erase the flag from the stored event.
        .refine((p) => (p.target !== undefined) !== (p.live === true), {
          message: "capability-provided: exactly one of `target` (expression) / `live: true`",
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

/** The capability table as a REDUCE-ONLY processor: pure reduce (the table) + the resolver
 *  methods the parent calls against that reduced state. Hosted INLINE at the parent's commit
 *  point (zero distance — no chain, no cursor, no facet); the provide/revoke side effects live
 *  in the VERBS below, which simply append. */
export class CapabilityTableProcessor implements ReduceOnlyProcessor<State> {
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
  /** THE LIVE-STUB BRIDGE: the pipelinable handle for the live stub mounted at a path (the host
   *  folds it onto its transport table — `directory.invoke(pathString, segments, args)`). A live
   *  row resolves through this instead of a target expression; boundary-arg callOn, remainder
   *  replay, and the fetch-shaped rule all ride the handle unchanged. */
  readonly #liveStub: (pathString: string) => InvokeHandle;

  constructor(args: {
    stream: ProcessorStream;
    builtIns: Record<string, unknown>;
    resolveCurrent: (call: Expression, depth?: number) => Promise<unknown>;
    liveStub: (pathString: string) => InvokeHandle;
  }) {
    this.stream = args.stream;
    this.#builtIns = args.builtIns;
    this.#resolveCurrent = args.resolveCurrent;
    this.#liveStub = args.liveStub;
  }

  // The capability table is pure reduce — no side effects (which is exactly what qualifies it
  // for inline hosting). Ephemeral capability events are IGNORED (they would vanish from any
  // rebuild); a malformed payload is SKIPPED loudly — one bad hand-appended event must not
  // wedge every later resolve. The STRING halves are parsed HERE, once, into the structured
  // in-memory table.
  reduce({ event, state }: ReduceArgs<State>): State | undefined {
    if (event.ephemeral) return undefined;
    if (event.type === "events.iterate.com/capability-table/capability-provided") {
      const { path, target, live, delivery, processor, lane } = event.payload as {
        path: string;
        target?: string;
        live?: true;
        delivery?: Record<string, unknown>;
        processor?: Record<string, unknown>;
        lane?: "facet" | "connected" | "durable";
      };
      let parsed: { path: CapabilityPath; target?: Expression; live?: true };
      try {
        // A LIVE row has no target to parse — the flag is the truth (the transport table, keyed
        // by the same path, is its target).
        parsed = live
          ? { path: parseCapabilityPath(path), live: true }
          : { path: parseCapabilityPath(path), target: parse(target as string) };
      } catch (error) {
        tableLog.warn("skipping malformed capability-provided", {
          event: "capability-table.malformed-mount.skipped",
          offset: event.offset,
          error,
        });
        return undefined;
      }
      const row = {
        ...parsed,
        providedAtOffset: event.offset,
        ...(delivery && { delivery }),
        ...(processor && { processor }),
        ...(lane && { lane }),
      };
      // ONE LIVE ROW PER PATH, BY REDUCE RULE: a live provide at a path already holding a live row
      // REPLACES that row in place (supersession — no shadow, no revoke event needed; the provided
      // event IS the reconnect record). Expression mounts keep full shadow-stack semantics —
      // including beneath a live row.
      if (live) {
        const pathString = parsed.path.join(".");
        const i = state.mounts.findIndex((m) => m.live && m.path.join(".") === pathString);
        if (i >= 0) return { mounts: state.mounts.map((m, j) => (j === i ? row : m)) };
      }
      return { mounts: [...state.mounts, row] };
    }
    if (event.type === "events.iterate.com/capability-table/capability-revoked") {
      const { providedAtOffset } = event.payload as { providedAtOffset: number };
      return { mounts: state.mounts.filter((m) => m.providedAtOffset !== providedAtOffset) };
    }
    return undefined;
  }

  /** Provide = append the mount event (STRING at rest — programmatic inputs are canonicalized
   *  through print). Exactly one of `target` (an expression mount) / `live: true` (the live stub
   *  parked at the path — no durable target exists). The offset that comes back IS the mount's
   *  identity. */
  async provide(input: {
    path: string | CapabilityPath;
    target?: ItxExpression;
    live?: true;
    delivery?: DeliveryPolicy;
    processor?: ProcessorPolicy;
    /** The delivery lane, stamped on the event (see `SubscriptionLane`). The host computes it once
     *  at the provide door; every reader reads it back rather than re-inferring from the target. */
    lane?: SubscriptionLane;
  }): Promise<{ providedAtOffset: number }> {
    const path = typeof input.path === "string" ? parseCapabilityPath(input.path) : input.path;
    if ((input.target !== undefined) === (input.live === true))
      throw new Error("provide: exactly one of `target` (expression) / `live: true`");
    const target = input.live ? undefined : toExpression(input.target!);
    if (target && target[0] !== "itx")
      throw new Error(
        `a provided capability's target must be rooted at "itx" (a bare built-in root is unspellable — targets recurse through the itx symbol)`,
      );
    // ROUND-TRIP THE STORED STRINGS NOW. The event stores strings; reduce re-parses them and
    // SKIPS anything that won't parse (a bad object key, an exponent number) — which would make
    // provide() report a providedAtOffset for a capability that silently never exists. Fail loud
    // at the door instead: parse what we are about to store and demand it survives. A LIVE row
    // stores no target — only the path half runs.
    const pathString = path.join(".");
    const targetString = target && print(target);
    try {
      const reparsedPath = parseCapabilityPath(pathString);
      if (
        reparsedPath.length !== path.length || // a pre-split array like ["itx.kv"] re-splits — reject
        reparsedPath.join(".") !== pathString ||
        (targetString !== undefined && print(parse(targetString)) !== targetString)
      )
        throw new Error("re-parse diverged");
    } catch (cause) {
      throw new Error(
        `provide: capability ${JSON.stringify(pathString)} → ${targetString === undefined ? "(live)" : JSON.stringify(targetString)} does not round-trip (${cause instanceof Error ? cause.message : cause}); it would be stored and then silently dropped`,
      );
    }
    const [event] = await this.stream.append(
      this.contract.buildEvent({
        type: "events.iterate.com/capability-table/capability-provided",
        payload: {
          path: pathString,
          ...(targetString !== undefined && { target: targetString }),
          ...(input.live && { live: true }),
          ...(input.delivery && { delivery: input.delivery }),
          ...(input.processor && { processor: input.processor }),
          ...(input.lane && { lane: input.lane }),
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
      if (winner.mount.live) {
        // A LIVE row's target is the stub parked at its path: hand the resolver bridge's handle in
        // as the whole scope and fall into the SAME apply — boundary-arg callOn (applyRoot),
        // remainder replay, and the fetch-shaped rule all ride the transport's invoke unchanged.
        // No transport ⇒ CONNECTION_OFFLINE at call time (mounted-but-offline — a never-provided
        // path already default-denied above).
        scope = { stub: this.#liveStub(winner.mount.path.join(".")) };
        target = ["stub"];
        m = winner.m;
      } else {
        scope = { itx };
        target = winner.mount.target!;
        m = winner.m;
      }
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
    // Doctrine point 1 (core/fetch-capabilities.ts): fetch-shaped capabilities are always called
    // via the terminal `fetch`, with the live Request as the one runtime arg.
    return this.resolve(state, expressionEndingInFetch(expr), [request]);
  }

  /** Pure routing: the winning userspace `provide` mount ROW for a call (the caller branches on
   *  its `live`/`target`), or null (built-ins are resolved before this — see `resolve`). Longest
   *  matching path wins; ties → newest mount (`providedAtOffset`). */
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
   *  primitive) — the same fold a bare `pathProxy` did, now on a pipelinable brand. */
  #itxAtDepth(depth: number): unknown {
    return new InvokeHandle((segments, args) => {
      const last = segments[segments.length - 1] as string;
      return this.#resolveCurrent(["itx", ...segments.slice(0, -1), [last, ...args]], depth);
    });
  }

  /** Deliver to ONE subscription mount BY ROW IDENTITY — never by name through the table (a
   *  broad default route must not intercept deliveries). A LIVE row delivers straight to the bare
   *  parked callable (empty call path on its transport); an expression target is evaluated and
   *  called with the delivery args (an event batch + its ScannedRange, or a state change
   *  payload). */
  async deliverTo(state: State, providedAtOffset: number, args: unknown[]): Promise<unknown> {
    const row = state.mounts.find((m) => m.providedAtOffset === providedAtOffset);
    if (!row) throw new Error(`no subscription mount at offset ${providedAtOffset}`);
    if (row.live) return this.#liveStub(row.path.join(".")).applyRoot(args);
    return apply({ itx: this.#itxAtDepth(1) }, row.target!, { boundaryArgs: args, remainder: [] });
  }
}
