import "@atomic-editor/editor/styles.css";
import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { atomicEditorTheme, atomicMarkdownSyntax, inlinePreview } from "@atomic-editor/editor";
import { markdownTables } from "./markdown-tables.ts";
import { projectedMarkdown } from "./rfm-projected-markdown.ts";
import { rfmReview, type RfmReviewConfig } from "./rfm-review-extension.ts";

// Keep the language and view plugins stable when only review selection changes.
const presentation = [
  Prec.high(projectedMarkdown()),
  inlinePreview(),
  atomicEditorTheme,
  atomicMarkdownSyntax,
  markdownTables(),
  EditorView.editorAttributes.of({ class: "atomic-cm-editor" }),
  Prec.high(
    EditorView.theme({
      "&": {
        "--atomic-editor-fg": "var(--foreground)",
        "--atomic-editor-fg-muted": "var(--muted-foreground)",
        "--atomic-editor-bg": "var(--background)",
        "--atomic-editor-bg-surface": "var(--popover)",
        "--atomic-editor-bg-panel": "var(--muted)",
        "--atomic-editor-border": "var(--border)",
        "--atomic-editor-accent-bright": "var(--foreground)",
        "--atomic-editor-selection-bg": "var(--accent)",
        "--atomic-editor-font": "var(--font-sans, system-ui)",
        fontSize: "15px",
      },
      ".cm-content": {
        fontFamily: "var(--font-sans, system-ui)",
        padding: "32px clamp(20px, 5vw, 56px) 30vh",
        maxWidth: "900px",
        margin: "0 auto",
        boxSizing: "border-box",
      },
      ".cm-tooltip": { borderRadius: "10px", boxShadow: "0 4px 20px #0002", zIndex: "80" },
      ".cm-line": { lineHeight: "1.7" },
    }),
  ),
];

/** A presentation over the existing Markdown buffer; no serializer or separate editor. */
export function richMarkdown(review: RfmReviewConfig) {
  return [presentation, rfmReview(review)];
}
