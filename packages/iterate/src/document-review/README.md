# Document review

`iterate/document-review` reads and changes Roughdraft Flavored Markdown (RFM),
using Roughdraft's parser and validation. It has no React dependency. The UI
components live in `@iterate-com/ui`; `@iterate-com/workspace-documents` connects
them to RFM and collaborative storage.

```text
The launch is {==on Friday==}{>>Please confirm the date.<<}{#c_date}.

---
comments:
  c_date:
    by: jonas@example.com
    at: 2026-09-08T12:00:00Z
    status: open
  c_document:
    by: jonas@example.com
    at: 2026-09-08T12:00:00Z
    body: Ready for a final review.
    status: open
```

The trailing YAML is RFM endmatter. It is part of the Markdown file; ordinary
renderers can show the text, including the review notation. Suggestions use
CriticMarkup additions, deletions, and substitutions with RFM metadata.

```ts
import { readReview, applyReviewOperation } from "iterate/document-review";
import { textEdits } from "@iterate-com/workspace-documents/text-edits";

const review = readReview(source);
// review.projection.markdown: preview text, without review delimiters/endmatter
// review.threads: comments grouped with replies and optional passage anchors
// review.suggestions: proposed changes and source/display ranges
// review.diagnostics: malformed or unsupported review data

const result = applyReviewOperation(source, {
  type: "add-document-comment",
  author: "jonas@example.com",
  body: "Ready for a final review.",
});
if (result.ok) editor.dispatch({ changes: textEdits(source, result.source) });
```

The module also supports selected comments, replies, edits, deletion,
resolve/reopen, and accepting/rejecting suggestions. Ranges use UTF-16 offsets;
source ranges are relative to `review.body.source`, display ranges to
`review.projection.markdown`. Map display selections with
`sourceRangeForDisplayRange` and pass the original full file as `expectedSource`
when creating an anchored comment. A stale selection or overlapping annotation
is rejected. In Docs, `textEdits` from `@iterate-com/workspace-documents/text-edits`
turns the result into ordinary local editor changes, using the same collaboration
path as typing. Clear drafts when the local edit is accepted. Concurrent edits
can still break structured markup; the first-endmatter race is pinned by an
expected-failure test.

Agents edit comments using ordinary file edits; there is no comment-specific RPC.
The [editing instructions](../../../../apps/docs/src/lib/document-review-instructions.ts)
are included in jam invitations and task assignments. Add document comments as
YAML entries, reply with `re: <parent ID>`, edit `body` or the inline message,
and resolve with `status: resolved`. Keep IDs stable and extend the existing
endmatter block.

This replaces the previous Iterate annotation format without a compatibility
parser or automatic conversion.
