# Issuer client design review — Claude Fable 5.1 xhigh

Read-only architecture review, 2026-09-10. Requested model `claude-fable-5-1`, effort `xhigh`; tools disabled; completed successfully. Recommendations are provisional pending the adversarial follow-up.

**Recommendation: option B, tightened.** The console's own OAuth client becomes the one root browser session. Its grant is an ordinary provider grant whose props say `kind: "issuer"`, written by exactly one code path, the Google callback. The stateless identity cookie is deleted. Consent for every other client is a facet on the ordinary `/api` `Session`, handed out only to issuer grants. A, C and D each keep a second authority or a second store. B removes one.

**Invariants**

- **One gate.** `/api` and `/mcp` admit provider bearers only. Cookie-to-bearer translation stays in the BFF and the DO. D breaks this.
- **Every authority a browser holds is a grant.** Visible in the inventory, D1-revocable, 30-day absolute bound. The identity cookie violates this today: revoke every session from another device and a lost laptop can still approve any client with one click.
- **Consent is the root session's act.** A derived grant must never mint another client's grant, or `account` scope becomes cross-client escalation. PAT minting is the one deliberate exception, bounded to the caller's reach.
- **Google proves identity into the issuer and nothing else.**
- **Project reach is a ceiling fixed at consent.** Creating the project mid-flow is the user's act under the root session. Claude's grant names the result and creates nothing later.
- **Clone equivalence.** A client holding `[iterate, account]` does everything the console does at `/api` except mint consent. The console's only specialness is where it is served and that it hosts the issuer UI.

**What "authenticate with the issuer client" means**

The console at `${issuer}/.auth/client.json` is a first-party client. First-party clients are auto-approved on fresh authentication and skip the consent screen. Auth0 and Okta model first-party apps exactly this way, so it is semantically legitimate. Its grant is the browser's login session at the authorization server. Every third-party `/authorize` requires that session in the browser, so authenticating with any app means first holding an issuer grant. The AS is not a client of itself. It hosts a client and gives that client's grant one extra facet because the AS itself created it after a Google proof.

If the identity and consent UI later moves to auth.iterate2.com, the issuer client and its cookie move with `/authorize`, and os.iterate2.com becomes a plain app client. Nothing else changes.

**Why not A, C, D**

- **A** keeps a 30-day unrevocable stateless root and adds a second RPC root under `POST /authorize` that re-exposes directory methods. A 10-minute cookie fixes nothing about revocation and makes org creation a race against expiry.
- **C** is B with a second store: another cookie, another table or DO, another marker kind, a union in the inventory, a second admission path. Provider grants plus D1 markers plus BrowserSession already implement the lifecycle C wants.
- **D** admits a cookie at the gate. Two authority kinds at one door, still unrevocable, and it resurrects the `from-server-cookie` credential we just removed.

**B's real blockers and how each resolves**

1. **Circularity.** The root session is the console grant, but creating it needs a login. Resolution: `/authorize` for the issuer client goes straight to Google. The callback completes that authorization and 303s to the console's existing `/.auth/callback` with the code. The DO does its normal public exchange. No new DO method, no in-process exchange, no extra browser trip.
2. **Identifying the first-party client without trusting client metadata.** Production: exact match on the client id `${issuer}/.auth/client.json`. Local dev uses DCR, so the id is random. Verify whether provider 0.10.3 accepts CIMD ids over loopback http so `begin` can skip DCR for the issuer's own origin. If it refuses, the loopback-only test is the validated redirect URI equal to `${issuer}/.auth/callback`. Neither test reads a display name. A foreign CIMD document pointing its redirect at the issuer earns a code that only the victim's own DO can receive, and the state will not match.
3. **Consent authorized by a bearer.** Legitimate only because `kind: "issuer"` is written solely by the Google callback. The consent getter refuses every other kind. `mint` hardcodes `personal`. The admin credential has no grant and is refused.
4. **Provider cost.** Auto-approve is `parseAuthRequest` plus `completeAuthorization`, the same as today's console consent minus the page. The issuer already fetches its own CIMD document for the console and for PAT minting. No adapter.
5. **Console scope changes re-enter Google.** Rule: an issuer session is created only by a fresh Google proof. Google's own session makes this near-silent. Accept it.
6. **Loopback and acceptance fixtures.** The bare-email form and admin-bearer `signIn` collapse into one shared "verified user" tail. On loopback without Google config, the issuer branch of `/authorize` renders an email form. Deployed acceptance tests already use the admin secret with `as` at `/api`.

**Traces**

First-ever Claude to MCP:

1. Claude sends the browser to `/authorize` with its client id, PKCE challenge, state, the MCP resource and `scope=iterate`.
2. The door parses it. Third-party, no issuer grant in this browser, so 302 to `/.auth/login` with that URL as `next`. The console DO begins and stores Claude's URL.
3. The DO redirects to `/authorize` for the issuer client. First-party, so 302 to Google with the 10-minute flow cookie whose `next` is this issuer authorize URL.
4. The Google callback verifies the id token, upserts the user, parses `next`, checks first-party, calls `completeAuthorization` with `kind: "issuer"`, and 303s to the returned redirect, which is the console's `/.auth/callback` with code, state and iss.
5. The DO exchanges at `/oauth/token` and 303s to Claude's original `/authorize` URL.
6. The root now exists. The Start consent route renders and opens the ordinary WebSocket to `/api`. The BFF swaps cookie for bearer. `info()` reports the issuer kind.
7. `orgs()` is empty. The page offers create org and project through the normal `orgs.create` and `projects.create`. Reach is membership, so it succeeds.
8. The page calls `consent.approve(location.search, [projectId])`. The server re-parses Claude's request, intersects with reachable projects, completes with `kind: "app"` and that one project, and returns the redirect. The page navigates. Claude's state and PKCE were never touched. They rode its URL through the DO's `next`, not a cookie, so length is not a concern.
9. Claude exchanges at `/oauth/token`. `/mcp` admits. `projects.create` under a project-list reach is FORBIDDEN, as today.

Console open with a session: unchanged. Probe `/api`, open the socket, call `info()`.

Logout: POST `/.auth/logout`. The DO's `end()` calls `logout()`, which is `endCurrent()`. D1 marker, DO cleared, cookie cleared. Third-party grants survive, as OAuth intends. No second cookie to clear.

Lost device: from another browser, end the "Browser session" row. The lost device's next `/api` call is 401. The BFF discards its DO and clears the cookie. Its next `/authorize` requires Google again. This closes the gap the identity cookie leaves today.

Escalation: Notes with `[iterate, account]` gets grant inventory and PAT minting, not consent. A PAT gets neither refresh nor consent. Revocation is checked at every HTTP admission, and the existing socket lease rules apply to issuer grants unchanged.

**Shapes**

```ts
// oauth.ts
export const GrantProps = z.object({
  kind: z.enum(["issuer", "app", "personal"]), // replaces kind:"user-grant" and tokenKind
  version: z.literal(2),
  userId: z.string().startsWith("user_"),
  email: z.string(),
  projects: z.array(z.string()).nullable(), // issuer: always null
  deadline: z.number().int().positive(),
});
// tokenExchangeCallback: refresh refused when kind === "personal"; TTL chosen by kind.
```

```ts
// consent.ts, an RpcTarget of roughly 80 lines, reached as Session.consent
type Pending =
  | { kind: "consent"; clientName: string; scopes: string[]; projectBound: string | null }
  | { kind: "redirect"; location: string }  // provider refusal with a validated redirect
  | { kind: "invalid"; description: string };
class Consent extends RpcTarget {
  describe(query: string): Promise<Pending>;
  approve(query: string, projects: string[] | "*"): Promise<{ redirectTo: string }>;
  refuse(query: string): Promise<{ redirectTo: string } | { kind: "invalid"; description: string }>;
}
// session.ts
get consent() {
  if (this.#authority.grant?.kind !== "issuer") throw codedError("FORBIDDEN", "...");
  return this.#consent;
}
```

```ts
// control-plane.ts, authorizeDoor: runs before Start on GET /authorize
const auth = await parseAuthorization(env, request); // refusals rendered as today
if (isIssuerClient(env, auth)) return beginGoogle(env, request.url); // always a fresh proof
const root = await browserAuthorization(env, request, ctx);
if (root?.grant?.kind !== "issuer")
  return redirect(`/.auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
return null; // Start renders _auth/authorize.tsx
```

```ts
// identity.ts, the callback's tail replaces setSessionCookie
const user = await directory(env.DB).upsertGoogleUser(sub, email);
return approveIssuerClient(env, flow.next, user);
// approveIssuerClient: parseAuthorization(next), refuse unless isIssuerClient,
// completeAuthorization({ props: { kind: "issuer", projects: null, ... } }), 303 redirectTo.
```

Browser state on the issuer origin after login: one `__Host-itx-session` cookie naming a DO that holds one issuer grant's access and refresh tokens under a 30-day absolute bound. During login only, the 10-minute signed flow cookie. Nothing long-lived is signed. Each third-party app origin holds its own cookie and DO with an app grant. Claude holds its own tokens. A PAT is a string shown once.

**Deletion and integration plan**

1. `oauth.ts`: `GrantProps` v2 with the kind enum. `authorizationOf` and `tokenExchangeCallback` read kind. `grants.ts`: labels by kind, `mint` writes `personal`.
2. `consent.ts`: move `projectsForClient`, `authorizationFailure` and the approve body out of the control plane into the facet. `Session` gains the consent getter and `SessionAuthority.grant`.
3. `identity.ts`: fold the `/.auth/identity` start into `beginGoogle`, called only from the authorize door. The callback tail becomes `approveIssuerClient`. The loopback email form and admin impersonation share that tail.
4. `control-plane.ts`: delete `issuerSessionOf`, `requireIssuerSession`, `signIn`, `signOut`, `Consent`, `consentOf`, `approveConsent`, `consoleDoor`. Add `authorizeDoor`.
5. `principal.ts`: delete `setSessionCookie`, `clearSessionCookie`, `verifySessionCookie`, `SessionCookieClaims`. Keep `signClaims`, `verifyClaims`, `cookieValueOf`.
6. `session.ts`: delete the `from-server-cookie` credential. `browser-client.ts` and `app-auth.ts`: delete `logoutCookie`.
7. Routes: delete the login form route. Rewrite the authorize route as a client route using `createIterateClient`, then describe, inline org and project creation, then approve or refuse.
8. Migration: v1 props fail the v2 parse and are refused, so every user re-logs in once. Given 30-day bounds this is acceptable. Accepting v1 for 30 days is the alternative.

Estimated delta:

| Deleted         | Added           |
| --------------- | --------------- |
| about 250 lines | about 120 lines |

**Clarify before building**

- Confirm that a console scope change may re-prompt Google.
- Verify provider CIMD behaviour over loopback http, else use the redirect-URI fallback locally.
- Choose forced re-login or a 30-day v1 grace period.
