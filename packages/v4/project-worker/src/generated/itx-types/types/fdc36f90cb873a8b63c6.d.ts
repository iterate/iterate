export type SqlStorageHandle = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): Iterable<T> & {
        toArray(): T[];
    };
};
export type ReduceCheckpoint<State> = {
    reducerVersion: string;
    reducedThroughOffset: number;
    state: State | undefined;
};
export interface ReduceCheckpointStore {
    read<State>(slug: string): ReduceCheckpoint<State> | undefined;
    write<State>(slug: string, cursor: {
        reducerVersion: string;
        reducedThroughOffset: number;
    }, state: State, stateChanged: boolean): void;
}
export declare class ReduceCheckpointTable implements ReduceCheckpointStore {
    #private;
    constructor(sql: SqlStorageHandle, options?: {
        createTable: boolean;
    });
    static createTable(sql: SqlStorageHandle): void;
    read<State>(slug: string): ReduceCheckpoint<State> | undefined;
    write<State>(slug: string, cursor: {
        reducerVersion: string;
        reducedThroughOffset: number;
    }, state: State, stateChanged: boolean): void;
}
