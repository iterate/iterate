export type DurableObjectAddress = {
    projectId: string;
    path: string;
    name: string;
};
export declare function resolveContextPath(basePath: string, contextPath: string): string;
export declare const DurableObjectNameCodec: {
    stringify({ projectId, path }: {
        projectId: string;
        path: string;
    }): string;
    parse(name: string): DurableObjectAddress;
};
