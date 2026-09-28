# Review rules

Every other `.md` file in this folder is a review rule. Agents follow the rules whose `files` globs
match what they change, and the iterate project's AI linter (`packages/ai-linter`, installed from
iterate/config `ai-linter/`) reviews each pull request against `rules/` at the pull request's base. A
rule a program can decide is an Oxlint rule in `lint/` instead, which CI enforces for free:
truthiness checks (`iterate/simple-truthiness-check`), inferable type annotations
(`iterate/no-inferable-type-annotation`) and single-use helpers (`iterate/no-single-use-helpers`)
moved there from this folder.

A rule is YAML frontmatter, then prose:

```yaml
---
id: comments/no-narrating-comments # a finding's and a suppression's name for the rule
severity: error # or warning
files: ["**/*.{ts,tsx}", "!**/*.gen.ts"] # globs; a leading ! excludes
suggestions: forbidden # optional: findings carry no suggested change
engine: jev # optional: llm (the default) or jev
---
```

## Engines

`engine: llm` rules are read by an LLM, which gets the pull request's diff and every LLM rule's
prose in one call and reports what violates them. An LLM rule with `select` and `window` (below)
gets only the units its selector picks, each with the lines around it, instead of the diff; a pull
request with no such unit asks the LLM nothing for it.

`engine: jev` rules are decided unit by unit. A fixed selector picks units on the lines the pull
request added, and Jev (TypeSafe's decision model on Workers AI) answers the rule's yes/no question
about each one with p, the probability that it violates the rule. The frontmatter says how:

- `select`: which units.
  - `comment`: a run of comment lines, or a comment after code.
  - `{ line: '<regex>' }`: an added line the regex matches. `{match}` is the whole words it matched.
  - `cast`: `value as T` or `<T>value`, never `as const`.
  - `conditional`: the outermost ternary of a chain, or an `if` with an `else`.
  - `shape`: a `&&` or `||` chain of two or more `typeof`, null, `in`, `instanceof` or
    `Array.isArray` tests, or `JSON.parse(…)` or `.json()` asserted with `as`.
- `window: [before, after]`: the lines around the unit that Jev reads.
- `question`: `instructions`, and what `"true"` and `"false"` mean.
- `flag`: a p at or above it is a finding.
- `pass`: a p below it is none. A p from `pass` up to `flag` goes to the LLM with the rule's prose.
  Without `pass`, nothing goes to the LLM.
- `message`: the finding's review comment. `{match}` works here too.

The Check Run says which engine decided each finding, with Jev's p.

A Jev rule's question, window and thresholds were measured together against labelled cases. Change
one only after measuring the change: terse wording raises p for everything, and a threshold holds
only for the wording and window it was chosen with.

`iterate-lint-disable-next-line <rule> -- <reason>` (also `-line`, and a `disable` / `enable` pair)
suppresses a finding of either engine.
