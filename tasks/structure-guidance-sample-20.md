---
status: in-progress
size: medium
---

# Apply structure guidance to a 20-file sample

## Status summary

Specified and ready to implement as a draft experiment stacked on PR #2305. No source changes have
been made yet. The implementation will change exactly 20 non-test JS/TS source files, chosen as a
small arbitrary slice of clear candidates.

## Spec

- [ ] Select 20 production source files with clear violations of the three new structure rules.
      *Prefer low-risk files and avoid generated or vendored code.*
- [ ] Apply the rules with file-by-file judgment. *Do not replace valid null, undefined, zero, or
      empty-string distinctions merely to reduce syntax counts.*
- [ ] Keep behavior unchanged and add no compatibility fallbacks. *Use existing tests and focused
      type/lint checks as the proof.*
- [ ] Keep the source diff to exactly 20 files. *The task record is the only non-source addition.*
- [ ] Open a draft PR with `rules/structure-guidance` as its base. *This is an intentionally
      disposable sample for visual review.*

## Decisions and assumptions

- “Arbitrary” means the slice need not follow a product boundary; files are selected for small,
  legible examples rather than maximum impact.
- The new rules are advisory and semantic. Every edit must make the local code clearer.
- Tests and specs are excluded by the rule frontmatter and remain unchanged.
