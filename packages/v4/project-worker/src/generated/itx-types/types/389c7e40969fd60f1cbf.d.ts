import type { z } from "./66f12fdbe94056929e4c";
import type { ReduceCheckpointStore } from "./fdc36f90cb873a8b63c6";
import type { StreamEvent, StreamEventInput } from "./75d416d5b9068a0a8f2a";
export type EventDefinition = {
    description?: string;
    payloadSchema: z.ZodType;
};
export type ProcessorContract<State = unknown> = {
    slug: string;
    version: string;
    description?: string;
    consumes: readonly string[];
    emits: readonly string[];
    initialState: () => State;
};
export type ProcessorStream = {
    append(...events: StreamEventInput[]): Promise<StreamEvent[]> | StreamEvent[];
    read(afterOffset?: number, limit?: number): Promise<{
        events: StreamEvent[];
        scannedThroughOffset: number;
        atHead: boolean;
    }>;
};
export type ScannedRange = {
    after: number;
    through: number;
};
export type ReduceArgs<State> = {
    event: StreamEvent;
    state: State;
};
export type ProcessEventArgs<State> = {
    event: StreamEvent | null;
    state: State;
    previousState: State;
    append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>;
    blockProcessorWhile: (work: () => Promise<unknown>) => void;
    runInBackground: (work: () => Promise<unknown>) => void;
    delivery: {
        caughtUp: boolean;
    };
};
export declare function consumesEvent(consumes: readonly string[] | undefined, event: {
    type: string;
    ephemeral?: boolean;
}): boolean;
export declare abstract class StreamProcessor<State> {
    abstract readonly contract: ProcessorContract<State>;
    reduce(_args: ReduceArgs<State>): State | null | undefined;
    processEvent(_args: ProcessEventArgs<State>): undefined;
    projectLiveState(state: State): unknown;
    idempotencyKey(key: string, event?: StreamEvent): string;
}
export declare class ProcessorEngine<State> {
    #private;
    readonly processor: StreamProcessor<State>;
    constructor(processor: StreamProcessor<State>, deps: {
        stream: ProcessorStream;
        storage: ReduceCheckpointStore;
    });
    liveSnapshot(): Promise<{
        rev: number;
        state: unknown;
    }>;
    publishLiveState(): void;
    processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void>;
    catchUpFromLog(): Promise<void>;
    snapshot(): Promise<{
        offset: number;
        state: State;
    }>;
    waitUntilProcessed(input: {
        offset: number;
        timeoutMs?: number;
    }): Promise<void>;
}
