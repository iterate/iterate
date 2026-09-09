---
state: backlog
priority: medium
size: small
---

# Preserve Roughdraft source and preview through plain-text edits

Docs intentionally dispatches client-generated review edits through the ordinary
collaborative text protocol. Two clients starting from the same file without
endmatter can each add a valid first comment. Rebasing preserves both insertions
but creates two YAML footers; Roughdraft then reports a missing metadata entry.
This limitation is explicitly accepted for the initial implementation.

A related stale-client case is pinned as `STALE ENDMATTER APPEND`: one client
creates its first comment and footer while another appends at the old EOF. Text
OT preserves that stale append after the new footer, where it corrupts YAML.
It cannot be fixed by relocating remote changes in one client, which would
diverge from the shared document.

The executable reproduction is
`apps/os/src/domains/workspaces/collab-review.test.ts`, named
“simultaneous first comments should share one valid endmatter”. It uses the real
Roughdraft writer, client text diff, collaboration host and parser, wrapped with
`createFailing`. Only the duplicate-footer failure is expected; unrelated errors
or an unexpected pass fail the suite.

Exit criteria: both comments and the original prose survive, the resulting file
has one valid endmatter, and the test runs without the expected-failure wrapper.
Keep the solution small; do not introduce a separate comment store or collaboration
engine.

The same test file now pins concurrent word/paragraph comments in both arrival
orders, with endmatter already present. Both local edits are valid and all three
comments survive, but the merged nested highlight leaks `{==` / `==}` into the
preview without a parser diagnostic. Only that exact `CONCURRENT COMMENT OVERLAP`
failure is expected. A fix must preserve the original prose and both annotations
without adding a separate annotation protocol; remove the expected-failure
wrapper once the preview stays correct in both arrival orders.

Two upstream source-preservation limitations are pinned in the same file:

- `UNRELATED COMMENT REWRITE`: adding a comment reflows an existing long body and
  removes timestamp quotes. The comment still reads correctly, but the text diff
  touches another author's entry. A fix must keep unrelated entries byte-for-byte
  intact, so concurrent edits and Git/redline attribution remain local.
- `ORPHANED COMMENT ENDMATTER`: ordinary typing removes an inline comment while
  leaving its metadata. Roughdraft stops recognizing that footer, renders it as
  prose, and appends a second footer for the next comment. A fix must recognize
  the remaining metadata and preserve a single endmatter with a clean preview.

Keep these as expected failures until there is a small upstream or adapter fix;
do not build another serializer, annotation format, or repair protocol around them.
