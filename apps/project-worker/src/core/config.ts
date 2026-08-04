// core/config.ts — the deployment-wide APP_CONFIG (target-core §3.3, §4). No projectId here; the projectId
// comes from the DO name. For the walking skeleton we only need `fallback` (the shell we delegate outward to).

/** A dotted capability expression, e.g. "itx.slack.chat.postMessage" (target-core §4.0). */
export type ItxCallPath = `itx.${string}`;

/** What a worker's root context falls back to (target-core §3.4 / D30). */
export type FallbackRef =
  | { via: "terminal" } // the real internet + real bindings — ends the chain
  | { via: "service-binding"; binding: string } // → an outer-shell worker (self-host / hosted)
  | { via: "loopback-entrypoint"; entrypoint: string }; // → a loopback entrypoint (solo: DummyControlPlane)

export type AppConfig = {
  fallback: FallbackRef;
};

const SOLO_DEFAULT: AppConfig = {
  fallback: { via: "loopback-entrypoint", entrypoint: "DummyControlPlane" },
};

/** Parse env.APP_CONFIG; default to SOLO (fallback → the project worker's own DummyControlPlane). */
export function parseAppConfig(raw: string | undefined): AppConfig {
  if (!raw) return SOLO_DEFAULT;
  try {
    const p = JSON.parse(raw) as Partial<AppConfig>;
    if (p && typeof p === "object" && p.fallback) return { fallback: p.fallback };
  } catch {
    /* fall through to solo */
  }
  return SOLO_DEFAULT;
}
