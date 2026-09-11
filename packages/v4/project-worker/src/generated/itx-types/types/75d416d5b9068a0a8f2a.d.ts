import { jsonEqual } from "./ebeff686db72ddcb3db2";
import type { ProvenanceEvidence, ProvenanceVerification } from "./f99e33d0612d66200aae";
export { jsonEqual };
export type StreamEventInput = {
    type: string;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    source?: {
        processor?: {
            slug: string;
            version: string;
            whileProcessing?: {
                offset: number;
                type: string;
            };
        };
    };
    provenance?: ProvenanceEvidence;
    idempotencyKey?: string;
    offset?: number;
    ephemeral?: true;
};
export type StreamEvent = Omit<StreamEventInput, "offset"> & {
    verification?: ProvenanceVerification;
    offset: number;
    createdAt: string;
    path: string;
};
export declare function idempotencyConflictMessage(idempotencyKey: string, existingOffset: number): string;
export declare function sameIdempotentEvent(existingEvent: StreamEventInput, requestedEvent: StreamEventInput): boolean;
