import type { ReachableContext, StreamPage, WaitForEventFilter } from "./c33f4d0fb731212a1164";
import type { StreamEvent, StreamEventInput } from "./75d416d5b9068a0a8f2a";
import type { LibraryRoots } from "./73cc5bf9bb3a0442218c";
import type { RepositoryScope } from "./7ab390872fbe0341e92b";
import type { BuildInput, BuildResult, CheckResult } from "./8baa80389791d8263744";
import type { SecretReceipt, ApprovalReceipt } from "./91feeeb0f7711c878b20";
import { type ItxExpression, type ItxExpressionInput } from "./080e8cd0d44c438e565a";
import { FacetHandle, InvokeHandle, RpcStubHandle } from "./3bca5abf8882b57630ae";
import { type NativeWorkerCode, type FacetSpec, type WorkerCacheKey, type WorkerSource } from "./79e3a3f04d71acac885e";
export type RewriteRuleListEntry = {
    match: string;
    target: string | null;
    origin: "platform" | "context";
};
export type SubscriptionListEntry = {
    name: string;
    target: string;
    consumes?: string[];
    configuredAtOffset: number;
    hostedFacet?: {
        name: string;
        className: string;
        cacheKey?: string;
    };
    cursor?: {
        confirmedOffset: number;
        attempt: number;
        nextAttemptAtMs?: number;
    };
    halted?: {
        afterOffset: number;
        attempts: number;
        error?: string;
    };
};
export interface BuiltInScope extends LibraryRoots {
    build(input: BuildInput): Promise<BuildResult>;
    check(input: BuildInput): Promise<CheckResult>;
    repos: RepositoryScope;
    secrets: {
        list(): SecretReceipt[];
    };
    approvals: {
        pending(): ApprovalReceipt[];
    };
    builtins: Omit<BuiltInScope, "builtins">;
    whoami(): {
        projectId: string;
        path: string;
    };
    kv: {
        get(key: string): Promise<string | null>;
        put(key: string, value: string): Promise<{
            ok: true;
        }>;
        delete(key: string): Promise<{
            ok: true;
        }>;
        list(prefix?: string): Promise<{
            keys: string[];
        }>;
    };
    ai: Ai;
    append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
    readEvents(afterOffset?: number, limit?: number): Promise<StreamPage>;
    waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
    cd(path: string): InvokeHandle;
    fetch(request: Request): Promise<Response>;
    rpcStubs: {
        get(rpcStubKey: string): RpcStubHandle;
        list(): string[];
    };
    rewriteRules: {
        list(): RewriteRuleListEntry[];
        get(match: string): RewriteRuleListEntry | null;
        resolve(call: ItxExpressionInput): string[];
    };
    facets: {
        get(name: string, spec?: FacetSpec): FacetHandle;
    };
    subscriptions: {
        list(): SubscriptionListEntry[];
        get(name: string): SubscriptionListEntry | null;
    };
    workers: {
        load(code: NativeWorkerCode, options?: {
            className?: string;
            props?: unknown;
            cacheKey?: string;
        }): InvokeHandle;
        get(spec: {
            source: WorkerSource;
            cacheKey?: WorkerCacheKey;
            className?: string;
            props?: unknown;
        }): InvokeHandle;
    };
    runScript(script: string, ...args: unknown[]): Promise<unknown>;
}
interface BuildBuiltInsDeps {
    secrets: BuiltInScope["secrets"];
    approvals: BuiltInScope["approvals"];
    build: BuiltInScope["build"];
    check: BuiltInScope["check"];
    repos: RepositoryScope;
    projectId: string;
    path: string;
    iterateContextName: string;
    env: {
        LOADER: WorkerLoader;
        ITX_KV: KVNamespace;
        AI: Ai;
    };
    deployId: string;
    invoke: (call: ItxExpression) => Promise<unknown>;
    context: (path: string) => ReachableContext;
    egress: (request: Request) => Promise<Response>;
    rpcStubs: BuiltInScope["rpcStubs"];
    subscriptions: BuiltInScope["subscriptions"];
    rewriteRules: BuiltInScope["rewriteRules"];
    waitForEvent: BuiltInScope["waitForEvent"];
    facets: BuiltInScope["facets"];
    itxEntrypoint: Fetcher;
    library: LibraryRoots;
}
export declare function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown>;
export {};
