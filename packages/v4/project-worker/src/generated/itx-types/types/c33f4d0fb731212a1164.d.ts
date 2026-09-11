import type { ItxExpressionInput } from "./080e8cd0d44c438e565a";
import { type CoreState } from "./5baae26f8eeba2c06c27";
import { type StreamEvent, type StreamEventInput } from "./75d416d5b9068a0a8f2a";
import { StreamStorage, type DurableObjectStorageSlice } from "./3c27d796492025926c85";
export interface StreamPage {
    events: StreamEvent[];
    scannedThroughOffset: number;
    atHead: boolean;
}
export interface StreamCommitParticipant {
    apply(event: StreamEvent, system: boolean): void;
}
export type WaitForEventFilter = {
    type?: string;
    afterOffset?: number;
    timeoutMs?: number;
};
interface StreamDeps {
    storage: DurableObjectStorageSlice;
    path: string;
    projectId: string;
    onCommit: (freshEvents: StreamEvent[], afterOffset: number, throughOffset: number) => void;
    participant?: StreamCommitParticipant;
}
export declare class Stream {
    #private;
    readonly storage: StreamStorage;
    constructor(deps: StreamDeps);
    appendCreatedAndWokenEvents(): void;
    currentIncarnation(): number;
    highestAssignedOffset(): number;
    highestDurableOffset(): number;
    get coreReducedState(): CoreState;
    coreReducedStateSnapshot(): {
        offset: number;
        state: CoreState;
    };
    coreLiveStateSnapshot(): {
        rev: number;
        state: CoreState;
    };
    append(...events: StreamEventInput[]): StreamEvent[];
    appendSystem(...events: StreamEventInput[]): StreamEvent[];
    read(afterOffset?: number, limit?: number): StreamPage;
    waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
    armAlarmNoLaterThan(atMs: number): void;
    noteAlarmFired(): void;
}
export interface ReachableContext {
    append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
    read(afterOffset?: number, limit?: number): Promise<StreamPage>;
    invoke(call: ItxExpressionInput): Promise<unknown>;
}
export declare function localReachableContext(self: {
    append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
    read(afterOffset?: number, limit?: number): StreamPage;
    invoke(call: ItxExpressionInput): Promise<unknown>;
}): ReachableContext;
export {};
