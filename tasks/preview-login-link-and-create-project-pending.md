---
status: ready
size: small
---

# Preview comment login link + create-project pending state

Two small auth/preview-deploy annoyances, from Misha:

> 1) in the table of deployed stuff, can we use the click-and-login thing like
> in [this comment](https://github.com/iterate/iterate/pull/2474#issuecomment-5256641538).
> actually, maybe it should just be a suffix on the `## Environment Config Lease`
> title. Just like a `Login ↗` `<a>` tag with target=_blank or something. So no
> extra space used-up
>
> 2) in the auth worker when I click create project there's no spinner and the
> create button doesn't get disabled, so I often click it twice and get an error
> the second time (it's nbd, i eventually get navigated anyway but a little
> annoying)

## Status

Spec written, implementation not started.

## 1. `Login ↗` suffix on the preview PR comment heading

The preview section in the PR body is rendered by
`renderCloudflarePreviewSection` in `scripts/preview/preview.ts`. Make the
heading:

```md
## Environment Config Lease [Login ↗](https://os.iterate-preview-N.com/api/iterate-auth/login?login_hint=prNNNN%2Btest%40nustom.com)
```

Decisions (assumptions, since Misha was brief):

- Markdown link, not a literal `<a target="_blank">` — GitHub's HTML sanitizer
  strips `target` anyway, and markdown-in-heading renders fine on GitHub.
- Login URL = os preview base URL (derived from the lease's doppler config via
  the typed `envs.ts` map — same source deploys use) +
  `/api/iterate-auth/login?login_hint=pr<PR#>+test@nustom.com`, matching the
  click-and-login link in the referenced comment. `+test@nustom.com` emails get
  the fixed OTP `424242` on preview slots, so this is one-click-ish login.
- Per-PR `login_hint` (`pr2474+test@nustom.com`) so each PR's testing lands on
  its own user by default.
- No link when there's no lease recorded, or the doppler config isn't a known
  os environment (render must never throw).

- [ ] thread `pullRequestNumber` into `renderCloudflarePreviewPullRequestBody`
      / `renderCloudflarePreviewSection` (required param, callers all have it)
- [ ] heading suffix with login URL derived from lease doppler config
- [ ] update/extend `scripts/preview/preview.test.ts`

## 2. Create-project button stays enabled during post-success redirect

The auth app's create-project surfaces (`apps/auth/src/routes/_auth/project-access.tsx`)
_do_ disable + relabel while the mutation is pending. The actual gap: on
success the code assigns `window.location.href` and returns, react-query flips
`isPending` back to `false`, and the button re-enables (labeled "Create
project" again) while the browser is still loading the redirect target. That's
the window where the second click lands and errors with a duplicate — and "I
eventually get navigated anyway" because the first redirect completes.

Fix: a `redirect()` helper that assigns `window.location.href` and returns a
never-resolving promise. Returned from `onSuccess` (or awaited in
`mutationFn`), react-query keeps the mutation pending until the page unloads,
so every button gated on `isSubmitting` stays disabled through the navigation.

- [ ] `redirect()` helper; use it for all `window.location.href` assignments in
      `project-access.tsx` (create org+project, create project, save selection,
      deny)
- [ ] regression test if practical — note apps/auth has no component-test
      (jsdom) infra today; if adding one isn't worth it for a 3-line helper,
      skip and say so here

## Implementation log

- Worktree `../worktrees/iterate/preview-login-link-and-create-project-pending`,
  branch of the same name, off `origin/main` (0790f2170).
