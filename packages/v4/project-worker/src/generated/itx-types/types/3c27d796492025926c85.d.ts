import { ReduceCheckpointTable, type SqlStorageHandle } from "./fdc36f90cb873a8b63c6";
export type DurableObjectStorageSlice = {
    sql: SqlStorageHandle;
    transactionSync<T>(closure: () => T): T;
    setAlarm(scheduledTime: number | Date): Promise<void>;
};
export type SubscriptionCursor = {
    confirmedOffset: number;
    attempt: number;
    nextAttemptAtMs?: number;
    resumeAppliedAtOffset?: number;
};
export type StoredEventRow = {
    offset: number;
    body: string;
    estimatedDecodedBytes?: number;
};
export type StreamResourceHalt = {
    offset: number;
    estimatedBytes: number;
};
export declare class StreamStorage {
    #private;
    readonly reduceCheckpoints: ReduceCheckpointTable;
    readonly incarnation: number;
    constructor(storage: DurableObjectStorageSlice);
    transactionSync<T>(closure: () => T): T;
    setAlarm(atMs: number): Promise<void>;
    highestEventOffset(): number;
    readActivityHead(): number | undefined;
    writeActivityHead(offset: number): void;
    readResourceHalt(): StreamResourceHalt | undefined;
    writeResourceHalt(halt: StreamResourceHalt): void;
    insertEvent(offset: number, serializedBody: string, idempotencyKey: string | null): void;
    readEventByIdempotencyKey(idempotencyKey: string): StoredEventRow | undefined;
    readEventPage(afterOffset: number, limit: number, budgetBytes: number, parsedBudgetBytes: number): {
        rows: StoredEventRow[];
        bytes: number;
        nextRowDidNotFit: boolean;
    };
    listSubscriptionCursors(): [name: string, cursor: SubscriptionCursor][];
    writeSubscriptionCursor(name: string, cursor: SubscriptionCursor): void;
    deleteSubscriptionCursor(name: string): void;
}
