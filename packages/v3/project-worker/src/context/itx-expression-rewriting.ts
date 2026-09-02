// context/itx-expression-rewriting.ts — HOW A CALL FINDS ITS TARGET, pure and total. An itx-expression
// REWRITE RULE is `{ match, target }`: a call that starts with `match` runs as the same call with
// `match` replaced by `target`. Rewriting repeats until the call's root is a BUILT-IN (the physical
// scope: kv, whoami, rpcStubs, load, …) — that call is what actually runs (./dispatch.ts walks it).
// The rules THEMSELVES are `core` state — stream/core-processor.ts reduces `itx/rewrite-rule-configured`
// into `state.itxExpressionRewriteRules`, a MAP by canonical match (set replaces, null deletes). This
// module is the rules of matching, the ONE event that writes the table, and the resolver that reads it.
// Every matching rule is one table row in itx-expression-rewriting.test.ts.
//
// THE RULES
//   1. A match is an itx-expression PREFIX: dotted names; any step may be a CALL STEP pinning literal
//      args: `itx.ai.run('gpt-5')`.
//   2. A name step matches the same property — or, as the prefix's FINAL step, a call of that name (all
//      of its args are unpinned). A call step matches a call of that name whose leading args EQUAL the
//      pinned literals (structurally). Pinned args are CONSUMED. Unpinned args beyond them are the call
//      on the target when the step is final; on a non-final step they are a non-match (the target
//      replaces every matched step, so a residual would have nowhere to go).
//   3. The most SPECIFIC matching rule wins: longest match, then most pinned args. (One rule per match,
//      so two rules with DIFFERENT matches of equal length and pins cannot both match one call.)
//   4. The rewrite: the target, then the unpinned args — folded into the target's final step when
//      that step is a name (`itx.grok ⇒ itx.openai.chat`, `itx.grok({…})` ⇒ `itx.openai.chat({…})`),
//      else an ANONYMOUS call on the target's result (`itx.cam ⇒ itx.rpcStubs.get('cam')`, `itx.cam(1)`
//      ⇒ `itx.rpcStubs.get('cam')(1)`) — then the call's steps after the match.
//   5. Rewriting repeats until the root is a built-in; 32 rewrites is the budget (a self-referential
//      rule errors, never spins); a call no rule matches is refused (default-deny).
//
// A LENT RPC STUB is no exception: `itx.provide(rpcStubKey, { stub, rewrite })` lends the stub to the
// `itx.rpcStubs` built-in (physical) and configures the pure-data rule `rewrite ⇒
// itx.rpcStubs.get('<rpcStubKey>')` — the log records the rule, never the socket. STRING AT REST: the
// event stores both halves in the string half of the codec; the core reduce parses ONCE.

import { codedError } from "../lib/errors.ts";
import { jsonEqual } from "../lib/patch.ts";
import { CoreContract, type ItxExpressionRewriteRule } from "../stream/core-processor.ts";
import type { StreamEventInput } from "../stream/events.ts";
import { callOn, walkSteps } from "./dispatch.ts";
import {
  canonicalItxExpressionPrefix,
  parse,
  print,
  toItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionPrefix,
} from "./expression.ts";

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

/** Rule 3: the most specific matching rule — or null. */
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

/** Rule 4: the call with the matched prefix replaced by the target. */
export function applyItxExpressionRewriteRule(
  target: ItxExpression,
  match: ItxExpressionPrefixMatch,
): ItxExpression {
  const { unpinnedArgs, stepsAfterMatch } = match;
  if (!unpinnedArgs) return [...target, ...stepsAfterMatch];
  const last = target.at(-1);
  return typeof last === "string"
    ? [...target.slice(0, -1), [last, ...unpinnedArgs], ...stepsAfterMatch]
    : [...target, ["", ...unpinnedArgs], ...stepsAfterMatch];
}

/** Rules 3–5 together: rewrite `call` through `rules` until its root is a built-in (`isBuiltInRoot`);
 *  the result is what runs. Throws NO_ITX_EXPRESSION_MATCH when no rule matches (default-deny) and a
 *  depth error after 32 rewrites. */
export function rewriteItxExpressionToBuiltIn(
  rules: readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
  isBuiltInRoot: (root: string) => boolean,
): ItxExpression {
  let current = call;
  for (let rewrites = 0; ; rewrites++) {
    const rootStep = current[1];
    const root = Array.isArray(rootStep) ? rootStep[0] : rootStep;
    if (current[0] === "itx" && typeof root === "string" && isBuiltInRoot(root)) return current;
    if (rewrites >= 32)
      throw new Error(`itx-expression rewriting exceeded depth 32 — self-referential rule?`);
    const winner = pickItxExpressionRewriteRule(rules, current);
    if (!winner)
      throw codedError(
        "NO_ITX_EXPRESSION_MATCH",
        `no rewrite rule matches ${JSON.stringify(print(current))} (default-deny; configure a rule first)`,
      );
    current = applyItxExpressionRewriteRule(winner.rule.target, winner.match);
  }
}

// ── THE ONE EVENT: build it, the caller appends it ──

/** `itx/rewrite-rule-configured`, STRING at rest — both halves canonicalized through the codec now, so
 *  a spelling the parser refuses fails LOUD here, in the parser's own words (the reduce would skip a
 *  target that does not parse — a rule that silently never exists). `target: null` un-sets the rule at
 *  `match`. */
export function rewriteRuleConfiguredEvent(
  match: ItxExpressionInput,
  target: ItxExpressionInput | null,
): StreamEventInput {
  const targetExpression = target === null ? null : parse(print(toItxExpression(target)));
  if (targetExpression && targetExpression[0] !== "itx")
    throw new Error(
      `a rewrite rule's target must be rooted at "itx" (a bare built-in root is unspellable — targets resolve through the rules)`,
    );
  return CoreContract.buildEvent({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: canonicalItxExpressionPrefix(match),
      target: targetExpression && print(targetExpression),
    },
  });
}

// ── THE RESOLVER (parent-constructed over the physical built-ins and a reader of the CURRENT rules) ──

export class ItxExpressionResolver {
  /** The built-ins: a plain record whose keys (kv, append, read, cd, …) are the physical-layer roots.
   *  A call `itx.<root>…` resolves DIRECTLY against these (no rule). Rules name NEW prefixes and their
   *  targets are `itx.…` expressions; they cannot spell a bare root, so the built-ins are unshadowable. */
  readonly #builtIns: Record<string, unknown>;
  readonly #rewriteRules: () => readonly ItxExpressionRewriteRule[];

  constructor(args: {
    builtIns: Record<string, unknown>;
    rewriteRules: () => readonly ItxExpressionRewriteRule[];
  }) {
    this.#builtIns = args.builtIns;
    this.#rewriteRules = args.rewriteRules;
  }

  /** Resolve + run one call: rewrite it to a built-in-rooted call (default-deny and the depth budget
   *  live in `rewriteItxExpressionToBuiltIn`), then evaluate that call against the physical scope: the
   *  root, its args if the root step is a call, the remaining steps (dispatch.ts walkSteps), and finally
   *  any runtime `extraArgs` (the fetch lane hands the live Request in here — a Request is not
   *  expression data). */
  async resolve(call: ItxExpressionInput, extraArgs?: unknown[]): Promise<unknown> {
    const rewritten = rewriteItxExpressionToBuiltIn(
      this.#rewriteRules(),
      toItxExpression(call),
      (root) => Object.hasOwn(this.#builtIns, root),
    );
    const rootStep = rewritten[1] as string | [string, ...unknown[]];
    let value: unknown = this.#builtIns[Array.isArray(rootStep) ? rootStep[0] : rootStep];
    let receiver: unknown = undefined;
    if (Array.isArray(rootStep)) value = await callOn(value, receiver, rootStep.slice(1));
    ({ value, receiver } = await walkSteps({ value, receiver }, rewritten.slice(2), "remainder"));
    if (extraArgs) value = await callOn(value, receiver, extraArgs);
    return await value;
  }
}
