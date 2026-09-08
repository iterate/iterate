import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  buildDocumentProjection,
  clearDocumentHighlights,
  paintDocumentHighlights,
  type SourceRange,
} from "../lib/document-projection.ts";
import { cn } from "../lib/utils.ts";
import { ReviewComposer } from "./document-comments.tsx";
import { MarkdownDocumentRenderer } from "./markdown-document-renderer.tsx";

const EMPTY_ANNOTATIONS: DocumentPreviewAnnotation[] = [];
const EMPTY_ANNOTATION_IDS: string[] = [];

const BODY_STYLES = [
  "text-[15px] leading-relaxed text-foreground",
  "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1:first-child]:mt-0",
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2:first-child]:mt-0",
  "[&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold",
  "[&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold",
  "[&_p]:my-2.5",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:my-0.5 [&_li[data-task]]:list-none [&_li[data-task]]:-ml-5",
  "[&_li[data-task]_input]:mr-1.5 [&_li[data-task]_input]:align-middle",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted/50 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px]",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted/60 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[13px]",
  "[&_hr]:my-6 [&_hr]:border-border",
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5",
  "[&_img]:my-2 [&_img]:max-w-full [&_img]:rounded-md",
  "[&_code[data-raw-html]]:block [&_code[data-raw-html]]:whitespace-pre-wrap [&_code[data-raw-html]]:text-muted-foreground",
].join(" ");

export interface DocumentPreviewAnnotation extends SourceRange {
  /** Stable application-owned thread or review-item ID. */
  id: string;
  state?: "open" | "resolved";
  /** Optional author color for comment highlights. */
  color?: string;
  tone?: "comment" | "addition" | "deletion" | "substitution";
}

export interface DocumentPreviewCommentSelection extends SourceRange {
  /** Display-Markdown revision this range was selected against. */
  markdown: string;
}

export interface DocumentPreviewProps {
  /**
   * The clean display Markdown. Annotation ranges and selection callbacks use
   * UTF-16, end-exclusive offsets into this exact string.
   */
  markdown: string;
  annotations?: DocumentPreviewAnnotation[];
  selectedAnnotationIds?: string[];
  className?: string;
  onSelectAnnotations?: (ids: string[]) => void;
  /** Receives display-Markdown offsets. The caller maps them to its storage source. */
  onComment?: (selection: DocumentPreviewCommentSelection, body: string) => boolean;
}

interface PendingComment extends DocumentPreviewCommentSelection {
  top: number;
  left: number;
  width: number;
}

/**
 * Safe Markdown preview with source-stamped DOM, CSS Highlight annotations,
 * click-to-select threads, and an optional generic comment composer. It knows
 * nothing about RFM, authors, persistence, or source-document translation.
 */
export function DocumentPreview({
  markdown,
  annotations = EMPTY_ANNOTATIONS,
  selectedAnnotationIds = EMPTY_ANNOTATION_IDS,
  className,
  onSelectAnnotations,
  onComment,
}: DocumentPreviewProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const projectionRef = useRef<ReturnType<typeof buildDocumentProjection> | null>(null);
  const highlightPrefix = `iterate-document-${useId().replaceAll(":", "")}`;
  const scrolledSelectionRef = useRef<string | null>(null);
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const projection = buildDocumentProjection(content);
    projectionRef.current = projection;

    const groups = new Map<string, Range[]>();
    const add = (key: string, range: SourceRange) => {
      const ranges = projection.sourceRangeToDomRanges(range);
      if (ranges.length === 0) return;
      groups.set(key, [...(groups.get(key) ?? []), ...ranges]);
    };
    for (const [index, annotation] of annotations.entries()) {
      const tone = annotation.state === "resolved" ? "resolved" : (annotation.tone ?? "comment");
      add(tone === "comment" && annotation.color ? `author-${index}` : tone, annotation);
      if (selectedAnnotationIds.includes(annotation.id)) add("selected", annotation);
    }
    if (pendingComment !== null && pendingComment.markdown === markdown)
      add("pending", pendingComment);

    paintDocumentHighlights(
      highlightPrefix,
      [...groups].map(([key, ranges]) => ({ key, ranges })),
    );
    return () => clearDocumentHighlights(highlightPrefix);
  }, [annotations, selectedAnnotationIds, pendingComment, markdown, highlightPrefix]);

  useEffect(() => {
    const selection = selectedAnnotationIds.join("\u0000");
    if (selection === scrolledSelectionRef.current) return;
    scrolledSelectionRef.current = selection;
    const annotation = annotations.find((entry) => selectedAnnotationIds.includes(entry.id));
    const projection = projectionRef.current;
    if (annotation === undefined || projection === null) return;
    projection.sourceRangeToDomRanges(annotation)[0]?.startContainer.parentElement?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [annotations, selectedAnnotationIds]);

  const clearPendingComment = useCallback(() => setPendingComment(null), []);

  const onMouseUp = useCallback(() => {
    if (onComment === undefined) return;
    const content = contentRef.current;
    const wrapper = wrapperRef.current;
    const projection = projectionRef.current;
    if (content === null || wrapper === null || projection === null) return;

    const selection = content.ownerDocument.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
    const domRange = selection.getRangeAt(0);
    if (!content.contains(domRange.startContainer) || !content.contains(domRange.endContainer))
      return;
    const range = projection.domRangeToSource(domRange);
    if (range === null) return;
    const selectionRect = domRange.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const width = Math.min(320, Math.max(0, wrapperRect.width - 16));
    setPendingComment({
      ...range,
      markdown,
      top: selectionRect.bottom - wrapperRect.top + 8,
      left: Math.max(
        0,
        Math.min(selectionRect.left - wrapperRect.left, wrapperRect.width - width - 8),
      ),
      width,
    });
  }, [markdown, onComment]);

  const onClick = useCallback(
    (event: MouseEvent) => {
      const content = contentRef.current;
      const projection = projectionRef.current;
      if (content === null || projection === null) return;
      const selection = content.ownerDocument.getSelection();
      if (selection !== null && !selection.isCollapsed) return;

      const offset = projection.sourceOffsetAtPoint(
        content.ownerDocument,
        event.clientX,
        event.clientY,
      );
      if (offset === null) {
        onSelectAnnotations?.([]);
        return;
      }
      const ids = annotations
        .filter((annotation) => annotation.start <= offset && offset < annotation.end)
        .map((annotation) => annotation.id);
      onSelectAnnotations?.(ids);
      if (ids.length === 0) clearPendingComment();
    },
    [annotations, clearPendingComment, onSelectAnnotations],
  );

  return (
    <div
      ref={wrapperRef}
      className={cn("relative min-h-0 flex-1 overflow-y-auto p-4 md:p-8", className)}
    >
      <style>{`
        ::highlight(${highlightPrefix}-comment) { background: color-mix(in srgb, var(--color-primary, #6366f1) 18%, transparent); }
        ::highlight(${highlightPrefix}-addition) { background: color-mix(in srgb, #22c55e 25%, transparent); text-decoration: underline; text-decoration-color: #16a34a; }
        ::highlight(${highlightPrefix}-deletion) { background: color-mix(in srgb, #ef4444 21%, transparent); text-decoration: line-through; text-decoration-color: #dc2626; }
        ::highlight(${highlightPrefix}-substitution) { background: color-mix(in srgb, #a855f7 20%, transparent); text-decoration: underline; text-decoration-color: #9333ea; }
        ::highlight(${highlightPrefix}-resolved) { background: color-mix(in srgb, var(--color-muted-foreground, #64748b) 14%, transparent); }
        ::highlight(${highlightPrefix}-selected) { background: color-mix(in srgb, var(--color-primary, #6366f1) 34%, transparent); }
        ::highlight(${highlightPrefix}-pending) { background: color-mix(in srgb, var(--color-primary, #6366f1) 25%, transparent); }
        ${annotations.map((annotation, index) => (annotation.color ? `::highlight(${highlightPrefix}-author-${index}) { background: color-mix(in srgb, ${annotation.color} 22%, transparent); }` : "")).join("\n")}
      `}</style>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- text selection and CSS Highlight hit testing need the rendered DOM surface; the supplied panel exposes annotation actions accessibly. */}
      <div
        ref={contentRef}
        className="mx-auto w-full max-w-3xl cursor-text"
        onPointerUp={onMouseUp}
        onKeyUp={onMouseUp}
        onClick={onClick}
      >
        <MarkdownDocumentRenderer markdown={markdown} className={BODY_STYLES} />
      </div>
      {pendingComment !== null && onComment !== undefined ? (
        <div
          className="absolute z-10 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-2 shadow-lg"
          style={{
            top: pendingComment.top,
            left: pendingComment.left,
            width: pendingComment.width,
          }}
        >
          <ReviewComposer
            placeholder="Comment on the selection…"
            submitLabel="Comment"
            onSubmit={(body) => {
              const saved = onComment(pendingComment, body);
              if (saved) clearPendingComment();
              return saved;
            }}
            onCancel={clearPendingComment}
          />
        </div>
      ) : null}
    </div>
  );
}
