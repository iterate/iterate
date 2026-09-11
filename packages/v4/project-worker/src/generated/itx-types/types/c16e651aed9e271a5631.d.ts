import type { RpcStubFetchServer, RpcStubFetchTransport } from "./87e0b4075b60284f5b06";
import type { StreamEventInput } from "./75d416d5b9068a0a8f2a";
import type { ItxExpression } from "./080e8cd0d44c438e565a";
export declare const RPC_STUB_PAGER_WEBSOCKET_HEADER = "x-itx-rpc-stub-pager";
type RpcStubPagerAttachRequest = {
    rpcStubKey: string;
    appendEvents: StreamEventInput[];
};
export declare const encodeRpcStubPagerAttachRequest: (request: RpcStubPagerAttachRequest) => string;
export declare const RPC_STUB_PAGER_KEEPALIVE_REQUEST = "itx-pager-keepalive";
export declare const RPC_STUB_PAGER_KEEPALIVE_RESPONSE = "itx-pager-keepalive-ack";
export type BorrowedRpcStub = RpcStubFetchTransport & {
    invoke(itxExpressionSteps: ItxExpression): Promise<unknown>;
    dup?(): BorrowedRpcStub;
};
export declare function disposeRpcStub(x: unknown): void;
export declare class RpcStubDirectory {
    #private;
    constructor(deps: {
        ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
        onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
        rpcStubFetch: RpcStubFetchServer;
        appendEvents: (events: StreamEventInput[]) => void;
    });
    lendRpcStub(input: {
        rpcStubKey: string;
        stub: BorrowedRpcStub;
    }): void;
    invokeRpcStub(rpcStubKey: string, itxExpressionSteps: ItxExpression): Promise<unknown>;
    hasBorrowedRpcStubs(): boolean;
    returnBorrowedRpcStubs(): void;
    acceptRpcStubPagerWebSocket(request: Request): Response | null;
    rpcStubPagerClosed(ws: WebSocket): void;
    dropRpcStubPager(transportId: string, reason: string): void;
    listRpcStubKeys(): string[];
    rpcStubTransportState(): {
        rpcStubPagers: number;
        borrowedRpcStubs: number;
        rpcStubPagesInFlight: number;
        dormant: boolean;
    };
}
export {};
