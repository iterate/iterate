// context/itx-expression-rewriting.ts — HOW A CALL FINDS A PROVIDED CAPABILITY, pure and total.
// A durable row is `{ match, target }`: a property-only itx name selects a no-hole invocation recipe.
// Its fixed calls run first; ordinary caller arguments apply at its final value. `null` masks a
// name. The resolver still uses the historical event/table spelling while callers migrate, but it
// has no argument matching, partial application, or argument transformation.
//
// THE PLATFORM'S OWN SPELLINGS ARE ROOTED AT `itx.builtins` — a lent stub's rule, a processor's
// row, a parent link, its own log plumbing (library.ts) — so a user's row at `itx.facets` or
// `itx.rpcStubs` redirects the user's calls and nothing else. A hosted processor's ENGINE speaks the
// context roots (sdk/index.ts), so a row at a context root is the owner's deliberate wall. AT REST
// (`normalizeRewriteRuleConfigured`, below) an event stores the match as its canonical STRING (the
// table's key) and the target PARSED; the core reduce parses the match once.

import {
  codedError,
  errorCode,
  jsonEqual,
  releaseRpcSessions,
  resolveContextPath,
} from "iterate/lib";
import type { RewriteRuleConfigured, RewriteRuleListEntry } from "iterate/api";
import {
  normalizedItxExpression,
  itxExpressionStepName,
  parse,
  parseItxExpressionPrefix,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionPrefix,
} from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import { crossingOneMore, newChain, recordRefusal, type Cause } from "../cause.ts";
import { isConfigPointerMatch, type Caller } from "../caller.ts";
import { ScheduledAppendInput } from "../stream/scheduled-appends.ts";
import { unavailableError } from "../unavailable.ts";
import { callOn, walkSteps, awaitAnswerReleasedIfRejected } from "./dispatch.ts";
import { SNAPSHOT_REREADS, type RuleSnapshot } from "./rule-snapshots.ts";
import { GLOBAL_PROJECT_ID } from "./paths.ts";
import {
  BUILT_IN_ROOT_DESCRIPTIONS,
  CONTEXT_BUILT_IN_ROOT_NAMES,
  PORTABLE_BUILT_IN_ROOT_NAMES,
  BUILT_IN_ROOT_NAMES,
  type BuiltInRootName,
} from "./built-in-roots.ts";

// ── built-in roots ──

export type BuiltInRoot = BuiltInRootName;
export const BUILT_IN_ROOTS = BUILT_IN_ROOT_NAMES;

const BUILT_IN_ROOT_SET: ReadonlySet<string> = new Set(BUILT_IN_ROOTS);
export const CONTEXT_ROOTS = CONTEXT_BUILT_IN_ROOT_NAMES;
const CONTEXT_ROOT_SET: ReadonlySet<string> = new Set(CONTEXT_ROOTS);
const PORTABLE_ROOT_SET: ReadonlySet<string> = new Set(PORTABLE_BUILT_IN_ROOT_NAMES);

/** Which roots are implicit at a context. Global contexts retain the full surface; navigation guards
 * decide which global operations a caller may use. */
export function implicitRootsAt(projectId: string, path: string): ReadonlySet<string> {
  return projectId === GLOBAL_PROJECT_ID || resolveContextPath("/", path) === "/"
    ? BUILT_IN_ROOT_SET
    : CONTEXT_ROOT_SET;
}

/** One rewrite rule as the table stores it: a canonical, property-only match prefix and the target
 *  it rewrites to (both parsed once, at reduce).
 *  A `null` target is a MASK: the row matches like any other and refuses the call. */
export type ItxExpressionRewriteRule = {
  match: ItxExpressionPrefix;
  target: ItxExpression | null;
  /** The one line a model reads for `match` here (`normalizeRewriteRuleConfigured`). */
  description?: string;
  /** Optional TypeScript declaration for the capability named by this rule. */
  declaration?: string;
};

/** The most a worker's literal source may be, serialized: in a rule's target, which every context
 *  that resolves through the table reads in a snapshot (context/rule-snapshots.ts), and in a
 *  facet's spec (worker-loader.ts `assertFacetSourceWithinCeiling`). */
export const SOURCE_MAX_CHARS = 1 << 20;

/** The proxy's own verbs — a match may not start with one (`normalizeRewriteRuleConfigured`). */
const PROXY_VERBS: readonly string[] = ["invoke", "provide", "subscribe"];

/** Is `call` at the fixed point — rooted at `itx.builtins` (a NAME step; `itx.builtins(…)` is not)? */
export function isBuiltInsRooted(call: ItxExpression): boolean {
  return call[0] === "itx" && call[1] === "builtins";
}

// ── the rules (pure) ──

/** What a provided name claims: the final call's ordinary arguments (when the name is called) and
 * the steps after the name. Names contain properties only; they never match or pin arguments. */
type ItxExpressionPrefixMatch = { unpinnedArgs?: unknown[]; stepsAfterMatch: ItxExpression };

/** Claim `call` with a provided dotted name, step by step from the start — or null. */
export function matchItxExpressionPrefix(
  match: ItxExpressionPrefix,
  call: ItxExpression,
): ItxExpressionPrefixMatch | null {
  let unpinnedArgs: unknown[] | undefined;
  for (let i = 0; i < match.length; i++) {
    const matchStep = match[i];
    const callStep = call[i];
    const final = i === match.length - 1;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- out-of-bounds detection: call[i] is undefined past the call's end, distinct from any present step
    if (callStep === undefined) return null; // the match is longer than the call
    // The append boundary makes every provided name property-only. Keep this defensive refusal so
    // a malformed historical row cannot recover argument matching after the language is removed.
    if (typeof matchStep !== "string") return null;
    if (typeof callStep === "string") {
      if (callStep !== matchStep) return null;
    } else if (callStep[0] !== matchStep || !final) return null;
    else unpinnedArgs = callStep.slice(1);
  }
  return { unpinnedArgs, stepsAfterMatch: call.slice(match.length) };
}

/** The longest provided name — or null. A mask competes like any other provided name. */
function pickItxExpressionRewriteRule(
  rules: readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
): { rule: ItxExpressionRewriteRule; match: ItxExpressionPrefixMatch } | null {
  let best: { rule: ItxExpressionRewriteRule; match: ItxExpressionPrefixMatch } | null = null;
  for (const rule of rules) {
    const match = matchItxExpressionPrefix(rule.match, call);
    if (match && (!best || rule.match.length > best.rule.match.length)) best = { rule, match };
  }
  return best;
}

/** The call with the matched name replaced by its target. The target's fixed calls happen first;
 * the caller's ordinary arguments then apply to the final value. */
function applyItxExpressionRewriteRule(
  target: ItxExpression,
  match: ItxExpressionPrefixMatch,
): ItxExpression {
  const { unpinnedArgs, stepsAfterMatch } = match;
  const last = target.at(-1);
  if (!unpinnedArgs) return [...target, ...stepsAfterMatch];
  return typeof last === "string"
    ? [...target.slice(0, -1), [last, ...unpinnedArgs], ...stepsAfterMatch]
    : [...target, ["", ...unpinnedArgs], ...stepsAfterMatch];
}

/** Rules 3–5 together, PURE: the CHAIN of rewrites from `call` to the call that runs — `call` itself
 *  first, the builtins-rooted call last (one element when `call` is already there). `implicitRoots`
 *  is what has an implicit row HERE (`implicitRootsAt`). Throws NO_ITX_EXPRESSION_MATCH when nothing
 *  claims the call, or when the winning row is a mask (default-deny), and a depth error after 32
 *  rewrites. `rules` is a THUNK read at most once, and NOT AT ALL when the call is already
 *  builtins-rooted: a fixed-point dispatch never materializes the table. */
export function resolveItxExpression(
  rules: () => readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
  implicitRoots: ReadonlySet<string>,
): ItxExpression[] {
  const chain: ItxExpression[] = [call];
  let current = call;
  let rulesList: readonly ItxExpressionRewriteRule[] | undefined;
  for (let rewrites = 0; ; rewrites++) {
    if (isBuiltInsRooted(current)) return chain;
    if (rewrites >= 32)
      throw new Error(`itx-expression rewriting exceeded depth 32 — self-referential rule?`);
    const root = itxExpressionStepName(current[1]);
    const implicit = current[0] === "itx" && !!root && implicitRoots.has(root);
    const winner =
      current[0] === "itx" ? pickItxExpressionRewriteRule((rulesList ||= rules()), current) : null;
    // A bare row WITH a target yields to an implicit row (the context's own log stays its own under
    // a parent link); a bare NULL yields to nothing — one row denies all.
    const yields = !!winner && winner.rule.match.length === 1 && !!winner.rule.target && implicit;
    if (winner && !yields) {
      if (!winner.rule.target)
        throw codedError(
          "NO_ITX_EXPRESSION_MATCH",
          `${JSON.stringify(print(current))} is masked: the rule at ${JSON.stringify(print(winner.rule.match))} is null (default-deny; provide a target)`,
        );
      current = applyItxExpressionRewriteRule(winner.rule.target, winner.match);
      chain.push(current);
      continue;
    }
    if (implicit) {
      // THE IMPLICIT ROW: `itx.<root> ⇒ itx.builtins.<root>` — the fixed point, done.
      current = ["itx", "builtins", ...current.slice(1)];
      chain.push(current);
      return chain;
    }
    throw codedError(
      "NO_ITX_EXPRESSION_MATCH",
      `no rewrite rule matches ${JSON.stringify(print(current))} (default-deny; configure a rule first)`,
    );
  }
}

/** Where `call` ends up, the last of its chain (`resolveItxExpression`, which keeps `rules` a thunk):
 *  undefined when it cannot resolve right now, a name nothing claims, a mask or the depth budget. */
export function fixedPointOf(
  rules: () => readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
  implicitRoots: ReadonlySet<string>,
): ItxExpression | undefined {
  try {
    return resolveItxExpression(rules, call, implicitRoots).at(-1);
  } catch {
    return undefined;
  }
}

/** The roots that say who a context is and where it is reached (built-ins.ts
 *  `buildIdentityRoots`): resolved through the context's table like any root, and answered by a
 *  resolver that speaks for that context itself — the stateless one included — where the call is,
 *  never by a call to the context. */
const IDENTITY_ROOTS: ReadonlySet<string> = new Set(["whoami", "url"]);

/** Does a call entering another context name one of that context's own roots — one that is neither
 *  portable nor more addressing (`cd`) nor loaded code with an authority (`workers`) nor who the
 *  context is (`IDENTITY_ROOTS`)? Then it runs there, and that context resolves it. */
function entersOwnRoot(call: ItxExpression): boolean {
  const root = itxExpressionStepName(withoutBuiltIns(call)[0]);
  return (
    !!root &&
    CONTEXT_ROOT_SET.has(root) &&
    root !== "cd" &&
    root !== "workers" &&
    !IDENTITY_ROOTS.has(root)
  );
}

/** A call's steps after `itx` and, when it is at the fixed point, after `builtins`. */
const withoutBuiltIns = (call: ItxExpression): ItxExpression =>
  isBuiltInsRooted(call) ? call.slice(2) : call.slice(1);

// ── THE ONE EVENT: build it, the caller appends it ──

/** Validate + normalize the payload of a LITERAL `events.iterate.com/itx/rewrite-rule-configured`
 *  event (the append boundary calls this — core-processor's `normalizeControlEvent`): the match is
 *  validated (rooted at `itx`, properties only, not `itx.builtins`, not a proxy verb) and canonicalized to
 *  a string; the target is validated (rooted at `itx`, whole-context override targets the physical
 *  spelling) and normalized to the PARSED array form BEFORE storage — a
 *  target may carry a whole facet source, which the reduce must never re-parse through the string
 *  codec (its 2 KiB cap). So call sites write `itx.append({ type, payload: { match, target } })`
 *  literally. A `null` target is the caller's deliberate MASK (deny); the platform-equivalent target
 *  with `ifTarget` is a compare-and-set removal (stream/core-processor.ts `CoreState.itxExpressionRewriteRules`). */
export function normalizeRewriteRuleConfigured(
  payload: RewriteRuleConfigured & { ifTarget?: ItxExpressionInput | null },
): {
  match: ItxExpression;
  target: ItxExpression | null;
  description?: string;
  declaration?: string;
  ifTarget?: ItxExpression | null;
} {
  const matchPrefix = parseItxExpressionPrefix(payload.match);
  const descriptionInput: unknown = payload.description;
  if (
    descriptionInput !== undefined &&
    (typeof descriptionInput !== "string" || descriptionInput.length > 500)
  )
    throw new Error("a rewrite rule's description is one line: a string of at most 500 chars");
  // oxlint-disable-next-line iterate/simple-truthiness-check -- the wire shape permits an explicit empty string after validation, distinct from a missing field.
  const description = typeof descriptionInput === "string" ? { description: descriptionInput } : {};
  const declarationInput: unknown = payload.declaration;
  if (
    declarationInput !== undefined &&
    (typeof declarationInput !== "string" || declarationInput.length > 16_384)
  )
    throw new Error("a rewrite rule's declaration is a string of at most 16384 chars");
  // oxlint-disable-next-line iterate/simple-truthiness-check -- the wire shape permits an explicit empty string after validation, distinct from a missing field.
  const declaration = typeof declarationInput === "string" ? { declaration: declarationInput } : {};
  if (matchPrefix[0] !== "itx")
    throw new Error(
      `a rewrite rule's match must be rooted at "itx" (every call starts there — ${JSON.stringify(print(matchPrefix))} could never match one)`,
    );
  if (matchPrefix.some(Array.isArray))
    throw new Error(
      `a rewrite rule's match is a dotted capability name, not a call (${JSON.stringify(print(matchPrefix))})`,
    );
  const firstName = itxExpressionStepName(matchPrefix[1]);
  if (firstName === "builtins")
    throw new Error(
      `a rewrite rule's match may not be rooted at "itx.builtins" — the reserved root is the fixed point every call rewrites TO, never a name a rule claims (${JSON.stringify(print(matchPrefix))})`,
    );
  if (firstName && PROXY_VERBS.includes(firstName))
    throw new Error(
      `a rewrite rule's match may not start with the proxy's own verb "${firstName}" (${PROXY_VERBS.join(", ")}): the dotted surface never hands those to the table, so the rule could fire from a string invoke but never from the sugar`,
    );
  // Stored as the PARSED form (a target may carry a whole source as data — never through the string
  // codec again); a string target is parsed once here, an array shape-checked in place.
  const targetExpression =
    // oxlint-disable-next-line iterate/simple-truthiness-check -- payload.target is `string | ItxExpression | null`; its null is the explicit mask sentinel (default-deny), distinct from a malformed empty-string target that normalization must still reject
    payload.target === null ? null : normalizedItxExpression(payload.target);
  if (targetExpression && targetExpression[0] !== "itx")
    throw new Error(
      `a rewrite rule's target must be rooted at "itx" (a bare built-in root is unspellable — targets resolve through the rules; the physical spelling is "itx.builtins.…")`,
    );
  const chars = targetExpression ? JSON.stringify(targetExpression).length : 0;
  if (chars > SOURCE_MAX_CHARS)
    throw codedError(
      "FACET_SOURCE_TOO_LARGE",
      `a rewrite rule's target is ${chars} chars, over the ${SOURCE_MAX_CHARS}-char ceiling — every context that resolves through this table reads it in a snapshot: load the source from a producer expression with a cacheKey`,
    );
  // The match is the PARSED prefix, never re-stringified: a target may carry a whole source as data,
  // and a canonical match can itself exceed the string codec's cap even when the input did not — the
  // reduce keys the table with `print` (no cap on printing), never a second parse.
  // `ifTarget` (a handle's compare-and-set undo) is normalized the SAME way as `target` — the reduce
  // jsonEquals it against the stored (parsed) target, so a string `ifTarget` must become the same
  // parsed shape here or the undo would silently never match. `null` is the mask sentinel, kept as-is.
  if (!("ifTarget" in payload))
    return { match: matchPrefix, target: targetExpression, ...description, ...declaration };
  // oxlint-disable-next-line iterate/simple-truthiness-check -- a PRESENT key with an undefined value (reachable over capnweb, never JSON) is malformed and refused loudly here; folding it into the null sentinel would silently turn a handle's undo into a mask-lift
  if (payload.ifTarget === undefined)
    throw new Error(
      "a rewrite rule's ifTarget is an itx expression or null (the mask sentinel), never undefined",
    );
  const ifTarget =
    // oxlint-disable-next-line iterate/simple-truthiness-check -- like `target` above: null is the explicit sentinel (compare against a masked, null-target row), distinct from a malformed empty-string ifTarget that normalization must still parse and reject
    payload.ifTarget === null ? null : normalizedItxExpression(payload.ifTarget);
  return { match: matchPrefix, target: targetExpression, ...description, ...declaration, ifTarget };
}

// ── WHICH WRITES WAIT OUT THE OLDER SNAPSHOTS (pure; context/rule-snapshots.ts says why) ──

/** DOES THIS CHANGE OF A CONTEXT'S TABLE WAIT OUT THE OLDER SNAPSHOTS? Yes when it removes or
 *  changes a name that already answered here — a row removed, masked, lifted or re-pointed, a new
 *  row shadowing a name that already resolved (`provide` of `itx.ai` on `/`), the bare null of a
 *  jail — so when it returns, no context resolves through the old table. No when it only adds a
 *  new name, which answers here at once and in every other context within SNAPSHOT_TTL_MS, and for
 *  a description alone. Over the tables before and after one commit, the roots with an implicit
 *  row here, and the names a pending fence took away (`namesTakenAway`): a name re-added while the
 *  fence of its removal is pending waits that fence out. */
export function rulesChangeNeedsCommitWait(
  before: Readonly<Record<string, ItxExpressionRewriteRule>>,
  after: Readonly<Record<string, ItxExpressionRewriteRule>>,
  implicitRoots: ReadonlySet<string>,
  takenAway: readonly ItxExpressionPrefix[] = [],
): boolean {
  if (before === after) return false;
  // a row removed, masked, lifted or re-pointed (a description alone changes nothing)
  const changed = Object.entries(before).some(
    ([key, old]) => !after[key] || !jsonEqual(old.target, after[key].target),
  );
  // A NEW row takes only what already answered here: a bare null takes every implicit row, a bare
  // link only names that answered nothing; any other row the calls its match claims. A new name
  // answers here at once, and in every other context within SNAPSHOT_TTL_MS.
  const rulesBefore = Object.values(before);
  return (
    changed ||
    Object.entries(after).some(
      ([key, next]) =>
        !before[key] &&
        (next.match.length === 1
          ? !next.target
          : !!fixedPointOf(() => rulesBefore, next.match, implicitRoots) ||
            takenAway.some((match) => matchItxExpressionPrefix(match, next.match))),
    )
  );
}

/** The names a change of a context's table took away that an older snapshot still answers: every
 *  row removed or re-pointed, but a mask (it answered nothing) and a row whose target lives in this
 *  context — not portable, not `cd`, not `workers` — which an older snapshot sends here, where the
 *  live table resolves it. */
export function namesTakenAway(
  before: Readonly<Record<string, ItxExpressionRewriteRule>>,
  after: Readonly<Record<string, ItxExpressionRewriteRule>>,
): ItxExpressionPrefix[] {
  return Object.entries(before)
    .filter(([key, old]) => {
      if (!old.target || jsonEqual(old.target, after[key]?.target)) return false;
      const root = isBuiltInsRooted(old.target) ? itxExpressionStepName(old.target[2]) : undefined;
      return !root || PORTABLE_ROOT_SET.has(root) || root === "cd" || root === "workers";
    })
    .map(([, old]) => old.match);
}

/** THE APP WALL, as one check over an expression loaded code hands in (the resolver's INPUT, or the
 *  TARGET of a row it appends), starting at the context `at` it runs at (where a row lands): never
 *  the fixed point, and a webhook's `signingSecret` only at the project's root, `cd` steps resolved
 *  on the way. A `cd` goes anywhere in the project, with every verb: the project is the boundary,
 *  and a jail's bare null the only one inside it, which a hop into it resolves through. A spec's
 *  PRODUCER — a source expression with its `cacheKey` in a call's arguments (`workers.get`,
 *  `facets.get`, `processors.enable`) — is walled too, at the context the walk has reached, so the
 *  call fails where it is made; the producer also runs there as loaded code when the code loads (the
 *  DO's `invoke`).
 *  A source expression with no `cacheKey` is a worker's NAME (iterate/api `FacetSpec`): it may name
 *  a worker anywhere in the project, and only reads rules (`admitWorkerName`) — the worker it names
 *  loads with the authority of the context whose rule that is, and the facet it hosts speaks for its
 *  own context. Codec-style — nothing here is policy: the rows a call rewrites through are the
 *  owner's and are never checked. */
function admitLoadedCodeExpression(expression: ItxExpression, from: string): void {
  let at = from; // what the next relative `cd` resolves against
  for (const step of expression) {
    const name = typeof step === "string" ? step : step[0];
    if (name === "builtins")
      throw codedError(
        "FORBIDDEN",
        `"itx.builtins" is not a loaded worker's word — this context's rows say what its code may spell (${JSON.stringify(print(expression))})`,
      );
    if (Array.isArray(step))
      for (const arg of step.slice(1)) {
        // A webhook's signing secret is the PROJECT's: a receiver that verifies a signature trusts
        // the event as the whole project's, so only a call at the project's root names one.
        if (at !== "/" && namesASigningSecret(arg))
          throw codedError(
            "FORBIDDEN",
            `a webhook's signing secret is named only at the project's root, and ${JSON.stringify(at)} is below it`,
          );
        if (isSourceSpec(arg)) {
          const sourceExpression = normalizedItxExpression(arg.source);
          if (namesAWorker(arg)) admitWorkerName(sourceExpression);
          else admitLoadedCodeExpression(sourceExpression, at);
        }
      }
    if (Array.isArray(step) && step[0] === "cd" && typeof step[1] === "string")
      at = resolveContextPath(at, step[1]);
  }
}

/** What a `workers.get` or facet spec carries that decides whether it names a worker. */
type WorkerSpecShape = { source?: unknown; cacheKey?: unknown };

/** Whether a call's argument is a webhook's spec naming its signing secret (iterate/api
 *  `webhooks.get`), which only a call at the project's root may do. */
const namesASigningSecret = (arg: unknown): boolean =>
  typeof arg === "object" && !!arg && "signingSecret" in arg;

/** Whether a call's argument is a spec with a source expression — `workers.get`, `facets.get`,
 *  `processors.enable` — whose source the app wall walks: a worker's name, or a producer. */
const isSourceSpec = (arg: unknown): arg is WorkerSpecShape & { source: ItxExpressionInput } =>
  typeof arg === "object" &&
  !!arg &&
  "source" in arg &&
  (typeof arg.source === "string" || Array.isArray(arg.source));

/** Whether a `workers.get` or facet spec NAMES a worker (iterate/api `FacetSpec`): a source
 *  expression with no cacheKey — an empty one is none — which only reads rules (`admitWorkerName`);
 *  anything else is code, a producer walled as the loaded code it is. The wall and every host read a
 *  spec by this alone. */
export const namesAWorker = <Spec extends WorkerSpecShape>(
  spec: Spec,
): spec is Spec & { source: ItxExpressionInput } =>
  !spec.cacheKey && (typeof spec.source === "string" || Array.isArray(spec.source));

/** A WORKER'S NAME (a source expression with no `cacheKey`, iterate/api `FacetSpec`) only READS
 *  RULES: property steps and `cd(path)`, never `builtins` and never another call. So the worker it
 *  names, and the context whose authority its producer runs with, are what a rule says — never what
 *  the name spells: `itx.cd('/').workers.get({ source, cacheKey })` is a producer at `/`, not a
 *  name. Whoever wrote the spec. */
function admitWorkerName(name: ItxExpression): void {
  for (const step of name.slice(1)) {
    const readsRules =
      typeof step === "string"
        ? step !== "builtins"
        : step[0] === "cd" && step.length === 2 && typeof step[1] === "string";
    if (!readsRules)
      throw codedError(
        "FORBIDDEN",
        `a worker's name only reads rules — property steps and cd(path) — and ${JSON.stringify(print(name))} does more: give a source you produce its cacheKey`,
      );
  }
}

/** THE APP WALL ON A ROW: a rewrite rule or a subscription loaded code appends is walled on its
 *  TARGET like a call is on its input, as it will resolve where it lands (`landsAt`) — else a jail
 *  granted `itx.append` would write itself `itx.x ⇒ itx.builtins.cd('/').x`, and a subscription
 *  target runs as the kernel. The one fixed-point target it may write is its OWN lend,
 *  `itx.builtins.rpcStubs.get(<key>)`: the registry is this context's, so the row grants nothing the
 *  code does not already hold. A `null` (a mask, an un-set) says nothing and passes. Nothing gets
 *  round the wall:
 *    • a REMOVAL (`ifTarget`, the reduce's compare-and-set delete) is refused: it hands the name back
 *      to what lies beneath it, a jail's bare null or a parent link. Loaded code never needs one:
 *      `provide` lends it live stubs only, whose rows the DO removes when the last pager closes;
 *    • a SCHEDULED batch (`schedule-set`) is walled event by event as it is scheduled: the alarm
 *      appends it later as the kernel.
 *  A jail's own null is the append boundary's (`refuseLiftingAJail`). Any other event passes
 *  untouched. */
export function admitLoadedCodeRow(
  event: { type: string; payload?: unknown },
  landsAt: string,
): void {
  if (event.type === "events.iterate.com/itx/schedule-set") {
    for (const occurrence of ScheduledAppendInput.parse(event.payload).events)
      admitLoadedCodeRow(occurrence, landsAt);
    return;
  }
  if (
    event.type !== "events.iterate.com/itx/rewrite-rule-configured" &&
    event.type !== "events.iterate.com/itx/subscription-configured"
  )
    return;
  // Wire-fed: each field is `unknown` here and checked where it is read; the codec parses the rest.
  const payload = event.payload as { target?: unknown } | undefined;
  if (
    event.type === "events.iterate.com/itx/rewrite-rule-configured" &&
    payload &&
    Object.hasOwn(payload, "ifTarget")
  )
    throw codedError(
      "FORBIDDEN",
      "loaded code removes no row (`ifTarget`): the name would answer from beneath it again — write `target: null` to mask it",
    );
  const target = payload?.target;
  if (!target) return; // a mask, an un-set (an empty string is the reduce's refusal, not this wall's)
  if (typeof target !== "string" && !Array.isArray(target)) return; // a live object: the lend's own business
  const expression = normalizedItxExpression(target as ItxExpressionInput);
  const [, root, registry, lend] = expression;
  if (root === "builtins" && registry === "rpcStubs" && Array.isArray(lend) && lend[0] === "get")
    return;
  admitLoadedCodeExpression(expression, landsAt);
}

/** A JAIL IS LIFTED ONLY BY A PERSON. While a context's table holds its bare `itx ⇒ null`, a row that
 *  re-points or removes it lands only from a member's session (a principal). Never from loaded code,
 *  however it got there: its own `itx.append` granted beside the null, a lend's row (which goes with
 *  its last pager, and the null with it), a sibling appending into a jail open inward. Never from the
 *  kernel's own writes either: a schedule's occurrence or a subscription whose target appends a row,
 *  whenever it was set up. Either would bring the context roots back, `cd` among them, and with it
 *  the whole project. Runs at the append boundary on the normalized batch (iterate-context-durable-
 *  object.ts `#appendAndRunCommittedEffects`). */
export function refuseLiftingAJail(
  events: readonly StreamEventInput[],
  rules: Readonly<Record<string, ItxExpressionRewriteRule>>,
  caller: Caller,
): void {
  if (caller.principal || !rules.itx || rules.itx.target) return;
  for (const event of events) {
    if (event.type !== "events.iterate.com/itx/rewrite-rule-configured") continue;
    // Normalized at the append boundary (`normalizeRewriteRuleConfigured`): the match is the parsed
    // prefix, the target the parsed expression or null.
    const payload = event.payload as { match: ItxExpressionPrefix; target: ItxExpression | null };
    if (payload.match.length === 1 && (payload.target || Object.hasOwn(payload, "ifTarget")))
      throw codedError(
        "FORBIDDEN",
        "this context is a jail (a bare `itx ⇒ null`): only a member's session re-points or removes it, never code",
      );
  }
}

/** A bare `itx` row whose target is `cd` of THIS context is a loop no depth budget can see — every
 *  hop is a fresh resolve — so the append boundary refuses it against the path the row lands on
 *  (core-processor.ts `normalizeControlEvent`), whichever caller appends: `provide`, a script's
 *  `itx.append`, a sibling's `cd(path).append`, a schedule's batch, a pager attach. Two contexts
 *  pointing at each other is never created (library.ts `entityRoot`: a context creates only
 *  beneath itself, so the link it writes points up); rows written by hand can still spell it, a
 *  trusted-client misconfiguration. Runs on the normalized row: the match and target parsed once. */
export function refuseSelfLoopRow(
  row: { match: ItxExpression; target: ItxExpression | null },
  ownPath: string,
): void {
  if (row.match.length !== 1 || !row.target) return;
  const cdStep = row.target[1] === "builtins" ? row.target[2] : row.target[1];
  if (!Array.isArray(cdStep) || cdStep[0] !== "cd" || typeof cdStep[1] !== "string") return;
  if (resolveContextPath(ownPath, cdStep[1]) === ownPath)
    throw new Error(
      `a bare itx row may not name its own context: "itx ⇒ ${print(row.target)}" at ${JSON.stringify(ownPath)} would route every call back to itself`,
    );
}

/** The `get` step of a RESOLVED target that addresses a registry's entry —
 *  `itx.builtins.<registry>.get(name, …)`: `[1]` is the name, `[2]` a hosting spec when one rides
 *  it. Undefined when the target is anything else. */
export function builtInsGetStep(
  resolved: ItxExpression,
  registry: "facets" | "rpcStubs",
): [method: "get", name: string, ...args: unknown[]] | undefined {
  const getStep = resolved[3];
  return resolved[1] === "builtins" &&
    resolved[2] === registry &&
    Array.isArray(getStep) &&
    getStep[0] === "get" &&
    typeof getStep[1] === "string"
    ? // the checks above are exactly this tuple's shape; a call step's args are `unknown[]`
      (getStep as [method: "get", name: string, ...args: unknown[]])
    : undefined;
}

// ── THE TABLE, DESCRIBED (pure; the DO hands it the rows and the hop) ──

/** THE EFFECTIVE table as `rewriteRules.list()` shows it — the tree this context can spell: its own
 *  rows (a mask as `target: null`, each with the description and optional declaration its event
 *  carried); the implicit rows HERE not shadowed by an own `itx.<root>` row, each with the platform's
 *  one-liner — `itx.ai`, for example, declares `IterateContextApi["ai"]`; an absent declaration is
 *  unknown. None appear under a bare null, which denies all; and, behind a bare row that hops
 *  (`itx ⇒ itx.builtins.cd(path)`), THAT context's list (`inherit(path, depth - 1)`) minus what this
 *  one's rows claim, every row keeping the `context` it was read from — a bare `itx ⇒ itx.builtins`
 *  lists every root as local. `depth` bounds the hops; a hop to `path` itself is none. */
export async function describeRewriteRules(args: {
  rules: readonly ItxExpressionRewriteRule[];
  /** The roots with an implicit row HERE (`implicitRootsAt`). */
  implicitRoots: ReadonlySet<string>;
  /** This context's canonical path — the `context` of its own rows, the base of the hop. */
  path: string;
  depth: number;
  /** The context at `path`'s own list, `depth` hops deep. */
  inherit: (path: string, depth: number) => Promise<RewriteRuleListEntry[]>;
}): Promise<RewriteRuleListEntry[]> {
  const { rules, implicitRoots, path: ownPath, depth } = args;
  const own = rules.map((rule): RewriteRuleListEntry => ({
    match: print(rule.match),
    target: rule.target && print(rule.target),
    description: rule.description,
    declaration: rule.declaration,
    context: ownPath,
  }));
  const claimed = new Set(own.map((row) => row.match));
  // `roots` is `implicitRoots` (`implicitRootsAt`: a subset of `BUILT_IN_ROOTS`) or the target of a
  // bare `itx ⇒ itx.builtins` (every root), so each one indexes the description map; the sets are
  // typed `string` because the resolver compares them against parsed step names, hence the assertion.
  const implicit = (roots: Iterable<string>): RewriteRuleListEntry[] =>
    [...roots]
      .filter((root) => !claimed.has(`itx.${root}`))
      .map((root) => ({
        match: `itx.${root}`,
        target: `itx.builtins.${root}`,
        description: BUILT_IN_ROOT_DESCRIPTIONS[root as BuiltInRoot],
        declaration: `IterateContextApi[${JSON.stringify(root)}]`,
        context: ownPath,
      }));
  const bare = rules.find((rule) => rule.match.length === 1);
  if (bare && !bare.target) return own; // one row denies all: nothing implicit, nothing inherited
  const rows = [...own, ...implicit(implicitRoots)];
  if (!bare?.target) return rows;
  // Resolve app-owned parent links through the same rules as invocation.
  let target: ItxExpression;
  try {
    target = resolveItxExpression(() => rules, bare.target, args.implicitRoots).at(-1)!;
  } catch (error) {
    if (errorCode(error) === "NO_ITX_EXPRESSION_MATCH") return rows;
    throw error;
  }
  if (target.length === 2 && target[1] === "builtins")
    return [...rows, ...implicit(BUILT_IN_ROOTS.filter((root) => !implicitRoots.has(root)))];
  const cdStep = target[2];
  if (
    depth <= 0 ||
    target.length !== 3 ||
    target[1] !== "builtins" ||
    !Array.isArray(cdStep) ||
    cdStep[0] !== "cd" ||
    typeof cdStep[1] !== "string"
  )
    return rows;
  const there = resolveContextPath(ownPath, cdStep[1]);
  if (there === ownPath) return rows;
  // An inherited row is shown iff a call spelled like it would reach that context — the resolver's
  // own law (`resolveItxExpression`): the most specific own row claiming the spelling is the link
  // itself, and the link yields to no implicit row here (a mask at `itx.ai` refuses
  // `itx.ai.run('gpt-5')`; a child's `itx.append` stays its own). The bare row of the context
  // behind the link is that context's link, never this one's.
  const forwarded = (spelling: string): boolean => {
    if (spelling === "itx") return false;
    let call: ItxExpression;
    try {
      call = parse(spelling);
    } catch {
      return false; // a spelling over the string codec's cap: not a name a call here can spell
    }
    const root = itxExpressionStepName(call[1]);
    if (root && implicitRoots.has(root)) return false;
    return pickItxExpressionRewriteRule(rules, call)?.rule === bare;
  };
  const inherited = await args.inherit(there, depth - 1);
  return [...rows, ...inherited.filter((row) => forwarded(row.match))];
}

// ── THE RESOLVER (parent-constructed over the physical built-ins and a reader of the CURRENT rules) ──

/** A resolver's reach beyond its own context (context/stateless-context.ts `contextReach`): its
 *  project, another context's table as this isolate holds it (context/rule-snapshots.ts), ONE call
 *  to the context at `path` where it lives (built-ins.ts `callContext`), and `itx.workers` with the
 *  authority of the context at `path` (built-ins.ts `workersRoot`), for a call `caller` makes that
 *  crossed `hops` contexts to get there; and where an act one of its calls was refused past the loop
 *  limit is recorded: the chain's one fact at the resolver's own context (cause.ts). */
export type ResolverReach = {
  projectId: string;
  recordLoopLimit: (path: string, cause: Cause, message: string) => void;
  snapshotOf: (path: string) => Promise<Pick<RuleSnapshot, "rules" | "expiresAt">>;
  located: (
    path: string,
    expression: ItxExpression,
    args: unknown[],
    caller: Caller,
  ) => Promise<unknown>;
  workersOf: (path: string, caller: Caller, hops: number) => unknown;
};

export class ItxExpressionResolver {
  /** The built-ins: a plain record whose keys (kv, append, readEvents, cd, …) are the physical-layer
   *  roots — `itx.builtins.<root>` reaches them directly; `itx.<root>` reaches them through an implicit
   *  row where one exists (`implicitRootsAt`) unless the context's table says otherwise. */
  readonly #builtIns: Record<string, unknown>;
  readonly #rewriteRules: (() => readonly ItxExpressionRewriteRule[]) | undefined;
  readonly #path: string;
  readonly #caller: () => Caller;
  readonly #reach: ResolverReach;

  constructor(args: {
    builtIns: Record<string, unknown>;
    /** This context's own table, read live — absent for the stateless entrypoint, which resolves
     *  through its snapshot (context/rule-snapshots.ts). */
    rewriteRules?: () => readonly ItxExpressionRewriteRule[];
    /** This context's canonical path: where loaded code's relative `cd` starts. */
    path: string;
    /** WHO is calling right now — the DO's ambient caller. */
    caller: () => Caller;
    reach: ResolverReach;
  }) {
    this.#builtIns = args.builtIns;
    this.#rewriteRules = args.rewriteRules;
    this.#path = args.path;
    this.#caller = args.caller;
    this.#reach = args.reach;
  }

  /** THE APP WALL (`admitLoadedCodeExpression`): loaded code hands in short names and never the
   *  fixed point. Its `cd` goes anywhere in the project, every verb after it: the destination
   *  resolves the rest through its own table, so a jail's bare null refuses it there, and the stamp
   *  says who called (src/caller.ts `stampCaller`). On the INPUT only: the rows a call rewrites
   *  through are the owner's grants and are never checked. Codec-style, kin to the reserved names
   *  `parse` refuses — nothing here is policy. */
  #admit(expression: ItxExpression): void {
    const caller = this.#caller();
    // Only a trusted cd hop stamps path, after the whole input expression passed this check.
    // The remaining expression now includes the owner's rewrites (e.g. the agent's sandbox
    // redirect to builtins.run), not just loaded code's words. Keep app for row admission and
    // attribution, but don't reject the owner's grant again at its destination.
    if (caller.app && !caller.path) admitLoadedCodeExpression(expression, this.#path);
  }

  /** PURE: the chain of rewrites from `call` to the builtins-rooted call that would run through
   *  THIS context's own table (`resolveItxExpression`, after the app wall) — a `cd` ends it.
   *  Nothing is dispatched. */
  resolve(call: ItxExpressionInput): ItxExpression[] {
    if (!this.#rewriteRules) throw new Error("a stateless resolver has no table of its own");
    const expression = normalizedItxExpression(call);
    this.#admit(expression);
    return resolveItxExpression(
      this.#rewriteRules,
      expression,
      implicitRootsAt(this.#reach.projectId, this.#path),
    );
  }

  /** Resolve + run one call — THE ROUTING CONTRACT, a context's Durable Object's and the stateless
   *  entrypoint's alike. A call that crosses a `cd` keeps resolving with the next context's table
   *  (`#route`) instead of being forwarded there, so no context sits on the path of another's
   *  traffic, and where the chain ends decides where the call runs:
   *    • a PORTABLE root (`PORTABLE_ROOTS`) runs here: in the calling context, or the stateless
   *      entrypoint (context/stateless-context.ts);
   *    • `workers.get` loads here, with the authority of the context whose rule named it;
   *    • anything else lives in a context — its log, facets, lent stubs, processors, secrets — and
   *      is ONE call there, which resolves it again with its live table.
   *  How fresh the tables it resolves through are is context/rule-snapshots.ts's contract.
   *  Runtime `extraArgs` are LIVE args (a Request, a callback — not
   *  expression data; an `x-itx-expression` fetch and the public `invoke(call, ...args)` hand them
   *  in): when the call ends in a NAME they are folded into it before resolving —
   *  `invoke("itx.kv.get", "k")` is `itx.kv.get("k")`; when it ends in a call they apply to the value
   *  the expression denotes. */
  async invoke(call: ItxExpressionInput, ...extraArgs: unknown[]): Promise<unknown> {
    try {
      return (await this.#dispatch(call, extraArgs)).value;
    } catch (error) {
      recordRefusal(error, (cause, message) =>
        this.#reach.recordLoopLimit(this.#path, cause, message),
      );
      throw error;
    }
  }

  /** The delivery loop's evaluation of a row's target (subscription-delivery.ts): `invoke`, how
   *  long its answer may be reused — until the first snapshot it read expires — and where it
   *  resolved (`routedTo`: the context and the call that ran there), which moves when a rule
   *  re-points what the target names. */
  async evaluate(
    call: ItxExpression,
  ): Promise<{ value: unknown; validUntil: number; routedTo: string }> {
    const { value, validUntil, route } = await this.#dispatch(call, []);
    const ran = route.kind === "located" ? route.expression : route.fixedPoint;
    return { value, validUntil, routedTo: JSON.stringify([route.at, ran]) };
  }

  /** THE WORKER A NAME PUBLISHES, not loaded: `name` (`admitWorkerName`: it only reads rules)
   *  routed as `invoke` would route it, to a RULE of the context `at` whose target is exactly
   *  `itx.builtins.workers.get(spec)` — the spec, that context (the authority its producer runs
   *  with), whether that rule is the config pointer, which the platform alone writes (`vouched`:
   *  only then does its manifest count, caller.ts `isConfigPointerMatch`) and how long the answer
   *  stands. A facet whose source is a worker's name loads from it
   *  (context/facet-host.ts). A name that ends anywhere else names no worker:
   *  NO_ITX_EXPRESSION_MATCH. */
  async namedWorker(
    call: ItxExpressionInput,
  ): Promise<{ at: string; spec: unknown; vouched: boolean; validUntil: number }> {
    const name = normalizedItxExpression(call);
    admitWorkerName(name);
    const { route, rules, validUntil } = await this.#route(name, []);
    const getStep = route.kind === "walked" ? route.fixedPoint[3] : undefined;
    const publishing =
      route.kind === "walked"
        ? rules.filter(
            (rule) =>
              !!rule.target &&
              jsonEqual(withoutBuiltIns(rule.target), withoutBuiltIns(route.fixedPoint)),
          )
        : [];
    if (
      route.kind !== "walked" ||
      route.fixedPoint.length !== 4 ||
      route.fixedPoint[2] !== "workers" ||
      !Array.isArray(getStep) ||
      getStep[0] !== "get" ||
      publishing.length === 0
    )
      throw codedError(
        "NO_ITX_EXPRESSION_MATCH",
        `${JSON.stringify(print(name))} names no worker: no rule it resolves through is itx.builtins.workers.get(spec)`,
      );
    return {
      at: route.at,
      spec: getStep[1],
      vouched: publishing.some((rule) => isConfigPointerMatch(rule.match)),
      validUntil,
    };
  }

  /** A route runs only while every snapshot it was assembled from lasts — one may expire while the
   *  next is read: it is resolved again, a bounded number of times, then UNAVAILABLE. */
  async #dispatch(call: ItxExpressionInput, extraArgs: unknown[]) {
    for (let routes = 0; routes < SNAPSHOT_REREADS; routes++) {
      const { route, validUntil } = await this.#route(call, extraArgs);
      if (Date.now() >= validUntil) continue;
      const value =
        route.kind === "located"
          ? await this.#reach.located(route.at, route.expression, route.extraArgs, route.caller)
          : await this.#walk(route.builtIns, route.fixedPoint, route.extraArgs);
      return { value, validUntil, route };
    }
    throw unavailableError(
      "overloaded",
      `${JSON.stringify(print(normalizedItxExpression(call)))}: the rule snapshots it resolves through expired ${SNAPSHOT_REREADS} times before it could run`,
    );
  }

  /** THE ONE DISPATCH BOUNDARY (`invoke` has the contract): the call folded and ADMITTED here,
   *  whole, as its caller made it (`#admit`), then resolved through every context its chain crosses
   *  without calling any of them — this context's own table live where it has one, and, where the
   *  chain meets `itx.builtins.cd(P)…`, P's snapshot with P's implicit rows. A relative `cd` means
   *  the caller's origin. The walk ends at the fixed point of one context's table, or early where a
   *  call enters a context without a live table here naming one of that context's own roots
   *  (`entersOwnRoot`): that context resolves it, so its snapshot is not read. A refusal a snapshot
   *  gives stands until the snapshot expires — except this context's own, decided live. A LOCATED
   *  call carries the caller stamped with where it came from (`Caller.path`), the trusted mark that
   *  its input was admitted here, so the context it lands in resolves it live and walls it no
   *  more. */
  async #route(call: ItxExpressionInput, extraArgs: unknown[]) {
    let expression = normalizedItxExpression(call);
    const last = expression.at(-1);
    if (extraArgs.length > 0 && typeof last === "string" && expression.length > 1) {
      expression = [...expression.slice(0, -1), [last, ...extraArgs]];
      extraArgs = [];
    }
    this.#admit(expression);
    const caller = this.#caller();
    const origin = caller.path || this.#path;
    const walked = (builtIns: Record<string, unknown>, fixedPoint: ItxExpression, at: string) =>
      ({ kind: "walked", builtIns, fixedPoint, extraArgs, at }) as const;
    const located = (there: string, target: ItxExpression, callerThere: Caller) =>
      ({ kind: "located", at: there, expression: target, extraArgs, caller: callerThere }) as const;
    const own = () => located(this.#path, expression, caller);
    let validUntil = Infinity;
    let at = this.#path;
    let entered = expression;
    // THE HOP COUNT (cause.ts): every context this call crosses, carried on to where it lands.
    let cause = caller.cause || newChain("a call");
    for (let hops = 0; ; hops++) {
      const liveRules = at === this.#path ? this.#rewriteRules : undefined;
      let fixedPoint: ItxExpression = ["itx", "builtins", ...withoutBuiltIns(entered)];
      // The table this hop resolved through (`namedWorker` reads the rule its worker came from).
      let rules: readonly ItxExpressionRewriteRule[] = [];
      if (liveRules || !entersOwnRoot(entered)) {
        if (liveRules) rules = liveRules();
        else if (!isBuiltInsRooted(entered)) {
          const snapshot = await this.#reach.snapshotOf(at);
          validUntil = Math.min(validUntil, snapshot.expiresAt);
          rules = snapshot.rules;
        }
        try {
          fixedPoint = resolveItxExpression(
            () => rules,
            entered,
            implicitRootsAt(this.#reach.projectId, at),
          ).at(-1)!;
        } catch (error) {
          if (errorCode(error) !== "NO_ITX_EXPRESSION_MATCH") throw error;
          if (hops === 0 && !liveRules) return { route: own(), validUntil, rules };
          // A refusal the snapshots gave stands only as long as they do (subscription-delivery.ts
          // evaluates a dangling row once more then). A refusal of the config pointer, which only a
          // publication writes, says the project has published no config: the config birth row
          // passes its event over.
          if (hops > 0 && error instanceof Error)
            Object.assign(error, {
              validUntil,
              ...(isConfigPointerMatch(entered) && { unpublishedConfig: true }),
            });
          throw error;
        }
        const cdStep = fixedPoint[2];
        if (fixedPoint.length > 3 && Array.isArray(cdStep) && cdStep[0] === "cd") {
          if (this.#reach.projectId === GLOBAL_PROJECT_ID)
            throw codedError(
              "FORBIDDEN",
              "a global context is reached by identity (session.user, session.organizations), never by path",
            );
          if (typeof cdStep[1] !== "string")
            throw codedError("INVALID_INPUT", `cd takes a path, got ${JSON.stringify(cdStep[1])}`);
          at = resolveContextPath(origin, cdStep[1]);
          entered = ["itx", ...fixedPoint.slice(3)];
          cause = crossingOneMore(cause, JSON.stringify(print(expression)));
          continue;
        }
      }
      const root = itxExpressionStepName(fixedPoint[2]) || "";
      const portable = PORTABLE_ROOT_SET.has(root);
      const ownIdentity =
        IDENTITY_ROOTS.has(root) && at === this.#path && Object.hasOwn(this.#builtIns, root);
      // A worker runs under the hops the call made to reach it, its own `cd`s back here included.
      const route =
        root === "workers" && !(liveRules && hops === 0)
          ? walked({ workers: this.#reach.workersOf(at, caller, hops) }, fixedPoint, at)
          : liveRules ||
              (portable && Object.hasOwn(this.#builtIns, root)) ||
              root === "cd" ||
              ownIdentity
            ? walked(this.#builtIns, fixedPoint, at)
            : hops > 0 && !portable
              ? located(at, entered, { ...caller, path: origin, cause })
              : own();
      return { route, validUntil, rules };
    }
  }

  /** Walk a fixed point `itx.builtins.<root>…` against `builtIns`. What the walk steps PAST that
   *  holds a Workers-RPC session — the collection stub a facet answered `repos()` with, walked on for
   *  `.list()`; a loaded worker's `make()` walked on for `.ping()` — is this actor's to release once
   *  the answer is in: kept, it would hold the facet or the worker, and so this actor, open until
   *  the next deploy. The answer itself is the caller's — unless it REJECTS (that collection
   *  refusing a `delete`): then nobody else holds it, and it is released here. */
  async #walk(
    builtIns: Record<string, unknown>,
    fixedPoint: ItxExpression,
    extraArgs: unknown[],
  ): Promise<unknown> {
    const rootName = itxExpressionStepName(fixedPoint[2]);
    const roots = () => Object.keys(builtIns).join(", ");
    if (!rootName)
      throw new Error(
        `"itx.builtins" names the reserved root — name a built-in under it (${roots()})`,
      );
    if (!Object.hasOwn(builtIns, rootName))
      throw codedError(
        "NO_ITX_EXPRESSION_MATCH",
        `no built-in ${JSON.stringify(rootName)} under itx.builtins (${roots()})`,
      );
    const rpcSessionsSteppedPast: unknown[] = [];
    try {
      const { value, receiver } = await walkSteps(
        { value: builtIns, receiver: undefined },
        fixedPoint.slice(2),
        rpcSessionsSteppedPast,
      );
      return extraArgs.length > 0
        ? await callOn(value, receiver, extraArgs)
        : await awaitAnswerReleasedIfRejected(value);
    } finally {
      releaseRpcSessions(rpcSessionsSteppedPast);
    }
  }
}
