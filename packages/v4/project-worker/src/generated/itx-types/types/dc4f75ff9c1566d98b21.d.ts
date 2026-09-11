import type { RpcStub as CapnwebRpcStub, RpcTarget as CapnwebRpcTarget } from "./69744e22e20f005565f2";
import type { IterateContextDurableObject } from "./a1f1aad266a28cfaff7b";
import type { StreamEventInput } from "./75d416d5b9068a0a8f2a";
export type IterateContextDurableObjectStub = DurableObjectStub<IterateContextDurableObject>;
export type ClientRpcStub = CapnwebRpcStub<CapnwebRpcTarget | ((...args: never[]) => unknown)>;
export declare function lendRpcStubOverPager(durableObject: IterateContextDurableObjectStub, clientRpcStub: ClientRpcStub, rpcStubKey: string, appendEvents: StreamEventInput[], waitUntil: (p: Promise<unknown>) => void): Promise<{
    dispose(): void;
}>;
