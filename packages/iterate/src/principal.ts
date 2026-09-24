// principal.ts — WHO user code is acting for, as the platform tells it: the verified `Principal`
// (`itx.whoami()`, `source.principal` on an event) and the header the platform stamps it in on a
// Request it forwards to a project's worker (sdk/auth.ts reads it). How the platform admits and
// carries a caller — `Caller`, `stampCaller`, its signed claims — is apps/os src/caller.ts.

/** Who is acting: a stable actor id (the control plane's user id) and, when known, an email. */
export type Principal = { actor: string; email?: string };

/** The header the edge sets on a Request it forwards on a principal's behalf — the ingress after
 *  the cookie check, a session's terminal `fetch` — and strips from every inbound Request. */
export const ITX_PRINCIPAL_HEADER = "x-itx-principal";
