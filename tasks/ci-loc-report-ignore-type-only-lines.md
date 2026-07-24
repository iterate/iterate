---
status: in-progress
size: small
---

# LOC report: exclude type-only TypeScript lines from Significant

## Status summary

Implementation and local checks are complete. TypeScript source maps now remove type-only lines
without changing source-line counts; the PR self-report and CI/review remain.

## Motivation

The PR LOC report treats type growth as implementation churn. More types are often useful, so the
Significant column should focus reviewers on changed runtime code without hiding the raw Lines
column.

## Spec

- [x] Type-only changes in TypeScript files contribute zero Significant additions/removals while
      remaining visible in Lines. _Covered by a real-git integration test._
- [x] Runtime-bearing TypeScript still counts, including syntax such as enums that looks type-like
      but emits JavaScript. _The enum fixture stays 4 raw / 4 significant._
- [x] JavaScript and non-JavaScript files retain their current Significant behavior. _JS comments
      and Markdown blank lines have regression coverage._
- [x] The PR-body footnote states that TypeScript type-only changes are excluded. _Rendered text
      names TypeScript lines with no runtime output._
- [x] Tests cover a type-only change, mixed type/runtime code, runtime-emitting TypeScript, and
      unchanged behavior outside TypeScript. _`scripts/ci/loc-report.test.ts` has five integration
      cases._
- [ ] Verify the report against this PR and record the observed raw/significant split.

## Decisions / assumptions

- Ask TypeScript's `transpileModule` for a source map for `.ts`, `.tsx`, `.mts`, and `.cts`, then
  retain only original source lines mapped to runtime output. This removes interfaces, type aliases,
  type-only imports, and other erased lines without maintaining a partial TypeScript parser or
  counting expanded compiler output.
- Emit modern ESM with preserved JSX. This avoids downlevel helper noise while retaining runtime
  constructs such as enums and decorators.
- Keep raw `git diff --numstat` unchanged. The new behavior affects only Significant.
- If TypeScript cannot transpile a file, fail the report instead of silently reverting to raw source;
  unexplained fallback behavior would make the metric untrustworthy.

## Implementation log

- Confirmed experimentally that changing an interface leaves TypeScript's emitted JS identical,
  while an enum emits runtime JavaScript and remains countable.
- The first compiler-output prototype exposed synthetic `export {};` churn and enum expansion.
  Source maps fixed both: they act only as a runtime-line stencil over the original source.
- `pnpm --dir scripts typecheck` and all 274 scripts workspace tests pass.
