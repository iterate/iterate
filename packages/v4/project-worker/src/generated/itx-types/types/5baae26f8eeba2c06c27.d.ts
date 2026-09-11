import { type ItxExpression } from "./080e8cd0d44c438e565a";
import { type ItxExpressionRewriteRule } from "./bb6a9160a3cdacc578de";
import type { StreamEvent, StreamEventInput } from "./75d416d5b9068a0a8f2a";
import { StreamProcessor, type ProcessorContract, type ReduceArgs } from "./389c7e40969fd60f1cbf";
export type { ItxExpressionRewriteRule } from "./bb6a9160a3cdacc578de";
export declare class FacetStartupMemoAdmissionError extends Error {
    readonly code = "FACET_STARTUP_MEMO_TOO_LARGE";
    readonly retryable = false;
    readonly data: {
        name: string;
        bytes: number;
        maxBytes: number;
    };
    constructor(name: string, bytes: number);
}
export type HostingFacetSpec = {
    name: string;
    source: unknown;
    className: string;
    cacheKey?: string;
};
export declare function facetSpecFromHostingTarget(resolvedTarget: ItxExpression): HostingFacetSpec | undefined;
export type Subscription = {
    target: ItxExpression;
    consumes?: string[];
    configuredAtOffset: number;
    hostedFacet?: {
        name: string;
        className: string;
        cacheKey?: string;
    };
    halted?: {
        afterOffset: number;
        attempts: number;
        error?: string;
    };
    resumed?: {
        afterOffset?: number;
        atOffset: number;
    };
};
export type CoreState = {
    projectId?: string;
    path?: string;
    createdAt?: string;
    incarnation?: number;
    paused: {
        reason: string;
    } | null;
    itxExpressionRewriteRules: Record<string, ItxExpressionRewriteRule>;
    subscriptions: Record<string, Subscription>;
};
export declare function parseSubscriptionName(name: string): string;
export declare function assertCoreControlEventMayLand(event: StreamEventInput): void;
export declare const CoreContract: ProcessorContract<CoreState> & {
    buildEvent: (event: {
        type: string;
        payload?: Record<string, unknown>;
        idempotencyKey?: string;
    }) => StreamEventInput;
};
export declare class CoreStreamProcessor extends StreamProcessor<CoreState> {
    #private;
    readonly contract: ProcessorContract<CoreState> & {
        buildEvent: (event: {
            type: string;
            payload?: Record<string, unknown>;
            idempotencyKey?: string;
        }) => StreamEventInput;
    };
    reduceBatch(events: StreamEvent[], state: CoreState, onError: (error: unknown, event: StreamEvent) => void): CoreState;
    reduce({ event, state }: ReduceArgs<CoreState>): CoreState | undefined;
}
