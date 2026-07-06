/**
 * Public secret capability data shapes. A secret's public live state IS its
 * {@link SecretDescription}: there is deliberately no separate secret processor
 * state type — the internal fold carries the encrypted material, and the DO's
 * processor facade projects it away (write-only material) before anything
 * crosses the RPC boundary.
 */

export type SecretUpdateInput = {
  egress?: { urls: string[] };
  material?: string;
};

export type SecretDescription = {
  audit: {
    lastUsedAt?: string;
    lastUsedBy?: string;
    lastUsedUrl?: string;
    usedCount: number;
  };
  egress: { urls: string[] };
  hasMaterial: boolean;
};
