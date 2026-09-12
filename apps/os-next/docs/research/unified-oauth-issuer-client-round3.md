# Issuer client and impersonation review — Claude Fable 5.1 xhigh

Read-only review, 2026-09-10. Requested model `claude-fable-5-1`, effort `xhigh`; tools disabled; completed successfully.

Disposition: implement B2 and fix `Session.orgs()` to read membership from `reach.userId`. Impersonation remains a future feature; its UI, grant restrictions, role assignment and parent logout semantics below are proposals, not implemented decisions. No unused impersonation fields or roles were added. The operator `as` fixture is explicitly distinguished from product impersonation.

Source correction: the pinned provider v0.10.3 `completeAuthorization()` writes an unexchanged grant with `expirationTtl: 600`. It does not leave an unbounded grant. Pending issuer DOs also expire after ten minutes. No compensating inventory scan or nonce is necessary. The inventory labels unexchanged grants as pending sign-in and displays their ten-minute expiry.

---

**Verdict.** B2 fits impersonation cleanly. `Authorization` already separates the three things impersonation must keep apart: `grant.userId` is the owner, `principal` is the actor, `reach` is the world being viewed. One construction site sets all three from the same id today. Impersonation later changes that site and nothing else, provided every reader uses each field for its own meaning. One reader does not. Fix that now, add nothing else, and build the baseline.

### The four authorities, mapped to existing fields

| Authority                           | Field today                       | Meaning                                     | Under impersonation later                            |
| ----------------------------------- | --------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Grant owner, authenticated operator | `grant.userId`, `principal.actor` | logged in, owns inventory, stamped on audit | unchanged: the admin                                 |
| Effective user                      | `reach.userId`                    | whose orgs, projects, reach checks apply    | the target                                           |
| Scope and project ceiling           | `grant.scope`, `grant.projects`   | what the client was delegated               | unchanged, bounds effective reach                    |
| Platform admin role                 | none                              | may start impersonation                     | fresh D1 read on the owner at start and each renewal |

The owner pin is `tokenExchangeCallback` refusing props whose `userId` differs from the provider's grant owner. Keep it verbatim in version 2. It guarantees an impersonation grant is only ever owned by the admin who made it.

### What B2 must change now

One rule: outside `authorizationOf` and the admin-secret gate, nothing derives actor from reach or reach from actor. Memberships read `reach.userId`. Attribution reads `principal`. Inventory and issuance read `grant.userId`.

Audit against that rule:

- `Session.orgs()` calls `listOrgs(principal.actor)`. Membership question, so it must read `reach.userId`. This is the one change.
- `Grants.#account()` uses `grant.userId` as the inventory subject. Correct.
- `ProjectCollection` stamps `principal` on context events. Correct.
- `createProject(reach, …)` and the project list in `grants.list()` follow reach. Correct today, and part of the open question below.
- B2's `Consent.approve` and `mint()` must write `userId: grant.userId` into both `completeAuthorization` and props, never the reach user. Otherwise an impersonating admin mints the target's credentials and the owner pin cannot notice, because the provider owner would be the target too.
- The admin-secret `as` option replaces the principal with the target, so the operator leaves the audit. It is an operator-gate fixture for API acceptance. Leave it, mark it in a comment as not the impersonation model.

No new fields, kinds, tables or classes. Version 2 props stay `kind`, `version`, `userId`, `email`, `projects`, `deadline`.

**Rendering the target exactly, without touching whoami.** Every rendering input except the name badge already flows from reach: `orgs()`, `projects.list()`, `projects.get()`, the reachable filter in grants, and the lease renewal. An admission whose reach is the target therefore renders the target's world verbatim through the unchanged browser SDK. `whoami()` keeps returning the operator because that is the audit truth. Later `info()` gains an effective identity beside the principal. The chrome renders the effective one and shows a banner when they differ. That is a field on a return value, not a new authority.

**Undecided, stated not assumed.** Whether an impersonated session may approve consent, mint tokens, list or revoke grants, or write to contexts is a product decision not taken. The default the code should express when built: those facets act for `grant.userId` only, and the factory withholds them when effective and owner differ. Inventory and revocation stay keyed by owner. The target's grants never appear in the operator's list and the reverse never happens. Context writes would carry the operator as actor, which is not "exactly as the target", so read-only is the honest first version.

### Future path, role, regression cases

**Recommend alternative 2.** Impersonation is a separate provider grant owned by the operator whose props name the effective subject. `authorizationOf` builds principal from the owner, reach from the subject, and re-reads the role. Because the effective user is fixed at admission, ingress, TanStack loaders, the socket lease and MCP all see one consistent world through the common gate. Picks, deferred until built:

- Start route on the issuer origin only. Requires an issuer grant, a fresh role read on the owner, a target resolved from the users table. Runs the B2 tail with a deadline of at most one hour and refresh refused, as for personal tokens.
- The new DO takes the session cookie. The previous DO id parks in a second HttpOnly cookie. Stop revokes the child and swaps cookies back. Logout revokes both. The parent link is that cookie, not a props field, so no parent-revocation tracking.
- Renewal treats loss of the role like revocation. The socket closes within the existing thirty-second bound.

**Why not 1.** A facet vended over an existing socket has a different reach from the root admission. The lease compares touched projects against root reach and closes the socket. Server loaders on the cookie render the operator's world while the socket shows the target's. Making lease and BFF facet-aware is the framework you said not to start.

**Why not 3.** A DO overlay carries the effective subject outside provider-verified props on a channel only the console BFF can use. MCP and clones could never carry it. Keep as fallback if impersonation must never be exportable.

**Role assignment.** A D1 table, one row per admin keyed by `user_id` with `granted_by` and `granted_at`, seeded by migration for the user row whose Google-verified email is jonas@nustom.com. Not a config email list, which would rejoin the role to a self-asserted string. Not in props, which are a copy of delegated authority and outlive a demotion.

**Apps never inherit it.** The impersonate capability is vended only for issuer-kind grants, or later for grants carrying an explicit `admin` scope. That scope stays out of `scopes_supported`, appears on the consent page only when the approving owner holds the role at that moment, and at use time still requires the fresh role read on `grant.userId`. Scope is the ceiling. Role is the live check. A clone gets an admin panel by requesting the scope and the user consenting. A demoted admin's clone token dies with the role.

**Regression cases now, node lane, no new types.**

1. Build an `Authorization` with `principal.actor` different from `reach.userId`. `orgs()` and `projects.list()` follow reach. `whoami()` and the principal stamped on a vended context follow principal.
2. Same split. `grants.list()` returns only the owner's grants and marks `current` by its own grant id. `end()` refuses a grant owned by the reach user.
3. Version 2 props whose `userId` differs from the provider owner fail exchange with `invalid_grant`.
4. B2 test 2 additionally asserts the issued app grant's `userId` equals the issuer grant's `userId`.

**Remaining B2 items.** No critical error. Corrections accepted: GET keeps the valid-scope-mismatch path, only explicit POST upgrades, and a valid grant is never discarded on GET. No arbitrary `next` cutoff. The same-origin path check is the only bound. If the signed flow cookie would exceed 4096 bytes, the door returns a page with a retry link rather than truncating. Durable pending state only if that case is actually hit.

The orphan grant needs a source audit before "dies at its deadline" is repeated. The provider sets expiry at token exchange, so a grant abandoned after `completeAuthorization` lists with no expiry and shows in our inventory as an unexpired session. Read whether the provider's purge removes grants whose unexchanged code expired. If not, the bounded fix is local: put a random nonce in grant metadata at the tail's `completeAuthorization`, and on `complete` failure list the owner's grants once, match the nonce, and revoke. One read on a failure path, logged, no cron, no cross-store atomicity. Either way, label rows with neither `last_used_at` nor `expiresAt` as never used.

Ready to implement the baseline with the `orgs()` change and the four cases above.
