---
status: in-progress
size: medium
---

# Template-carrying login links

## Status

Implemented and live-verified on preview-17 (all CI green): both hints
survive os login -> authorize -> signed /login redirect; a project created as
`pr2477-template-waiter-chef` was born from PR 2477's `configs/waiter-chef`
(MENU.md and waiter prompts in its repo), and the existence gate correctly
downgraded a `smoke-template-waiter-chef` (no pr prefix -> main ref, template
not merged) to a stock project. Everything below the Decisions section
is best-guess fleshing-out of a brief prompt — assumptions are called out.

## Ask (from Misha, verbatim-ish)

> allow query params that let me choose the project config too. Example PR
> with written instructions to create a project:
> https://github.com/iterate/iterate/pull/2477 — but it'd be good if it could
> be encoded in the URL somehow. How about: if the project slug ends with
> `-template-mytemplate` and `mytemplate` is a config template that exists,
> the project when created in OS will be created with `mytemplate`. And the
> auth app just needs a `projectHint` query param similar to `loginHint` that
> it respects and uses instead of the derived-from-email algorithm that
> always ends up with `nustom`. So the projectHint could be
> `pr1234-template-mytemplate`. Then, as long as this is documented, agents
> can add a maximally useful login link to PR bodies.

## The end-to-end recipe (what this enables)

An agent opening a config-template PR (e.g. #2477, template
`configs/waiter-chef` on branch `waiter-chef`) adds to the PR body:

```
https://os.iterate-preview-N.com/api/iterate-auth/login?login_hint=pr2477%2Btest%40nustom.com&project_hint=pr2477-template-waiter-chef
```

Click → "Continue as pr2477+test@nustom.com" (fixed OTP) → first-run setup
prefilled with project slug `pr2477-template-waiter-chef` → Get started →
OS creates the project **from that PR's `configs/waiter-chef`**.

## Decisions (assumptions delineated)

1. **Slug convention** (os side): the first `-template-` splits the slug:
   `<prefix>-template-<name>` → template folder `configs/<name>` in
   `github:iterate/iterate`. _Assumption: the canonical template repo is
   hardcoded to iterate/iterate — same default the create form's placeholder
   advertises._
2. **Ref from the prefix**: `pr<digits>` prefix → git ref `pull/<N>/head`
   (verified: the downloader's `commits/{ref}` GitHub endpoint resolves it,
   and the existing ref validator accepts it — no GitHub PR-API lookup
   needed). Any other prefix → no ref (downloader defaults to HEAD =
   default branch). _So merged templates work as
   `whatever-template-<name>`, and in-flight PR templates as
   `pr<N>-template-<name>`._
3. **Existence gate**: before recording the derived template in the creation
   event, one GitHub `contents/<path>?ref=` check. Missing/failed → create
   proceeds WITHOUT a template (per "and mytemplate is a config template
   that exists"), with a loud server log. _Assumption: graceful downgrade
   beats blocking project birth on GitHub availability; explicit
   `configRepoTemplate` args are never second-guessed and skip all of this._
4. **Derivation point**: `ProjectRpcTarget.create()` — applies to both the
   prospective-slug lane (os create form) and the existing-handle lane (the
   welcome page's `?ensureBirth` after an auth-app create — Misha's flow).
5. **Param name** (auth side): `project_hint`, snake_case sibling of
   `login_hint` — same "non-binding suggestion" semantics, same forwarding
   path. Validated against the project-slug shape (lowercase kebab, ≤50
   chars) at every hop; anything else is dropped.
6. **Plumbing**: RP `/login` forwards it onto the authorize URL;
   the @better-auth/oauth-provider patch gains
   `project_hint: z.string().optional()` in the authorize endpoint schema
   (exactly how `login_hint` survives the signed /login redirect and
   post-login authorize re-entry); `/project-access` reads it and uses it as
   the initial project slug in both the first-run (org+project) and
   project-only forms, beating the derived-from-email suggestion.
7. **Docs**: recipe documented in `docs/dev-environments.md` next to the
   test-email/OTP section. The preview PR comment's `Login ↗` link (#2475)
   stays hint-less — agents opt in per-PR when they have a template to demo.

## Checklist

- [x] os: `configRepoTemplateFromSlug` helper (pure parse) + existence check
      with injectable fetch; unit tests
- [x] os: derive in `ProjectRpcTarget.create()` when `configRepoTemplate`
      arg is absent
- [x] auth: extend oauth-provider patch with `project_hint`
- [x] auth: RP `/login` forwards valid `project_hint`
      (+ forwarding matrix test in relying-party-behavior.test.ts)
- [x] auth: `/project-access` prefills project slug from the hint
- [x] auth e2e: `project_hint` survives into the signed /login redirect
      (sibling of the login_hint case in oauth-code-exchange.e2e.test.ts)
- [x] docs: login-link recipe in docs/dev-environments.md
