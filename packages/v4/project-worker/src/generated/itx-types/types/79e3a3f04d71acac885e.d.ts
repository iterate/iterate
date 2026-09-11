import { type ItxExpression, type ItxExpressionInput } from "./080e8cd0d44c438e565a";
export type NativeWorkerCode = Omit<WorkerLoaderWorkerCode, "env"> & {
    env?: Record<string, unknown>;
};
export type NativeWorkerCacheOptions = {
    cacheKey?: string;
    deployId: string;
    owner: string;
};
export declare function loadNativeWorker(loader: WorkerLoader, itxEntrypoint: Fetcher, code: NativeWorkerCode): WorkerStub;
export declare function loadNativeWorker(loader: WorkerLoader, itxEntrypoint: Fetcher, code: NativeWorkerCode, options: NativeWorkerCacheOptions): Promise<WorkerStub>;
export declare function facetLoaderOwner(iterateContextName: string, discriminator: string): string;
export type WorkerModules = Record<string, string>;
export type WorkerSource = WorkerModules | ItxExpressionInput;
export type WorkerCacheKey = string;
export type FacetSpec = {
    source: WorkerSource;
    cacheKey?: WorkerCacheKey;
    className: string;
};
export declare const facetSpecOf: ({ source, cacheKey, className }: FacetSpec) => FacetSpec;
type LoadConfinedWorkerOptions = {
    env: {
        LOADER: WorkerLoader;
    };
    deployId: string;
    itxEntrypoint: Fetcher;
    kind: "worker" | "facet";
    owner: string;
    source: WorkerSource;
    cacheKey?: WorkerCacheKey;
    invoke: (call: ItxExpression) => Promise<unknown>;
    where: string;
};
export declare function loadConfinedWorker(opts: LoadConfinedWorkerOptions): Promise<{
    worker: WorkerStub;
    loaderId: string;
}>;
export {};
