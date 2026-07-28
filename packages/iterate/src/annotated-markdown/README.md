# annotated-markdown

A standalone codec for iterate-style markdown task files: YAML front matter,
an ordinary markdown body, and — new — discussion threads that live at the end
of the same file between paired HTML-comment sentinels. One task, one file,
readable in any editor and renderer, no database or sidecar.

Implements the design in the config repo's
`tasks/2026-07-28-markdown-native-task-comments.md` (option A: paired
HTML-comment sentinels around visible markdown).

```md
---
title: Prevent stale search results
state: in-progress
---

# Prevent stale search results

Publishing must durably enqueue invalidation before returning. [T1](#thread-th_01K…)

<!-- task-discussions:v1 -->

## Discussion

<!-- task-thread:v1 begin id=th_01K… status=open -->

<a id="thread-th_01K…"></a>

### T1 · Open

<!-- task-anchor:v1 {"quote":{"exact":"durably enqueue","prefix":"must ","suffix":" invalidation"},"position":{"start":58,"end":73}} -->

<!-- task-comment:v1 begin id=cm_01K… author=lee created=2026-07-28T08:30:00Z -->

#### Lee · 2026-07-28 08:30 UTC

Does "durably enqueue" require the queue write to finish?

<!-- task-comment:v1 end id=cm_01K… -->

<!-- task-thread:v1 end id=th_01K… -->
```

## Grammar (task-discussions/v1, normative)

A document is, in order: an optional UTF-8 BOM, optional front matter, a body,
and an optional discussion store that runs to the end of the file.

**Front matter** starts only at the very beginning of the file (after the BOM):
a line that is exactly `---` (trailing spaces/tabs allowed), YAML content, then
the first following line that is `---` or `...`. The YAML is restricted: it
must be a mapping (or empty) of plain string keys, with no anchors, aliases,
tags, merge keys, duplicate keys, `%YAML` directives, unsafe keys
(`__proto__`, …), or nesting beyond 64 levels. An opening fence that never
closes is fatal.

**Sentinels** are recognized only when a line starts at column 0 with
`<!-- task-` and are parsed strictly:

- `<!-- task-discussions:v1 -->` — opens the store; everything after it
  belongs to the store. At most one per file.
- `<!-- task-thread:v1 begin id=<id> status=open|resolved -->` …
  `<!-- task-thread:v1 end id=<id> -->` — a thread block. Only legal at store
  level; ids on both boundaries must match.
- `<!-- task-comment:v1 begin id=<id> author=<token> created=<iso-utc>
[in-reply-to=<id>] [deleted=true] -->` …
  `<!-- task-comment:v1 end id=<id> -->` — a comment block inside a thread.
- `<!-- task-anchor:v1 <json> -->` — at most one per thread, before the first
  comment: a W3C-style selector
  `{"quote":{"exact","prefix","suffix"},"position?":{"start","end"}}` with
  body-relative offsets.

Attributes are single-space-separated `key=value` tokens; unknown or duplicate
attributes are fatal. Ids are opaque `[A-Za-z0-9._-]` tokens (this codec
generates `th_`/`cm_`-prefixed ULIDs). `created` is an ISO-8601 UTC instant.
`--` may not appear anywhere inside a sentinel (HTML comments cannot contain
it); anchor JSON therefore escapes the second hyphen of any `--` inside string
literals as `-`, which is transparent to `JSON.parse`.

Between and around blocks, non-sentinel lines are free interstitial content
and are preserved verbatim: the visible `## Discussion` heading,
`<a id="thread-…"></a>` jump targets, `### T1 · Open` thread headings, and
`#### Lee · 2026-07-28 08:30 UTC` comment headings are all presentation, not
grammar. A comment's model `body` is its content minus a leading `#### `
heading line and the blank padding around it. Thread labels (`T1`) are
presentation only and are never renumbered.

Ids must be unique across the whole file (threads and comments share one
namespace). `in-reply-to` must name another comment in the same thread.
Replies are flat records — rendering as a tree is the consumer's choice.

## Fail-open parsing

`parseAnnotatedMarkdown(raw)` is transactional: it returns either

- `{ kind: "structured", … }` — the full model, with source ranges for every
  region, or
- `{ kind: "plain", raw, body, diagnostics }` — with `body === raw`,
  byte-for-byte, and at least one diagnostic naming the first structural
  problem.

Any structural doubt — malformed YAML, a sentinel-looking line that does not
parse, crossed or unterminated blocks, duplicate ids, broken replies, a second
store, oversize input — rejects the _entire_ structured interpretation. The
codec never rewrites, normalizes, or repairs input: BOMs, CRLF, mixed line
endings, trailing whitespace, and a missing final newline all round-trip
exactly, in both structured and plain results.

Anchor drift is deliberately _not_ structural: a thread whose quoted text
changed or vanished still parses. `resolveThreadAnchor(body, threadId,
selector)` reconciles it in spec order — inline marker, stored position,
unique exact quote (context-disambiguated), high-confidence fuzzy match — and
reports `attached`, `needs_review`, or `orphaned` without ever invalidating
the discussion.

## Edits

All mutations are minimal source splices against the parsed document; bytes
outside the spliced ranges are untouched, and every operation re-runs the
strict parser and refuses to succeed unless the result is structured. New
content uses the file's dominant line ending.

- `addThread(doc, { body, author, createdAt, anchor?, … })` — appends a thread
  (creating the store on first use) and, for anchored threads, inserts a
  ` [T1](#thread-…)` marker after the anchored text.
- `addComment(doc, { threadId, body, author, createdAt, inReplyTo? })`
- `setThreadStatus(doc, threadId, "open" | "resolved")` — also updates a
  `### T1 · Open` heading when present.
- `editComment(doc, commentId, body)`
- `deleteComment(doc, commentId)` — removes the block; when replies still
  reference it, writes a tombstone (`deleted=true`, body `*Deleted.*`)
  instead; removing a thread's last comment removes the thread.
- `removeThread(doc, threadId)` — also removes inline markers, and the store
  itself when nothing but scaffolding remains.
- `setThreadAnchor(doc, threadId, selector | null)`

Comment text may not contain a line starting with `<!-- task-` at column 0
(indent or fence such lines to quote them).

## Divergences from the task-spec sketch

- The spec sketch carries `format: task/v1` in front matter; existing iterate
  task files predate that key, so this codec neither requires nor interprets
  it. The store sentinel's version gates the discussion grammar instead.
- `raw` is a JS string (UTF-16 code units), not `Uint8Array`; callers own
  decoding. Text with unpaired surrogates is rejected as plain.
- The anchor selector lives on its own `task-anchor:v1` sentinel line rather
  than as an attribute of the thread-begin sentinel, keeping identity and
  positioning separately editable.
