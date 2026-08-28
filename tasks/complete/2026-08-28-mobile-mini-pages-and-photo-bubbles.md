---
status: ready
size: medium
---

# Mobile: mini in-app pages, compact secret form, Telegram-style photo bubbles

## Status

Done, awaiting merge — [PR #2538](https://github.com/iterate/iterate/pull/2538).
All five items shipped, CI green, every review thread resolved.

**The mini-page approach was abandoned mid-review, on purpose.** The first
build opened the collect-secret page in an in-app browser sheet that closed
itself. It worked, but it carried iOS's "Iterate wants to use iterate.com to
sign in" consent prompt — and that prompt asks about something that is not even
true here: the app authenticates itx with a bearer token, so no browser's
cookies decide whether you are signed in. Checking that also ruled out a
WKWebView (its own cookie jar means a fresh login inside the popup). The app
can do everything the page does over the session it already holds, so it now
renders the request natively: no browser, no prompt, no second sign-in, no app
switch, one hop fewer than the web path. The `returnTo` contract was deleted
with the sheet — nothing else consumed it.

- **Done:** the native collect-secret screen and its link parser, the eye
  toggle and compaction on the web page (which still serves desktop, Slack and
  email), Telegram-style photo bubbles, and `getSecret(...)` in query values.
- **Covered by:** `specs/mobile/collect-secret.spec.ts` (the whole round trip
  on the real build, driven by a link from the production builder),
  `specs/collect-secret.spec.ts` (the web page, including its size budget),
  `specs/mobile/chat-photos.spec.ts`, plus unit tests for the link parser, the
  photo frame maths, and the substitution rules.
- **Review changed two rules.** Bugbot found that a caption longer than its
  photo stretched the bubble past it, reopening the very gap this was meant to
  close; the fix made the frame width a constant every photo and its caption
  share, which also retired the separate "small images keep their own size"
  case. It also found that `URLSearchParams` reads a literal `+` as a space, so
  a secret path containing one routed correctly at discovery and then 400d —
  query pairs now come off the raw query text.
- **Declined:** two `no-inferable-type-annotation` suggestions (raised twice).
  The annotations they object to are the prevailing style in the same files
  (~488 repo-wide), nothing enforces the rule, and both functions are single
  sources of truth where the annotation is what fails the build if a body
  drifts. Reasoning is in the threads; if the repo wants that direction it is a
  codemod plus a lint rule.
- **Next:** ad-hoc "collect some info" screens. The native path makes this a
  different shape than the abandoned web contract — the app would render a
  described form rather than open a page — so it wants its own task.

Assumptions marked **[assumption]** below were made without the requester
present.

### Late findings (after the native rework)

Review and the preview lane turned up four defects in the native screen, all of
one shape — **the screen asserting a state it had not confirmed**:

- Saving over an existing secret from a stale "does it exist?" answer took the
  `create()` path, which keeps the old material, while the stored-material
  check reported success. A rotation that silently did not happen. (Bugbot,
  High.)
- Gating Save on the query's *status* meant a failed background refetch took
  the button away — triggered by leaving to a password manager, this screen's
  main flow. (Bugbot, Medium.)
- A bare `Pressable` renders as a plain `div`, so nothing outside React could
  tell Save was disabled: assistive tech announces it as pressable, and the
  preview lane tapped a no-op then waited 30s for a save that never started.
  This was the red CI, not the spinner-waiter it was first blamed on.
- Reopening the link after a save served the pre-save existence answer, so the
  overwrite warning was missing on the visit where it matters most.

Reproduced locally by slowing the existence check to 5s — worth keeping as the
technique for this screen, since a fast local save hides all of it.

Two things I got wrong along the way, recorded so they are not repeated:
middlewright's spinner-waiter DOES honour an explicitly passed `{ timeout }`
(it passes straight through; only the no-timeout path gets the 1ms fast-fail),
and its `spinnerSelectors` are adjustable per-call via
`spinnerWaiter.settings.run` — as `specs/mobile/chat-titles.spec.ts` already
does. Neither was the problem here, and I asserted both without checking.

## What's being asked

Five bundled items, four mobile-facing plus one platform one:

1. **Mini in-app browser for secret collection.** Tapping an
   `/collect-secret/...` link in chat currently leaves the app for Safari.
   It should open a mini in-app browser that auto-closes when the secret is
   submitted. Build it so the auto-close trigger is a **generic page-state
   contract**, not something hard-wired to secrets — ad-hoc "collect some
   info" pages will want to reuse the same component soon. (Only the
   contract + the secret page need doing now.)
2. **Show/hide toggle on the "Value" field** of the "Provide a secret" page,
   so the submitter can eyeball what they pasted.
3. **Compactify the "Provide a secret" page** — it should not need more than
   ~2/3 of an iPhone screen now that it renders inside a mini browser.
   Explicitly authorised to make the compaction calls unilaterally.
4. **Telegram-style photo attachments** in chat: the photo goes flush to the
   bubble edges, and a photo skinnier than the bubble gets a blurred backdrop
   of itself rather than black bars.
5. **Allow `getSecret(...)` placeholders in URL query params** (today
   substitution is path-only and the query throws), unless there's a reason
   not to.

## Checklist

### 1. Mini page contract (web + mobile)

- [x] `apps/os/src/lib/mini-page.ts` — the shared contract, generic from day
      one: a `returnTo` search param a native client appends, an allowlist of
      schemes it may point at (the app scheme only), and the helper that
      builds the redirect a finished mini page navigates to. _`MiniPageSearch`
      + `miniPageReturnUrl`._
- [x] `/collect-secret/$projectSlug` accepts `returnTo` and, on a successful
      save, navigates to it with the outcome in its params. Still renders the
      success card underneath, so a browser that does not auto-dismiss (or a
      `returnTo`-less desktop visit) is not left blank. _The card also carries
      a "Back to the app" link — the manual way back, and what the spec
      asserts, since Chromium cannot follow `iterate://`._
- [x] `returnTo` values that are not the app scheme are ignored, not
      followed — the page is org-member-gated but the param is attacker-
      supplyable in a pasted link, and an open redirect out of an
      authenticated page is not something to ship. _`iterate:` and `exp:`
      only; every http(s) form returns null._
- [x] `apps/mobile/src/lib/mini-page.ts` — pure resolver: which same-origin
      URLs open as a mini page (path allowlist, starting with
      `/collect-secret`), how the `returnTo` is added, and how the returned
      URL is read back into an outcome. _The browser opener is injected, so
      the module stays out of React Native's way in the node test lane._
- [x] Chat markdown link handling consults the mini-page resolver after the
      existing in-app route resolver, before falling through to
      `Linking.openURL`. _`components/markdown.tsx`; success needs no toast
      (the agent's reply lands in the thread), a stored-but-unannounced
      secret gets an alert._

### 2. Show/hide on the Value field

- [x] Eye toggle inside the input, labelled for screen readers, defaulting to
      hidden. _`InputGroup` + `InputGroupButton`, "Show value"/"Hide value"._

### 3. Compact the collect-secret page

- [x] Fits an iPhone viewport with room to spare (target: the whole card
      under ~2/3 of a 390×844 screen with the keyboard closed). _Asserted in
      the spec, so it cannot drift back._
- [x] Nothing load-bearing removed: the description, the destination path,
      the egress pin, and the overwrite warning all still show. _Header
      separator and the footer's project line went; the project name moved
      into the header sentence._

### 4. Telegram-style photo bubbles

- [x] Photo renders flush to the bubble's edges with the bubble's corner
      radius. _The bubble lost its padding and clips its children; text
      children bring their own inset._
- [x] Aspect ratio preserved; frame height capped so a tall screenshot does
      not eat the thread. _280pt wide, 340pt tall at most._
- [x] A photo narrower than the frame sits on a blurred, cover-scaled copy of
      itself instead of a black letterbox. _React Native's own `blurRadius`,
      no new dependency. Two ways a photo ends up narrower: the height cap, and
      an image too small to fill the width (never scaled up)._
- [x] A caption can never stretch the bubble wider than its photo — that would
      put bubble fill along the photo's edge. _Bugbot found it; the frame width
      is now a constant (`photoFrameMaxWidth`) that the bubble's caption shares._
- [x] Layout maths lives in a pure module with unit tests. _`lib/photo-layout.ts`._

### 5. `getSecret(...)` in query params

- [x] Substitution covers query parameter **values**.
- [x] Query parameter **names** still throw — same rule as JSON object keys.
- [x] Fragment, userinfo and host still throw.
- [x] A literal `+` in a query placeholder stays a `+`. _Bugbot found it:
      `URLSearchParams` decodes form-urlencoded, so `/secrets/a+b` routed
      correctly at discovery and then 400d as `/secrets/a b`. Query pairs are
      split from the raw text now._
- [x] A query with no placeholder stays byte-identical (the existing ratchet).
      _Path and query now track their hits separately, so a path placeholder
      no longer re-encodes an innocent query either._
- [x] Docs updated: `apps/os/docs/integrations-and-secrets-design.md` §1 and
      `apps/os/docs/adr/0005-the-secret-cell-invariant.md`, including the
      caveat that a credential in a query string lands in provider access
      logs.

## Decisions taken while specifying

**~~Mini-page auto-close via `WebBrowser.openAuthSessionAsync`~~ — superseded.**
Built and then removed. The consent sheet was judged an acceptable cost here;
it was not, and the reasoning behind accepting it was wrong: the sheet asks
about a browser sign-in that has nothing to do with how the app authenticates.
See the status note above.

**~~The generic contract is `returnTo` + status params~~ — superseded.** Deleted
with the sheet, since nothing else consumed it. The reuse it was meant to buy
(ad-hoc "collect some info" pages) is still wanted, but the native path makes
it a different shape: the app renders a described form rather than opening a
page.

**The app writes the secret itself.** The collect-secret page only ever did
three things — describe the secret, write material and egress in one update,
message the agent that asked — and the app holds an authenticated itx session
that can do all three. Rendering the request natively removes the browser, the
consent prompt, the cookie jar and the app switch in one move, and shortens the
path the material travels. The web page stays for links followed anywhere else.

**Query-param secrets: doing it, with the caveat written down.** The
reason to hesitate is real but it is the caller's to weigh, not the
platform's to forbid: a credential in a query string ends up in the
provider's access logs, and in any intermediary's, in a way a header does
not. What the platform must not do is leak it on *our* side, and it doesn't —
the audit event records `request.url` **before** substitution, so the stored
fact keeps the `getSecret(...)` placeholder, exactly as it already does for
Telegram's path-substituted bot token. Plenty of APIs only accept
`?api_key=`; refusing them buys nothing.

**Query params are rewritten only when one carries a placeholder.**
Re-serialising a query string changes its encoding (`%20` → `+`), so an
untouched query must not round-trip through `URLSearchParams`. Same ratchet
the path substitution already keeps.

**Photo-first bubbles.** Telegram puts the image above its caption; ours
currently puts text first and the image under it. Matching Telegram, since
that is the reference the request named.

## Out of scope

- Ad-hoc "collect some info" mini pages themselves. The contract lands; the
  first non-secret page that uses it does not.
- Any change to which links open in-app vs. the system browser beyond adding
  the collect-secret path.
- Video or non-image attachment rendering.
