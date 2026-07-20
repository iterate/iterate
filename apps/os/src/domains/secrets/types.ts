/**
 * Public secret capability data shapes. A secret's public live state IS its
 * {@link SecretDescription}: there is deliberately no separate secret processor
 * state type — the internal fold carries the encrypted material, and the DO's
 * processor facade projects it away (write-only material) before anything
 * crosses the RPC boundary.
 */

/** How a secret's material may leave the secret system. Extendable — e.g. a
 * future "reveal-once". */
export type SecretVisibility = "write-only" | "readable";

export type SecretCreateInput = {
  /** Complete egress policy established by the birth certificate. */
  egress: { urls: string[] };
  /** Optional initial write-only material. */
  material?: unknown;
  /** Optional initial refresh strategy; omitted means no refresh. */
  refresh?: SecretRefresh | null;
  /**
   * How the material may leave: "write-only" (never — the default and the
   * classic secret invariant) or "readable" (reveal() answers it, as often
   * as asked). IMMUTABLE: declared at birth, never updatable, so a
   * write-only secret can never be retro-flipped readable. Reserve
   * "readable" for credentials whose whole purpose is to be shown to the
   * outside — the born project ingress key at /secrets/project-api-key is
   * the canonical case.
   */
  visibility?: SecretVisibility;
};

/** Input for replacing secret material or changing its egress and refresh policy. */
export type SecretUpdateInput =
  | {
      /** Replacement material must name its complete egress policy in the same
       * authorized update. It never inherits a policy chosen by a public event. */
      egress: { urls: string[] };
      /** Any serializable value (write-only, one JSON blob). A plain string keeps
       * the whole-material placeholder working; structured material is addressed
       * by `field` in placeholders (design §2.1). */
      material: unknown;
      /** A named refresh strategy the secret runs in trusted DO code when a
       * substituted request 401s (or a referenced field is missing), or `null` to
       * clear it. Omitted leaves the strategy unchanged. */
      refresh?: SecretRefresh | null;
    }
  | {
      /** Replaces the effective egress origins. Every update without `material`
       * clears stored material, including egress-only and refresh-only updates. */
      egress?: { urls: string[] };
      material?: never;
      /** Omitted leaves the strategy unchanged. A refresh-only update still
       * clears material because it does not contain replacement material. */
      refresh?: SecretRefresh | null;
    };

/**
 * Input to `itx.secrets.collectFromUser`: which path the secret should land
 * at, the egress origins its material may ever be substituted into, and an
 * optional human-facing note the collection page shows the user (what the
 * key is for, where to find it).
 */
export type CollectSecretInput = {
  path: string;
  /** The egress allowlist the secret is born pinned to — the user sees these
   * origins on the collection page as the promise of where the value can go.
   * Must be non-empty http(s) URLs; validated at mint so a bad list fails on
   * the agent that can fix it, not in the user's face at submit time. */
  egress: { urls: string[] };
  /** Shown to the user on the collection page (e.g. "API key for
   * api.somewhere.com — found under Settings → API"). */
  description?: string;
};

/**
 * What `itx.secrets.collectFromUser` returns: the normalized secret path and
 * the deep link to the chrome-free collection page. Send the URL to the user;
 * when they submit, the secret is stored (material + egress pin in one update)
 * and — when the caller was an agent scope — that agent receives a message
 * that the secret at this path is ready.
 */
export type CollectSecretLink = {
  path: string;
  url: string;
};

/**
 * A reference to a deployment-owned platform credential, resolved from typed
 * AppConfig in trusted platform code — never stored in project material, never
 * readable. Each known config path carries its own allowed-origin list
 * (platform-secrets.ts), so a credential can only ever be sent to the hosts it
 * belongs to, no matter who configured the reference.
 */
export type PlatformCredsRef = { platform: string };

/**
 * A named credential-refresh strategy a secret runs in its own trusted DO
 * code — one shared implementation per protocol instead of a worker copied
 * into every secret. Client credentials come from the secret's own material
 * (`"material"`, the bring-your-own-app case) or a platform config reference
 * (built-ins). Exchange endpoints must fall within the secret's pinned egress
 * hosts, so refresh preserves the cell invariant: bytes only ever leave toward
 * pinned hosts.
 */
export type SecretRefresh =
  | {
      kind: "oauth-refresh-token";
      /** RFC 6749 refresh_token grant target (e.g. the provider's /token URL).
       * Its origin must be within the secret's pinned egress hosts. */
      tokenEndpoint: string;
      /** Where the Basic client credential comes from: `"material"` reads
       * clientId/clientSecret fields of this secret's own material. */
      clientCreds: PlatformCredsRef | "material";
    }
  | {
      kind: "github-app-installation";
      /** GitHub API origin (or a stand-in in e2e). Its origin must be within
       * the secret's pinned egress hosts. */
      apiBase: string;
      /** The App id — the JWT issuer (public). */
      appId: string;
      /** The installation this connection acts as (public — it is the
       * connection's external id, not secret material). */
      installationId: string;
      /** Where the App's RS256 private key comes from: `"material"` reads the
       * privateKey field of this secret's own material (bring-your-own-App). */
      privateKey: PlatformCredsRef | "material";
    }
  | {
      kind: "waitrose-session";
      /** The Waitrose GraphQL endpoint (or a stand-in in e2e) the `NewSession`
       * mutation is POSTed to. Its origin must be within the secret's pinned
       * egress hosts. Waitrose has no token-refresh grant — re-login IS the
       * refresh — so this strategy re-runs the login with `username`/`password`
       * from this secret's own material and stores the returned `accessToken`.
       * Material-only by nature: a Waitrose account is always the user's own. */
      graphqlUrl: string;
    };

/**
 * A stored secret's public face — its live state and what `__describe()`
 * merges in: usage audit counters, pinned egress URLs, whether material is
 * present, and the configured refresh strategy's kind. Never the material
 * itself: material is write-only and projected away before crossing the RPC
 * boundary.
 */
export type SecretDescription = {
  audit: {
    lastUsedAt?: string;
    lastUsedBy?: string;
    lastUsedUrl?: string;
    usedCount: number;
  };
  egress: { urls: string[] };
  /** Whether the secret processor has folded its birth certificate. */
  created: boolean;
  hasMaterial: boolean;
  /** How the material may leave (a birth-certificate fact): write-only secrets refuse reveal(). */
  visibility: SecretVisibility;
  /** The configured refresh strategy's kind, or null when none is configured. */
  refresh: SecretRefresh["kind"] | null;
};
