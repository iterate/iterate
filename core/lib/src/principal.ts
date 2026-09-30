// principal.ts — WHO user code is acting for, as the platform tells it: the verified `Principal`
// (`itx.whoami()`, `source.principal` on an event) and the header the platform stamps it in on a
// Request it forwards to a project's worker (sdk/auth.ts reads it). How the platform admits and
// carries a caller, and signs its own tokens, stays in the platform.

/** Who is acting: a stable actor id (the control plane's user id) and, when known, an email. A
 *  platform admin signed in as someone else is two people (RFC 8693's subject and actor): the
 *  principal is the person, whose access every check reads, and `impersonatedBy` the admin doing
 *  it, stamped beside them on every event. */
export type Principal = {
  actor: string;
  email?: string;
  impersonatedBy?: { actor: string; email: string };
};

/** The header the edge sets on a Request it forwards on a principal's behalf — the ingress after
 *  the cookie check, a session's terminal `fetch` — and strips from every inbound Request. */
export const ITX_PRINCIPAL_HEADER = "x-itx-principal";
