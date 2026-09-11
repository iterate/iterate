import type { StreamEvent, StreamEventInput } from "./75d416d5b9068a0a8f2a";
import type { StreamCommitParticipant } from "./c33f4d0fb731212a1164";
export declare const EGRESS_POLICY_CONFIGURED = "events.iterate.com/egress/policy-configured";
export declare const APPROVAL_DECIDED = "events.iterate.com/approval/decided";
export type EgressPolicy = {
    approval: "none";
} | {
    approval: "required";
    expiresInMs: number;
};
export type SecretReceipt = {
    name: string;
    origin: string;
    revision: number;
};
export type PolicyReceipt = EgressPolicy & {
    revision: number;
};
export type ApprovalReceipt = {
    requestId: string;
    expiresAt: number;
    origin: string;
    method: string;
    policyRevision: number;
    decidedAtOffset: number | null;
    allow: boolean | null;
    used: boolean;
};
export type EgressPolicyOptions = {
    storage: {
        sql: SqlStorage;
        transactionSync<T>(callback: () => T): T;
    };
    context: string;
    egressKey: string | undefined;
    appendAudit: (event: StreamEventInput) => void;
    isTrustedApproval: (event: StreamEvent) => boolean;
    policyFingerprint?: () => string;
};
export declare class FetchPolicy implements StreamCommitParticipant {
    #private;
    readonly options: EgressPolicyOptions;
    constructor(options: EgressPolicyOptions);
    putSecret(input: unknown): Promise<SecretReceipt>;
    listSecrets(): SecretReceipt[];
    listApprovalReceipts(): ApprovalReceipt[];
    prepare(...events: StreamEventInput[]): StreamEventInput[];
    fetch(request: Request, terminal: (request: Request) => Promise<Response>): Promise<Response>;
    apply(event: StreamEvent): void;
}
