import { RpcTarget, type RpcStub } from "./69744e22e20f005565f2";
import type { IterateContextDurableObject } from "./a1f1aad266a28cfaff7b";
import { type ItxExpressionInput } from "./080e8cd0d44c438e565a";
import { type FacetSpec } from "./79e3a3f04d71acac885e";
import type { BuiltInScope } from "./f8e0db051d0519d9de51";
import { type DurableObjectAddress } from "./89db9c6ec75638affd35";
import { type ClientRpcStub } from "./dc4f75ff9c1566d98b21";
import type { ContextLeaseBook } from "./ff2336f8bcd265f360fa";
import type { StreamEvent } from "./75d416d5b9068a0a8f2a";
export type IterateContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
export type WaitUntil = (p: Promise<unknown>) => void;
type SubscriptionTarget = RpcStub<(events: StreamEvent[], range: {
    after: number;
    through: number;
}) => unknown>;
declare class RewriteRuleHandle extends RpcTarget {
    #private;
    constructor(undo: () => void);
    [Symbol.dispose](): void;
}
declare class SubscriptionHandle extends RpcTarget {
    #private;
    constructor(name: string, undo: () => void);
    get name(): string;
    [Symbol.dispose](): void;
}
export interface IterateContext extends Omit<BuiltInScope, "cd"> {
}
export declare class IterateContext extends RpcTarget {
    #private;
    constructor(contextNamespace: IterateContextNamespace, durableObjectAddress: DurableObjectAddress, leases: ContextLeaseBook, waitUntil: WaitUntil);
    cd(path: string): IterateContext;
    invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown>;
    provide(match: ItxExpressionInput, target: ClientRpcStub | ItxExpressionInput | null): Promise<RewriteRuleHandle>;
    subscribe(input: {
        name?: string;
        target: ItxExpressionInput | SubscriptionTarget | null;
        consumes?: string[];
    }): Promise<SubscriptionHandle>;
    enableProcessor(name: string, spec: FacetSpec & {
        consumes?: string[];
    }): Promise<{
        name: string;
    }>;
    disableProcessor(name: string): Promise<void>;
}
export {};
