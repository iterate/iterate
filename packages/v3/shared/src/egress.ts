// core/egress.ts — secret substitution, WS-SAFE. Ported/simplified from apps/kernel/src/egress.ts.
//
// The one thing this file must NOT do: break a WebSocket upgrade while rewriting headers (target-core §6.0
// risk #4). It only rebuilds the Headers and constructs `new Request(request, { headers })`, which preserves
// the method + the `Upgrade` header + everything else — so a 101 flows straight back through it.

const SECRET_TOKEN = /\{\{secret:(project|platform):([a-zA-Z0-9._-]+)\}\}/g;

/**
 * Substitute every `{{secret:<scope>:<name>}}` token in the request HEADERS whose scope this door owns.
 * Unresolved tokens (no value) are left intact for the next door down. Returns a NEW Request when anything
 * changed (headers only — body/method/upgrade untouched), else the original request.
 */
export async function substituteHeaderSecrets(
  request: Request,
  scope: "project" | "platform",
  resolve: (name: string) => Promise<string | null> | string | null,
): Promise<Request> {
  const headers = new Headers(request.headers);
  let changed = false;
  for (const [hname, hvalue] of request.headers) {
    if (!hvalue.includes("{{secret:")) continue;
    let out = "";
    let last = 0;
    let any = false;
    for (const m of hvalue.matchAll(SECRET_TOKEN)) {
      if (m[1] !== scope) continue; // not our door's scope — leave the token for the next door
      const val = await resolve(m[2]);
      if (val == null) continue; // unresolved — leave the placeholder intact
      out += hvalue.slice(last, m.index) + val;
      last = (m.index ?? 0) + m[0].length;
      any = true;
    }
    if (any) {
      out += hvalue.slice(last);
      headers.set(hname, out);
      changed = true;
    }
  }
  return changed ? new Request(request, { headers }) : request;
}
