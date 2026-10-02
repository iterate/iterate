---
status: done
size: small
---

# A link can recommend how to sign in: `provider_hint`

**Status:** done (iterate/iterate#3409). The hint, its plumbing, the PR body links and the
deployment-naming title are in; screenshots on the PR. Jonas's question on what "Sign in with
os.iterate.com" means is answered there, and the description now opens with that context.

## Why

A reviewer following a PR body `Sign in ↗` link to a preview, signed out, lands on the platform's
sign-in page: email, password, Google, GitHub, Cloudflare and, last, **os.iterate.com**, the only one
a reviewer can use. Nothing on the page says so. The link should put that button front and centre.

## Decisions

- **`provider_hint=<provider>`** on `/login` (the name follows OpenID Connect's `login_hint`, and
  Keycloak's `kc_idp_hint`). Values: `google`, `github`, `cloudflare`, or the admin issuer's host
  (`os.iterate.com`, the button's own label). A hint naming a way this deployment doesn't offer is
  ignored, so the page is unchanged (prd has no admin issuer).
- **Pure UI.** Signed out with a matching hint, the page shows one primary **Sign in with
  <provider>** button and a small "or sign in another way" link: the same `/login` with `next` but
  without the hint. A pending mailed code still shows its form. Signed in, nothing changes.
- **The hint reaches `/login` from every PR body link:**
  - `iterate/app-server` `/.auth/login` passes `provider_hint` on: to the login page (the
    platform's own, for proxied apps), else onto the issuer's authorization URL beside `login_hint`;
  - the issuer's consent page sends a signed-out browser to `/login` with the authorization's
    `provider_hint`.
- **The PR body links carry it**: every app's `Sign in ↗` and the template quick-launch links name
  the deployment's admin issuer host. A proxied app's link becomes the platform's
  `/.auth/login?next=<the app's page in pr<N>>&provider_hint=…` (a signed-in member goes straight on).

## Checklist

- [x] `/login`: `provider_hint` in the search; the recommended button and the way back _`RecommendedSignIn`, `signInProvidersOf`_
- [x] app-server `/.auth/login` passes it on; consent's sign-in redirect lifts it
- [x] PR body links carry it
- [x] tests: app-server rows, preview.test.ts rows, the Notes link spec shows the recommendation and
      the way back
- [x] the page names the deployment (added in review): "Sign in to PR <N>'s preview", the deployment
      name beneath, the tab's icon in the header; "local dev"; prd unchanged _`routes/login.tsx`,
      `deploymentEnvironment`'s `deployment`_
- [x] docs

## Implementation notes

- iterate/iterate#3401 was squash-merged and GitHub retargeted this PR to main without rebasing it, so it
  conflicted; merged main in, kept this branch's side plus iterate/iterate#3401's last commit (`Promise.all`), and
  dropped the pre-squash copies of iterate/iterate#3401's tests and task file the merge resurrected.
