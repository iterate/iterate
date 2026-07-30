// ---------------------------------------------------------------------------
// The EGRESS door(s) + secret substitution — the concrete "iterate product wraps the control plane"
// proof (ADR 0017/0030). Design: ../os/docs/simplification/wayfinder/questions/control-plane-integrations.md
//
// TWO LEVELS, chained (ADR 0017 — egress always flows through the control plane):
//   userspace fetch(placeholder)  →  PROJECT door  →  CONTROL-PLANE door  →  internet
//
//   • PROJECT door  — substitutes the PROJECT's own secrets (`{{secret:project:<name>}}`). The project
//     owns these; stored per-project, keyed by the unforgeable projectId prop.
//   • CONTROL-PLANE door — substitutes FIRST-PARTY / platform secrets (`{{secret:platform:<name>}}`,
//     e.g. Exa/Parallel keys iterate holds). This is the ITERATE-PRODUCT layer: present only when the
//     deployment is configured with platform secrets; empty in a generic/self-host control plane. It is
//     ORIGIN-PINNED (a platform secret substitutes only for an allow-listed destination — stops a
//     malicious userspace worker exfiltrating the key) and METERED (usage counted; the billing hook).
//
// The confinement property: the userspace config worker only ever writes a PLACEHOLDER. The real value
// lives in the door that owns it (project store / platform config) — never in userspace code or props.
// A platform secret value never reaches the project worker at all (it's substituted at the CP door).
// ---------------------------------------------------------------------------

// `{{secret:project:NAME}}` / `{{secret:platform:NAME}}` anywhere in a header value.
const SECRET_TOKEN = /\{\{secret:(project|platform):([a-zA-Z0-9._-]+)\}\}/g;

export type PlatformSecret = { name: string; value: string; allowedOrigins: string[] };

// A minimal per-project secret store over a KV namespace (`secret:<projectId>:<name>`). Write + resolve;
// NEVER read back to userspace (mirrors apps/os — secrets are write-only, referenced by placeholder).
export type SecretsKV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};
// A stored project secret. `allowedOrigins` is OPTIONAL (security follow-up R8): declare it to origin-pin
// the secret (it substitutes only for those destinations — a script can't exfiltrate it elsewhere);
// omit it for an unrestricted secret (the project's own footgun, but not a cross-tenant leak — the R8
// auth gate already stops an anonymous attacker acting AS the project). Bare strings (legacy) = unrestricted.
type StoredProjectSecret = { value: string; allowedOrigins?: string[] };
function parseStored(raw: string | null): StoredProjectSecret | null {
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object" && typeof p.value === "string") return p as StoredProjectSecret;
  } catch {
    /* not JSON — a legacy bare-string value */
  }
  return { value: raw };
}
export function projectSecrets(kv: SecretsKV | undefined, projectId: string) {
  const key = (name: string) => `secret:${projectId}:${name}`;
  return {
    async set(name: string, value: string, allowedOrigins?: string[]): Promise<void> {
      if (!kv) throw new Error("no SECRETS_KV bound — cannot store project secrets");
      await kv.put(key(name), JSON.stringify({ value, allowedOrigins }));
    },
    // Resolve for a destination `origin`: an origin-pinned secret substitutes only for an allow-listed
    // destination (else null → the placeholder is left intact, exactly like platform secrets).
    async resolve(name: string, origin: string): Promise<string | null> {
      if (!kv) return null;
      const s = parseStored(await kv.get(key(name)));
      if (s === null) return null;
      if (s.allowedOrigins && !s.allowedOrigins.includes(origin)) return null; // pinned, not allowed
      return s.value;
    },
  };
}

// Substitute every `{{secret:<scope>:<name>}}` token in the request's HEADERS whose scope this door owns,
// using `resolve(scope,name,origin) -> value|null`. Unresolved tokens are left intact (the next door
// down handles its own scope). Returns a NEW Request; the body is untouched (secrets ride in headers).
export async function substituteHeaderSecrets(
  request: Request,
  scopes: Set<"project" | "platform">,
  resolve: (scope: "project" | "platform", name: string, origin: string) => Promise<string | null>,
): Promise<Request> {
  const origin = new URL(request.url).origin;
  const headers = new Headers(request.headers);
  let changed = false;
  for (const [hname, hvalue] of request.headers) {
    if (!hvalue.includes("{{secret:")) continue;
    const parts: string[] = [];
    let last = 0;
    for (const m of hvalue.matchAll(SECRET_TOKEN)) {
      const scope = m[1] as "project" | "platform";
      if (!scopes.has(scope)) continue; // not our door's scope — leave the token for the next door
      const val = await resolve(scope, m[2], origin);
      if (val === null) continue; // unresolved (e.g. origin not allow-listed) — leave intact
      parts.push(hvalue.slice(last, m.index), val);
      last = m.index + m[0].length;
      changed = true;
    }
    if (last > 0) {
      parts.push(hvalue.slice(last));
      headers.set(hname, parts.join(""));
    }
  }
  return changed ? new Request(request, { headers }) : request;
}

// The CONTROL-PLANE egress door (the iterate-product boundary). Substitutes platform secrets
// (origin-pinned + metered), then hits the internet. In the two-worker split this runs in the CP worker;
// here it's a function the project door chains into.
export async function controlPlaneEgress(
  request: Request,
  platform: PlatformSecret[],
  meter?: (name: string) => void,
): Promise<Response> {
  const byName = new Map(platform.map((p) => [p.name, p]));
  const substituted = await substituteHeaderSecrets(
    request,
    new Set(["platform"]),
    async (_scope, name, origin) => {
      const p = byName.get(name);
      if (!p) return null;
      // ORIGIN PIN: a platform secret substitutes ONLY for an allow-listed destination (anti-exfiltration).
      if (!p.allowedOrigins.includes(origin)) return null;
      meter?.(name); // the billing hook — count first-party-secret usage
      return p.value;
    },
  );
  // SECURITY (thermonuclear review R7 #3): do NOT auto-follow redirects. The Fetch spec strips
  // `Authorization` on a cross-origin redirect but NOT custom headers (e.g. `x-api-key`), so an
  // allow-listed origin that 302s to attacker.com would leak the substituted secret. The origin pin is
  // computed once on the original URL; manual redirect keeps the secret from riding to an unpinned hop.
  return fetch(new Request(substituted, { redirect: "manual" }));
}

// The PROJECT egress door: substitute the project's own secrets (origin-aware — a pinned project secret
// only substitutes for an allow-listed destination), then chain into the control-plane door.
export async function projectEgress(
  request: Request,
  projSecrets: { resolve(name: string, origin: string): Promise<string | null> },
  platform: PlatformSecret[],
  meter?: (name: string) => void,
): Promise<Response> {
  const substituted = await substituteHeaderSecrets(
    request,
    new Set(["project"]),
    (_s, name, origin) => projSecrets.resolve(name, origin),
  );
  return controlPlaneEgress(substituted, platform, meter);
}
