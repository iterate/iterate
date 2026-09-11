import { DurableObject } from "cloudflare:workers";
import type { StreamEvent, StreamEventInput } from "./75d416d5b9068a0a8f2a";
import type Bundler from "./581c345a256482709232";
import type { OptionalAuthEnv } from "./6de4ba9e7ec6f24ce58c";
import { type ItxExpressionInput } from "./080e8cd0d44c438e565a";
import { type StreamPage, type WaitForEventFilter } from "./c33f4d0fb731212a1164";
import { RpcStubDirectory } from "./c16e651aed9e271a5631";
import { type AppConfigEnv } from "./8edaf48a252ded9b3146";
export interface Env extends AppConfigEnv, OptionalAuthEnv {
    BUNDLER: Service<Bundler>;
    ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
    LOADER: WorkerLoader;
    ITX_KV: KVNamespace;
    AI: Ai;
    SECRETS_KV?: KVNamespace;
    EGRESS_KEY?: string;
    EXPERIMENT_ADMIN_TOKEN?: string;
    FALLBACK: Fetcher;
}
export declare class IterateContextDurableObject extends DurableObject<Env> {
    #private;
    constructor(ctx: DurableObjectState, env: Env);
    append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
    waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
    read(afterOffset?: number, limit?: number): StreamPage;
    alarm(): Promise<void>;
    invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown>;
    fetch(request: Request): Promise<Response>;
    rpcStubTransportState(): ReturnType<RpcStubDirectory["rpcStubTransportState"]>;
    putSecret(input: unknown): Promise<import("./91feeeb0f7711c878b20").SecretReceipt>;
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void;
    webSocketClose(ws: WebSocket, code: number, reason: string): void;
    webSocketError(ws: WebSocket): void;
    lendRpcStub(input: {
        rpcStubKey: string;
        stub: unknown;
    }): void;
}
