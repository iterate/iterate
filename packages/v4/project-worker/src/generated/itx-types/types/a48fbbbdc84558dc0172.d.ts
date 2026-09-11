import { type RpcStub } from "./69744e22e20f005565f2";
import { InvokeHandle } from "./3bca5abf8882b57630ae";
import { type LibraryItx } from "./73cc5bf9bb3a0442218c";
type RemoteMain = RpcStub<any>;
export type CapnwebConnectOptions = {
    headers?: Record<string, string>;
    transport?: "websocket" | "batch";
};
export declare function connectToCapnweb(itx: LibraryItx, url: string, options?: CapnwebConnectOptions): Promise<CapnwebConnection>;
export declare class CapnwebConnection extends InvokeHandle {
    #private;
    constructor(remoteMain: () => RemoteMain | Promise<RemoteMain>, closeSession: () => void);
    [Symbol.dispose](): void;
}
export {};
