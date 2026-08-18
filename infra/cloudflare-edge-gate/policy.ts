export interface ScannerPathPolicyEntry {
  path: string;
  reason: string;
  evidence: {
    observedOn: `${number}-${number}-${number}`;
    productionInvocations: number;
  };
}

/** Reviewed exact paths that Iterate will never intentionally serve. */
export const scannerPathPolicy = [
  {
    path: "/.git/config",
    reason: "A public Git configuration is a source-disclosure probe, not an Iterate route.",
    evidence: {
      observedOn: "2026-08-17",
      productionInvocations: 997,
    },
  },
  {
    path: "/.git/head",
    reason: "A public Git HEAD file is a source-disclosure probe, not an Iterate route.",
    evidence: {
      observedOn: "2026-08-17",
      productionInvocations: 574,
    },
  },
  {
    path: "/.env",
    reason: "A public dotenv file is a secret-disclosure probe, not an Iterate route.",
    evidence: {
      observedOn: "2026-08-17",
      productionInvocations: 443,
    },
  },
] as const satisfies readonly ScannerPathPolicyEntry[];
