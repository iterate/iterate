// core/egress.ts — secret substitution, WS-SAFE. Ported/simplified from apps/kernel/src/egress.ts.
//
// The one thing this file must NOT do: break a WebSocket upgrade while rewriting headers (target-core §6.0
// risk #4). It only rebuilds the Headers and constructs `new Request(request, { headers })`, which preserves
// the method + the `Upgrade` header + everything else — so a 101 flows straight back through it.

const SECRET_TOKEN = /\{\{secret:(project|platform):([a-zA-Z0-9._-]+)\}\}/g;

/**
 * Substitute every `{{secret:<scope>:<name>}}` token this door owns in the request URL AND headers —
 * an existing secret must never survive as a literal placeholder wherever it appears (a URL
 * `?access_token={{secret:project:token}}` would otherwise send the credential's NAME to the
 * destination and the value nowhere). Unresolved tokens (no value) are left intact for the next door
 * down. Returns a NEW Request when anything changed, else the original.
 *
 * WS-safe: `new Request(url, request)` / `new Request(request, { headers })` both preserve the
 * method, the `Upgrade` header, and the body, so a 101 flows straight back through.
 *
 * NOTE: the BODY is not yet scanned (substituting a streaming body means buffering it and recomputing
 * content-length) — a secret spelled inside a request body still forwards as a literal placeholder.
 */
export async function substituteHeaderSecrets(
  request: Request,
  scope: "project" | "platform",
  resolve: (name: string) => Promise<string | null> | string | null,
): Promise<Request> {
  // Substitute this door's owned tokens in one string; null = nothing owned changed (leave as-is).
  const subst = async (value: string): Promise<string | null> => {
    if (!value.includes("{{secret:")) return null;
    let out = "";
    let last = 0;
    let any = false;
    for (const m of value.matchAll(SECRET_TOKEN)) {
      if (m[1] !== scope) continue; // not our door's scope — leave the token for the next door
      const val = await resolve(m[2]);
      if (val == null) continue; // unresolved — leave the placeholder intact
      out += value.slice(last, m.index) + val;
      last = (m.index ?? 0) + m[0].length;
      any = true;
    }
    return any ? out + value.slice(last) : null;
  };

  // URL first: rebuild onto the new URL (carrying method/headers/body/upgrade), then headers on top.
  const newUrl = await subst(request.url);
  const base = newUrl !== null ? new Request(newUrl, request) : request;
  const headers = new Headers(base.headers);
  let changed = false;
  for (const [hname, hvalue] of base.headers) {
    const sub = await subst(hvalue);
    if (sub !== null) {
      headers.set(hname, sub);
      changed = true;
    }
  }
  return changed ? new Request(base, { headers }) : base;
}
