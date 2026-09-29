---
status: in-progress
size: small
---

# The PR body's Notes link signs an admin in, as themselves, to the PR's project

**Status:** spec'd, implementation starting.

## Why

The PR body's Notes (and, with iterate/iterate#3384, Docs) `Sign in ↗` points at the app Worker's
own `/.auth/login`, which it doesn't serve (404). Proxied apps have no sign-in of their own: under
paths ingress (every preview) they run on the platform's session. An admin signing in to a preview
with **Continue with os.iterate.com** is themselves (e.g. `misha@nustom.com`), who is no member of
the PR's project `pr<N>`, so Notes wouldn't let them in anyway. And the seeded `pr<N>` doesn't serve
the `notes` routing slug (the default config worker 404s on it).

Supersedes iterate/iterate#3393, which made the platform's `/login` sign an admin in _as_ the test
person. That needed new sign-in code in apps/os/src; nobody needs to be the test person in Notes.

## Decisions

- **No apps/os/src change.** Only CI scripts (`apps/os/scripts/preview*.ts`), tests and docs.
- **The seed makes the deployment's admins members of `pr<N>`'s organization**: envs.ts
  `previewDeployment` `admins` (prd's, plus the specs' `admin@preview.iterate.test`). Users are
  created by email through the operator's session (find-or-create), so a prd admin's first sign-in
  through os.iterate.com finds the same row.
- **The seed sets a fetch route per proxied app** (routing slug = app name, members only) to a small
  loaded worker that fetches through to the deployment's own app Worker, as the app's
  `config-worker.ts` does for prd's.
- **The link is the app's page for the project**: `<platform>/projects/pr<N>/<app>/projects/pr<N>`.
  Signed out, the edge sends the browser to the platform's sign-in and back; signed in as a member,
  it opens. Landing on `/projects/pr<N>` inside the app, not its root, because the app's root picks
  the person's first project, which for an admin may be another.
- **Proxied apps by name** (`notes`, `docs`) in preview-config.ts, so Docs gets its link and route
  when #3384 lands.

## Checklist

- [ ] preview-config: `PROXIED_APPS`, the proxied link, the route; one function for each row's link
- [ ] preview.ts: `signInLinks` uses it; `seedSignIn` sets the routes and adds the admins
- [ ] unit rows in preview.test.ts
- [ ] spec: an admin signs in as themselves through the Notes link and lands on the project's note
- [ ] docs: dev-environments.md PR sign-in links, apps/os README, testing.md
- [ ] close #3393 pointing here

## Implementation notes

(log goes here)
