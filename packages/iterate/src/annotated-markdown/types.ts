import type { Document } from "yaml";

// Model types for the annotated-markdown codec: iterate-style markdown (YAML
// front matter + body) carrying discussion threads in an EOF store of paired
// HTML-comment sentinels. Grammar and invariants: see README.md next to this
// file. Offsets are UTF-16 code-unit indices into the raw document text.

export interface SourceRange {
  start: number;
  /** Exclusive. */
  end: number;
}

export type DiagnosticCode =
  | "invalid-text"
  | "file-too-large"
  | "frontmatter-unterminated"
  | "frontmatter-too-large"
  | "frontmatter-yaml-error"
  | "frontmatter-not-a-map"
  | "frontmatter-alias"
  | "frontmatter-tag"
  | "frontmatter-merge-key"
  | "frontmatter-depth"
  | "sentinel-malformed"
  | "sentinel-unsupported-version"
  | "sentinel-outside-store"
  | "sentinel-unexpected"
  | "sentinel-mismatched"
  | "sentinel-unterminated"
  | "store-duplicate"
  | "record-limit"
  | "duplicate-id"
  | "invalid-reply"
  | "anchor-misplaced"
  | "anchor-invalid";

// Every parse diagnostic is fatal: emitting one means the parser refused the
// structured interpretation and fell back to a plain document. Nonfatal anchor
// drift is deliberately NOT a Diagnostic — it lives in AnchorResolution.
export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  range?: SourceRange;
}

export interface AnchorSelector {
  quote: {
    exact: string;
    prefix: string;
    suffix: string;
  };
  /** Body-relative offsets recorded when the anchor was created. */
  position?: {
    start: number;
    end: number;
  };
}

export interface ThreadAnchor {
  selector: AnchorSelector;
  /** The whole anchor sentinel line, including its line ending. */
  range: SourceRange;
}

export interface ThreadComment {
  id: string;
  author: string;
  /** ISO-8601 UTC instant exactly as written in the sentinel. */
  createdAt: string;
  /** Last-edit instant from the optional `modified` attribute. */
  modifiedAt: string | null;
  inReplyTo: string | null;
  deleted: boolean;
  /** Presentation name from a `#### Lee · 2026-07-28 08:30 UTC` heading. */
  displayName: string | null;
  /**
   * Comment prose without the presentation heading and without the blank
   * padding around it. Verbatim otherwise (line endings included).
   */
  body: string;
  /** Begin sentinel line start → end sentinel line end. */
  range: SourceRange;
  /** Exact extent of `body` within raw; zero-width when the body is empty. */
  bodyRange: SourceRange;
}

export interface Thread {
  id: string;
  status: "open" | "resolved";
  /** Presentation label parsed from a `### T1 · Open` heading, if present. */
  label: string | null;
  anchor: ThreadAnchor | null;
  comments: ThreadComment[];
  /** Begin sentinel line start → end sentinel line end. */
  range: SourceRange;
}

export interface Frontmatter {
  /** Plain-object projection of the YAML mapping (empty object when blank). */
  data: Record<string, unknown>;
  /** The parsed `yaml` Document, for format-preserving key edits. */
  document: Document;
  /** Opening fence line start → closing fence line end. */
  range: SourceRange;
  /** The YAML text between the fences. */
  contentRange: SourceRange;
}

export interface Discussion {
  /** Store sentinel line start → end of file. */
  range: SourceRange;
  threads: Thread[];
}

export interface StructuredDocument {
  kind: "structured";
  raw: string;
  frontmatter: Frontmatter | null;
  /** Verbatim slice between front matter and the discussion store. */
  body: string;
  bodyRange: SourceRange;
  discussion: Discussion | null;
  diagnostics: Diagnostic[];
}

export interface PlainDocument {
  kind: "plain";
  raw: string;
  /** Always identical to `raw`: fallback interprets the whole file as body. */
  body: string;
  diagnostics: Diagnostic[];
}

export type ParseResult = StructuredDocument | PlainDocument;

export interface Splice {
  /** Range in the raw text of the document the edit was computed against. */
  range: SourceRange;
  insert: string;
}

export interface EditResult {
  /** The re-parsed document after the edit; edits always re-validate. */
  doc: StructuredDocument;
  raw: string;
  /** Sorted, non-overlapping, in coordinates of the pre-edit raw text. */
  splices: Splice[];
}
