import { RpcTarget } from "./69744e22e20f005565f2";
import { type LibraryItx } from "./73cc5bf9bb3a0442218c";
export type OpenApiConnectOptions = {
    baseUrl?: string;
    headers?: Record<string, string>;
};
export type OpenApiDocument = {
    openapi: string;
    servers?: Array<{
        url?: string;
    }>;
    paths?: Record<string, Record<string, unknown>>;
};
export type OpenApiOperation = {
    operationId: string;
    method: string;
    path: string;
    parameters: Array<{
        name: string;
        in: string;
        required?: boolean;
    }>;
    hasRequestBody: boolean;
    summary?: string;
};
export declare function connectToOpenApi(itx: LibraryItx, specOrUrl: string | OpenApiDocument, options?: OpenApiConnectOptions): Promise<OpenApiConnection>;
export declare class OpenApiConnection extends RpcTarget {
    #private;
    constructor(itx: LibraryItx, operations: OpenApiOperation[], base: URL, headers: Record<string, string>);
    operations(): OpenApiOperation[];
    call(operationId: string, input?: Record<string, unknown>): Promise<unknown>;
}
