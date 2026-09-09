export interface ReviewRange {
  start: number;
  end: number;
}

export interface ReviewDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface ReviewAnchor {
  source: ReviewRange;
  display: ReviewRange;
}

export interface ReviewComment {
  id: string;
  parentId: string | null;
  author: string | null;
  createdAt: string | null;
  status: "open" | "resolved";
  body: string;
}

export interface ReviewThread {
  id: string;
  anchor: ReviewAnchor | null;
  comments: ReviewComment[];
}

export interface ReviewSuggestion {
  id: string;
  kind: "addition" | "deletion" | "substitution";
  author: string | null;
  createdAt: string | null;
  status: "open" | "resolved";
  source: ReviewRange;
  display: ReviewRange;
  originalText: string;
  replacementText: string;
}

export interface ReviewProjectionSegment {
  source: ReviewRange;
  display: ReviewRange;
  /** A review change has different source and display text; selections cannot enter it. */
  atomic?: boolean;
}

export interface ReviewProjection {
  /** Markdown suitable for an ordinary mdast renderer: RFM controls omitted. */
  markdown: string;
  /** Character-for-character text segments between display and RFM body source. */
  segments: ReviewProjectionSegment[];
}

export interface DocumentReview {
  /** RFM body source, excluding valid YAML frontmatter and RFM endmatter. */
  body: { source: string; range: ReviewRange };
  threads: ReviewThread[];
  suggestions: ReviewSuggestion[];
  diagnostics: ReviewDiagnostic[];
  projection: ReviewProjection;
}

export type ReviewOperation =
  | {
      type: "add-selected-comment";
      range: ReviewRange;
      expectedSource: string;
      body: string;
      author: string;
      createdAt?: string;
    }
  | { type: "add-document-comment"; body: string; author: string; createdAt?: string }
  | { type: "reply"; parentId: string; body: string; author: string; createdAt?: string }
  | { type: "set-status"; id: string; status: "open" | "resolved"; summary?: string }
  | { type: "edit"; id: string; body: string }
  | { type: "delete"; id: string }
  | { type: "accept-suggestion"; id: string }
  | { type: "reject-suggestion"; id: string };

export type ApplyReviewOperationResult =
  | { ok: true; source: string; review: DocumentReview }
  | {
      ok: false;
      code:
        | "invalid-document"
        | "invalid-operation"
        | "missing-item"
        | "stale-selection"
        | "overlapping-selection";
      message: string;
      review: DocumentReview;
    };
