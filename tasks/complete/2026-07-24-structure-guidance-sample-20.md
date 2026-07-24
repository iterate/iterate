---
status: complete
size: medium
---

# Apply structure guidance to a 20-file sample

## Status summary

Complete in draft PR #2306, stacked on PR #2305. Exactly 20 non-test JS/TS source files changed:
19 multiline ternaries were removed, one single-use helper was inlined, and several unnecessary
falsy distinctions were collapsed. Full typecheck, lint, formatting, and tests pass.

## Spec

- [x] Select 20 production source files with clear violations of the three new structure rules.
      *Used small handwritten files across apps and packages; generated, vendored, test, and spec
      files were excluded.*
- [x] Apply the rules with file-by-file judgment. *Kept valid numeric and nullable distinctions;
      empty optional search/config strings now follow their existing fallback meaning.*
- [x] Preserve valid behavior and add no compatibility fallbacks. *Full monorepo typecheck, lint,
      and tests pass.*
- [x] Keep the source diff to exactly 20 files. *The task record is the only non-source addition.*
- [x] Open a draft PR with `rules/structure-guidance` as its base. *Opened disposable sample PR
      #2306.*

## Decisions and assumptions

- “Arbitrary” means the slice need not follow a product boundary; files are selected for small,
  legible examples rather than maximum impact.
- The new rules are advisory and semantic. Every edit must make the local code clearer.
- Tests and specs are excluded by the rule frontmatter and remain unchanged.

## Implementation log

- Started from PR #2305 and merged its follow-up filename correction without rewriting history.
- The 20-file AST census moved from 19 to zero multiline ternaries, three to two tiny single-use
  helper candidates, 14 to nine explicit null/undefined comparisons, and 15 to 13 nullish
  coalescing expressions. The two remaining helper candidates are multi-step parsing/error
  boundaries, not one-line aliases.
- The source diff is 111 additions and 101 removals. Some examples shrink; branch dispatch and
  socket setup get taller, which is useful evidence for reviewing the rule itself.
- `pnpm typecheck`, `pnpm lint`, targeted formatting checks, the focused 39-case repo-file suite,
  and the full monorepo `pnpm test` pass (including 2,333 passing OS tests).
