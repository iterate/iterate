---
status: ready
size: medium
---

# Mobile: mini in-app pages, compact secret form, Telegram-style photo bubbles

## Status

All five items implemented. Remaining: capture PR media (a recording of the
collect-secret spec at phone size, and a before/after of the photo bubbles)
and get CI green.

- **Done:** the mini-page contract on both sides (`returnTo` + status, with an
  app-scheme-only allowlist), the eye toggle, the compacted collect-secret
  page, Telegram-style photo bubbles, and `getSecret(...)` in query values.
- **Covered by:** `specs/collect-secret.spec.ts` (the page end-to-end at
  390×844, including the two-thirds-of-a-screen budget), plus unit tests for
  the two contract modules, the photo frame maths, and the substitution rules.
- **Not done here:** the first ad-hoc "collect some info" mini page — the
  contract is what this PR lands.

Assumptions marked **[assumption]** below were made without the requester
present.

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

**Mini-page auto-close mechanism: `WebBrowser.openAuthSessionAsync`.**
`expo-web-browser` is already a dependency and already used for OAuth. Its
auth-session mode dismisses the browser by itself the moment the page
navigates to a URL with the app's scheme, and it hands the resulting URL back
to the caller — which is exactly "watch for page state, then close", and it
gives the app the outcome rather than just a dismissal. **[assumption]** The
cost is iOS's one-time "Iterate wants to use iterate.com to sign in" consent
sheet. The alternative — `openBrowserAsync` plus a deep-link handler calling
`dismissBrowser()` — dodges that sheet but loses the result and needs a global
link listener. Taking the consent sheet.

**The generic contract is `returnTo` + status params.** A mini page is any
page that (a) reads a `returnTo` app-scheme URL from its search params and
(b) navigates to it when its job is done, with `status=` describing how. The
mobile side needs to know nothing about what the page collected. Ad-hoc
"collect some info" pages implement the same two things and get the same
auto-close for free.

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
