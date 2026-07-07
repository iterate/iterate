---
status: in-progress
size: small
---

# CI workflow: LOC-changed report on PRs, by group

## Status summary

Spec fleshed out, implementation not started. Plan: a Depot workflow + `scripts/ci/loc-report.ts`
that posts a sticky PR comment with a per-group net-LOC table. Second commit switches counting to
SLOC (ignoring JS comments).

## Motivation

An important review signal is how many lines of code a PR adds/removes — but "added to the
product" is a very different signal to "added to tests", "added to docs", or "regenerated
lockfile churn". PRs should show a small table of net LOC change broken down by group.

## Spec

- [ ] New Depot workflow `.depot/workflows/loc-report.yml` triggered on `pull_request`, calling a
      script per repo convention (thin YAML, logic in `scripts/ci`).
- [ ] `scripts/ci/loc-report.ts` computes the diff between the PR base and head (merge-base
      three-dot diff, like GitHub's Files Changed tab) and buckets changed files into hardcoded
      groups: `Array<{ name: string; glob: string }>`.
- [ ] Posts a **sticky comment** on the PR (marker comment, update-in-place on synchronize) with a
      table: group | files | added | removed | net.
- [ ] Colors: GitHub markdown has no real color support in tables, so render the table inside a
      ```diff code block — each group's row is prefixed `+`/`-`/` ` by net sign, which GitHub
      renders green/red. (Assumption delineated below.)
- [ ] Script is runnable locally with no PR context (prints the table instead of commenting), so
      it can be tested against any base/head pair.
- [ ] Follow-up commit (same PR, pushed separately): count **SLOC** instead of raw lines — strip
      JS `//` and `/* ... */` comments before counting, for JS-ish files
      (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts`).

## Decisions / assumptions (made while AFK)

- **First-match-wins grouping.** The user said overlapping groups need no special protection.
  Rather than double-counting, the group array is ordered most-specific-first and each file lands
  in the first matching group, with a final `**` catch-all ("Other"). This makes the groups an
  exact partition so a Total row is meaningful. Trivial to change to multi-count later.
- **Groups** (initial hardcoded set, ordered): Generated (incl. `pnpm-lock.yaml` and
  `**/.generated/**`), Tests, UI components (`packages/ui` + `**/components/**`), Docs,
  CI & scripts, Config, Product (remaining `apps/**` + `packages/**`), Other.
- **Rename handling**: use git rename detection so pure renames don't show up as huge +/-.
- **SLOC definition**: after stripping comments, lines that are empty/whitespace-only don't count.
  Added/removed SLOC per file is computed by diffing the comment-stripped before/after contents
  (`git diff --no-index --numstat`), so multiline `/* */` blocks are handled naturally. String
  literals are tracked so `"http://..."` isn't treated as a comment; regex literals are not
  (known, acceptable limitation — "for now" per the ask).
- **Trigger gotcha**: Depot registers triggers from the default branch, so the automatic
  `pull_request` runs only start once this lands on main. Validated pre-merge via
  `depot ci run --workflow .depot/workflows/loc-report.yml` and by running the script locally.

## Implementation log

(append as work proceeds)
