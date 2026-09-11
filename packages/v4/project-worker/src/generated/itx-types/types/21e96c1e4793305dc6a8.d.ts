import { Client } from "./9ea966ee74c0d0ea9199";
import { StreamableHTTPClientTransport } from "./e23fe0d3954ac799f34a";
import { RpcTarget } from "./69744e22e20f005565f2";
import { type LibraryItx } from "./73cc5bf9bb3a0442218c";
export type McpConnectOptions = {
    headers?: Record<string, string>;
};
export type McpTool = {
    name: string;
    description?: string;
    inputSchema?: unknown;
};
export type McpServerInfo = {
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    serverInfo?: {
        name?: string;
        version?: string;
    };
};
export declare function connectToMcp(itx: LibraryItx, url: string, options?: McpConnectOptions): Promise<McpConnection>;
type Connected = {
    client: Client;
    transport: StreamableHTTPClientTransport;
    tools: McpTool[];
    serverInfo: McpServerInfo;
    failure: {
        error: Error | undefined;
    };
};
export declare class McpConnection extends RpcTarget {
    #private;
    constructor(itx: LibraryItx, url: string, headers: Record<string, string>, connected: Connected);
    serverInfo(): McpServerInfo;
    tools(): McpTool[];
    listTools(): Promise<McpTool[]>;
    callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
    [Symbol.dispose](): void;
}
export {};
