---
state: backlog
priority: medium
size: small
---

# Preserve one Roughdraft endmatter when first comments race

Docs intentionally dispatches client-generated review edits through the ordinary
collaborative text protocol. Two clients starting from the same file without
endmatter can each add a valid first comment. Rebasing preserves both insertions
but creates two YAML footers; Roughdraft then reports a missing metadata entry.
This limitation is explicitly accepted for the initial implementation.

The executable reproduction is
`apps/os/src/domains/workspaces/collab-review.test.ts`, named
“simultaneous first comments should share one valid endmatter”. It uses the real
Roughdraft writer, client text diff, collaboration host and parser, wrapped with
`createFailing`. Only the duplicate-footer failure is expected; unrelated errors
or an unexpected pass fail the suite.

Exit criteria: both comments and the original prose survive, the resulting file
has one valid endmatter, and the test runs without the expected-failure wrapper.
Keep the solution small; do not introduce a separate comment store or collaboration
engine. Overlapping concurrent annotations are another known limitation of
client-generated CriticMarkup and need separate investigation.
