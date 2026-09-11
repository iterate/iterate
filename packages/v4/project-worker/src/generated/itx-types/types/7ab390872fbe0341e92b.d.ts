import { z } from "./66f12fdbe94056929e4c";
import type { ItxExpression } from "./080e8cd0d44c438e565a";
import { InvokeHandle } from "./3bca5abf8882b57630ae";
import type { StreamEvent, StreamEventInput } from "./75d416d5b9068a0a8f2a";
import type { SqlStorageHandle } from "./fdc36f90cb873a8b63c6";
export declare const REPOSITORY_COMMITTED = "events.iterate.com/repo/committed";
declare const CommitInput: z.ZodObject<{
    message: z.ZodString;
    files: z.ZodRecord<z.ZodString, z.ZodString>;
    parent: z.ZodNullable<z.ZodString>;
    idempotencyKey: z.ZodOptional<z.ZodString>;
    offset: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type RepositoryHead = {
    revision: string;
    parent: string | null;
    message: string;
    offset: number;
};
export type RepositoryRevision = RepositoryHead & {
    files: Record<string, string>;
};
export type RepositoryCommitInput = z.input<typeof CommitInput>;
export type RepositoryScope = {
    get(path: string): RepositoryHandle;
};
export declare class RepositoryHandle extends InvokeHandle {
    #private;
    constructor(repositories: Repositories, repoPath: string, append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>);
    commit(input: RepositoryCommitInput): Promise<RepositoryHead>;
    head(): RepositoryHead | null;
    read(revision?: string): RepositoryRevision;
    list(): RepositoryHead[];
}
export declare class Repositories {
    #private;
    constructor(sql: SqlStorageHandle);
    scope(append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>): RepositoryScope;
    prepare(...events: StreamEventInput[]): Promise<StreamEventInput[]>;
    commitEvent(repoPath: string, input: RepositoryCommitInput): Promise<StreamEventInput>;
    apply(event: StreamEvent): void;
    commit(repoPath: string, append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>, input: RepositoryCommitInput): Promise<RepositoryHead>;
    dispatch(repoPath: string, append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>, steps: ItxExpression): unknown;
    head(repoPath: string): RepositoryHead | null;
    list(repoPath: string): RepositoryHead[];
    read(repoPath: string, revision?: string): RepositoryRevision;
    commitAt(repoPath: string, revision: string): RepositoryHead;
    assertRepoPath(path: string): void;
    files(files: Record<string, string>): Record<string, string>;
    prepareOne(event: StreamEventInput): Promise<StreamEventInput>;
}
export {};
