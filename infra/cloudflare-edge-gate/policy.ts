interface ScannerPolicyEvidence {
  reason: string;
  evidence: {
    observedOn: `${number}-${number}-${number}`;
    productionInvocations: number;
  };
}

export type ScannerPolicyEntry = ScannerPolicyEvidence &
  (
    | { path: string; extension?: undefined; pathWildcard?: undefined }
    | { extension: string; path?: undefined; pathWildcard?: undefined }
    | { pathWildcard: string; extension?: undefined; path?: undefined }
  );

/** Reviewed request shapes that Iterate will never intentionally serve. */
export const scannerPolicy = [
  {
    pathWildcard: "*/.git",
    reason: "A public Git metadata path is a source-disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 38 },
  },
  {
    pathWildcard: "*/.git/*",
    reason: "Public Git metadata files are source-disclosure probes, not Iterate routes.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 845 },
  },
  {
    pathWildcard: "*/.env",
    reason: "Public dotenv files are secret-disclosure probes, not Iterate routes.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 5_944 },
  },
  {
    pathWildcard: "*/.env.*",
    reason: "Public environment-specific dotenv files are secret-disclosure probes.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 10_121 },
  },
  {
    pathWildcard: "*/.aws/*",
    reason: "Public AWS metadata files are credential-disclosure probes, not Iterate routes.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 1_233 },
  },
  {
    pathWildcard: "*/.ssh/*",
    reason: "Public SSH metadata files are credential-disclosure probes, not Iterate routes.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 596 },
  },
  {
    pathWildcard: "*/.svn/*",
    reason: "Public Subversion metadata files are source-disclosure probes, not Iterate routes.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 90 },
  },
  {
    pathWildcard: "*/.hg/*",
    reason: "Public Mercurial metadata files are source-disclosure probes, not Iterate routes.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 1 },
  },
  {
    path: "/.ds_store",
    reason: "A public macOS directory index is a disclosure probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 16 },
  },
  {
    path: "/.htpasswd",
    reason: "A public Apache password file is a credential probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 82 },
  },
  {
    path: "/server-status",
    reason: "An Apache status endpoint is a server probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 105 },
  },
  {
    path: "/server-info",
    reason: "An Apache configuration endpoint is a server probe, not an Iterate route.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 89 },
  },
  {
    extension: "php",
    reason: "Iterate runs Workers rather than PHP; this suffix is reserved for scanner traffic.",
    evidence: { observedOn: "2026-08-18", productionInvocations: 53_348 },
  },
] as const satisfies readonly ScannerPolicyEntry[];
