// context/itx-expression-rewriting.ts — HOW A CALL FINDS ITS TARGET, pure and total. An itx-expression
// REWRITE RULE is `{ match, target }`: a call that starts with `match` runs as the same call with
// `match` replaced by `target`. Rewriting repeats until the call is rooted at THE RESERVED ROOT,
// `itx.builtins` — the physical scope (kv, whoami, rpcStubs, facets, …; context/built-ins.ts) — and
// that call is what actually runs (expression.ts's `walkSteps` walks it). The rules THEMSELVES are `core` state —
// stream/core-processor.ts reduces `itx/rewrite-rule-configured` into `state.itxExpressionRewriteRules`,
// a MAP by canonical match (set replaces; `null` MASKS a name that has a platform row beneath it and
// deletes any other). This module is the rules of matching, the ONE event that writes the table, and
// the resolver that reads it. Every matching rule is one table row in itx-expression-rewriting.test.ts.
//   built-in roots — `BUILT_IN_ROOTS` / `isBuiltInRoot`: THE RESERVED ROOT'S KEYS, as one constant
//
// THE RULES
//   1. A match is an itx-expression PREFIX: dotted names; any step may be a CALL STEP pinning literal
//      args: `itx.ai.run('gpt-5')`.
//   2. A name step matches the same property — or, as the prefix's FINAL step, a call of that name (all
//      of its args are unpinned). A call step matches a call of that name whose leading args EQUAL the
//      pinned literals (structurally). Pinned args are CONSUMED. Unpinned args beyond them are the call
//      on the target when the step is final; on a non-final step they are a non-match (the target
//      replaces every matched step, so a residual would have nowhere to go).
//   3. The most SPECIFIC matching row of the CONTEXT's table wins: longest match, then most pinned
//      args. (One row per match, so two rows with DIFFERENT matches of equal length and pins cannot
//      both match one call.) THE IMPLICIT ROWS compete as rows of length 2 (`implicitRootsAt`,
//      below): every built-in root at the owner root, only the CONTEXT roots elsewhere — so an own
//      `itx.<root>` row shadows one. A bare `itx` row WITH a target claims only what no longer row
//      claims: the parent link `itx ⇒ itx.builtins.cd('/agents/x')` sends every unclaimed name up
//      while the context's own log stays its own. A bare `itx ⇒ null` claims EVERYTHING: one row
//      denies all (a jail is that row plus its grants).
//   4. The rewrite: the target, then the unpinned args — folded into the target's final step when
//      that step is a name (`itx.grok ⇒ itx.openai.chat`, `itx.grok({…})` ⇒ `itx.openai.chat({…})`),
//      else an ANONYMOUS call on the target's result (`itx.cam ⇒ itx.builtins.rpcStubs.get('cam')`,
//      `itx.cam(1)` ⇒ `itx.builtins.rpcStubs.get('cam')(1)`) — then the call's steps after the match.
//      A target denotes a VALUE; calling the match calls that value.
//   5. THE FIXED POINT is `itx.builtins`: a call rooted there runs as is and never reads the table
//      (the whole facet-push path, every kernel-spelled append). It is the PLATFORM'S word: loaded
//      code (`Caller.app` — a worker, a facet, a script holding `env.ITX`) may not spell it, nor `cd`
//      above its own context, on the INPUT it hands in (`ItxExpressionResolver`'s wall; rewrites the
//      owner wrote are never checked). Any other `itx.…` call, RULES FIRST: the winning row (rule 3)
//      with a `null` target is a MASK — refused, default-deny; a winning row with a target rewrites
//      and the loop repeats — unless it is the bare row and the call's root is implicit HERE, when
//      the implicit row applies instead; no winner and an implicit root ⇒ the implicit row
//      `itx.<root> ⇒ itx.builtins.<root>`, and the call is at the fixed point; anything else is
//      refused. 32 rewrites is the budget (a self-referential rule errors, never spins). Implicit
//      rows are never stored; `list()` spells them, described.
//   6. THE DOOR (`normalizeRewriteRuleConfigured`, run at the append boundary): a match is rooted at `itx`; never at `itx.builtins`
//      (the fixed point is what every call rewrites TO, never a name a row claims); never at one of
//      the proxy's own verbs (`invoke`, `provide`, `subscribe` — the dotted surface never hands
//      those to the table; `cd` IS a name, so `itx.cd ⇒ null` is a legal wall). A target is rooted
//      at `itx`. `description`, when present, is one line (≤ 500 chars) a model reads for the name.
//   7. `@` IS THE CALLER'S INPUT (expression.ts lexes it; targets only, final step only — the door
//      refuses it in a match, in a non-final step, and `parse` refuses it in a call). A target whose
//      final call step holds `@` is a TEMPLATE, and rule 4's fold does not apply to it: as a top-level
//      argument `@` is the unpinned argument list, SPLICED (`itx.fable ⇒ itx.builtins.ai.run('@cf/x', @)`,
//      `itx.fable(inputs, opts)` ⇒ `itx.builtins.ai.run('@cf/x', inputs, opts)`; a property access on
//      the match has no args, so it DROPS); nested inside an object or array literal `@` is THE one
//      argument, and `...@` as an object entry merges the one argument's fields under the template's
//      own keys (the template wins: a pinned `model` cannot be talked out of) — two or more args, or
//      none, where one is required is a refusal at rewrite time. The one reserved literal is the
//      marker's array-half spelling, `{ "@": true }` (and the entry key `"...@"`).
//   8. UN-SETTING: `target: null` deletes the row — kept as a MASK only where something beneath the
//      match HERE would answer it: an implicit row, or a stored SHORTER row with a target (the
//      parent link, a granted root). A handle's undo and a dead stub's census
//      send `null` WITH `ifTarget`: a compare-and-set DELETE, never a mask. There is no "restore"
//      spelling: at a child the platform-equivalent target `itx.builtins.<x>` is a GRANT and is
//      stored; at the owner root it equals the implicit row and deletes (core-processor.ts).
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
import type { RewriteRuleConfigured } from "iterate/next/api";
import {
  callOn,
  walkSteps,
  normalizedItxExpression,
  containsItxExpressionHole,
  isItxExpressionHole,
  ITX_EXPRESSION_MERGE_KEY,
  itxExpressionStepName,
  parseItxExpressionPrefix,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionPrefix,
} from "iterate/next/expression";
import { GLOBAL_PROJECT_ID, resourceScope } from "./paths.ts";

/** One rewrite rule: a canonical match prefix and the target it rewrites to (both parsed once, at
 *  reduce; a call step pins literal args, `itx.ai.run('gpt-5')` — expression.ts). A `null` target is a
 *  MASK: the row matches like any other and refuses the call (rule 5). */

// ── built-in roots ── THE RESERVED ROOT'S KEYS, as one constant. `itx.builtins.<root>` is
// the physical scope (context/built-ins.ts `BuiltInScope` — kv, append, rpcStubs, facets, …), and
// every short name `itx.<root>` is the IMPLICIT PLATFORM ROW `itx.<root> ⇒ itx.builtins.<root>`
// (rule 5, above). Kept apart from the record on purpose: the core reduce
// (stream/core-processor.ts) needs this list to tell a MASK (`itx.kv ⇒ null`, kept — it shadows a
// platform row) from a plain deletion, and the DO's `rewriteRules.list()` needs it to show the
// platform rows; neither may import the record itself (it closes over bindings and the loader).
// built-ins.ts asserts, at the type level, that this list and `keyof BuiltInScope` are the same set.

export const BUILT_IN_ROOTS = [
  "whoami",
  "url",
  "kv",
  "secrets",
  "ai",
  "browser",
  "r2",
  "cfArtifacts",
  "append",
  "schedules",
  "readEvents",
  "waitForEvent",
  "cd",
  "fetch",
  "rpcStubs",
  "rewriteRules",
  "facets",
  "subscriptions",
  "processors",
  "workers",
  // THE LIBRARY (library.ts): first-party verbs that take only `itx` — could be userspace
  "run",
  "connectToMcp",
  "connectToOpenApi",
  "connectToCapnweb",
  "repos",
  "workspaces",
  "agents",
  "mcpConnections",
  "files",
] as const;

export type BuiltInRoot = (typeof BUILT_IN_ROOTS)[number];

const BUILT_IN_ROOT_SET: ReadonlySet<string> = new Set<string>(BUILT_IN_ROOTS);

/** Is `root` one of the reserved root's keys — i.e. does `itx.<root>` have a platform row? */
export function isBuiltInRoot(root: unknown): root is BuiltInRoot {
  return typeof root === "string" && BUILT_IN_ROOT_SET.has(root);
}

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

const ALL_ROOTS: ReadonlySet<string> = BUILT_IN_ROOT_SET;
const CONTEXT_ROOT_SET: ReadonlySet<string> = new Set<string>(CONTEXT_ROOTS);

/** THE ONE PREDICATE (rule 3): which roots have an implicit row at `path` — every built-in at a
 *  project's root, the context roots anywhere below it. The GLOBAL namespace is not navigable (no
 *  `cd`, so nothing there can inherit through a link): a user's or an organization's subtree is that
 *  owner's own, and every context in it has every root — `/users/<id>/x` reads its owner's kv and
 *  shares its owner's secrets catalog, as before. Read by the resolver, the reduce and `list()`. */
export function implicitRootsAt(projectId: string, path: string): ReadonlySet<string> {
  if (projectId === GLOBAL_PROJECT_ID) return ALL_ROOTS;
  return resourceScope(projectId, path).rootPath === resolveContextPath("/", path)
    ? ALL_ROOTS
    : CONTEXT_ROOT_SET;
}

/** Rule 8's two questions about a match, against the roots implicit HERE. An implicit row lies
 *  BENEATH `itx` (all of them) and beneath any `itx.<root>…` whose root is implicit — a `null` there
 *  is kept as a mask. A match IS an implicit row only when it is exactly `itx.<root>` with `root`
 *  implicit, or the bare `itx` at the owner root (where every root is) — the platform-equivalent
 *  target there restates the default and deletes; anywhere else it is a grant and is stored. */
export function implicitRowBeneath(
  match: ItxExpressionPrefix,
  implicitRoots: ReadonlySet<string>,
): boolean {
  if (match.length === 1) return implicitRoots.size > 0;
  const root = itxExpressionStepName(match[1]);
  return !!root && implicitRoots.has(root);
}
export function isImplicitRow(
  match: ItxExpressionPrefix,
  implicitRoots: ReadonlySet<string>,
): boolean {
  if (match.length === 1) return implicitRoots.size === BUILT_IN_ROOTS.length;
  if (match.length !== 2 || typeof match[1] !== "string") return false;
  return implicitRoots.has(match[1]);
}

/** One line per built-in — what `rewriteRules.list()` says for an implicit row, and so what a model
 *  reads for it. Kept beside the list so a root added here is described here. */
export const BUILT_IN_ROOT_DESCRIPTIONS: Record<BuiltInRoot, string> = {
  whoami: "who this context is: `itx.whoami()` → { projectId, path }",
  url: "this project's public URL over HTTP — the apex or an app's, at a path: `url({ app?, path? })`; only from a session that reached the platform on an origin",
  kv: "key-value strings, the project's own: `kv.get(k)` · `kv.put(k, v)` · `kv.list(prefix)` · `kv.delete(k)`",
  secrets:
    'names only, never values: `secrets.list()`; a `getSecret("/secrets/x")` placeholder in an outbound request is substituted at egress',
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
  agents:
    "other agents, each a conversation on its own path: `agents.get(path).message(text)` · `agents.list()`",
  mcpConnections:
    "the MCP connections born under this project, by grant: itx.mcpConnections.list() → [{ grantId, path, createdAt }]",
  files:
    "project files: `files.get(path).put({ contentType, data })` · `.bytes()` · `.url()` · `files.list(prefix)`",
};

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

/** `itx/rewrite-rule-configured`: the match PRINTED (its canonical string), the target PARSED — both
 *  through the codec's one door, which for an ARRAY input is the only validation (reserved names, an
 *  anonymous call at the root, an argless pinned step), so a spelling the parser refuses fails LOUD
 *  here, in the parser's own words (the reduce would skip a match that does not parse — a rule that
 *  silently never exists). `target: null` un-sets the rule at
 *  `match` (a MASK when a platform row lies beneath, a deletion otherwise); the platform-equivalent
 *  target `itx.builtins.<match…>` restores the platform row (the reduce deletes the row). Rule 6 is
 *  enforced here, at the door. */
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
export function admitLoadedCodeExpression(expression: ItxExpression, base: string): void {
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
      const getStep = resolved[3];
      if (
        resolved[1] === "builtins" &&
        resolved[2] === "rpcStubs" &&
        Array.isArray(getStep) &&
        getStep[0] === "get" &&
        typeof getStep[1] === "string"
      )
        keys.add(getStep[1]);
    } catch {
      /* an unresolvable target names no key */
    }
  }
  return keys;
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
    if (this.#caller().app) admitLoadedCodeExpression(expression, this.#path);
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
    const { value, receiver } = await walkSteps(
      { value: this.#builtIns, receiver: undefined },
      rewritten.slice(2),
    );
    return extraArgs.length > 0 ? await callOn(value, receiver, extraArgs) : value;
  }
}
