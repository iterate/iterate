// context/itx-expression-rewriting.ts — HOW A CALL FINDS ITS TARGET, pure and total. An itx-expression
// REWRITE RULE is `{ match, target }`: a call that starts with `match` runs as the same call with
// `match` replaced by `target`. Rewriting repeats until the call is rooted at THE RESERVED ROOT,
// `itx.builtins` — the physical scope (kv, whoami, rpcStubs, facets, …; context/built-ins.ts) — and
// that call is what actually runs (./dispatch.ts walks it). The rules THEMSELVES are `core` state —
// stream/core-processor.ts reduces `itx/rewrite-rule-configured` into `state.itxExpressionRewriteRules`,
// a MAP by canonical match (set replaces; `null` MASKS a name that has a platform row beneath it and
// deletes any other). This module is the rules of matching, the ONE event that writes the table, and
// the resolver that reads it. Every matching rule is one table row in itx-expression-rewriting.test.ts.
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
//      both match one call.) A bare `itx` row matches every call — the whole-context override.
//   4. The rewrite: the target, then the unpinned args — folded into the target's final step when
//      that step is a name (`itx.grok ⇒ itx.openai.chat`, `itx.grok({…})` ⇒ `itx.openai.chat({…})`),
//      else an ANONYMOUS call on the target's result (`itx.cam ⇒ itx.builtins.rpcStubs.get('cam')`,
//      `itx.cam(1)` ⇒ `itx.builtins.rpcStubs.get('cam')(1)`) — then the call's steps after the match.
//      A target denotes a VALUE; calling the match calls that value.
//   5. THE FIXED POINT is `itx.builtins`: a call rooted there runs as is and never reads the table
//      (the whole facet-push path, every platform-spelled append). Any other `itx.…` call, RULES
//      FIRST: a matching row (rule 3) whose target is `null` is a MASK — the call is refused,
//      default-deny, even though a platform row lies beneath; a matching row with a target rewrites
//      and the loop repeats; NO matching row and a root that is a built-in (context/built-in-roots.ts)
//      is THE IMPLICIT PLATFORM ROW `itx.<root> ⇒ itx.builtins.<root>` — applied, and the call is at
//      the fixed point; anything else is refused. 32 rewrites is the budget (a self-referential rule
//      errors, never spins). The platform rows are never materialized on this path; `list()` and
//      `resolve()` are the only readers that spell them out.
//   6. THE DOOR (`rewriteRuleConfiguredEvent`): a match is rooted at `itx`; never at `itx.builtins`
//      (the fixed point is what every call rewrites TO, never a name a row claims); never at one of
//      the proxy's own verbs (`cd`, `invoke`, `provide`, `subscribe`, `enableProcessor`,
//      `disableProcessor` — the dotted surface never hands those to the table, so such a row could
//      fire from a string invoke but never from the sugar). A target is rooted at `itx`.
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
//
// THE PLATFORM NEVER SPELLS A SHORT NAME: every expression the platform itself writes — the proxy's
// own append, a lent stub's rule (`match ⇒ itx.builtins.rpcStubs.get('<match>')`), a processor's
// row (`itx.builtins.facets.get(name, spec).processEventBatch`) — is rooted at `itx.builtins`, so a
// user's row at `itx.facets` or `itx.rpcStubs` redirects the user's calls and nothing else. A LENT RPC
// STUB is no exception: `itx.provide(match, stub)` lends the stub to the `itx.builtins.rpcStubs`
// registry (physical) under the key = the canonical match and configures that pure-data rule — the log
// records the rule, never the socket. STRING AT REST: the event stores both halves in the string half
// of the codec; the core reduce parses ONCE.

import { codedError } from "../lib/errors.ts";
import { jsonEqual } from "../lib/patch.ts";
import type { StreamEventInput } from "../stream/events.ts";
import { callOn, walkSteps } from "./dispatch.ts";
import {
  containsItxExpressionHole,
  isItxExpressionHole,
  ITX_EXPRESSION_MERGE_KEY,
  parse,
  parseItxExpressionPrefix,
  print,
  toItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionPrefix,
} from "./expression.ts";

/** One rewrite rule: a canonical match prefix and the target it rewrites to (both parsed once, at
 *  reduce; a call step pins literal args, `itx.ai.run('gpt-5')` — expression.ts). A `null` target is a
 *  MASK: the row matches like any other and refuses the call (rule 5). */
export type ItxExpressionRewriteRule = { match: ItxExpressionPrefix; target: ItxExpression | null };

/** The reserved root: `itx.builtins` is the fixed point of rewriting (rule 5). */
export const BUILTINS_ROOT = "builtins";

/** The proxy's own verbs — a match may not start with one (rule 6). */
export const PROXY_VERBS: readonly string[] = [
  "cd",
  "invoke",
  "provide",
  "subscribe",
  "enableProcessor",
  "disableProcessor",
];

/** Is `call` at the fixed point — rooted at `itx.builtins` (a NAME step; `itx.builtins(…)` is not)? */
export function isBuiltInsRooted(call: ItxExpression): boolean {
  return call[0] === "itx" && call[1] === BUILTINS_ROOT;
}

// ── the rules (pure) ──

/** What `matchItxExpressionPrefix` claims: the final step's unpinned args (present when the final
 *  prefix step matched a call step) and the call's steps after the match. */
export type ItxExpressionPrefixMatch = { unpinnedArgs?: unknown[]; stepsAfterMatch: ItxExpression };

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
export function pickItxExpressionRewriteRule(
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
    if (match && (best === null || moreSpecific(rule, best.rule))) best = { rule, match };
  }
  return best;
}

/** Rule 7: the template's arguments with `@` filled from the caller's unpinned args. */
function fillItxExpressionHoles(
  templateArgs: unknown[],
  unpinnedArgs: unknown[] | undefined,
  target: ItxExpression,
): unknown[] {
  const theOne = (what: string): unknown => {
    if (unpinnedArgs?.length !== 1)
      throw new Error(
        `${what} in the target ${JSON.stringify(print(target))} takes exactly one argument, got ${unpinnedArgs?.length ?? 0}`,
      );
    return unpinnedArgs[0];
  };
  const fill = (value: unknown): unknown => {
    if (isItxExpressionHole(value)) return theOne("a nested `@`");
    if (Array.isArray(value)) return value.map(fill);
    if (value !== null && typeof value === "object") {
      const template = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      if (Object.hasOwn(template, ITX_EXPRESSION_MERGE_KEY)) {
        const source = theOne("`...@`");
        if (source === null || typeof source !== "object" || Array.isArray(source))
          throw new Error(
            `\`...@\` in the target ${JSON.stringify(print(target))} merges an object; the argument is ${JSON.stringify(source)}`,
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
    isItxExpressionHole(arg) ? (unpinnedArgs ?? []) : [fill(arg)],
  );
}

/** Rule 4 (and 7): the call with the matched prefix replaced by the target. */
export function applyItxExpressionRewriteRule(
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
 *  first, the builtins-rooted call last (one element when `call` is already there). Throws
 *  NO_ITX_EXPRESSION_MATCH when no row matches and the root is no built-in, or when the winning row is
 *  a mask (default-deny), and a depth error after 32 rewrites. `rules` is a THUNK read at most once,
 *  and NOT AT ALL when the call is already builtins-rooted: a fixed-point dispatch never materializes
 *  the table. The implicit platform row is applied here, never stored. */
export function resolveItxExpression(
  rules: () => readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
  isBuiltInRoot: (root: string) => boolean,
): ItxExpression[] {
  const chain: ItxExpression[] = [call];
  let current = call;
  let rulesList: readonly ItxExpressionRewriteRule[] | undefined;
  for (let rewrites = 0; ; rewrites++) {
    if (isBuiltInsRooted(current)) return chain;
    if (rewrites >= 32)
      throw new Error(`itx-expression rewriting exceeded depth 32 — self-referential rule?`);
    const winner =
      current[0] === "itx" ? pickItxExpressionRewriteRule((rulesList ??= rules()), current) : null;
    if (winner) {
      if (winner.rule.target === null)
        throw codedError(
          "NO_ITX_EXPRESSION_MATCH",
          `${JSON.stringify(print(current))} is masked: the rule at ${JSON.stringify(print(winner.rule.match))} is null (default-deny; provide a target, or restore the platform row with itx.builtins.…)`,
        );
      current = applyItxExpressionRewriteRule(winner.rule.target, winner.match);
      chain.push(current);
      continue;
    }
    const rootStep = current[1];
    const root = Array.isArray(rootStep) ? rootStep[0] : rootStep;
    if (current[0] === "itx" && typeof root === "string" && isBuiltInRoot(root)) {
      // THE IMPLICIT PLATFORM ROW: `itx.<root> ⇒ itx.builtins.<root>` — the fixed point, done.
      current = ["itx", BUILTINS_ROOT, ...current.slice(1)];
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

/** `itx/rewrite-rule-configured`, STRING at rest — both halves canonicalized through the codec now, so
 *  a spelling the parser refuses fails LOUD here, in the parser's own words (the reduce would skip a
 *  target that does not parse — a rule that silently never exists). `target: null` un-sets the rule at
 *  `match` (a MASK when a platform row lies beneath, a deletion otherwise); the platform-equivalent
 *  target `itx.builtins.<match…>` restores the platform row (the reduce deletes the row). Rule 6 is
 *  enforced here, at the door. */
export function rewriteRuleConfiguredEvent(
  match: ItxExpressionInput,
  target: ItxExpressionInput | null,
): StreamEventInput {
  const matchPrefix = parseItxExpressionPrefix(match);
  if (matchPrefix[0] !== "itx")
    throw new Error(
      `a rewrite rule's match must be rooted at "itx" (every call starts there — ${JSON.stringify(print(matchPrefix))} could never match one)`,
    );
  if (containsItxExpressionHole(matchPrefix))
    throw new Error(
      `\`@\` (the caller's input) is legal only in a rewrite rule's target, not its match (${JSON.stringify(print(matchPrefix))})`,
    );
  const firstStep = matchPrefix[1];
  const firstName = Array.isArray(firstStep) ? firstStep[0] : firstStep;
  if (firstName === BUILTINS_ROOT)
    throw new Error(
      `a rewrite rule's match may not be rooted at "itx.builtins" — the reserved root is the fixed point every call rewrites TO, never a name a rule claims (${JSON.stringify(print(matchPrefix))})`,
    );
  if (typeof firstName === "string" && PROXY_VERBS.includes(firstName))
    throw new Error(
      `a rewrite rule's match may not start with the proxy's own verb "${firstName}" (${PROXY_VERBS.join(", ")}): the dotted surface never hands those to the table, so the rule could fire from a string invoke but never from the sugar`,
    );
  const targetExpression =
    target === null
      ? null
      : parse(print(toItxExpression(target, { holes: true })), { holes: true });
  if (targetExpression && targetExpression[0] !== "itx")
    throw new Error(
      `a rewrite rule's target must be rooted at "itx" (a bare built-in root is unspellable — targets resolve through the rules; the physical spelling is "itx.builtins.…")`,
    );
  if (targetExpression && targetExpression.slice(0, -1).some(containsItxExpressionHole))
    throw new Error(
      `\`@\` (the caller's input) is legal only in the target's FINAL step — ${JSON.stringify(print(targetExpression))} holds it earlier (rule 7)`,
    );
  return {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: print(matchPrefix),
      target: targetExpression && print(targetExpression),
    },
  };
}

/** The REMOVAL spelling of the same event: the row at `match` is gone — back to the platform row when
 *  one lies beneath, nothing otherwise. Spelled as the platform-equivalent target
 *  `itx.builtins.<match…>`, which the core reduce turns into a deletion, so a disposed handle and a
 *  dead stub RESTORE `itx.ai` rather than mask it (`null` is the caller's deliberate deny). */
export function rewriteRuleRemovedEvent(match: ItxExpressionInput): StreamEventInput {
  const matchPrefix = parseItxExpressionPrefix(match);
  return rewriteRuleConfiguredEvent(matchPrefix, ["itx", BUILTINS_ROOT, ...matchPrefix.slice(1)]);
}

// ── THE RESOLVER (parent-constructed over the physical built-ins and a reader of the CURRENT rules) ──

export class ItxExpressionResolver {
  /** The built-ins: a plain record whose keys (kv, append, read, cd, …) are the physical-layer roots
   *  — `itx.builtins.<root>` reaches them directly; `itx.<root>` reaches them through the implicit
   *  platform row unless the context's table says otherwise (rule 5). */
  readonly #builtIns: Record<string, unknown>;
  readonly #rewriteRules: () => readonly ItxExpressionRewriteRule[];

  constructor(args: {
    builtIns: Record<string, unknown>;
    rewriteRules: () => readonly ItxExpressionRewriteRule[];
  }) {
    this.#builtIns = args.builtIns;
    this.#rewriteRules = args.rewriteRules;
  }

  /** PURE: the chain of rewrites from `call` to the builtins-rooted call that would run (rules 3–5).
   *  Nothing is dispatched. The one law: `invoke(call)` ≡ `invoke(resolve(call).at(-1))`. */
  resolve(call: ItxExpressionInput): ItxExpression[] {
    return resolveItxExpression(this.#rewriteRules, toItxExpression(call), (root) =>
      Object.hasOwn(this.#builtIns, root),
    );
  }

  /** Resolve + run one call: the chain's last element, evaluated against the physical scope — the
   *  root after `builtins`, its args if that step is a call, the remaining steps (dispatch.ts
   *  walkSteps), and finally any runtime `extraArgs`, applied to the value the expression denotes
   *  (the fetch lane hands the live Request in here — a Request is not expression data; the public
   *  `invoke(call, ...args)` is the same door). */
  async invoke(call: ItxExpressionInput, extraArgs?: unknown[]): Promise<unknown> {
    const rewritten = this.resolve(call).at(-1)!;
    const rootStep = rewritten[2] as string | [string, ...unknown[]] | undefined;
    if (rootStep === undefined)
      throw new Error(
        `"itx.builtins" names the reserved root — name a built-in under it (${Object.keys(this.#builtIns).join(", ")})`,
      );
    const rootName = Array.isArray(rootStep) ? rootStep[0] : rootStep;
    if (!Object.hasOwn(this.#builtIns, rootName))
      throw codedError(
        "NO_ITX_EXPRESSION_MATCH",
        `no built-in ${JSON.stringify(rootName)} under itx.builtins (${Object.keys(this.#builtIns).join(", ")})`,
      );
    let value: unknown = this.#builtIns[rootName];
    let receiver: unknown = undefined;
    if (Array.isArray(rootStep)) value = await callOn(value, receiver, rootStep.slice(1));
    ({ value, receiver } = await walkSteps({ value, receiver }, rewritten.slice(3)));
    if (extraArgs) value = await callOn(value, receiver, extraArgs);
    return await value;
  }
}
