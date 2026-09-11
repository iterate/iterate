# Issuer client adversarial review — Claude Fable 5.1 xhigh

Read-only architecture review, 2026-09-10. Requested model `claude-fable-5-1`, effort `xhigh`; tools disabled; completed successfully.

**Choice: B2.** Keep the explicit `/login` page. The Google callback is the only writer of `kind: "issuer"`, and it establishes the console session by driving the console's own BrowserSession through its existing `begin` and `complete` methods in process. No public `/authorize` branch auto-approves anything. The stateless identity cookie, its verifier and the `from-server-cookie` credential go.

**Why B1 loses on its own terms.**

- **Silent re-login.** B1 chains every anonymous protected request straight into Google. Google re-issues a code for a returning user with no prompt. After an Iterate logout or a remote revocation, the next visit recreates a root grant with zero clicks. Keeping a login page fixes that, and once the page exists the first-party auto-approve at `/authorize` buys nothing except two extra self-redirects.
- **A public path writes the trusted kind.** `isIssuerClient` runs on attacker-supplied query strings. Production matches a client id anyone can copy. Local dev needs a redirect-URI fallback any DCR client can satisfy. The defence is that the code lands in a DO whose state will not match. That proof holds today, but it depends on four cooperating checks that every future edit to the door must preserve. B2 has no such branch.
- **An approval decision in a signed cookie.** B1's flow cookie carries a whole issuer authorize request the callback then approves. Short-lived, but a second place where approval rides a cookie.

B2 is roughly 40 lines more than B1 and keeps one route B1 deletes. It removes the public issuer-approval branch and its local fallback. Net maintainability favours B2.

**No simpler C survives.** Installing tokens into the DO directly needs a new DO method and skips PKCE and the token endpoint. A short "just verified" cookie that unlocks auto-approve at `/authorize` is B1 plus a login page. Keeping the signed identity cookie as root and adding revocation is a second store. The spike proves `begin` plus `complete` suffice with the pinned provider and no new surface.

### Lifecycle

**Login routing, no loops.**

1. Any protected page on any host gets 401 from `/api` and sends the browser to `/.auth/login?next=…`. Console and clone run the same code.
2. `appAuth` probes the held bearer. Valid with sufficient scopes: 303 to `next`. Otherwise it discards the DO and clears the cookie. A clone then begins OAuth against the issuer. The issuer origin passes `loginPage: "/login"` and 302s there instead. This option replaces `logoutCookie`.
3. `/login` is a Start route. Its loader redirects to `next` when the browser already holds an active authorization. It forces `next` to a same-origin path that is not `/login` or under `/.auth/`. It renders one Google button targeting `/.auth/identity?next=…`, or the bare-email form on loopback without Google config. GET never starts Google.
4. The callback verifies state, nonce, PKCE and the id token as today, upserts the user, calls `establishIssuerSession(env, user, next)`, and 303s to `next`.
5. For a third-party consent, `next` is Claude's original `/authorize` URL. The door parses it, finds an issuer grant in the browser, and Start renders the consent route. Without one it goes to step 1.

Worst chain from a stale cookie: `/authorize`, `/.auth/login`, `/login`. Three hops, then a page.

**Lifetimes.**

| Thing                         | Where                   | Lifetime                           |
| ----------------------------- | ----------------------- | ---------------------------------- |
| Google flow cookie            | browser, signed         | 10 minutes, cleared at callback    |
| BrowserSession pending record | DO                      | 10 minutes, alarm clears           |
| Issuer grant                  | provider KV plus D1 row | 30-day deadline, revocable         |
| Console session cookie        | browser, opaque id      | set only after `complete` succeeds |
| Access token                  | DO only                 | 1 hour, refreshed in the DO        |
| App grant, PAT                | provider KV             | 30 days, PAT never refreshes       |

The flow cookie holds `next`, not an authorization request. Bound `next` to 2 KB.

**Failures inside the tail.** The cookie is set last, so every earlier failure leaves the browser holding nothing.

- `begin`, `parseAuthorization` or `completeAuthorization` throws: 503 with a link to `/login`. No grant, or a pending record the alarm clears. No cookie, no retry loop, because retry is a click.
- `completeAuthorization` succeeds and `complete` fails at the token endpoint: one issuer grant exists with no tokens and no `last_used_at`. The code never left the worker. The row shows in the inventory as a never-used browser session, is revocable, and dies at its deadline. That is the documented bound. Do not add a compensating revoke; `completeAuthorization` does not return the grant id.
- `complete` succeeds and the browser never receives the 303: an active DO nobody can address. Same inventory row, same bound, the DO alarm clears it at 30 days.

**Explicit logout.** POST `/.auth/logout` calls `end()`, which probes, calls `logout()` over the public protocol, writes the D1 marker, revokes in KV, clears the DO and the cookie. Third-party grants and PATs survive as OAuth intends. Google's upstream session survives and does not matter, because `/login` needs a click.

**No automatic root grant after revocation or 5xx.** After a remote revocation the next `/api` call is 401, `appAuth` discards and clears, and the browser lands on `/login`. A provider 5xx during refresh throws out of `bearer()`, the request fails with 500, the DO is untouched, and nothing re-enters Google.

**Lost or foreign flow cookie.** A callback without a matching cookie is 400 and creates nothing. Google's code is useless without our verifier. Login CSRF fails because state lives in the victim's cookie.

**Revocation races.** The socket lease re-reads D1 every 30 seconds and hard-caps `until` at 60 seconds, so a revoked grant's open socket runs about 30 seconds more. Reads and context calls in that window are the accepted bound. Issuing a new long-lived grant is different: `consent.approve` and `grants.mint` call `grants.requireActive()` first, one primary D1 read plus the deadline check. The residual window is the approve call itself, sub-second. Closing it needs a transaction across D1 and KV. Do not build that. A grant minted in that window is independently listed and revocable.

**Copied issuer client id.** A crafted `/authorize` with `${issuer}/.auth/client.json` reaches the ordinary consent page. `describe` returns invalid with the text that the console signs in from its login page. Even without that refusal, approval writes `kind: "app"` and the code goes to a DO whose state never matches.

### Shapes, deletions, tests

```ts
// oauth.ts
export const GrantProps = z.object({
  kind: z.enum(["issuer", "app", "personal"]),
  version: z.literal(2),
  userId: z.string().startsWith("user_"),
  email: z.string(),
  projects: z.array(z.string()).nullable(), // issuer: null
  deadline: z.number().int().positive(),
});
// AccessProps keeps the separate { kind: "admin" } member.
// tokenExchangeCallback: refresh refused for "personal"; TTL by kind; revocation check unchanged.
```

```ts
// app-auth.ts
type AppAuth = { /* … */ loginPage?: string }; // replaces logoutCookie
export async function startAppSession(sessions, url: URL, host: BrowserHost, next: string) {
  const id = crypto.randomUUID();
  const session = sessions.getByName(`${url.origin}:${id}`);
  const location = await session.begin(host, next);
  const setCookie = `${sessionCookieName(url)}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
  return { session, location, setCookie };
}
```

```ts
// identity.ts, shared by the Google callback and the loopback email form
async function establishIssuerSession(env: Env, user: User, next: string) {
  const { issuer, api } = oauthAddresses(env);
  const started = await startAppSession(
    env.BROWSER_SESSION,
    new URL(issuer),
    { origin: issuer, issuer, resource: api, scopes: ["iterate", "account"] },
    next,
  );
  const helpers = oauthHelpers(env);
  const request = await parseAuthorization(
    { ...env, OAUTH_PROVIDER: helpers },
    new Request(started.location),
  );
  const { redirectTo } = await helpers.completeAuthorization({
    request,
    userId: user.id,
    scope: request.scope,
    metadata: { clientName: "Iterate" },
    revokeExistingGrants: false,
    props: {
      kind: "issuer",
      version: 2,
      userId: user.id,
      email: user.email,
      projects: null,
      deadline: Date.now() + 30 * 24 * 3600_000,
    },
  });
  const q = new URL(redirectTo).searchParams;
  const done = await started.session.complete({
    state: q.get("state")!,
    issuer: q.get("iss")!,
    code: q.get("code")!,
    error: "",
  });
  if ("error" in done) throw new Error(done.error);
  return new Response(null, {
    status: 303,
    headers: { Location: next, "Set-Cookie": started.setCookie, "Cache-Control": "no-store" },
  });
}
```

```ts
// consent.ts
type Pending =
  | { kind: "consent"; clientName: string; scopes: string[]; projectBound: string | null }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };
export class Consent extends RpcTarget {
  describe(query: string): Promise<Pending>;
  approve(query: string, projects: string[] | "*"): Promise<{ redirectTo: string }>; // requireActive, then kind:"app"
  refuse(query: string): Promise<{ redirectTo: string } | { kind: "invalid"; description: string }>;
}
// rpc.ts: consent: auth.grant?.kind === "issuer" ? new Consent(env, auth, grants) : null
// projectDoors: auth.grant ? null : input   (unchanged)
// session.ts
get consent()            // FORBIDDEN when the factory injected null
createOrg(name: string)  // FORBIDDEN unless reach is a user without projectIds
info()                   // adds grant: { kind } | null
// projects.create({ project, orgId? }) forwards orgId to directory.createProject
// grants.ts
requireActive()          // fresh grantIsRevoked plus deadline; used by mint and Consent.approve
mint()                   // writes kind:"personal"; refused when the caller's kind is "personal"
// control-plane.ts
authorizeDoor()          // GET /authorize: parseAuthorization, then require an issuer grant or redirect to /.auth/login?next=
```

No `OrgCollection`. A class earns its place when it vends capabilities. Orgs vend nothing yet, and one method on `Session` says so honestly.

**Authorization UI.** The `/authorize` client route opens `createIterateClient` over WebSocket exactly as the console does. It calls `describe`, then shows two sequential forms when needed: create organization, then create project in the chosen org, each awaited before the next. Then `approve` and navigate to `redirectTo`. A project-name conflict leaves the org in place. No batch session.

**Deletions.**

- `principal.ts`: `setSessionCookie`, `clearSessionCookie`, `verifySessionCookie`, `SessionCookieClaims`.
- `session.ts`: the `from-server-cookie` credential and its verifier case.
- `app-auth.ts`, `browser-client.ts`: `logoutCookie`.
- `control-plane.ts`: `issuerSessionOf`, `requireIssuerSession`, `signIn`, `signOut`, `consoleDoor`, `Consent`, `consentOf`, `approveConsent`. The approve body and `projectsForClient` move into `consent.ts`.
- `oauth.ts`: `tokenKind`, `kind: "user-grant"`, `version: 1`. No grace period, nothing is deployed.
- Admin impersonation `signIn` goes unless a deployed browser acceptance test needs it. API acceptance already uses the admin bearer with `as`.

**Top remaining risks.**

1. Every login now depends on the worker fetching its own origin twice, the client document and `/oauth/token` from the DO. The console already does both today, but a regression is a total login outage. Verify on preview first.
2. Orphan issuer grants after a failed exchange are bounded but may confuse. Label never-used rows in the inventory.
3. The sub-second approve-versus-revoke window is accepted and documented.
4. `parseAuthorization` expects `env.OAUTH_PROVIDER`. The tail must build helpers as the spike did if it runs outside the provider's handler.
5. Google's auto-consent means our button is the only explicit gesture. That is the intended boundary.

**Tests to implement,** workers lane, `fetch` routed to `SELF` as in the spike.

1. Bootstrap: drive the real tail through the loopback email form. Assert one cookie, `info().grant.kind === "issuer"`, one inventory row marked current.
2. First Claude consent end to end: anonymous third-party `/authorize` ends at `/login` with 200 and no Google Location. After login the same query renders consent. Over WebSocket run `describe`, `createOrg`, `projects.create` with `orgId`, `approve`. Exchange the code with PKCE as Claude. `/mcp` admits. `projects.create` on the app grant is FORBIDDEN. The issued props parse as `kind: "app"`.
3. Explicit action after revocation: revoke the issuer grant from a second session. The old cookie gets 401 with a clearing Set-Cookie, `GET /.auth/login?next=/` ends at `/login`, and `bearer()` is null.
4. Method-start recheck: open a socket, write the D1 marker directly, then `consent.approve` and `grants.mint` are refused inside the lease window.
5. Kind isolation: a PAT socket gets FORBIDDEN on `consent` and `mint`. An app grant with `[iterate, account]` gets FORBIDDEN on `consent` and succeeds on `grants.list`.
6. Copied client id: `/authorize` with the console's client id yields an invalid `describe`.
7. Failure injection: `completeAuthorization` throws, giving 503, no Set-Cookie, unchanged grant list. Token endpoint returns 500, giving 503, no Set-Cookie, exactly one never-used grant.
8. Logout: POST clears cookie and DO, writes the marker, `/api` is 401, and a following protected GET ends at `/login`.
9. Flow cookie missing at callback: 400, no grant, no cookie.
10. Loop guard: with a cookie naming a DO holding a revoked token, `GET /authorize?…` reaches a 200 page within three redirects.

## Implementation notes

Keep the existing explicit POST scope-upgrade behavior: a valid grant missing a requested permission must not be discarded by GET. No arbitrary 2 KB return-path cutoff: the pending external OAuth query must survive; any chosen bound must account for the signed Google-flow cookie size. New-grant issuance rechecks authorization at method start; a bounded operation admitted before revocation may finish. The new deployment has no users needing a v1 migration window.
