import { z } from "./66f12fdbe94056929e4c";
import type { SqlStorageHandle } from "./fdc36f90cb873a8b63c6";
declare const ProvenanceEvidence: z.ZodObject<{
    signatures: z.ZodArray<z.ZodObject<{
        algorithm: z.ZodLiteral<"Ed25519">;
        publicKey: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ProvenanceEvidence = z.infer<typeof ProvenanceEvidence>;
export type ProvenanceVerification = {
    signerKeyIds: string[];
    signers?: {
        keyId: string;
        trusted: boolean;
    }[];
    level?: 0 | 1 | 2;
    policyOffset?: number;
};
declare const TrustPolicy: z.ZodObject<{
    keys: z.ZodArray<z.ZodString>;
    minimumLevel: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>]>;
    minimumSigners: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type TrustPolicy = z.infer<typeof TrustPolicy>;
export declare const TRUST_CONFIGURATION = "events.iterate.com/provenance/trust-configured";
type TrustState = {
    policy: TrustPolicy | undefined;
    policyOffset: number;
};
export type TrustDecision = {
    verification: ProvenanceVerification | undefined;
    nextPolicy?: TrustPolicy;
};
export declare function isTrustConfiguration(event: {
    type: unknown;
    payload?: unknown;
}): boolean;
export declare function decideTrust(event: {
    type: string;
    payload?: unknown;
    provenance?: unknown;
    ephemeral?: true;
}, cryptoVerification: ProvenanceVerification | undefined, state: TrustState): TrustDecision;
export declare class TrustPolicyStore {
    #private;
    constructor(sql: SqlStorageHandle);
    apply(event: {
        type: string;
        payload?: Record<string, unknown>;
        provenance?: ProvenanceEvidence;
        ephemeral?: true;
        verification?: ProvenanceVerification;
        offset: number;
    }): void;
}
export declare function provenanceMessage(input: Record<string, unknown>, location: {
    projectId: string;
    path: string;
}): string;
export declare function prepareProvenance(input: Record<string, unknown>, location: {
    projectId: string;
    path: string;
}): Promise<ProvenanceVerification | undefined>;
export {};
