---
status: ready
size: small
---

# The public copies name PRs and issues as owner/repo#N

**Status:** spec only. The test fails on main by design (30 lines in 17 files) until
iterate/iterate#3509 merges and this branch merges main.

The public copies (iterate/core, iterate/packages; `copybara/copy.bara.sky`) hold `core/`,
`packages/`, `configs/` and a few root files. A bare `#N` there names an iterate/iterate PR,
but a reader of the copy reads it as the copy's own issue #N. iterate/iterate#3509 qualifies every
existing one; this keeps new ones out.

Elsewhere a bare `#N` stays fine: after the move to iterate/private it means an iterate/private
PR, which is what it'll be written to mean.

## Decisions (guessed, Misha asked for "core, packages and configs")

- **Scope: every file a public copy holds**, the same set `lint/copy-doc-links.test.ts` derives
  from `copy.bara.sky`'s `origin_files`. That's `core/`, `packages/`, `configs/`, plus
  `patches/`, the root tsconfigs, `.nvmrc`, `LICENSE` and `copybara/{core,packages}/`. Today
  `tsconfig.app.json` has a bare `#2904`, so the root files matter.
- **One file, one copy list.** Both checks need the same "what does a copy hold" list, so
  `copy-doc-links.test.ts` becomes `lint/public-copies.test.ts` with two tests and one shared
  list, rather than a second file with the list copied over.
- **What counts as bare:** `#` + 3–5 digits, no leading zero, not after a word character, `/`,
  `&`, `#` or `-`. So `workerd#6800`, `shadcn-ui/ui#11920` and `&#39;` pass.
  - No leading zero and at most 5 digits: `#000` and 6-digit all-decimal hex colours
    (`#171717` in `core/os/public/issuer.css`) aren't refs. No 3-digit colour without a
    leading zero exists in the repo.
  - 1–2 digits aren't checked: `#1` is a list item, a delivery count or a loader-id suffix far
    more often than a PR. After the move, iterate/private's first 99 PRs slip through. That's
    accepted, since they'll be outnumbered within days.
- **Literal text is skipped:** a `#N` inside backticks (`` `#123` ``, an offset's display
  format in `event-row.tsx`), since GitHub doesn't link one there either, and files under
  `/fixtures/` (verbatim copies, already skipped by the doc-links check).
- **A failure names `file:line` and the ref**, and the test title says what to write instead.

## Checklist

- [ ] `git mv lint/copy-doc-links.test.ts lint/public-copies.test.ts`; hoist the copy list into
      a helper at the bottom both tests use
- [ ] the new test: fails on main with the 30 lines iterate/iterate#3509 fixes, passes on
      iterate/iterate#3509's head
- [ ] PR stays red until iterate/iterate#3509 merges; then merge main and check it's green
