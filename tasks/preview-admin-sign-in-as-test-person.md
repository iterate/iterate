---
status: in-progress
size: medium
---

# An admin signs in to a preview as the PR's test person from the platform's own sign-in page

**Status:** spec'd, implementation starting. Nothing built yet.

## Why

A preview's PR body links every app's `Sign in ↗` as the PR's test person, `pr<N>@preview.iterate.test`.
For apps with their own OAuth client (Dash, Agents) the issuer's consent page opens an admin's
"Sign in as someone else…" with the person filled in, and one confirm does it (`apps/os/src/consent.ts`).

Proxied apps (Notes; Docs from iterate/iterate#3384) have no OAuth client. Under paths ingress
(every preview) they run on the platform's own issuer session and send a signed-out browser to the
platform's `/login`, which only signs you in as yourself. And their `Sign in ↗` links point at the
app Worker's own `/.auth/login`, which those Workers don't serve (404).

## Decisions (made while AFK-style; revisit if wrong)

- **The link goes straight to `/login`**, not through `/.auth/login`:
  `<platform>/login?next=/projects/pr<N>/<slug>/&login_hint=pr<N>@preview.iterate.test`. The
  platform's `/.auth/login` sends a browser already signed in (as the admin) straight to `next`,
  where the admin is not a member of `pr<N>` and lands on "Sign in again". `/login` handles both
  the signed-in and signed-out admin.
- **The offer lives on `/login`'s signed-in state.** Signed out, the page's sign-in options return
  to `/login?next=…&login_hint=…` (only when the hint is under `login.testEmailDomain`), so after
  "Continue with os.iterate.com" or the password form the admin lands on the offer. Signed in as a
  platform admin (their own session, not an impersonation), with a hint naming an existing person
  under the test email domain who isn't them: a **Sign in as <hint> for an hour** button next to
  Continue. Anyone else sees today's "You're signed in".
- **The confirm is a plain POST to `/login`** (`sign_in_as=<email>`), which re-checks everything
  server-side: live issuer session, not an impersonation, `isAdmin`, test email domain configured
  and matched, the person exists and isn't the admin. The page's offer grants nothing.
- **Result: a new issuer session for the person**, `impersonatedBy` the admin, deadline one hour
  (the consent flow's), both accounts recording `account/impersonation-started` /
  `account/impersonation-performed` (awaited before the browser gets the cookie). The admin's own
  issuer session in that browser is ended (it would otherwise be orphaned for 30 days).
- **An impersonated issuer session can't mint longer-lived credentials:**
  - consent approved from it carries `impersonatedBy` and never outlives the issuer grant's
    deadline (else the Dash's consent would mint a 30-day unattributed grant of the person);
  - `grants.mint` (personal access tokens) refuses any impersonation. This also closes the same
    gap for consent-page impersonations that asked for `account`.
- **The seed makes `pr<N>` serve the proxied apps.** The default config template 404s on the
  `notes`/`docs` routing slugs, so the new link would land nowhere. The seed sets a fetch route per
  deployed proxied app (routing slug = app name, members only) to a small loaded worker that
  fetches through to the deployment's own app Worker, as `apps/notes/config-worker.ts` does for
  prd. The default config worker already forwards fetch-route matches.
- **Which apps are proxied:** `notes` and `docs` by name in `preview-config.ts`. Docs isn't on
  main yet (#3384); when it lands its row gets the new link and route with no further change.
- Not changing `iterate/app-server`'s `/.auth/login` to carry `login_hint` to the login page: the
  PR link doesn't go through it, and a signed-in admin would skip it anyway.

## Checklist

- [ ] `/login`: `login_hint` in the search; offer for admins; sign-in options return to the offer
- [ ] `POST /login` `sign_in_as`: guards, one-hour impersonated issuer session, both records, old session ended
- [ ] `SignedIn` shows the offer button and, for an impersonation, who you are
- [ ] consent from an impersonated issuer session: `impersonatedBy` + capped deadline
- [ ] `grants.mint` refuses an impersonation
- [ ] preview-config: `proxiedAppSignInLink`, the fetch route per proxied app; preview.ts uses both
- [ ] unit rows (preview.test.ts): link shape, section row, route shape
- [ ] workers test rows: POST guards, the session's attribution/deadline, consent + mint from it
- [ ] specs: admin via the link lands on Notes as the test person (paths only); non-admin and non-test hint get no offer
- [ ] docs: dev-environments.md (PR sign-in links, Acting as users and admins), comments
- [ ] PR (draft) with risk map calling out the trust boundary

## Implementation notes

(log goes here)
