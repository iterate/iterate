/** Shared brief for humans and agents editing the same Markdown review. */
export const DOCUMENT_REVIEW_INSTRUCTIONS = `Comments are plain text in the document, using Roughdraft Flavored Markdown (RFM). Read the current file and make small edits with the ordinary file-editing tools.

Keep one YAML endmatter block after a final --- divider, separate from any frontmatter. Add entries under comments with a fresh unique ID, your identity in by, an ISO timestamp in at, status: open, and body for the message:

---
comments:
  c_unique_id:
    by: /agents/your-agent
    at: "2026-09-08T12:00:00Z"
    status: open
    body: Please confirm the date.

For a whole-document comment, this entry is sufficient. To comment on a passage, replace that passage with {==selected text==}{>>Your comment<<}{#c_unique_id} and omit body from its YAML entry. Do not nest or cross existing annotations; use a document comment quoting the passage instead. Keep raw CriticMarkup closing delimiters out of comment text.

To reply, add another comments entry with its own ID, by, at, body, and re: <parent ID>. To edit a comment, change its inline message or YAML body. Resolve a thread by setting its root entry's status to resolved; reopen with status: open and remove any resolved summary. To delete a thread, remove its entries and replies, and unwrap its inline annotation while preserving the selected document text.

Preserve other people's text, IDs, metadata, and suggestions. Extend existing endmatter instead of appending a second block; keep all document prose before it. Re-read after a conflicting edit. Use your actual identity and the current timestamp, not the example values.`;
