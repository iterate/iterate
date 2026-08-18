export interface ScannerPathPolicyEntry {
  path: string;
  reason: string;
  evidence: {
    observedOn: `${number}-${number}-${number}`;
    productionInvocations: number;
    source: string;
  };
}

/**
 * Reviewed exact paths that Iterate will never intentionally serve.
 *
 * Additions need production traffic evidence and a compatibility review.
 * Discovered scanner candidates do not become blocks automatically.
 */
export const scannerPathPolicy = [
  {
    path: "/.git/config",
    reason: "A public Git configuration is a source-disclosure probe, not an Iterate route.",
    evidence: {
      observedOn: "2026-08-17",
      productionInvocations: 997,
      source: "docs/cloudflare-public-scanner-edge-gate-research-2026-08-18.md",
    },
  },
  {
    path: "/.git/head",
    reason: "A public Git HEAD file is a source-disclosure probe, not an Iterate route.",
    evidence: {
      observedOn: "2026-08-17",
      productionInvocations: 574,
      source: "docs/cloudflare-public-scanner-edge-gate-research-2026-08-18.md",
    },
  },
  {
    path: "/.env",
    reason: "A public dotenv file is a secret-disclosure probe, not an Iterate route.",
    evidence: {
      observedOn: "2026-08-17",
      productionInvocations: 443,
      source: "docs/cloudflare-public-scanner-edge-gate-research-2026-08-18.md",
    },
  },
] as const satisfies readonly ScannerPathPolicyEntry[];
