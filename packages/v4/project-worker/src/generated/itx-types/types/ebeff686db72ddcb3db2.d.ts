export type PatchOp = {
    op: "add";
    path: string;
    value: unknown;
} | {
    op: "replace";
    path: string;
    value: unknown;
} | {
    op: "remove";
    path: string;
};
export declare function jsonEqual(a: unknown, b: unknown): boolean;
export declare function diff(a: unknown, b: unknown): PatchOp[] | undefined;
export declare function applyPatch<T>(doc: T, ops: PatchOp[]): T;
