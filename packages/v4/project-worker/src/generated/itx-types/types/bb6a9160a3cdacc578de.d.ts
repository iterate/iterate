import type { StreamEventInput } from "./75d416d5b9068a0a8f2a";
import { type ItxExpression, type ItxExpressionInput, type ItxExpressionPrefix } from "./080e8cd0d44c438e565a";
export type ItxExpressionRewriteRule = {
    match: ItxExpressionPrefix;
    target: ItxExpression | null;
};
export declare const BUILTINS_ROOT = "builtins";
export declare const isBuiltInsRooted: (call: ItxExpression) => boolean;
type ItxExpressionPrefixMatch = {
    unpinnedArgs?: unknown[];
    stepsAfterMatch: ItxExpression;
};
export declare function matchItxExpressionPrefix(match: ItxExpressionPrefix, call: ItxExpression): ItxExpressionPrefixMatch | null;
export declare function pickItxExpressionRewriteRule(rules: readonly ItxExpressionRewriteRule[], call: ItxExpression): {
    rule: ItxExpressionRewriteRule;
    match: ItxExpressionPrefixMatch;
} | null;
export declare function resolveItxExpression(rules: () => readonly ItxExpressionRewriteRule[], call: ItxExpression): ItxExpression[];
export declare function rewriteRuleConfiguredEvent(match: ItxExpressionInput, target: ItxExpressionInput | null): StreamEventInput;
export declare function rowsNamingRpcStub(args: {
    rpcStubKey: string;
    rules: readonly ItxExpressionRewriteRule[];
    subscriptionTargets: Record<string, ItxExpression>;
}): {
    ruleMatches: ItxExpressionPrefix[];
    subscriptionNames: string[];
};
export declare function rpcStubKeysNamed(args: {
    rules: readonly ItxExpressionRewriteRule[];
    subscriptionTargets: Record<string, ItxExpression>;
}): Set<string>;
export declare function rewriteRuleRemovedEvent(match: ItxExpressionInput): StreamEventInput;
export declare class ItxExpressionResolver {
    #private;
    constructor(args: {
        builtIns: Record<string, unknown>;
        rewriteRules: () => readonly ItxExpressionRewriteRule[];
    });
    resolve(call: ItxExpressionInput): ItxExpression[];
    invoke(call: ItxExpressionInput, ...extraArgs: unknown[]): Promise<unknown>;
}
export {};
