---
status: in-review
size: small
pr: https://github.com/iterate/iterate/pull/1715
---

# CI workflow: LOC-changed report on PRs, by group

## Status summary

Implemented, PR open (#1715). Workflow + script + SLOC follow-up all pushed; validated locally
against real merged-PR diffs and via `depot ci run`. Remaining: automatic `pull_request` runs
only start once this lands on main (Depot registers triggers from the default branch).

## Motivation

An important review signal is how many lines of code a PR adds/removes — but "added to the
product" is a very different signal to "added to tests", "added to docs", or "regenerated
lockfile churn". PRs should show a small table of net LOC change broken down by group.

## Spec

- [x] New Depot workflow `.depot/workflows/loc-report.yml` triggered on `pull_request`, calling a
      script per repo convention (thin YAML, logic in `scripts/ci`). _Thin wrapper around
      `pnpm tsx scripts/ci/loc-report.ts`; `fetch-depth: 0` so the merge-base is available._
- [x] `scripts/ci/loc-report.ts` computes the diff between the PR base and head (merge-base
      three-dot diff, like GitHub's Files Changed tab) and buckets changed files into hardcoded
      groups: `Array<{ name: string; glob: string }>`. _`git diff --numstat -z -M` parsed
      rename-aware; groups matched with `node:path` `matchesGlob`._
- [x] Posts a **sticky comment** on the PR (marker comment, update-in-place on synchronize) with a
      table: group | files | added | removed | net. _Marker `<!-- iterate-loc-report -->`, upsert
      via Octokit issues API using `ITERATE_BOT_GITHUB_TOKEN`._
- [x] Colors: render the table inside a ```diff code block — each group's row is prefixed
`+`/`-`/` ` by net sign, which GitHub renders green/red. _`renderTable` computes column
      widths and prefixes rows by net sign.\_
- [x] Script is runnable locally with no PR context (prints the table instead of commenting).
      _`pnpm tsx scripts/ci/loc-report.ts [base] [head]`, defaults `origin/main HEAD`._
- [x] Follow-up commit: count **SLOC** — strip JS `//` and `/* ... */` comments before counting.
      _`stripJsComments` is a small string/template-literal-aware state machine; per-file counts
      come from `git diff --no-index --numstat` over the stripped before/after contents._

## Decisions / assumptions (made while AFK)

- **First-match-wins grouping.** The user said overlapping groups need no special protection.
  Rather than double-counting, the group array is ordered most-specific-first and each file lands
  in the first matching group, with a code-level "Other" fallback (a literal `**` glob doesn't
  match dotfiles, so the fallback lives in code, not in a glob). This makes the groups an exact
  partition so the Total row is meaningful. Trivial to change to multi-count later.
- **Groups** (ordered): Generated (`pnpm-lock.yaml`, `**/.generated/**`, `**/generated/**`,
  `**/*.generated.*`), Tests, UI components (`packages/ui` + `**/components/**`), Docs,
  CI & scripts, Config, Product (remaining `apps/**` + `packages/**`), Other.
- **Rename handling**: git rename detection (`-M`) so pure renames don't show up as huge +/-.
- **SLOC definition**: blank lines never count (for all text files, not just JS); JS-ish files
  additionally get comments stripped. Added/removed per file is computed by diffing the
  comment-stripped before/after contents, so multiline `/* */` blocks are handled naturally.
  String literals are tracked so `"http://..."` isn't treated as a comment; regex literals are
  not (known, acceptable limitation — "for now" per the ask). "Before" content is taken at the
  merge-base, matching the three-dot diff.
- **Trigger gotcha**: Depot registers triggers from the default branch, so the automatic
  `pull_request` runs only start once this lands on main. Validated pre-merge via
  `depot ci run --workflow .depot/workflows/loc-report.yml` and by running the script locally.

## Implementation log

- Sample output against merged sandbox-platform PR (3296aa87a), SLOC mode:

  ```
    Group         Files  Added  Removed    Net
  + Generated         2    +11      -10     +1
  + Tests            10   +138      -26   +112
  + Docs              6   +478      -42   +436
  + CI & scripts      6    +66      -38    +28
  + Product          22   +593      -82   +511
  + Other             7    +30       -2    +28
  + Total            53  +1316     -200  +1116
  ```

  (raw-line mode counted +1939/-315 for the same diff — blanks and comments were ~30% of it.)

- `stripJsComments` covered by a 12-case ad-hoc harness during development (trailing/whole-line
  `//`, single/multiline blocks, strings containing `//` and `/* */`, escapes, template
  literals spanning lines, division, jsdoc, unterminated block). Worth promoting to a real test
  file if this script grows.
- `GithubEventPayload` in `scripts/ci/github.ts` gained optional `base`/`head` sha fields.
