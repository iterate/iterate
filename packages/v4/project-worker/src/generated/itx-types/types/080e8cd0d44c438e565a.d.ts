export type ItxExpressionStep = string | [method: string, ...args: unknown[]];
export type ItxExpression = ItxExpressionStep[];
export type ItxExpressionInput = string | ItxExpression;
export type ItxExpressionPrefix = ItxExpression;
export declare const itxExpressionStepName: (step: ItxExpressionStep | undefined) => string | undefined;
export declare const ITX_EXPRESSION_MERGE_KEY = "...@";
export declare const isItxExpressionHole: (value: unknown) => boolean;
export declare function containsItxExpressionHole(value: unknown): boolean;
export declare function parse(source: string, options?: {
    holes?: boolean;
}): ItxExpression;
export declare function toItxExpression(input: ItxExpressionInput, options?: {
    holes?: boolean;
}): ItxExpression;
export declare function print(expr: ItxExpression, options?: {
    holes?: boolean;
}): string;
export declare function parseItxExpressionPrefix(source: ItxExpressionInput): ItxExpressionPrefix;
export declare function canonicalItxExpressionPrefix(source: ItxExpressionInput): string;
