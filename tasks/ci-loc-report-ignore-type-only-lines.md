---
status: in-progress
size: small
---

# LOC report: exclude type-only TypeScript lines from Significant

## Status summary

Specified and ready to implement. The intended compiler-backed design is chosen; tests,
implementation, and preview proof remain.

## Motivation

The PR LOC report treats type growth as implementation churn. More types are often useful, so the
Significant column should focus reviewers on changed runtime code without hiding the raw Lines
column.

## Spec

- [ ] Type-only changes in TypeScript files contribute zero Significant additions/removals while
      remaining visible in Lines.
- [ ] Runtime-bearing TypeScript still counts, including syntax such as enums that looks type-like
      but emits JavaScript.
- [ ] JavaScript and non-JavaScript files retain their current Significant behavior.
- [ ] The PR-body footnote states that TypeScript type-only changes are excluded.
- [ ] Tests cover a type-only change, mixed type/runtime code, runtime-emitting TypeScript, and
      unchanged behavior outside TypeScript.
- [ ] Verify the report against this PR and record the observed raw/significant split.

## Decisions / assumptions

- Use TypeScript's own `transpileModule` emit as the significant representation for `.ts`, `.tsx`,
  `.mts`, and `.cts`. Diffing compiler output removes interfaces, type aliases, annotations,
  overload signatures, `declare` statements, and type-only imports without maintaining a partial
  TypeScript parser.
- Emit modern ESM with preserved JSX. This avoids downlevel helper noise while retaining runtime
  constructs such as enums and decorators.
- Keep raw `git diff --numstat` unchanged. The new behavior affects only Significant.
- If TypeScript cannot transpile a file, fail the report instead of silently reverting to raw source;
  unexplained fallback behavior would make the metric untrustworthy.

## Implementation log

- Confirmed experimentally that changing an interface leaves TypeScript's emitted JS identical,
  while an enum emits runtime JavaScript and remains countable.
