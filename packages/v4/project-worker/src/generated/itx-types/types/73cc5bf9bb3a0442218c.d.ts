import type { BuiltInScope } from "./f8e0db051d0519d9de51";
import { type CapnwebConnection, type CapnwebConnectOptions } from "./a48fbbbdc84558dc0172";
import { type McpConnection, type McpConnectOptions } from "./21e96c1e4793305dc6a8";
import { type OpenApiConnection, type OpenApiConnectOptions, type OpenApiDocument } from "./5e160cbf9fc6e45f5613";
export type LibraryItx = Pick<BuiltInScope, "fetch">;
export interface LibraryRoots {
    connectToMcp(url: string, options?: McpConnectOptions): Promise<McpConnection>;
    connectToOpenApi(specOrUrl: string | OpenApiDocument, options?: OpenApiConnectOptions): Promise<OpenApiConnection>;
    connectToCapnweb(url: string, options?: CapnwebConnectOptions): Promise<CapnwebConnection>;
}
export declare function buildLibrary(itx: LibraryItx): {
    roots: LibraryRoots;
    releaseConnections(): void;
};
export declare function subclassWithMethods<Base extends abstract new (...args: never[]) => object>(base: Base, names: string[], call: (self: InstanceType<Base>, name: string, input: unknown) => unknown): Base;
export declare function responseRefusal(response: Response, what: string): Promise<Error>;
export declare function responseTextPrefix(response: Response, limit?: number): Promise<string>;
export declare function refuseUnlessOk(response: Response, what: string): Promise<Response>;
