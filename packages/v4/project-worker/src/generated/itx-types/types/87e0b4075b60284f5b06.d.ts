import type { ItxExpression } from "./080e8cd0d44c438e565a";
export declare const ITX_EXPRESSION_FETCH_HEADER = "x-itx-expression";
export declare function itxExpressionEndingInFetch(expr: ItxExpression): ItxExpression;
type FetchUpgradeMarker = {
    webSocketUpgrade: true;
};
export type RpcStubFetchTransport = {
    fetch(upgradeId: string, itxExpressionSteps: ItxExpression, request: Request): Promise<unknown>;
};
export declare function dialRpcStubFetch(providerFetch: (request: Request) => Promise<unknown>, request: Request, upgradeId: string, durableObject: {
    fetch(url: string, init?: RequestInit): Promise<Response>;
}): Promise<Response | FetchUpgradeMarker>;
export declare class RpcStubFetchServer {
    #private;
    constructor(ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">);
    serve(transport: RpcStubFetchTransport, itxExpressionSteps: ItxExpression, request: Request): Promise<unknown>;
    acceptFetchUpgradeLeg(request: Request): Response | null;
    handleWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): boolean;
    handleWebSocketClose(ws: WebSocket, code?: number, reason?: string): boolean;
}
export {};
