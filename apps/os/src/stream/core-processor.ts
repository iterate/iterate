// core-processor.ts — THE CORE REDUCE: the one processor the context DO reduces INLINE at its commit
// point. Its reduced state is everything the DO needs SYNCHRONOUSLY in its handlers, event-sourced
// from the context's own control events and nothing else:
//
//   future event batches     stream/append-scheduled · append-schedule-{cancelled,completed,failed} → schedules
//   who this context is       stream/created { projectId, path }            → projectId · path · createdAt
//   which incarnation runs    stream/woken { incarnation }                  → incarnation
//   may appends land          stream/paused { reason } · stream/resumed     → paused        (one `if` in Stream.append)
//   where the project apex goes project/ingress-configured { target|null } → ingressTarget
//   how calls rewrite         itx/rewrite-rule-configured { match, target|null, ifTarget? } → itxExpressionRewriteRules (every invoke)
//   who is sent each commit   stream/subscription-configured { name, target|null, ifConfiguredAtOffset? }|
//                             -delivery-halted|-delivery-resumed            → subscriptions (the delivery loop)
//   which scripts are running context/run-requested { code } · run-settled { requestOffset, settlement } → scriptRuns, by the request's offset (the DO's runner; the wake record settles what a restart interrupted)
//
// ONE reduce, no effects, no verbs — a pure fold (`reduceCoreEvent`) with a batch form
// (`reduceCoreEventBatch`), NOT a hosted `StreamProcessor`: owned by the Stream itself and reduced
// inside every commit, because its readers (Stream.append, the dispatcher, the delivery loop) are
// all synchronous. The COMMANDS that append these events live beside the code that reads each slice
// (context/itx-expression-rewriting.ts for the rules, `normalizeControlEvent` below normalizes literal rows). Control is
// ORDINARY EVENTS: `itx.append({ type: 'events.iterate.com/stream/paused', payload: { reason } })`
// pauses — so a POLICY processor (a token-bucket breaker, a quota) runs as an ordinary facet and
// trips the stream by appending `paused`. Core knows nothing about it; e2e/support/sources.ts's
// BreakerProcessor is that pattern. created/woken come from the stream's birth record and the first
// request or alarm of each incarnation (Stream.appendBirthRecord / appendWakeRecord); the pause exemptions are Stream.append's.
//
// ONE VALIDATION BOUNDARY: every append the DO commits passes `normalizeControlEvent` (below), which
// zod-parses each control event's payload and stores the normalized form, so the fold CASTS what it
// reads and never re-parses. The stream's own records (birth, wake, the halted fact, the alarm trace)
// are well-formed by construction. No stored row predates its event's normalization.

import {
  itxExpressionStepName,
  normalizedItxExpression,
  type ItxExpressionInput,
  parseItxExpressionPrefix,
  type ItxExpression,
  print,
} from "iterate/next/expression";
import { jsonEqual } from "iterate/next/lib";
import { z } from "zod";
import type { StreamEvent, ReduceArgs, StreamEventInput } from "iterate/next/stream/processor";
import type { RewriteRuleConfigured } from "iterate/next/api";
import { RunRequested, RunSettled } from "iterate/next/stream/run";
import { firstPartyFacetClassOf } from "../first-party-facets.ts";
import {
  BUILT_IN_ROOTS,
  builtInsGetStep,
  implicitRootsAt,
  isBuiltInsRooted,
  normalizeRewriteRuleConfigured,
  refuseSelfLoopRow,
  resolveItxExpression,
  type ItxExpressionRewriteRule,
} from "../context/itx-expression-rewriting.ts";
import {
  ScheduledAppendInput,
  ScheduledAppendCancelled,
  ScheduledAppendSettled,
  reduceScheduledAppends,
  type ScheduledAppend,
} from "./scheduled-appends.ts";

/** A hosting spec, read off a RESOLVED target. */
type HostingFacetSpec = {
  name: string;
  /** Absent for a first-party facet: its class is this worker's own (first-party-facets.ts). */
  source?: unknown;
  className: string;
  cacheKey?: string;
};

/** The hosting spec inside a target RESOLVED to the fixed point
 *  (`itx.builtins.facets.get(name, { source, className, cacheKey? }).…`) — present ONLY in the raw
 *  log event's target, before the reduce elides the source (M1). Undefined for an address-only
 *  target. Resolution is what makes a user's short spelling, or a rule of their own naming
 *  `itx.builtins.facets`, host exactly like the platform's. */
export function facetSpecFromHostingTarget(
  resolvedTarget: ItxExpression,
): HostingFacetSpec | undefined {
  const getStep = builtInsGetStep(resolvedTarget, "facets");
  if (!getStep) return undefined;
  // A FIRST-PARTY facet hosts this worker's own class: the target names it and carries no spec.
  const firstPartyClassName = firstPartyFacetClassOf(getStep[1]);
  if (getStep.length === 2 && firstPartyClassName)
    return { name: getStep[1], className: firstPartyClassName };
  if (getStep.length >= 3 && typeof getStep[2] === "object" && getStep[2] !== null) {
    // The spec is caller-authored and only its object-ness is checked here: a malformed one is
    // copied as it is and fails where the facet host loads it (FacetHost `#facetStartupMemoFor`).
    const spec = getStep[2] as { source: unknown; className: string; cacheKey?: string };
    return {
      name: getStep[1],
      source: spec.source,
      className: spec.className,
      // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical facet spec: cacheKey feeds the loader's identity-keyed memo (facetSpecOf); an absent cacheKey must stay absent, not `cacheKey: undefined`
      ...(spec.cacheKey !== undefined && { cacheKey: spec.cacheKey }),
    };
  }
  return undefined;
}

/** Resolve a target through THIS state's rules to the fixed point — or undefined when it cannot be
 *  resolved right now (a prefix nothing names yet, a mask, the depth budget): such a target is stored
 *  as given and hosts nothing until it can. */
function resolveThroughState(state: CoreState, target: ItxExpression): ItxExpression | undefined {
  try {
    return resolveItxExpression(
      () => Object.values(state.itxExpressionRewriteRules),
      target,
      implicitRootsAt(state.projectId || "", state.path || "/"),
    ).at(-1);
  } catch {
    return undefined;
  }
}

/** M1: split a configured target into the SOURCE-LESS target the reduce stores (the ORIGINAL
 *  spelling, minus the spec — a target re-resolves at every delivery, so the reduce never freezes
 *  its resolution) and the `hostedFacet` marker (the facet's name, class and cacheKey). A non-hosting
 *  target passes through with no marker. */
function elideHostedFacetSource(
  target: ItxExpression,
  resolvedTarget: ItxExpression | undefined,
): {
  target: ItxExpression;
  hostedFacet?: { name: string; className: string; cacheKey?: string };
} {
  const spec = resolvedTarget && facetSpecFromHostingTarget(resolvedTarget);
  if (!spec) return { target };
  // The marker is the spec minus its source (a 100 KB processor must not ride the checkpoint).
  const { source: _source, ...hostedFacet } = spec;
  // The spec rides the ORIGINAL target's `get` call step, wherever a rule of the caller's put it.
  const specStepIndex = target.findIndex(
    (step) =>
      Array.isArray(step) &&
      step[0] === "get" &&
      step.length >= 3 &&
      typeof step[1] === "string" &&
      typeof step[2] === "object" &&
      step[2] !== null &&
      "className" in (step[2] as object),
  );
  return {
    target:
      specStepIndex === -1
        ? target
        : [
            ...target.slice(0, specStepIndex),
            // The findIndex predicate above checked step[0] === "get" and a string step[1].
            ["get", (target[specStepIndex] as [string, string])[1]],
            ...target.slice(specStepIndex + 1),
          ],
    hostedFacet,
  };
}

/** Does a row's target OWN ITS PROGRESS — a facet (its own checkpoint) or a lent rpc stub (a live
 *  client's own offset), so the stream keeps no cursor for it and its deliveries are PUSHES? Decided
 *  from the rules alone, never by evaluating the target: a fresh incarnation classifies every row
 *  before anything runs, so a facet row is never a cursor row's claim on the alarm (the delivery
 *  loop). A target that cannot be resolved yet (a `subscribe` before its `provide`) cannot own
 *  progress: the stream keeps its cursor, as for any plain target. */
export function targetOwnsProgress(state: CoreState, row: Subscription): boolean {
  const resolved = resolveThroughState(state, row.target);
  if (!resolved) return false;
  return !!(builtInsGetStep(resolved, "facets") || builtInsGetStep(resolved, "rpcStubs"));
}

/** THE DRAFT TABLES OF ONE BATCH: a table is copied ONCE per batch, on its first touch, and mutated
 *  in place from then on, so a page of N control events costs O(rows + N), not N copies of the whole
 *  table (the O(rows²) constructor re-reduce memory-budget.test.ts pins). The set is fresh per batch
 *  and never holds a published table, so the state a caller handed in stays immutable; only the
 *  batch's own intermediate states share a draft, and nothing observes those. */
type DraftTables = WeakSet<object> | undefined;
function draftOf<Table extends object>(table: Table, draftTables: DraftTables): Table {
  if (draftTables?.has(table)) return table;
  const draft = { ...table };
  draftTables?.add(draft);
  return draft;
}

/** THE MARKERS FOLLOW THE RULES: after the table changed, a row whose target is NOT builtins-rooted
 *  may host a different facet than its `hostedFacet` says, while the delivery loop re-resolves at
 *  every push and the removal effect trusts the marker — they must agree. So every rule commit
 *  re-derives the marker of every such row through the NEW table: a hosting spelling marks that
 *  facet; an ADDRESS of the facet it is marked with keeps its marker (its own spec was elided, M1);
 *  anything else drops it. A builtins-rooted row's marker is final; an unresolvable row keeps what it has. */
function withHostedFacetMarkersFollowingRules(
  state: CoreState,
  draftTables: DraftTables,
): CoreState {
  let subscriptions: CoreState["subscriptions"] | undefined; // the draft, taken on the first change
  for (const [name, row] of Object.entries(state.subscriptions)) {
    if (isBuiltInsRooted(row.target)) continue;
    const resolved = resolveThroughState(state, row.target);
    if (!resolved) continue;
    const spec = facetSpecFromHostingTarget(resolved);
    let next: Subscription["hostedFacet"];
    if (spec) {
      const { source: _source, ...hostedFacet } = spec;
      next = hostedFacet;
    } else if (builtInsGetStep(resolved, "facets")?.[1] === row.hostedFacet?.name) {
      next = row.hostedFacet; // an ADDRESS of the facet it is marked with: its own spec was elided
    }
    if (jsonEqual(next || null, row.hostedFacet || null)) continue;
    subscriptions ||= draftOf(state.subscriptions, draftTables);
    const { hostedFacet: _previous, ...rest } = row;
    subscriptions[name] = next ? { ...rest, hostedFacet: next } : rest;
  }
  return subscriptions ? { ...state, subscriptions } : state;
}

/** One subscription row (by name; a same-named configure REPLACES). */
export type Subscription = {
  /** The target, parsed; its terminal is callable with (events, range). */
  target: ItxExpression;
  /** Event types delivered; absent = every durable event; naming a type opts its ephemerals in. */
  consumes?: string[];
  /** The row's identity — the offset of its subscription-configured event. */
  configuredAtOffset: number;
  /** Where CURSOR delivery starts for this row — its first delivery follows this offset (0 = the
   *  whole log); absent = `configuredAtOffset`, "from now". A target that owns its progress (a
   *  facet, a lent stub) ignores it. */
  afterOffset?: number;
  /** Set when this row HOSTS a facet (M1): the facet's name, class and cacheKey, but NOT the source —
   *  that stays in the durable log event and the `facet:<name>` kv memo, so a 100 KB processor never
   *  bloats the checkpoint blob rewritten on every core change. An address-only row has none. */
  hostedFacet?: { name: string; className: string; cacheKey?: string };
  /** A CURSOR target that exhausted its retries (the loop appended the halted fact). */
  halted?: { afterOffset: number; attempts: number; error?: string };
  /** The newest delivery-resumed: the loop applies it once (a seek, an un-halt). */
  resumed?: { afterOffset?: number; atOffset: number };
};

/** THE CORE STATE — the context's own state, reduced inline at the commit point. A hand-written
 *  type, not a schema-derived one: the fold runs synchronously inside every commit and casts what
 *  the append boundary already parsed (the header). */
export type CoreState = {
  /** From the birth certificate (stream/created, offset 1). */
  projectId?: string;
  path?: string;
  createdAt?: string;
  /** From the wake record (stream/woken) — growth across idle is the hibernation tell. */
  incarnation?: number;
  paused: { reason: string } | null;
  /** THE REWRITE-RULE TABLE, by canonical match (a map — no stack, no identity beyond the match): a
   *  configured target REPLACES; `null` is kept as a MASK where something beneath would answer the
   *  match HERE (an implicit row: `itx.kv` and `itx.ai.run('gpt-5')` at the owner root, `itx.append`
   *  anywhere, the bare `itx` — one row denies all; or a stored shorter row with a target: `itx.tool`
   *  behind the parent link) and DELETES otherwise; `null` with `ifTarget` is a handle's
   *  compare-and-set DELETE; a target equal to the implicit row it would restate deletes (the
   *  default said as much), the same spelling elsewhere is a grant and is stored (rule 8). */
  itxExpressionRewriteRules: Record<string, ItxExpressionRewriteRule>;
  /** THE SUBSCRIPTIONS TABLE, by name. */
  subscriptions: Record<string, Subscription>;
  /** Explicit fetch target for the project apex; null until configured. */
  ingressTarget: ItxExpression | null;
  schedules: Record<string, ScheduledAppend>;
  /** THE OPEN SCRIPT RUNS, by the request's offset: a script requested (`context/run-requested`)
   *  and not yet settled — what is running right now, or what a restart left open (never re-run:
   *  the wake record settles it `interrupted`, stream.ts). The code stays on the request event. */
  scriptRuns: Record<number, OpenScriptRun>;
};

/** One open script run: when it was asked for (its identity is its key, the request's offset). */
type OpenScriptRun = { requestedAt: string };

/** A subscription name is ONE segment, [A-Za-z0-9_-] — and never a key of `Object.prototype`: the
 *  tables are plain records indexed by name, so such a name would read or write the prototype
 *  instead of a row — and never `core`: the always-on reduce is addressable as a facet but not a
 *  configurable subscription — a row named `core` would be undeliverable and climb the retry ladder
 *  to a halt. */
const SUBSCRIPTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
function parseSubscriptionName(name: string): string {
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a name carried in an untrusted event payload (the `: string` type is a claim); the typeof guards the pattern test and prototype-pollution check below
  if (typeof name !== "string" || !SUBSCRIPTION_NAME_PATTERN.test(name) || name in Object.prototype)
    throw new Error(
      `a subscription name is one segment: [A-Za-z0-9_-]+, never a key of Object.prototype (got ${JSON.stringify(name)})`,
    );
  if (name === CoreContract.slug)
    throw new Error(
      `"${CoreContract.slug}" is reserved as a subscription name: it is the core reduce, never a configurable subscription`,
    );
  return name;
}

/** THE CORE CONTRACT — what the Stream reads: the checkpoint's slug and reducer version (a bump
 *  re-reduces the log from offset 0 in the DO constructor), and the every-field-defaulted initial
 *  state. The reduce below is the one list of the types it consumes. */
export const CoreContract = {
  slug: "core",
  version: "13.0.0",
  /** THE EVENTS THIS CONTRACT OWNS beyond its control events (their schemas:
   *  iterate/next/stream/run). A processor that consumes them names the contract in its
   *  `processorDeps` (the agent); the runner and `itx.run` read them here. */
  events: {
    "events.iterate.com/context/run-requested": {
      description:
        "A script this context is asked to run once, against its own itx, by whoever appended it (source.principal); the event's offset is the run.",
      payloadSchema: RunRequested,
    },
    "events.iterate.com/context/run-settled": {
      description:
        "What the requested script returned, or how it failed; a run the context's restart interrupted is settled here too, never re-run.",
      payloadSchema: RunSettled,
    },
  },
  initialState: (): CoreState => ({
    paused: null,
    itxExpressionRewriteRules: {},
    subscriptions: {},
    ingressTarget: null,
    schedules: {},
    scriptRuns: {},
  }),
};

/** THE BATCH REDUCE: the events in order over `state`, each table copied once for the whole batch
 *  (`draftOf`). A throwing event is handed to `onError` and skipped — the reduce touches a draft
 *  only after everything that can throw, so one bad hand-appended event never wedges the batch,
 *  and the state handed in is never mutated: a mid-transaction throw rolls back to it cleanly. */
export function reduceCoreEventBatch(
  events: StreamEvent[],
  state: CoreState,
  onError: (error: unknown, event: StreamEvent) => void,
): CoreState {
  const draftTables = new WeakSet<object>();
  for (const event of events) {
    try {
      state = reduceCoreEvent({ event, state }, draftTables) ?? state;
    } catch (error) {
      onError(error, event);
    }
  }
  return state;
}

/** THE CORE REDUCE of one event — a pure fold, `undefined` = keep the state (identity is the host's
 *  change signal). Without `draftTables` (the tests' single-event fold) every touch copies.
 *  Ephemeral control events are IGNORED (they would vanish from any rebuild). Payloads are read as
 *  the boundary stored them (the header); a target the codec still refuses THROWS here like any
 *  reduce would — BEFORE any draft is touched — and `reduceCoreEventBatch` contains it. */
export function reduceCoreEvent(
  { event, state }: ReduceArgs<CoreState>,
  draftTables?: DraftTables,
): CoreState | undefined {
  if (event.ephemeral) return undefined;
  const payload = (event.payload || {}) as Record<string, unknown>;
  /** The subscriptions table with `name` set to `row` (or removed): the batch's draft, mutated. */
  const withSubscription = (name: string, row: Subscription | undefined): CoreState => {
    const subscriptions = draftOf(state.subscriptions, draftTables);
    if (row) subscriptions[name] = row;
    else delete subscriptions[name];
    return { ...state, subscriptions };
  };
  switch (event.type) {
    case "events.iterate.com/project/ingress-configured": {
      const target = payload.target as ItxExpression | null;
      return jsonEqual(state.ingressTarget, target)
        ? undefined
        : { ...state, ingressTarget: target };
    }
    case "events.iterate.com/stream/append-scheduled":
    case "events.iterate.com/stream/append-schedule-cancelled":
    case "events.iterate.com/stream/append-schedule-completed":
    case "events.iterate.com/stream/append-schedule-failed": {
      const schedules = reduceScheduledAppends(state.schedules, event);
      return schedules === state.schedules ? undefined : { ...state, schedules };
    }
    case "events.iterate.com/context/run-requested": {
      // the code is the event's to keep; the row is its offset's
      if (state.scriptRuns[event.offset]) return undefined;
      const scriptRuns = draftOf(state.scriptRuns, draftTables);
      scriptRuns[event.offset] = { requestedAt: event.createdAt };
      return { ...state, scriptRuns };
    }
    case "events.iterate.com/context/run-settled": {
      const requestOffset = payload.requestOffset as number;
      if (!state.scriptRuns[requestOffset]) return undefined; // settled twice, or never requested
      const scriptRuns = draftOf(state.scriptRuns, draftTables);
      delete scriptRuns[requestOffset];
      return { ...state, scriptRuns };
    }
    case "events.iterate.com/stream/created":
      return {
        ...state,
        projectId: payload.projectId as string,
        path: payload.path as string,
        createdAt: event.createdAt,
      };
    case "events.iterate.com/stream/woken":
      return { ...state, incarnation: payload.incarnation as number };
    case "events.iterate.com/stream/paused":
      return { ...state, paused: { reason: (payload.reason as string | undefined) ?? "paused" } };
    case "events.iterate.com/stream/resumed":
      return { ...state, paused: null };

    case "events.iterate.com/itx/rewrite-rule-configured": {
      // A no-op is `undefined`, not a fresh object: the inline host detects change by identity, and
      // a benign double-delete or double-mask must not rewrite the checkpoint or publish a
      // live-state delta.
      // The append boundary stores the match as the PARSED prefix (like the target), so this reads it
      // in place — never a second string parse that a canonical match over the codec cap would throw
      // on. `print` derives the table key (printing has no cap).
      const matchPrefix = parseItxExpressionPrefix(payload.match as ItxExpressionInput);
      const matchString = print(matchPrefix);
      const existing = state.itxExpressionRewriteRules[matchString];
      // What has an implicit row HERE (rule 3) decides what a null and a platform-equivalent target
      // mean (rule 8). The event carries the path.
      const implicitRoots = implicitRootsAt(state.projectId || "", event.path);
      // Every change to the rules table re-derives the subscriptions' hosting markers through it.
      const withRule = (rule: ItxExpressionRewriteRule | undefined): CoreState => {
        const rules = draftOf(state.itxExpressionRewriteRules, draftTables);
        if (rule)
          rules[matchString] = rule; // a match string is `itx…`, never a prototype key
        else delete rules[matchString];
        return withHostedFacetMarkersFollowingRules(
          { ...state, itxExpressionRewriteRules: rules },
          draftTables,
        );
      };
      // THE COMPARE-AND-SET of a handle's undo and a dead stub's census (`ifTarget`): a DELETE that
      // applies only while the row's target is still the one the handle wrote — a replacement owns
      // the match now and a stale undo is a no-op. Decided inside the commit, so there is no
      // read-then-append window. Never a mask: a disposed session row leaves nothing behind.
      if ("ifTarget" in payload)
        return existing && jsonEqual(existing.target, payload.ifTarget)
          ? withRule(undefined)
          : undefined;
      const description =
        typeof payload.description === "string" ? { description: payload.description } : {};
      if (payload.target === null) {
        // A MASK where something beneath would answer the match — an implicit row, or a stored
        // SHORTER row with a target (the parent link `itx ⇒ itx.builtins.cd('/agents/a')`, a granted
        // root `itx.repos ⇒ …`): the call is refused, not answered. A plain deletion anywhere else
        // (a mask there would equal a deletion and only grow the table).
        const root = matchPrefix.length === 1 ? undefined : itxExpressionStepName(matchPrefix[1]);
        const answeredBeneath =
          matchPrefix.length === 1 || // beneath the bare `itx`: every implicit row here
          (!!root && implicitRoots.has(root)) ||
          Object.values(state.itxExpressionRewriteRules).some(
            (row) =>
              !!row.target &&
              row.match.length < matchPrefix.length &&
              row.match.every((step, i) => jsonEqual(step, matchPrefix[i])),
          );
        if (!answeredBeneath) return existing ? withRule(undefined) : undefined;
        if (existing && !existing.target && jsonEqual(existing.description, payload.description))
          return undefined;
        return withRule({ match: matchPrefix, target: null, ...description });
      }
      const target = normalizedItxExpression(payload.target as ItxExpressionInput, { holes: true }); // a target may hold `@` (rule 7); stored as the parsed form
      // A target that restates THE implicit row of its match (`itx.kv ⇒ itx.builtins.kv` at the owner
      // root, `itx ⇒ itx.builtins` there, `itx.append ⇒ itx.builtins.append` anywhere) is "back to
      // the default": the row is deleted, never stored, so the table never carries a row that only
      // repeats it — UNLESS a bare null stands, which took that default away: then the same spelling
      // is the grant through the wall and is stored (so a jail writes its mask first, its grants
      // after). At a child, a project root's physical target is a grant either way.
      const wall =
        matchPrefix.length > 1 && state.itxExpressionRewriteRules["itx"]?.target === null;
      // The implicit row of THIS match: `itx.<root>` with `root` implicit here, or the bare `itx`
      // where every root is (the owner root) — nothing longer, nothing pinned.
      const isImplicitRow =
        matchPrefix.length === 1
          ? implicitRoots.size === BUILT_IN_ROOTS.length
          : matchPrefix.length === 2 &&
            typeof matchPrefix[1] === "string" &&
            implicitRoots.has(matchPrefix[1]);
      if (!wall && isImplicitRow && jsonEqual(target, ["itx", "builtins", ...matchPrefix.slice(1)]))
        return existing ? withRule(undefined) : undefined;
      return withRule({ match: matchPrefix, target, ...description });
    }

    case "events.iterate.com/stream/subscription-configured": {
      const name = payload.name as string;
      if (payload.target === null) {
        // The same compare-and-set for a subscription handle's undo: `ifConfiguredAtOffset` is the
        // identity of the row the handle wrote.
        if (
          "ifConfiguredAtOffset" in payload &&
          state.subscriptions[name]?.configuredAtOffset !== payload.ifConfiguredAtOffset
        )
          return undefined;
        return state.subscriptions[name] ? withSubscription(name, undefined) : undefined;
      }
      const consumes = payload.consumes as string[] | undefined;
      const afterOffset = payload.afterOffset as number | undefined;
      // M1: a hosting target keeps its spelling but sheds its SOURCE here (`hostedFacet` says why).
      const configuredTarget = normalizedItxExpression(payload.target as ItxExpressionInput); // stored as the parsed form
      const { target, hostedFacet } = elideHostedFacetSource(
        configuredTarget,
        resolveThroughState(state, configuredTarget),
      );
      return withSubscription(name, {
        target,
        // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical subscription row (serialized to the JSON checkpoint, compared with jsonEqual which counts keys): an absent optional field must stay absent, not `field: undefined`
        ...(consumes && { consumes }),
        configuredAtOffset: event.offset,
        // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical subscription row (serialized to the JSON checkpoint, compared with jsonEqual which counts keys): an absent optional field must stay absent, not `field: undefined`
        ...(afterOffset !== undefined && { afterOffset }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical subscription row (serialized to the JSON checkpoint, compared with jsonEqual which counts keys): an absent optional field must stay absent, not `field: undefined`
        ...(hostedFacet && { hostedFacet }),
      });
    }
    case "events.iterate.com/stream/subscription-delivery-halted": {
      const row = state.subscriptions[payload.name as string];
      if (!row) return undefined;
      return withSubscription(payload.name as string, {
        ...row,
        halted: {
          afterOffset: payload.afterOffset as number,
          attempts: payload.attempts as number,
          ...(payload.error !== undefined && { error: payload.error as string }),
        },
      });
    }
    case "events.iterate.com/stream/subscription-delivery-resumed": {
      const row = state.subscriptions[payload.name as string];
      if (!row) return undefined;
      const { halted: _cleared, ...kept } = row;
      return withSubscription(payload.name as string, {
        ...kept,
        resumed: {
          ...(payload.afterOffset !== undefined && {
            afterOffset: payload.afterOffset as number,
          }),
          atOffset: event.offset,
        },
      });
    }
    default:
      return undefined;
  }
}

// ── subscriptions ── THE SUBSCRIPTIONS TABLE's one COMMAND (the rows are core state; the reader is
// subscription-delivery.ts). A subscription is pure data — a NAME, a TARGET expression whose
// terminal is callable with `(events, range)`, an optional `consumes` filter, and an optional
// `afterOffset` (where cursor delivery starts: 0 = the whole log; absent = from the configure
// offset). `configured` REPLACES a same-named row; a `null` target REMOVES it. The halted fact is
// appended by the delivery loop; the resumed fact by an operator's plain `itx.append`.

/** The `subscription-configured` event for `input.name`. `ifConfiguredAtOffset` (with a null
 *  target) is a handle's undo: the reduce drops the row ONLY while it is still the one configured at
 *  that offset. */
function normalizeSubscriptionConfigured(input: {
  name: string;
  target: ItxExpressionInput | null;
  consumes?: string[];
  afterOffset?: number;
  ifConfiguredAtOffset?: number;
}): Record<string, unknown> {
  const name = parseSubscriptionName(input.name);
  const { afterOffset } = input;
  if (afterOffset !== undefined && !(Number.isInteger(afterOffset) && afterOffset >= 0))
    throw new Error(
      `a subscription's afterOffset is a non-negative integer offset (got ${JSON.stringify(afterOffset)})`,
    );
  // Through the codec (`normalizedItxExpression`), so a target the reduce could not read fails LOUD
  // here, in the parser's words. STORED AS THE PARSED FORM: a target carries a facet's whole source as data, and
  // the reduce must never re-parse that through the string codec (its 2 KiB cap).
  // oxlint-disable-next-line iterate/simple-truthiness-check -- input.target is `string | ItxExpression | null`; its null is the explicit undo/mask sentinel, distinct from a malformed empty-string target that normalization must still reject
  const target = input.target === null ? null : normalizedItxExpression(input.target);
  if (target && target[0] !== "itx")
    throw new Error(
      `a subscription target must be rooted at "itx" (got ${JSON.stringify(print(target))})`,
    );
  return {
    name,
    target,
    ...(target && input.consumes && { consumes: input.consumes }),
    ...(target && afterOffset !== undefined && { afterOffset }),
    ...(!target &&
      input.ifConfiguredAtOffset !== undefined && {
        ifConfiguredAtOffset: input.ifConfiguredAtOffset,
      }),
  };
}

const IngressConfigured = z.object({
  // The expression codec below validates every step after this outer shape check.
  target: z
    .custom<ItxExpressionInput>((value) => typeof value === "string" || Array.isArray(value))
    .nullable(),
});

/** Apex routing stores the complete capability expression, independently of rewrite aliases. */
function normalizeIngressConfigured(input: unknown): { target: ItxExpression | null } {
  const { target } = IngressConfigured.parse(input);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- null disables ingress; an empty expression must be rejected by the codec
  if (target === null) return { target: null };
  const expression = normalizedItxExpression(target);
  if (expression[0] !== "itx") throw new Error("ingress target must be rooted at itx");
  return { target: expression };
}

/** THE APPEND BOUNDARY for core CONTROL events: validate + normalize a LITERAL control event so call
 *  sites write `itx.append({ type, payload })` with NO event-builder helper. A subscription/rewrite
 *  target is validated and normalized STRING→array before storage (the reduce must never string-parse
 *  a facet source — the codec's 2 KiB cap), and a malformed control event throws HERE instead of
 *  committing a durable no-op. Every other event passes through untouched. The DO runs this on every
 *  append (iterate-context-durable-object.ts). */
export function normalizeControlEvent(event: StreamEventInput, ownPath: string): StreamEventInput {
  if (event.type === "events.iterate.com/project/ingress-configured") {
    if (event.ephemeral) throw new Error("ingress configuration must be durable");
    return { ...event, payload: normalizeIngressConfigured(event.payload) };
  }
  // `String(…)`: a non-string type (a client's `{ type: 12345 }`) is Stream.append's to refuse, with
  // its own message — this prefix check runs first and must not throw a TypeError of its own.
  if (String(event.type).startsWith("events.iterate.com/stream/append-schedule")) {
    if (event.ephemeral) throw new Error("scheduled append control events must be durable");
    if (event.type === "events.iterate.com/stream/append-scheduled") {
      const payload = ScheduledAppendInput.parse(event.payload);
      return {
        ...event,
        payload: {
          ...payload,
          events: payload.events.map((scheduled) => normalizeControlEvent(scheduled, ownPath)),
        },
      };
    }
    if (event.type === "events.iterate.com/stream/append-schedule-cancelled")
      return { ...event, payload: ScheduledAppendCancelled.parse(event.payload) };
    if (
      event.type === "events.iterate.com/stream/append-schedule-completed" ||
      event.type === "events.iterate.com/stream/append-schedule-failed"
    )
      return { ...event, payload: ScheduledAppendSettled.parse(event.payload) };
    throw new Error(`unknown scheduled append control event: ${event.type}`);
  }
  if (event.type === "events.iterate.com/context/run-requested") {
    if (event.ephemeral)
      throw new Error("a run's request is durable: the scriptRuns table is rebuilt from the log");
    return { ...event, payload: RunRequested.parse(event.payload) };
  }
  if (event.type === "events.iterate.com/context/run-settled") {
    if (event.ephemeral)
      throw new Error(
        "a run's settlement is durable: the scriptRuns table is rebuilt from the log",
      );
    return { ...event, payload: RunSettled.parse(event.payload) };
  }
  if (event.type === "events.iterate.com/stream/subscription-configured")
    return {
      ...event,
      payload: normalizeSubscriptionConfigured(
        event.payload as Parameters<typeof normalizeSubscriptionConfigured>[0],
      ),
    };
  if (event.type === "events.iterate.com/itx/rewrite-rule-configured") {
    // A literal event's payload is wire-fed JSON (`unknown`); `normalizeRewriteRuleConfigured` parses
    // `match`, `target` and `ifTarget` and shape-checks `description`, throwing on anything else — the
    // assertion only names the shape it is about to check.
    const payload = event.payload as RewriteRuleConfigured & {
      ifTarget?: ItxExpressionInput | null;
    };
    // normalizeRewriteRuleConfigured parses match, target AND ifTarget into the stored (parsed)
    // shape, and carries the `ifTarget` KEY through only when the caller sent one — the reduce keys
    // its compare-and-set undo off `"ifTarget" in payload`.
    const normalized = normalizeRewriteRuleConfigured(payload);
    // The one row no table can refuse at resolve: a bare link back to the context it lands on.
    refuseSelfLoopRow(normalized, ownPath);
    return { ...event, payload: normalized };
  }
  return event;
}
