// fetch/egress.ts — `{{secret:project:NAME}}` substitution at the egress door, WS-SAFE: it only
// rebuilds the URL and the Headers and constructs `new Request(request, { headers })`, which preserves
// the method, the `Upgrade` header and the body — so a 101 flows straight back through it.

// The placeholder as written, or as the URL parser percent-encodes it in a path segment.
const SECRET_TOKEN = /(?:\{\{|%7B%7B)secret:project:([a-zA-Z0-9._-]+)(?:\}\}|%7D%7D)/g;

/** A placeholder whose secret is not stored, or whose secret is bound to another origin (the DO's
 *  resolver throws it) — the egress door answers it with a 502, to the caller, never the destination. */
export class ProjectSecretRefused extends Error {}

/**
 * Substitute every `{{secret:project:<name>}}` token in the request URL AND headers. An existing
 * secret must never survive as a literal placeholder wherever it appears (a URL
 * `?access_token={{secret:project:token}}` would otherwise send the credential's NAME to the
 * destination and the value nowhere); a placeholder with NO stored secret throws
 * `ProjectSecretRefused` naming the token and where it sat — to the caller, never the destination.
 * In the URL the value is spliced as ONE component (`encodeURIComponent`), so a secret can never add
 * a query parameter or a fragment. Returns a NEW Request when anything changed, else the original.
 *
 * NOTE: the BODY is not scanned (substituting a streaming body means buffering it and recomputing
 * content-length) — a secret spelled inside a request body forwards as a literal placeholder.
 */
export async function substituteProjectSecrets(
  request: Request,
  resolve: (name: string) => Promise<string | null> | string | null,
): Promise<Request> {
  // Substitute the tokens in one string; null = no token in it (leave as-is).
  const substitute = async (value: string, where: string, encode: boolean) => {
    if (!value.includes("secret:project:")) return null;
    let out = "";
    let last = 0;
    let any = false;
    for (const m of value.matchAll(SECRET_TOKEN)) {
      const secret = await resolve(m[1]);
      if (secret == null)
        throw new ProjectSecretRefused(
          `egress: no stored project secret for {{secret:project:${m[1]}}} in ${where}`,
        );
      out += value.slice(last, m.index) + (encode ? encodeURIComponent(secret) : secret);
      last = m.index + m[0].length;
      any = true;
    }
    return any ? out + value.slice(last) : null;
  };

  // URL first: rebuild onto the new URL (carrying method/headers/body/upgrade), then headers on top.
  const url = await substitute(request.url, "the request URL", true);
  const base = url !== null ? new Request(url, request) : request;
  const headers = new Headers(base.headers);
  let changed = false;
  for (const [name, value] of base.headers) {
    const substituted = await substitute(value, `header "${name}"`, false);
    if (substituted !== null) {
      headers.set(name, substituted);
      changed = true;
    }
  }
  return changed ? new Request(base, { headers }) : base;
}
