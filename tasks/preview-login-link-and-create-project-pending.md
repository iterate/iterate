---
status: in-review
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

Both parts implemented and tested (133 preview unit tests, 95 auth tests,
typecheck/lint/knip green). PR: https://github.com/iterate/iterate/pull/2475.
Remaining: live verification of the Login ↗ link via this PR's own preview
comment (added the `preview` label to trigger it despite draft).

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

- [x] thread `pullRequestNumber` into `renderCloudflarePreviewPullRequestBody`
      / `renderCloudflarePreviewSection` _(required third param; the one
      production callsite in `updateCloudflarePreviewState` already had it)_
- [x] heading suffix with login URL derived from lease doppler config
      _(`previewLoginUrl` in `scripts/preview/preview.ts`, resolved through
      `cloudflarePreviewApps.os.resolvePreviewAppConfig`)_
- [x] update/extend `scripts/preview/preview.test.ts` _(link asserted in the
      round-trip test; no-lease and unknown-config cases assert no link)_

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

- [x] `redirect()` helper; use it for all `window.location.href` assignments in
      `project-access.tsx` (create org+project, create project, save selection,
      deny) _(`redirectAndStayPending` at the bottom of the file; the
      `ExternalRedirect` component's `window.location.replace` is untouched —
      it renders nothing, so there's no button to re-enable)_
- ~~[ ] regression test~~ _(skipped: apps/auth has no jsdom/component-test
      infra and the helper is 3 lines; standing up React test infra for it
      isn't worth it. The behavior is covered by the docstring + preview e2e
      exercising the flow.)_

## Follow-up: email login_hint was dropped at the os hop

Misha tried the deployed link and didn't get the "Login with <email>" page.
Root cause: the login page (utils/login-hint.ts, from the mobile QR deep-link
work in #2429/#2433) and the auth worker's authorize→login hop (oauth-provider
patch, pinned by e2e) both already handle email-address hints — but the
relying-party `/login` route in `apps/auth/src/lib/server.ts` (which serves
os's `/api/iterate-auth/login`, the URL the PR comment links to) only
forwarded `login_hint=email|google` and silently dropped email addresses.
Mobile QRs link to auth directly, which is why they never hit this.

- [x] `forwardableLoginHint` in `apps/auth/src/lib/forwardable-login-hint.ts`
      (mode selectors + `z.email()`-valid addresses, matching the login page's
      search schema); used by the RP `/login` route and the worker's redirect
      param preservation
- [x] widened `LoginOptions.loginHint` on the RP client to allow email strings
- [x] email case added to the forwarding matrix in
      `relying-party-behavior.test.ts`

## Implementation log

- Worktree `../worktrees/iterate/preview-login-link-and-create-project-pending`,
  branch of the same name, off `origin/main` (0790f2170).
