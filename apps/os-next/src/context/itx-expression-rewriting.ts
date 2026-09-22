import { errorCode } from "iterate/next/lib";
// context/itx-expression-rewriting.ts — HOW A CALL FINDS ITS TARGET, pure and total. An itx-expression
// REWRITE RULE is `{ match, target }`: a call that starts with `match` runs as the same call with
// `match` replaced by `target`. Rewriting repeats until the call is rooted at THE RESERVED ROOT,
// `itx.builtins` — the physical scope (kv, whoami, rpcStubs, facets, …; context/built-ins.ts) — and
// that call is what actually runs (expression.ts's `walkSteps` walks it). The rules THEMSELVES are `core` state —
// stream/core-processor.ts reduces `itx/rewrite-rule-configured` into `state.itxExpressionRewriteRules`,
// a MAP by canonical match (set replaces; `null` MASKS a name that has a platform row beneath it and
// deletes any other). This module is the rules of matching, the ONE event that writes the table, and
// the resolver that reads it. Every matching rule is one table row in itx-expression-rewriting.test.ts.
//   built-in roots — `BUILT_IN_ROOT_DESCRIPTIONS`: THE RESERVED ROOT'S KEYS, each described once
//
// THE RULES live on the code they govern — read the docstrings, and the table in
// itx-expression-rewriting.test.ts: matching and rewriting (`resolveItxExpression`: the most specific
// row of THIS context's table wins, the fixed point `itx.builtins` ends the chain, a bare `itx` row
// with a target yields to the implicit rows and a bare `null` denies all), the implicit rows
// (`implicitRootsAt`), the door every row passes at the append boundary
// (`normalizeRewriteRuleConfigured`), `@` as the caller's input (expression.ts), the app wall on a
// loaded worker's calls and rows (`admitLoadedCodeExpression`, `admitLoadedCodeRow`), and un-setting
// — a `null` kept as a mask only where something beneath would answer, `ifTarget` as a compare-and-set
// delete (stream/core-processor.ts `CoreState.itxExpressionRewriteRules`).
//
// THE PLATFORM'S OWN SPELLINGS ARE ROOTED AT `itx.builtins`: every target it writes — a lent stub's
// rule (`match ⇒ itx.builtins.rpcStubs.get('<match>')`), a processor's row
// (`itx.builtins.facets.get(name, spec).processEventBatch`), a parent link, the sandbox rows — and
// its own log plumbing (the runner's request and wait, library.ts), so a user's row at `itx.facets`
// or `itx.rpcStubs` redirects the user's calls and nothing else. A hosted processor's ENGINE speaks
// the context roots (`append`, `readEvents`, `processors.claim` — implicit everywhere, sdk/index.ts):
// a loaded processor may not spell the fixed point, and a row at a context root is the owner's
// deliberate wall. A LENT RPC
// STUB is no exception: `itx.provide(match, stub)` lends the stub to the `itx.builtins.rpcStubs`
// registry (physical) under the key = the canonical match and configures that pure-data rule — the log
// records the rule, never the socket. AT REST (`normalizeRewriteRuleConfigured`, below): the event stores
// the match as its canonical STRING (the table's key) and the target in the PARSED form; the core
// reduce parses the match once and takes the target as it is.

import type { Caller } from "iterate/next/principal";
import { codedError, jsonEqual, resolveContextPath } from "iterate/next/lib";
import type { RewriteRuleConfigured, RewriteRuleListEntry } from "iterate/next/api";
import {
  callOn,
  InvokeHandle,
  walkSteps,
  normalizedItxExpression,
  containsItxExpressionHole,
  isItxExpressionHole,
  ITX_EXPRESSION_MERGE_KEY,
  itxExpressionStepName,
  parse,
  parseItxExpressionPrefix,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionPrefix,
} from "iterate/next/expression";
import { GLOBAL_PROJECT_ID } from "./paths.ts";

// ── built-in roots ── THE RESERVED ROOT'S KEYS, each with the one line `rewriteRules.list()` says
// for its implicit row (what a model reads for it). `itx.builtins.<root>` is the physical scope
// (context/built-ins.ts `BuiltInScope`), and every short name `itx.<root>` is the IMPLICIT ROW
// `itx.<root> ⇒ itx.builtins.<root>` where the root is implicit (`implicitRootsAt`, below). The
// record stands apart from the scope on purpose: the core reduce and the DO's `list()` read it, and
// neither may import the scope itself (it closes over bindings and the loader). built-ins.ts asserts,
// at the type level, that these keys and `keyof BuiltInScope` are the same set.
export const BUILT_IN_ROOT_DESCRIPTIONS = {
  whoami: "who this context is: `itx.whoami()` → { projectId, path }",
  url: "this project's public URL over HTTP — the apex or an app's, at a path: `url({ app?, path? })`; only from a session that reached the platform on an origin",
  kv: "key-value strings, the project's own: `kv.get(k)` · `kv.put(k, v)` · `kv.list(prefix)` · `kv.delete(k)`",
  secrets:
    'names only, never values: `secrets.list()`; a `getSecret("/secrets/x")` placeholder in an outbound request is substituted at egress; `secrets.verifyHmac(path, { payload, signature })` checks a webhook\'s HMAC-SHA256 hex signature without revealing the secret',
  ai: "Workers AI, verbatim: `ai.run(model, inputs)`",
  browser: 'browser rendering: `browser.quickAction("markdown", { url })`',
  r2: "the object store, verbatim (`files` is the friendlier surface)",
  cfArtifacts: "the Artifacts binding, project-scoped (`repos` is the friendlier surface)",
  append: "write events to this log: `itx.append({ type, payload })`",
  schedules:
    "durable future appends: `schedules.set({ key, when, events })` · `schedules.cancel(key)`",
  readEvents: "read this log: `(await itx.readEvents(afterOffset, limit)).events`",
  waitForEvent: "block until an event lands: `waitForEvent({ type, afterOffset, timeoutMs })`",
  cd: "a context below this one: `itx.cd('./sandbox')`",
  fetch: "the internet through the project's egress: `itx.fetch(new Request(url))`",
  rpcStubs: "live values clients lent here: `rpcStubs.list()` · `rpcStubs.get(key)`",
  rewriteRules: "this table, described: `await rewriteRules.list()`",
  facets: "a durable facet hosted here: `facets.get(name)`",
  subscriptions: "the rows delivered each commit: `subscriptions.list()`",
  processors: "hosted processors: `processors.enable(name, spec)` · `list()` · `disable(name)`",
  workers: "load code as a stateless worker: `workers.get({ source }).run()`",
  run: 'a fresh confined run of a script you write as text: `itx.run("async (itx) => …")`',
  connectToMcp:
    "a live MCP handle: `(await itx.connectToMcp(url)).listTools()`, one method per tool",
  connectToOpenApi:
    "a live OpenAPI handle: one method per operationId, `call(operationId, input)` too",
  connectToCapnweb: "a live capnweb handle: `itx.connectToCapnweb(url)`, dotted calls pipelined",
  repos:
    "git on Artifacts; `/repos/config` is the project's code: `repos.get(path).readFile(f)` · `commitFiles({ message, changes })` · `repos.list()`",
  workspaces:
    "a private overlay over the repos: `workspaces.get(path).writeFile(f, text)` · `gitCommit({ message, scope })`",
  files:
    "project files: `files.get(path).put({ contentType, data })` · `.bytes()` · `.url()` · `files.list(prefix)`",
} as const satisfies Record<string, string>;

/** A built-in root's name — a key of the record above. */
export type BuiltInRoot = keyof typeof BUILT_IN_ROOT_DESCRIPTIONS;
export const BUILT_IN_ROOTS = Object.keys(BUILT_IN_ROOT_DESCRIPTIONS) as readonly BuiltInRoot[];

const BUILT_IN_ROOT_SET: ReadonlySet<string> = new Set<string>(BUILT_IN_ROOTS);

/** THE CONTEXT ROOTS: the built-ins that are a context's OWN — its log, its tables, its facets, the
 *  hosts whose loaded code speaks for it, and where it lives (`whoami`, `url`: information, not a
 *  capability). Implicit in every context (rule 3): nothing else could `append` mean at `/agents/x`,
 *  and a hop for it would land in another log. Everything else in `BUILT_IN_ROOTS` is a PROJECT
 *  resource or an external capability (`fetch`, `ai`, `browser`), implicit at the owner root only. */
export const CONTEXT_ROOTS = [
  "whoami",
  "url",
  "append",
  "readEvents",
  "waitForEvent",
  "cd",
  "facets",
  "subscriptions",
  "processors",
  "schedules",
  "rewriteRules",
  "rpcStubs",
  "workers",
  "run",
] as const satisfies readonly BuiltInRoot[];

const CONTEXT_ROOT_SET: ReadonlySet<string> = new Set<string>(CONTEXT_ROOTS);

/** THE ONE PREDICATE (rule 3): which roots have an implicit row at `path` — every built-in at a
 *  project's root, the context roots anywhere below it. The GLOBAL namespace is not navigable (no
 *  `cd`, so nothing there can inherit through a link): a user's or an organization's subtree is that
 *  owner's own, and every context in it has every root — `/users/<id>/x` reads its owner's kv and
 *  shares its owner's secrets catalog, as before. Read by the resolver, the reduce and `list()`. */
export function implicitRootsAt(projectId: string, path: string): ReadonlySet<string> {
  return projectId === GLOBAL_PROJECT_ID || resolveContextPath("/", path) === "/"
    ? BUILT_IN_ROOT_SET
    : CONTEXT_ROOT_SET;
}

/** One rewrite rule as the table stores it: a canonical match prefix and the target it rewrites to
 *  (both parsed once, at reduce; a call step pins literal args, `itx.ai.run('gpt-5')` — expression.ts).
 *  A `null` target is a MASK: the row matches like any other and refuses the call. */
export type ItxExpressionRewriteRule = {
  match: ItxExpressionPrefix;
  target: ItxExpression | null;
  /** The one line a model reads for `match` here (rule 6). */
  description?: string;
};

/** The proxy's own verbs — a match may not start with one (rule 6). */
const PROXY_VERBS: readonly string[] = ["invoke", "provide", "subscribe"];

/** Is `call` at the fixed point — rooted at `itx.builtins` (a NAME step; `itx.builtins(…)` is not)? */
export function isBuiltInsRooted(call: ItxExpression): boolean {
  return call[0] === "itx" && call[1] === "builtins";
}

// ── the rules (pure) ──

/** What `matchItxExpressionPrefix` claims: the final step's unpinned args (present when the final
 *  prefix step matched a call step) and the call's steps after the match. */
type ItxExpressionPrefixMatch = { unpinnedArgs?: unknown[]; stepsAfterMatch: ItxExpression };

/** Rule 2: claim `call` with `match`, step by step from the start — or null. */
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
    if (typeof matchStep === "string") {
      if (typeof callStep === "string") {
        if (callStep !== matchStep) return null;
      } else if (callStep[0] !== matchStep || !final) return null;
      else unpinnedArgs = callStep.slice(1);
    } else {
      if (typeof callStep === "string" || callStep[0] !== matchStep[0]) return null;
      const pinned = matchStep.slice(1);
      const args = callStep.slice(1);
      if (args.length < pinned.length || !pinned.every((p, k) => jsonEqual(p, args[k])))
        return null;
      const residual = args.slice(pinned.length);
      if (final) unpinnedArgs = residual;
      else if (residual.length > 0) return null;
    }
  }
  return { unpinnedArgs, stepsAfterMatch: call.slice(match.length) };
}

const pinnedArgCount = (match: ItxExpressionPrefix): number =>
  match.reduce<number>((n, step) => n + (Array.isArray(step) ? step.length - 1 : 0), 0);

/** Rule 3: the most specific matching rule — or null. A mask row competes like any other. */
function pickItxExpressionRewriteRule(
  rules: readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
): { rule: ItxExpressionRewriteRule; match: ItxExpressionPrefixMatch } | null {
  let best: { rule: ItxExpressionRewriteRule; match: ItxExpressionPrefixMatch } | null = null;
  const moreSpecific = (a: ItxExpressionRewriteRule, b: ItxExpressionRewriteRule): boolean =>
    a.match.length !== b.match.length
      ? a.match.length > b.match.length
      : pinnedArgCount(a.match) > pinnedArgCount(b.match);
  for (const rule of rules) {
    const match = matchItxExpressionPrefix(rule.match, call);
    if (match && (!best || moreSpecific(rule, best.rule))) best = { rule, match };
  }
  return best;
}

/** Rule 7: the template's arguments with `@` filled from the caller's unpinned args. */
function fillItxExpressionHoles(
  templateArgs: unknown[],
  unpinnedArgs: unknown[] | undefined,
  target: ItxExpression,
): unknown[] {
  const spelled = print(target, { holes: true });
  const theOneUnpinnedArg = (what: string): unknown => {
    if (unpinnedArgs?.length !== 1)
      throw new Error(
        `${what} in the target ${JSON.stringify(spelled)} takes exactly one argument, got ${unpinnedArgs?.length ?? 0}`,
      );
    return unpinnedArgs[0];
  };
  const fill = (value: unknown): unknown => {
    if (isItxExpressionHole(value)) return theOneUnpinnedArg("a nested `@`");
    if (Array.isArray(value)) return value.map(fill);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `value` is `unknown`; the typeof separates real objects from primitives (bare truthiness would misroute strings/numbers)
    if (value !== null && typeof value === "object") {
      const template = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      if (template[ITX_EXPRESSION_MERGE_KEY] === true) {
        const source = theOneUnpinnedArg("`...@`");
        // oxlint-disable-next-line iterate/simple-truthiness-check -- `source` is `unknown` (a caller-supplied arg); the typeof is real validation that it is a mergeable object
        if (source === null || typeof source !== "object" || Array.isArray(source))
          throw new Error(
            `\`...@\` in the target ${JSON.stringify(spelled)} merges an object; the argument is ${JSON.stringify(source)}`,
          );
        Object.assign(out, source);
      }
      for (const [k, v] of Object.entries(template))
        if (k !== ITX_EXPRESSION_MERGE_KEY) out[k] = fill(v); // the template's own keys win
      return out;
    }
    return value;
  };
  return templateArgs.flatMap((arg) =>
    isItxExpressionHole(arg) ? unpinnedArgs || [] : [fill(arg)],
  );
}

/** Rule 4 (and 7): the call with the matched prefix replaced by the target. */
function applyItxExpressionRewriteRule(
  target: ItxExpression,
  match: ItxExpressionPrefixMatch,
): ItxExpression {
  const { unpinnedArgs, stepsAfterMatch } = match;
  const last = target.at(-1);
  if (Array.isArray(last) && containsItxExpressionHole(last))
    return [
      ...target.slice(0, -1),
      [last[0], ...fillItxExpressionHoles(last.slice(1), unpinnedArgs, target)],
      ...stepsAfterMatch,
    ];
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

// ── THE ONE EVENT: build it, the caller appends it ──

/** Validate + normalize the payload of a LITERAL `events.iterate.com/itx/rewrite-rule-configured`
 *  event (the append boundary calls this — core-processor's `normalizeControlEvent`): the match is
 *  validated (rooted at `itx`, no `@` hole, not `itx.builtins`, not a proxy verb) and canonicalized to
 *  a string; the target is validated (rooted at `itx`, whole-context override targets the physical
 *  spelling, `@` only in its final step) and normalized to the PARSED array form BEFORE storage — a
 *  target may carry a whole facet source, which the reduce must never re-parse through the string
 *  codec (its 2 KiB cap). So call sites write `itx.append({ type, payload: { match, target } })`
 *  literally. A `null` target is the caller's deliberate MASK (deny); the platform-equivalent target
 *  with `ifTarget` is a compare-and-set removal (rule 8). */
export function normalizeRewriteRuleConfigured(
  payload: RewriteRuleConfigured & { ifTarget?: ItxExpressionInput | null },
): {
  match: ItxExpression;
  target: ItxExpression | null;
  description?: string;
  ifTarget?: ItxExpression | null;
} {
  const matchPrefix = parseItxExpressionPrefix(payload.match);
  const d = payload.description;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- wire-fed: a present non-string (a number, an object) must be refused where the event is normalized, not coerced
  if (d && (typeof d !== "string" || d.length > 500))
    throw new Error("a rewrite rule's description is one line: a string of at most 500 chars");
  const description = payload.description ? { description: payload.description } : {};
  if (matchPrefix[0] !== "itx")
    throw new Error(
      `a rewrite rule's match must be rooted at "itx" (every call starts there — ${JSON.stringify(print(matchPrefix))} could never match one)`,
    );
  if (containsItxExpressionHole(matchPrefix))
    throw new Error(
      `\`@\` (the caller's input) is legal only in a rewrite rule's target, not its match (${JSON.stringify(print(matchPrefix))})`,
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
    payload.target === null ? null : normalizedItxExpression(payload.target, { holes: true });
  if (targetExpression && targetExpression[0] !== "itx")
    throw new Error(
      `a rewrite rule's target must be rooted at "itx" (a bare built-in root is unspellable — targets resolve through the rules; the physical spelling is "itx.builtins.…")`,
    );
  if (targetExpression && targetExpression.slice(0, -1).some(containsItxExpressionHole))
    throw new Error(
      `\`@\` (the caller's input) is legal only in the target's FINAL step — ${JSON.stringify(print(targetExpression, { holes: true }))} holds it earlier (rule 7)`,
    );
  // The match is the PARSED prefix, never re-stringified: a target may carry a whole source as data,
  // and a canonical match can itself exceed the string codec's cap even when the input did not — the
  // reduce keys the table with `print` (no cap on printing), never a second parse.
  // `ifTarget` (a handle's compare-and-set undo) is normalized the SAME way as `target` — the reduce
  // jsonEquals it against the stored (parsed) target, so a string `ifTarget` must become the same
  // parsed shape here or the undo would silently never match. `null` is the mask sentinel, kept as-is.
  if (!("ifTarget" in payload))
    return { match: matchPrefix, target: targetExpression, ...description };
  // oxlint-disable-next-line iterate/simple-truthiness-check -- a PRESENT key with an undefined value (reachable over capnweb, never JSON) is malformed and refused loudly here; folding it into the null sentinel would silently turn a handle's undo into a mask-lift
  if (payload.ifTarget === undefined)
    throw new Error(
      "a rewrite rule's ifTarget is an itx expression or null (the mask sentinel), never undefined",
    );
  const ifTarget =
    // oxlint-disable-next-line iterate/simple-truthiness-check -- like `target` above: null is the explicit sentinel (compare against a masked, null-target row), distinct from a malformed empty-string ifTarget that normalization must still parse and reject
    payload.ifTarget === null ? null : normalizedItxExpression(payload.ifTarget, { holes: true });
  return { match: matchPrefix, target: targetExpression, ...description, ifTarget };
}

// ── WHAT NAMES A LENT STUB (pure; the DO appends the removals it decides) ──

/** The physical spelling of a lent stub: `itx.builtins.rpcStubs.get('<key>')`, possibly with steps
 *  after it. */
function namesRpcStubDirectly(target: ItxExpression, rpcStubKey: string): boolean {
  return (
    target.length >= 4 &&
    jsonEqual(target.slice(0, 4), ["itx", "builtins", "rpcStubs", ["get", rpcStubKey]])
  );
}

/** THE ROWS THAT NAME A LENT STUB — decided against ONE frozen table, so the answer never depends on
 *  the order the rows were configured in. A row names `rpcStubKey` DIRECTLY when its target IS the
 *  physical spelling (the row `provide(stub)` writes, or a caller's own); every other row is resolved
 *  through the table MINUS the direct namers — the table as it will stand once they are gone — and
 *  names the key only if it still ends at the physical spelling then (a user's own `itx.reg ⇒
 *  itx.builtins.rpcStubs` + `itx.reg.get('k')`). So an alias to a shadowed root (`itx.llm ⇒ itx.ai`
 *  while `itx.ai` is a lent fake) resolves to the platform row beneath and is KEPT; a row that only
 *  dangles once the stub is gone (`itx.x ⇒ itx.cam`, `cam` no built-in) is kept too — it errors like
 *  any unconfigured name and revives with the next provide. Subscriptions are read the same way. */
export function rowsNamingRpcStub(args: {
  rpcStubKey: string;
  rules: readonly ItxExpressionRewriteRule[];
  subscriptionTargets: Record<string, ItxExpression>;
  implicitRoots: ReadonlySet<string>;
}): {
  ruleUnsets: { match: ItxExpressionPrefix; ifTarget: ItxExpression }[];
  subscriptionNames: string[];
} {
  const { rpcStubKey, rules, subscriptionTargets, implicitRoots } = args;
  const direct = rules.filter(
    (rule) => rule.target && namesRpcStubDirectly(rule.target, rpcStubKey),
  );
  const remaining = rules.filter((rule) => !direct.includes(rule));
  const namesThroughRemaining = (target: ItxExpression): boolean => {
    try {
      return namesRpcStubDirectly(
        resolveItxExpression(() => remaining, target, implicitRoots).at(-1)!,
        rpcStubKey,
      );
    } catch {
      return false;
    }
  };
  const indirect = remaining.filter((rule) => rule.target && namesThroughRemaining(rule.target));
  return {
    // Each unset carries the target the census SAW (`ifTarget`), so the removal is a compare-and-set:
    // the reduce restores the row only while it still names this dead stub. A `provide` that lands at
    // the same match in the detach window owns the row with a different target, and is left untouched.
    ruleUnsets: [...direct, ...indirect].map((rule) => ({
      match: rule.match,
      ifTarget: rule.target!,
    })),
    subscriptionNames: Object.entries(subscriptionTargets)
      .filter(([, target]) => namesThroughRemaining(target))
      .map(([name]) => name),
  };
}

/** THE APP WALL, as one check over an expression loaded code hands in (the resolver's INPUT, or the
 *  TARGET of a row it appends): never the fixed point, never a `cd` above `base` (self and descendants
 *  only, resolved step by step). Codec-style — nothing here is policy: the rows a call rewrites
 *  through are the owner's and are never checked. */
function admitLoadedCodeExpression(expression: ItxExpression, base: string): void {
  let at = base;
  for (const step of expression) {
    const name = typeof step === "string" ? step : step[0];
    if (name === "builtins")
      throw codedError(
        "FORBIDDEN",
        `"itx.builtins" is not a loaded worker's word — this context's rows say what its code may spell (${JSON.stringify(print(expression, { holes: true }))})`,
      );
    if (Array.isArray(step) && step[0] === "cd" && typeof step[1] === "string") {
      const to = resolveContextPath(at, step[1]);
      if (to !== at && !to.startsWith(at === "/" ? "/" : `${at}/`))
        throw codedError(
          "FORBIDDEN",
          `cd goes down only for loaded code: ${JSON.stringify(step[1])} from ${JSON.stringify(at)} would leave it`,
        );
      at = to;
    }
  }
}

/** THE APP WALL ON A ROW: a rewrite rule or a subscription loaded code appends on its own context is
 *  walled on its TARGET like a call is on its input — else `itx ⇒ itx.builtins.cd('/')` on its own log
 *  would re-parent it past its creator's masks, and a subscription target runs as the kernel. The one
 *  fixed-point target it may write is its OWN lend, `itx.builtins.rpcStubs.get(<key>)`: the registry is
 *  this context's, so the row grants nothing the code does not already hold. A `null` (a mask, an
 *  un-set) says nothing and passes. Any other event passes untouched. */
export function admitLoadedCodeRow(event: { type: string; payload?: unknown }, base: string): void {
  if (
    event.type !== "events.iterate.com/itx/rewrite-rule-configured" &&
    event.type !== "events.iterate.com/stream/subscription-configured"
  )
    return;
  const target = (event.payload as { target?: unknown } | undefined)?.target;
  if (!target) return; // a mask, an un-set (an empty string is the reduce's refusal, not this wall's)
  if (typeof target !== "string" && !Array.isArray(target)) return; // a live object: the lend's own business
  const expression = normalizedItxExpression(target as ItxExpressionInput, { holes: true });
  const [, root, registry, lend] = expression;
  if (root === "builtins" && registry === "rpcStubs" && Array.isArray(lend) && lend[0] === "get")
    return;
  admitLoadedCodeExpression(expression, base);
}

/** A bare `itx` row whose target is `cd` of THIS context is a loop no depth budget can see — every
 *  hop is a fresh resolve — so the append boundary refuses it against the path the row lands on
 *  (core-processor.ts `normalizeControlEvent`), whichever caller appends: `provide`, a script's
 *  `itx.append`, a sibling's `cd(path).append`, a schedule's batch, a pager attach. Two contexts
 *  pointing at each other is refused only where it would be created (library.ts `createEntity`: a
 *  context does not create its own ancestor); rows written by hand can still spell it, a
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
      `a bare itx row may not name its own context: "itx ⇒ ${print(row.target, { holes: true })}" at ${JSON.stringify(ownPath)} would route every call back to itself`,
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

/** Every rpc-stub key some row (a rule, a subscription) currently names, resolved through the
 *  whole table — the census a `stream/resumed` commit compares against the registry's presence. */
export function rpcStubKeysNamed(args: {
  rules: readonly ItxExpressionRewriteRule[];
  subscriptionTargets: Record<string, ItxExpression>;
  implicitRoots: ReadonlySet<string>;
}): Set<string> {
  const { rules, subscriptionTargets, implicitRoots } = args;
  const keys = new Set<string>();
  const targets = [
    ...rules.flatMap((rule) => (rule.target ? [rule.target] : [])),
    ...Object.values(subscriptionTargets),
  ];
  for (const target of targets) {
    try {
      const resolved = resolveItxExpression(() => rules, target, implicitRoots).at(-1)!;
      const getStep = builtInsGetStep(resolved, "rpcStubs");
      if (getStep) keys.add(getStep[1]);
    } catch {
      /* an unresolvable target names no key */
    }
  }
  return keys;
}

// ── THE TABLE, DESCRIBED (pure; the DO hands it the rows and the hop) ──

/** THE EFFECTIVE table as `rewriteRules.list()` shows it — the tree this context can spell: its own
 *  rows (a template's `@` spelled, a mask as `target: null`, each with the description its event
 *  carried); the implicit rows HERE not shadowed by an own `itx.<root>` row, each with the platform's
 *  one-liner — none under a bare null, which denies all; and, behind a bare row that hops
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
  const own = rules.map(
    (rule): RewriteRuleListEntry => ({
      match: print(rule.match),
      target: rule.target && print(rule.target, { holes: true }),
      description: rule.description,
      context: ownPath,
    }),
  );
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

export class ItxExpressionResolver {
  /** The built-ins: a plain record whose keys (kv, append, readEvents, cd, …) are the physical-layer
   *  roots — `itx.builtins.<root>` reaches them directly; `itx.<root>` reaches them through an implicit
   *  row where one exists (rule 3) unless the context's table says otherwise. */
  readonly #builtIns: Record<string, unknown>;
  readonly #rewriteRules: () => readonly ItxExpressionRewriteRule[];
  readonly #implicitRoots: ReadonlySet<string>;
  readonly #path: string;
  readonly #caller: () => Caller;

  constructor(args: {
    builtIns: Record<string, unknown>;
    rewriteRules: () => readonly ItxExpressionRewriteRule[];
    /** The roots with an implicit row HERE (`implicitRootsAt`). */
    implicitRoots: ReadonlySet<string>;
    /** This context's canonical path: the base of loaded code's `cd`, and its ceiling. */
    path: string;
    /** WHO is calling right now — the DO's ambient caller. */
    caller: () => Caller;
  }) {
    this.#builtIns = args.builtIns;
    this.#rewriteRules = args.rewriteRules;
    this.#implicitRoots = args.implicitRoots;
    this.#path = args.path;
    this.#caller = args.caller;
  }

  /** THE APP WALL (rule 5): loaded code hands in short names and nothing else — never the fixed
   *  point, never a `cd` above its own context (self and descendants only, resolved step by step). On
   *  the INPUT only: the rows a call rewrites through are the owner's grants and are never checked, so
   *  a parent link `itx ⇒ itx.builtins.cd('/agents/x')` carries a script up exactly as far as its
   *  owner said. Codec-style, kin to the reserved names `parse` refuses — nothing here is policy. */
  #admit(expression: ItxExpression): void {
    const caller = this.#caller();
    // Only a trusted cd hop stamps path, after the whole input expression passed this check.
    // The remaining expression now includes the owner's rewrites (e.g. the agent's sandbox
    // redirect to builtins.run), not just loaded code's words. Keep app for row admission and
    // attribution, but don't reject the owner's grant again at its destination.
    if (caller.app && !caller.path) admitLoadedCodeExpression(expression, this.#path);
  }

  /** PURE: the chain of rewrites from `call` to the builtins-rooted call that would run (rules 3–5).
   *  Nothing is dispatched. The one law: `invoke(call)` ≡ `invoke(resolve(call).at(-1))`. */
  resolve(call: ItxExpressionInput): ItxExpression[] {
    const expression = normalizedItxExpression(call);
    this.#admit(expression);
    return resolveItxExpression(this.#rewriteRules, expression, this.#implicitRoots);
  }

  /** Resolve + run one call: the chain's last element, walked against the physical scope from the
   *  record (expression.ts `walkSteps` — the root after `builtins` is the first step). Runtime `extraArgs`
   *  are LIVE args (a Request, a callback — not expression data; the fetch lane and the public
   *  `invoke(call, ...args)` hand them in): when the call ends in a NAME they are FOLDED INTO it BEFORE
   *  resolving — `invoke("itx.kv.get", "k")` IS `itx.kv.get("k")`, so a template fills, a pinned row
   *  matches and a mask refuses exactly as the dotted call would; when it ends in a call they apply to
   *  the value the expression denotes. */
  async invoke(call: ItxExpressionInput, ...extraArgs: unknown[]): Promise<unknown> {
    let expression = normalizedItxExpression(call);
    const last = expression.at(-1);
    if (extraArgs.length > 0 && typeof last === "string" && expression.length > 1) {
      expression = [...expression.slice(0, -1), [last, ...extraArgs]];
      extraArgs = [];
    }
    this.#admit(expression);
    const rewritten = resolveItxExpression(this.#rewriteRules, expression, this.#implicitRoots).at(
      -1,
    )!;
    const rootName = itxExpressionStepName(rewritten[2]);
    const roots = () => Object.keys(this.#builtIns).join(", ");
    if (!rootName)
      throw new Error(
        `"itx.builtins" names the reserved root — name a built-in under it (${roots()})`,
      );
    if (!Object.hasOwn(this.#builtIns, rootName))
      throw codedError(
        "NO_ITX_EXPRESSION_MATCH",
        `no built-in ${JSON.stringify(rootName)} under itx.builtins (${roots()})`,
      );
    // Forward the whole remaining expression through cd. Walking a factory call such as
    // workers.get(spec) here would return its handle over RPC first, making the later fetch
    // an RPC call too and losing a socket-bearing Response before cd can select native fetch.
    if (rootName === "cd" && Array.isArray(rewritten[2]) && rewritten.length > 3) {
      const { value } = await walkSteps(
        { value: this.#builtIns, receiver: undefined },
        rewritten.slice(2, 3),
      );
      if (!(value instanceof InvokeHandle))
        throw new Error("builtins.cd must return an InvokeHandle");
      const result = await value.invoke(rewritten.slice(3));
      return extraArgs.length > 0 ? await callOn(result, undefined, extraArgs) : result;
    }
    const { value, receiver } = await walkSteps(
      { value: this.#builtIns, receiver: undefined },
      rewritten.slice(2),
    );
    return extraArgs.length > 0 ? await callOn(value, receiver, extraArgs) : value;
  }
}
