interface ScannerPolicyEvidence {
  reason: string;
  evidence: {
    observedOn: `${number}-${number}-${number}`;
    productionInvocations: number;
  };
}

export type ScannerPolicyEntry = ScannerPolicyEvidence &
  ({ path: string; extension?: undefined } | { extension: string; path?: undefined });

/** Reviewed request shapes that Iterate will never intentionally serve. */
export const scannerPolicy = [
  {
    path: "/.git/config",
    reason: "A public Git configuration is a source-disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 853 },
  },
  {
    path: "/.git/head",
    reason: "A public Git HEAD file is a source-disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 447 },
  },
  {
    path: "/.env",
    reason: "A public dotenv file is a secret-disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 850 },
  },
  {
    path: "/.aws/credentials",
    reason: "A public AWS credentials file is a secret-disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 362 },
  },
  {
    path: "/.ssh/id_rsa",
    reason: "A public SSH private key is a secret-disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 188 },
  },
  {
    path: "/.svn/entries",
    reason: "A public Subversion metadata file is a source-disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 172 },
  },
  {
    path: "/.ds_store",
    reason: "A public macOS directory index is a disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 32 },
  },
  {
    path: "/.htpasswd",
    reason: "A public Apache password file is a credential probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 164 },
  },
  {
    path: "/server-status",
    reason: "An Apache status endpoint is a server probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 209 },
  },
  {
    path: "/server-info",
    reason: "An Apache configuration endpoint is a server probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 177 },
  },
  {
    extension: "php",
    reason: "Iterate runs Workers rather than PHP; this suffix is reserved for scanner traffic.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 106_702 },
  },
] as const satisfies readonly ScannerPolicyEntry[];
