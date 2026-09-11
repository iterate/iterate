import { RpcTarget } from "./69744e22e20f005565f2";
import { IterateContext, type IterateContextNamespace, type WaitUntil } from "./d4c683507904cab5d4f0";
import type { BrowserPrincipal } from "./6de4ba9e7ec6f24ce58c";
type LeaseTarget = {
    pager?: {
        dispose(): void;
    };
    undo?: () => void;
};
export declare class ContextLeaseBook {
    #private;
    lease(contextName: string, key: string, target: LeaseTarget): {
        dispose(): void;
    };
    disposeAll(): void;
}
export { ContextLeaseBook as SessionTeardown };
export declare class UnauthenticatedSession extends RpcTarget {
    #private;
    constructor(contextNamespace: IterateContextNamespace, ctx: ExecutionContext, principal?: BrowserPrincipal);
    [Symbol.dispose](): void;
    authenticate(_credentials?: unknown): Session;
}
declare class Session extends RpcTarget {
    #private;
    constructor(contextNamespace: IterateContextNamespace, leases: ContextLeaseBook, waitUntil: WaitUntil, principal?: BrowserPrincipal);
    get projects(): ProjectCollection;
    identity(): BrowserPrincipal | null;
}
declare class ProjectCollection extends RpcTarget {
    #private;
    constructor(contextNamespace: IterateContextNamespace, leases: ContextLeaseBook, waitUntil: WaitUntil);
    get(projectId: string): IterateContext;
}
