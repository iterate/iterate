# OAuth account-scope review

Reviewer: Claude Fable 5.1, effort xhigh. Exact model verified from CLI model usage. Read-only review; no permission denials.

**Verdict: the `account` scope design is correct and the right minimal fix.** Keep the shared Session RpcTarget decision. The alternatives that avoid an OAuth change are all worse, and the details below matter more than the shape.

**The hole is real.** On a project host the browser adapter already answers same-origin `/api` with the BFF bearer (browser-client.ts:129). Today grants management is reachable only through console server functions on the platform origin. Moving it into Session means any userspace app on a project host, or an XSS in one, could enumerate every client the user has authorized, revoke all of them, and mint a 30-day exfiltrable PAT. The PAT is the real escalation. The BFF token never leaves the platform, but a PAT does, and it outlives the browser.

**Why scope beats the alternatives.** Gating on `projects === null`, on the issuer CIMD client id, or on the platform-origin cookie all either re-introduce a first-party allowlist or conflate project selection with account authority. Scope is the OAuth primitive for exactly this distinction. It also costs no new storage: the provider clamps a token's scope to the grant's scope (`downscope`, oauth-provider.js:2887), and `tokenExchangeCallback` already copies it into the encrypted props. So a server-side check on `authorization.grant.scope` is unforgeable, and `authorizationOf` keeps its `iterate` requirement.

**Tightenings I would insist on.**

- **Consent must pass the parsed scope through.** Both `approveConsent` and `mintPersonalToken` hardcode `scope: ["iterate"]` today. The consent path must use `oauthRequest.scope`. The mint path must stay iterate-only. Add a test that a PAT is refused by every account method.
- **Do step-up inside the BrowserSession DO, not with a new cookie.** If `/.auth/login?scope=account` finds an active session lacking the scope, starting a second session orphans a live 30-day grant. Revoking on GET is the CSRF logout the existing comment warns against. Instead let the DO enter an "upgrading" phase, keep the old tokens, and revoke the old grant only after the new code exchange succeeds. On failure it keeps the old session.
- **Parse the login scope param as a closed set.** Dedupe, always include `iterate`, reject unknown values with 400, and never forward the raw string into the authorize URL. Apply the same rule in `parseAuthorization`. Update both scope metadata lists.
- **Check scope per method on the server.** One helper reading `authorization.grant.scope`. The admin credential has no grant and no user, so account methods return FORBIDDEN for it.
- **Drop the self-end carve-out.** Logout already revokes the current grant through the DO. An extra path adds surface for no capability.

**Consent wording.** The consent page currently frames everything as "Projects it may reach". A project-bound client requesting `account` needs a separate line making clear it can see and revoke sessions across all projects and clients. Without that, the project checkbox misleads the user into thinking the grant is project-limited.

**Residual risks, all acceptable.** A project app that obtains consent for `account` can still do everything the console can. That is the consented outcome under standard OAuth and consent fatigue is the main exposure. The list call discloses other clients' names. Mint from a project-bound account grant is already ceilinged by `reachableProjects(session.reach)`, so it yields a PAT for that project only. Revocation of an account-scoped grant reaches live sockets within the existing 60-second renewal in rpc.ts.

**Nothing simpler is correct** given your constraints. Every shortcut either allowlists first-party origins or leaves the PAT mint reachable from userspace.
