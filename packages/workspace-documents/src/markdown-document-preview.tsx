import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { Table, TableBody, TableCell, TableRow } from "@iterate-com/ui/components/table";
import { MessageSquarePlusIcon } from "lucide-react";
import {
  addThread,
  createAnchorSelector,
  parseAnnotatedMarkdown,
  projectMarkdownPreview,
  resolveThreadAnchor,
} from "iterate/annotated-markdown";
import type { AnchorResolution, Thread } from "iterate/annotated-markdown";
import {
  AnnotatedMarkdownView,
  buildProjection,
  clearHighlights,
  paintHighlights,
  sourceOffsetAtPoint,
} from "iterate/annotated-markdown/react";
import type { SourceProjection } from "iterate/annotated-markdown/react";
import { authorColor } from "./collab-author.ts";
import { useDiscussionApply } from "./use-discussion-apply.ts";
import type { CommentIdentity } from "./types.ts";
import { CommentComposer } from "./document-comments.tsx";

// The Preview tab, now the annotation surface: the body renders through the
// source-stamped viewer, anchored threads paint as CSS highlights in their
// author's color, and selecting text grows a comment bubble whose thread is
// an ordinary whole-file edit through the same landed-outcome lane as the
// comments strip. Fail-open files keep the read-only streamdown path, with
// independently valid frontmatter projected away from the document body.

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

const slugForAuthor = (author: string) =>
  author
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "someone";

const authorOf = (thread: Thread) => thread.comments[0]?.author ?? "someone";

export function MarkdownDocumentPreview({
  source,
  identity,
  busy,
  onTransform,
  selectedThreadId,
  onSelectThread,
}: {
  source: string;
  /** Null → read-only preview (no select-to-comment). */
  identity: CommentIdentity | null;
  busy: boolean;
  onTransform: (transform: (source: string) => string) => Promise<boolean>;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string | null) => void;
}) {
  const parsed = useMemo(() => parseAnnotatedMarkdown(source), [source]);
  if (parsed.kind !== "structured") {
    return <PlainPreview source={source} />;
  }
  return (
    <AnnotatedPreview
      body={parsed.body}
      metadata={metadataFromRecord(parsed.frontmatter?.data ?? {})}
      threads={parsed.discussion?.threads ?? []}
      identity={identity}
      busy={busy}
      onTransform={onTransform}
      selectedThreadId={selectedThreadId}
      onSelectThread={onSelectThread}
    />
  );
}

/** Read-only rendering for files whose annotation structure is invalid. */
function PlainPreview({ source }: { source: string }) {
  const preview = projectMarkdownPreview(source);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-6 text-sm">
        <FrontmatterTable metadata={preview.metadata} />
        {/* A settled document, not a stream — skip streamdown's unpaired-
            marker balancing (it appends a phantom `*` to text like "17 * 23"). */}
        <MessageResponse
          loadingFallback={
            <div className="text-sm text-muted-foreground" data-spinner="true" role="status">
              Rendering preview...
            </div>
          }
          parseIncompleteMarkdown={false}
        >
          {preview.body}
        </MessageResponse>
      </div>
    </div>
  );
}

function FrontmatterTable({ metadata }: { metadata: { key: string; value: string }[] }) {
  if (metadata.length === 0) return null;
  return (
    <div className="mb-6 overflow-hidden rounded-lg border bg-muted/20">
      <Table className="text-xs">
        <TableBody>
          {metadata.map((property) => (
            <TableRow key={property.key} className="hover:bg-transparent">
              <TableCell className="w-36 py-1.5 font-medium text-muted-foreground">
                {property.key}
              </TableCell>
              <TableCell className="py-1.5 font-mono whitespace-normal">{property.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface PendingSelection {
  range: { start: number; end: number };
  /** The body the range was computed against — live edits must remap. */
  sourceBody: string;
  /** Bubble position, relative to the positioned content wrapper. */
  top: number;
  left: number;
}

function AnnotatedPreview({
  body,
  metadata,
  threads,
  identity,
  busy,
  onTransform,
  selectedThreadId,
  onSelectThread,
}: {
  body: string;
  metadata: { key: string; value: string }[];
  threads: Thread[];
  identity: CommentIdentity | null;
  busy: boolean;
  onTransform: (transform: (source: string) => string) => Promise<boolean>;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string | null) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const markdownRef = useRef<HTMLDivElement | null>(null);
  const projectionRef = useRef<SourceProjection | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const { apply, opError } = useDiscussionApply({ busy, onTransform });

  /** Open threads with a live resolution, the paint + hit-test working set. */
  const resolved = useMemo(() => {
    const entries: { thread: Thread; resolution: AnchorResolution }[] = [];
    for (const thread of threads) {
      if (thread.status !== "open") continue;
      const resolution = resolveThreadAnchor(body, thread.id, thread.anchor?.selector ?? null);
      if (resolution.range) entries.push({ thread, resolution });
    }
    return entries;
  }, [body, threads]);

  // Projection + paint after every body/thread render. Highlights are a
  // registry beside the DOM (CSS Custom Highlight API): repainting is
  // re-registering fresh Ranges against the freshly rendered nodes.
  useLayoutEffect(() => {
    const root = markdownRef.current;
    if (!root) return;
    const projection = buildProjection(root);
    projectionRef.current = projection;
    const groups = new Map<string, Range[]>();
    const push = (key: string, ranges: Range[]) => {
      if (ranges.length === 0) return;
      groups.set(key, [...(groups.get(key) ?? []), ...ranges]);
    };
    for (const { thread, resolution } of resolved) {
      if (!resolution.range) continue;
      const ranges = projection.sourceRangeToDomRanges(resolution.range);
      if (resolution.state === "needs_review") push("review", ranges);
      else push(`a-${slugForAuthor(authorOf(thread))}`, ranges);
      if (thread.id === selectedThreadId) push("selected", ranges);
    }
    // A pending range only paints against the body it was computed on — a
    // kept-for-its-draft stale selection must not highlight the wrong text.
    if (pending && pending.sourceBody === body) {
      push("pending", projection.sourceRangeToDomRanges(pending.range));
    }
    // Registration order is paint order: selected and pending go last so
    // they win where highlights overlap.
    const ordered = [...groups.entries()].toSorted(
      ([a], [b]) =>
        Number(a === "selected" || a === "pending") - Number(b === "selected" || b === "pending"),
    );
    paintHighlights(
      "amv",
      ordered.map(([key, ranges]) => ({ key, ranges })),
    );
    return () => clearHighlights("amv");
  }, [body, resolved, selectedThreadId, pending]);

  // Selected-from-panel: bring the thread's text into view — once per
  // selection. `resolved` recomputes on every live edit, and re-scrolling
  // then would yank the viewport away from wherever the user is reading.
  const scrolledThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedThreadId === scrolledThreadRef.current) return;
    scrolledThreadRef.current = selectedThreadId;
    if (!selectedThreadId) return;
    const projection = projectionRef.current;
    const entry = resolved.find(({ thread }) => thread.id === selectedThreadId);
    if (!projection || !entry || !entry.resolution.range) return;
    const first = projection.sourceRangeToDomRanges(entry.resolution.range)[0];
    first?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedThreadId, resolved]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setComposerOpen(false);
  }, []);

  // Live edits move the body under a pending selection: re-find the selected
  // text so the pending paint stays on the right passage (and the bubble
  // follows it — this runs AFTER the layout effect rebuilt the projection
  // for the new body). When it can't be re-found unambiguously: a bare
  // bubble just drops, but an OPEN composer keeps its typed draft — the
  // stale selection stops painting (the paint effect checks sourceBody) and
  // submit's own re-find surfaces "reselect and retry" while the text
  // survives for the user to copy.
  // The sourceBody equality guard makes this a convergent rebase, not a
  // state loop: the write below pins sourceBody to body, so the next run
  // early-returns.
  useLayoutEffect(() => {
    if (!pending || pending.sourceBody === body) return;
    const exact = pending.sourceBody.slice(pending.range.start, pending.range.end);
    const first = body.indexOf(exact);
    const projection = projectionRef.current;
    const wrapper = wrapperRef.current;
    const range =
      first !== -1 && body.indexOf(exact, first + 1) === -1
        ? { start: first, end: first + exact.length }
        : null;
    const rect = !range
      ? undefined
      : projection?.sourceRangeToDomRanges(range)[0]?.getBoundingClientRect();
    const wrapperRect = wrapper?.getBoundingClientRect();
    if (!range || !rect || !wrapperRect) {
      if (!composerOpen) setPending(null);
      return;
    }
    // react-doctor-disable-next-line react-doctor/no-self-updating-effect
    setPending({
      range,
      sourceBody: body,
      top: rect.bottom - wrapperRect.top + 8,
      left: Math.max(0, rect.left - wrapperRect.left),
    });
  }, [body, composerOpen, pending]);

  const onMouseUp = useCallback(() => {
    if (!identity || composerOpen) return;
    const root = markdownRef.current;
    const wrapper = wrapperRef.current;
    const projection = projectionRef.current;
    if (!root || !wrapper || !projection) return;
    const selection = root.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const domRange = selection.getRangeAt(0);
    if (!root.contains(domRange.startContainer) || !root.contains(domRange.endContainer)) return;
    const range = projection.domRangeToSource(domRange);
    if (!range) return;
    const rect = domRange.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    setPending({
      range,
      sourceBody: body,
      top: rect.bottom - wrapperRect.top + 8,
      left: Math.max(0, rect.left - wrapperRect.left),
    });
    setComposerOpen(false);
  }, [identity, composerOpen, body]);

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      if (composerOpen) return;
      const projection = projectionRef.current;
      const root = markdownRef.current;
      if (!projection || !root) return;
      const selection = root.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed) return; // a drag, not a click
      const offset = sourceOffsetAtPoint(
        projection,
        root.ownerDocument,
        event.clientX,
        event.clientY,
      );
      if (!Number.isFinite(offset)) {
        onSelectThread(null);
        return;
      }
      let best: { threadId: string; width: number } | null = null;
      for (const { thread, resolution } of resolved) {
        const range = resolution.range;
        if (!range || offset < range.start || offset > range.end) continue;
        const width = range.end - range.start;
        if (!best || width < best.width) best = { threadId: thread.id, width };
      }
      onSelectThread(best?.threadId ?? null);
      if (!best) cancelPending();
    },
    [composerOpen, resolved, onSelectThread, cancelPending],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelPending();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelPending]);

  const submitThread = (commentBody: string) => {
    const selection = pending;
    if (!selection || !identity) return Promise.resolve(false);
    return apply((doc) => {
      // The document may have moved since the selection was made: the range
      // is only valid against the body it was computed on (the remap effect
      // keeps that current, but the apply-time doc can be newer still) —
      // otherwise re-find the selected text and refuse ambiguity rather
      // than anchor wrongly.
      let range = selection.range;
      if (doc.body !== selection.sourceBody) {
        const exact = selection.sourceBody.slice(selection.range.start, selection.range.end);
        const first = doc.body.indexOf(exact);
        if (first === -1 || doc.body.indexOf(exact, first + 1) !== -1) {
          throw new Error("the document changed under the selection — reselect and retry");
        }
        range = { start: first, end: first + exact.length };
      }
      const anchor = createAnchorSelector(doc.body, range.start, range.end);
      return addThread(doc, {
        body: commentBody,
        createdAt: new Date().toISOString(),
        anchor,
        // Highlights carry the location in this surface; a visible marker
        // would drop markdown syntax into the middle of the selected prose.
        insertMarker: false,
        ...identity,
      });
    }).then((ok) => {
      if (ok) cancelPending();
      return ok;
    });
  };

  const highlightCss = useMemo(() => {
    const authors = [...new Set(resolved.map(({ thread }) => authorOf(thread)))];
    const rules = authors.map(
      (author) =>
        `::highlight(amv-a-${slugForAuthor(author)}) { background-color: ${authorColor(author, 0.28)}; }`,
    );
    rules.push(
      "::highlight(amv-review) { background-color: color-mix(in srgb, var(--color-amber-500, #f59e0b) 25%, transparent); text-decoration: underline dotted; }",
      "::highlight(amv-selected) { background-color: color-mix(in srgb, var(--color-primary, #6366f1) 30%, transparent); }",
      "::highlight(amv-pending) { background-color: color-mix(in srgb, var(--color-primary, #6366f1) 22%, transparent); }",
    );
    return rules.join("\n");
  }, [resolved]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <style>{highlightCss}</style>
      <div ref={wrapperRef} className="relative mx-auto w-full max-w-3xl px-8 py-6">
        {identity ? (
          <p className="mb-4 text-xs text-muted-foreground">Select text to comment on a passage.</p>
        ) : null}
        <FrontmatterTable metadata={metadata} />
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events, react-doctor/no-static-element-interactions, react-doctor/click-events-have-key-events -- selection/hit-test layer over rendered text; the threads themselves are reachable through the comments panel */}
        <div ref={markdownRef} onMouseUp={onMouseUp} onClick={onClick} className="cursor-text">
          <AnnotatedMarkdownView source={body} className={BODY_STYLES} />
        </div>
        {!!pending && !composerOpen && (
          <div
            className="absolute z-10"
            style={{ top: pending.top, left: Math.min(pending.left, 560) }}
          >
            <Button
              size="sm"
              variant="secondary"
              className="shadow-md"
              onClick={() => setComposerOpen(true)}
            >
              <MessageSquarePlusIcon aria-hidden className="size-3.5" /> Comment
            </Button>
          </div>
        )}
        {!!pending && composerOpen && (
          <div
            className="absolute z-10 w-80 rounded-lg border bg-popover p-2 shadow-lg"
            style={{ top: pending.top, left: Math.min(pending.left, 420) }}
          >
            <CommentComposer
              placeholder="Comment on the selection…"
              submitLabel="Comment"
              focusOnMount
              onSubmit={submitThread}
              onCancel={cancelPending}
            />
            {!!opError && <p className="pt-1 text-xs text-red-700">{opError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function metadataFromRecord(record: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(record).map(([key, value]) => ({
    key,
    value: formatMetadataValue(value),
  }));
}

function formatMetadataValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatMetadataValue).join(", ");
  if (typeof value === "object" && value) return JSON.stringify(value);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- 0/''/false must format as themselves; only null formats as "null"
  if (value === null) return "null";
  return String(value);
}
