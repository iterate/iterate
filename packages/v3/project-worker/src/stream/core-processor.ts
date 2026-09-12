// core-processor.ts — THE CORE REDUCE: the one processor the context DO reduces INLINE at its commit
// point. Its reduced state is everything the DO needs SYNCHRONOUSLY at its doors, event-sourced from
// the context's own control events and nothing else:
//
//   who this context is       stream/created { projectId, path }            → projectId · path · createdAt
//   which incarnation runs    stream/woken { incarnation }                  → incarnation
//   may appends land          stream/paused { reason } · stream/resumed     → paused        (one `if` in Stream.append)
//   how calls rewrite         itx/rewrite-rule-configured { match, target|null, ifTarget? } → itxExpressionRewriteRules (every invoke)
//   who is sent each commit   stream/subscription-configured { name, target|null, ifConfiguredAtOffset? }|
//                             -delivery-halted|-delivery-resumed            → subscriptions (the delivery loop)
//
// ONE reduce, no effects, no verbs — a pure fold (`reduceCoreEvent`) with a batch door
// (`reduceCoreEventBatch`), NOT a hosted `StreamProcessor`: owned by the Stream itself and reduced
// inside every commit, because its readers (the append door, the dispatcher, the delivery loop) are
// all synchronous. The COMMANDS that append these events live beside the code that reads each slice
// (context/itx-expression-rewriting.ts for the rules, `normalizeControlEvent` below normalizes literal rows). Control is
// ORDINARY EVENTS: `itx.append({ type: 'events.iterate.com/stream/paused', payload: { reason } })`
// pauses — so a POLICY processor (a token-bucket breaker, a quota) runs as an ordinary facet and
// trips the stream by appending `paused`. Core knows nothing about it; e2e/support/sources.ts's
// BreakerProcessor is that pattern. created/woken come from the DO constructor
// (Stream.appendCreatedAndWokenEvents); the pause exemptions are Stream.append's.
//   subscriptions — a literal `subscription-configured` event, THE SUBSCRIPTIONS TABLE's one command (the rows are core state)

import {
  normalizedItxExpression,
  type ItxExpressionInput,
  itxExpressionStepName,
  parseItxExpressionPrefix,
  type ItxExpression,
  type ItxExpressionPrefix,
  print,
} from "../context/expression.ts";
import {
  isBuiltInRoot,
  isBuiltInsRooted,
  normalizeRewriteRuleConfigured,
  resolveItxExpression,
  type ItxExpressionRewriteRule,
} from "../context/itx-expression-rewriting.ts";
import { jsonEqual } from "../lib.ts";
import type { StreamEvent, ReduceArgs, StreamEventInput } from "./processor.ts";

/** A hosting spec, read off a RESOLVED target. */
export type HostingFacetSpec = {
  name: string;
  source: unknown;
  className: string;
  cacheKey?: string;
};

/** The hosting spec inside a target RESOLVED to the fixed point
 *  (`itx.builtins.facets.get(name, { source, className, cacheKey? }).…`) — present ONLY in the raw
 *  log event's target, before the reduce elides the source (M1). Undefined for an address-only
 *  target. Resolution is what makes a user's short spelling, or a rule of their own naming the door,
 *  host exactly like the platform's. */
export function facetSpecFromHostingTarget(
  resolvedTarget: ItxExpression,
): HostingFacetSpec | undefined {
  const getStep = resolvedTarget[3];
  if (
    resolvedTarget[1] === "builtins" &&
    resolvedTarget[2] === "facets" &&
    Array.isArray(getStep) &&
    getStep[0] === "get" &&
    getStep.length >= 3 &&
    typeof getStep[1] === "string" &&
    typeof getStep[2] === "object" &&
    getStep[2] !== null
  ) {
    const spec = getStep[2] as { source: unknown; className: string; cacheKey?: string };
    return {
      name: getStep[1],
      source: spec.source,
      className: spec.className,
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
    return resolveItxExpression(() => Object.values(state.itxExpressionRewriteRules), target).at(
      -1,
    );
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
            ["get", (target[specStepIndex] as [string, string])[1]],
            ...target.slice(specStepIndex + 1),
          ],
    hostedFacet: {
      name: spec.name,
      className: spec.className,
      ...(spec.cacheKey !== undefined && { cacheKey: spec.cacheKey }),
    },
  };
}

/** The facet a resolved target merely ADDRESSES (`itx.builtins.facets.get(name)…`, no spec) — or
 *  undefined when it is not the facets door at all. */
function facetAddressedBy(resolvedTarget: ItxExpression): string | undefined {
  const getStep = resolvedTarget[3];
  return resolvedTarget[1] === "builtins" &&
    resolvedTarget[2] === "facets" &&
    Array.isArray(getStep) &&
    getStep[0] === "get" &&
    typeof getStep[1] === "string"
    ? getStep[1]
    : undefined;
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
    const next = spec
      ? {
          name: spec.name,
          className: spec.className,
          ...(spec.cacheKey !== undefined && { cacheKey: spec.cacheKey }),
        }
      : facetAddressedBy(resolved) === row.hostedFacet?.name
        ? row.hostedFacet
        : undefined;
    if (jsonEqual(next ?? null, row.hostedFacet ?? null)) continue;
    subscriptions ??= draftOf(state.subscriptions, draftTables);
    const { hostedFacet: _previous, ...rest } = row;
    subscriptions[name] = next ? { ...rest, hostedFacet: next } : rest;
  }
  return subscriptions ? { ...state, subscriptions } : state;
}

/** Does a `null` at `match` MASK a platform row (kept as a row) or merely delete (nothing beneath)?
 *  A bare `itx` masks everything; a match under a built-in root masks that root's calls it claims. */
function matchShadowsAPlatformRow(match: ItxExpressionPrefix): boolean {
  if (match.length === 1) return true;
  const name = itxExpressionStepName(match[1]);
  // `itx.worker` is a platform row too — the resolver's default config worker (itx-expression-
  // rewriting.ts); a `null` there MASKS it, else the project falls back to the no-op silently.
  return isBuiltInRoot(name) || name === "worker";
}

/** One subscription row (by name; a same-named configure REPLACES). */
export type Subscription = {
  /** The target, parsed; its terminal is callable with (events, range). */
  target: ItxExpression;
  /** Event types delivered; absent = every durable event; naming a type opts its ephemerals in. */
  consumes?: string[];
  /** The row's identity — the offset of its subscription-configured event. */
  configuredAtOffset: number;
  /** Where the CURSOR lane starts for this row — its first delivery follows this offset (0 = the
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

/** THE CORE STATE — the context's own state, reduced inline at the commit point. HAND-WRITTEN, no
 *  zod on the edge/DO script: these events are the platform's own, trusted, so the 310 KB runtime
 *  validator earned its removal. */
export type CoreState = {
  /** From the birth certificate (stream/created, offset 1). */
  projectId?: string;
  path?: string;
  createdAt?: string;
  /** From the wake record (stream/woken) — growth across idle is the hibernation tell. */
  incarnation?: number;
  paused: { reason: string } | null;
  /** THE REWRITE-RULE TABLE, by canonical match (a map — no stack, no identity beyond the match): a
   *  configured target REPLACES; `null` is kept as a MASK when the match shadows a platform row
   *  (`itx.kv`, `itx.ai.run('gpt-5')`, bare `itx`) and DELETES otherwise; the platform-equivalent
   *  target `itx.builtins.<match…>` DELETES the row (back to the platform row). */
  itxExpressionRewriteRules: Record<string, ItxExpressionRewriteRule>;
  /** THE SUBSCRIPTIONS TABLE, by name. */
  subscriptions: Record<string, Subscription>;
  /** THE SECRETS CATALOG, by name — the origin a secret is bound to, never a value (the value is
   *  physical, in KV): `itx.secrets.list()` reads this, strongly consistent, where KV's own list lags
   *  a write by up to a minute. */
  secrets: Record<string, { origin?: string }>;
};

/** A subscription name is ONE segment, [A-Za-z0-9_-] — and never a key of `Object.prototype`: the
 *  tables are plain records indexed by name, so such a name would read or write the prototype
 *  instead of a row. Refused here and at the append door (stream.ts, beside `core`). */
const SUBSCRIPTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
function parseSubscriptionName(name: string): string {
  if (typeof name !== "string" || !SUBSCRIPTION_NAME_PATTERN.test(name) || name in Object.prototype)
    throw new Error(
      `a subscription name is one segment: [A-Za-z0-9_-]+, never a key of Object.prototype (got ${JSON.stringify(name)})`,
    );
  return name;
}

/** THE CORE CONTRACT — what the Stream reads: the checkpoint's slug and reducer version (a bump
 *  re-reduces the log from offset 0 in the DO constructor), and the every-field-defaulted initial
 *  state. The reduce below is the one list of the types it consumes. */
export const CoreContract = {
  slug: "core",
  version: "8.0.0",
  initialState: (): CoreState => ({
    paused: null,
    itxExpressionRewriteRules: {},
    subscriptions: {},
    secrets: {},
  }),
};

/** THE BATCH DOOR: the events in order over `state`, each table copied once for the whole batch
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
 *  Ephemeral control events are IGNORED (they would vanish from any rebuild). A malformed payload
 *  THROWS here like any reduce would — BEFORE any draft is touched — and the batch door contains it. */
export function reduceCoreEvent(
  { event, state }: ReduceArgs<CoreState>,
  draftTables?: DraftTables,
): CoreState | undefined {
  if (event.ephemeral) return undefined;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  /** The subscriptions table with `name` set to `row` (or removed): the batch's draft, mutated. */
  const withSubscription = (name: string, row: Subscription | undefined): CoreState => {
    const subscriptions = draftOf(state.subscriptions, draftTables);
    if (row) subscriptions[name] = row;
    else delete subscriptions[name];
    return { ...state, subscriptions };
  };
  switch (event.type) {
    case "events.iterate.com/secrets/changed": {
      const name = payload.name as string;
      const next = payload.deleted
        ? undefined
        : { ...(typeof payload.origin === "string" && { origin: payload.origin }) };
      // A no-op is `undefined`, not a fresh object (the rules case says why).
      if (next ? jsonEqual(state.secrets[name], next) : state.secrets[name] === undefined)
        return undefined;
      const secrets = draftOf(state.secrets, draftTables);
      if (next) secrets[name] = next;
      else delete secrets[name];
      return { ...state, secrets };
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
      const matchString = payload.match as string;
      const matchPrefix = parseItxExpressionPrefix(matchString);
      const existing = state.itxExpressionRewriteRules[matchString];
      // THE COMPARE-AND-SET of a handle's undo (`ifTarget`): the removal applies only while the row's
      // target is still the one the handle wrote — a replacement owns the match now and a stale undo
      // is a no-op. Decided inside the commit, so there is no read-then-append window.
      if ("ifTarget" in payload && (!existing || !jsonEqual(existing.target, payload.ifTarget)))
        return undefined;
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
      if (payload.target === null) {
        // A MASK where a platform row lies beneath (rule 5: the call is refused, not defaulted);
        // a plain deletion anywhere else (a mask there would equal a deletion and only grow the table).
        if (!matchShadowsAPlatformRow(matchPrefix))
          return existing ? withRule(undefined) : undefined;
        if (existing && existing.target === null) return undefined;
        return withRule({ match: matchPrefix, target: null });
      }
      const target = normalizedItxExpression(payload.target as ItxExpressionInput, { holes: true }); // a target may hold `@` (rule 7); stored as the parsed form
      // THE PLATFORM-EQUIVALENT TARGET (`itx.kv ⇒ itx.builtins.kv`, `itx ⇒ itx.builtins`) is "back to
      // the platform row": the row is deleted, never stored — so an un-mask is one ordinary event and
      // the table never carries a row that only restates the default.
      if (jsonEqual(target, ["itx", "builtins", ...matchPrefix.slice(1)]))
        return existing ? withRule(undefined) : undefined;
      return withRule({ match: matchPrefix, target });
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
        ...(consumes && { consumes }),
        configuredAtOffset: event.offset,
        ...(afterOffset !== undefined && { afterOffset }),
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
// `afterOffset` (where the cursor lane starts: 0 = the whole log; absent = from the configure
// offset). `configured` REPLACES a same-named row; a `null` target REMOVES it. The halted fact is
// appended by the delivery loop; the resumed fact by an operator's plain `itx.append`.

/** The `subscription-configured` event for `input.name`. `ifConfiguredAtOffset` (with a null
 *  target) is a handle's undo: the reduce drops the row ONLY while it is still the one configured at
 *  that offset (core-processor.ts). */
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
  // Through the codec's one door, so a target the reduce could not read fails LOUD here, in the
  // parser's words. STORED AS THE PARSED FORM: a target carries a facet's whole source as data, and
  // the reduce must never re-parse that through the string codec (its 2 KiB cap).
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

/** THE APPEND BOUNDARY for core CONTROL events: validate + normalize a LITERAL control event so call
 *  sites write `itx.append({ type, payload })` with NO event-builder helper. A subscription/rewrite
 *  target is validated and normalized STRING→array before storage (the reduce must never string-parse
 *  a facet source — the codec's 2 KiB cap), and a malformed control event throws HERE instead of
 *  committing a durable no-op. Every other event passes through untouched. The DO runs this on every
 *  append (iterate-context-durable-object.ts). */
export function normalizeControlEvent(event: StreamEventInput): StreamEventInput {
  if (event.type === "events.iterate.com/stream/subscription-configured")
    return {
      ...event,
      payload: normalizeSubscriptionConfigured(
        event.payload as Parameters<typeof normalizeSubscriptionConfigured>[0],
      ),
    };
  if (event.type === "events.iterate.com/itx/rewrite-rule-configured") {
    const payload = event.payload as {
      match: ItxExpressionInput;
      target: ItxExpressionInput | null;
      ifTarget?: unknown;
    };
    const { match, target } = normalizeRewriteRuleConfigured(payload);
    return {
      ...event,
      payload: { match, target, ...("ifTarget" in payload && { ifTarget: payload.ifTarget }) },
    };
  }
  return event;
}
