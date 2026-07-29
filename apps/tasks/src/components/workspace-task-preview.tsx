import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { Table, TableBody, TableCell, TableRow } from "@iterate-com/ui/components/table";
import { MessageSquarePlusIcon } from "lucide-react";
import {
  addThread,
  createAnchorSelector,
  parseAnnotatedMarkdown,
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
import { authorColor } from "../lib/collab-redline.ts";
import { useDiscussionApply } from "../lib/use-discussion-apply.ts";
import type { CommentIdentity } from "./task-comments.tsx";
import { CommentComposer } from "./task-comments.tsx";
import { projectMarkdownPreview } from "~/components/repo-ide/markdown-frontmatter.ts";

// The Preview tab, now the annotation surface: the body renders through the
// source-stamped viewer, anchored threads paint as CSS highlights in their
// author's color, and selecting text grows a comment bubble whose thread is
// an ordinary whole-file edit through the same landed-outcome lane as the
// comments strip. Fail-open files keep the old read-only streamdown path —
// when the codec refuses a file, nothing may interpret it.

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

const slugForAuthor = (author: string): string =>
  author.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "someone";

export function WorkspaceTaskPreview({
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
      threads={parsed.discussion?.threads ?? []}
      source={source}
      identity={identity}
      busy={busy}
      onTransform={onTransform}
      selectedThreadId={selectedThreadId}
      onSelectThread={onSelectThread}
    />
  );
}

/** The pre-annotation rendering path, kept verbatim for fail-open files. */
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
  /** Bubble position, relative to the positioned content wrapper. */
  top: number;
  left: number;
}

function AnnotatedPreview({
  body,
  threads,
  source,
  identity,
  busy,
  onTransform,
  selectedThreadId,
  onSelectThread,
}: {
  body: string;
  threads: Thread[];
  source: string;
  identity: CommentIdentity | null;
  busy: boolean;
  onTransform: (transform: (source: string) => string) => Promise<boolean>;
  selectedThreadId: string | null;
  onSelectThread: (threadId: string | null) => void;
}) {
  const metadata = useMemo(() => projectMarkdownPreview(source).metadata, [source]);
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
      if (resolution.range !== null) entries.push({ thread, resolution });
    }
    return entries;
  }, [body, threads]);

  const authorOf = (thread: Thread): string => thread.comments[0]?.author ?? "someone";

  // Projection + paint after every body/thread render. Highlights are a
  // registry beside the DOM (CSS Custom Highlight API): repainting is
  // re-registering fresh Ranges against the freshly rendered nodes.
  useLayoutEffect(() => {
    const root = markdownRef.current;
    if (root === null) return;
    const projection = buildProjection(root);
    projectionRef.current = projection;
    const groups = new Map<string, Range[]>();
    const push = (key: string, ranges: Range[]) => {
      if (ranges.length === 0) return;
      groups.set(key, [...(groups.get(key) ?? []), ...ranges]);
    };
    for (const { thread, resolution } of resolved) {
      if (resolution.range === null) continue;
      const ranges = projection.sourceRangeToDomRanges(resolution.range);
      if (resolution.state === "needs_review") push("review", ranges);
      else push(`a-${slugForAuthor(authorOf(thread))}`, ranges);
      if (thread.id === selectedThreadId) push("selected", ranges);
    }
    if (pending !== null) push("pending", projection.sourceRangeToDomRanges(pending.range));
    // Registration order is paint order: selected and pending go last so
    // they win where highlights overlap.
    const ordered = [...groups.entries()].sort(
      ([a], [b]) => Number(a === "selected" || a === "pending") - Number(b === "selected" || b === "pending"),
    );
    paintHighlights(
      "amv",
      ordered.map(([key, ranges]) => ({ key, ranges })),
    );
    return () => clearHighlights("amv");
  }, [body, resolved, selectedThreadId, pending]);

  // Selected-from-panel: bring the thread's text into view.
  useEffect(() => {
    if (selectedThreadId === null) return;
    const projection = projectionRef.current;
    const entry = resolved.find(({ thread }) => thread.id === selectedThreadId);
    if (projection === null || entry === undefined || entry.resolution.range === null) return;
    const first = projection.sourceRangeToDomRanges(entry.resolution.range)[0];
    first?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedThreadId, resolved]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setComposerOpen(false);
  }, []);

  const onMouseUp = useCallback(() => {
    if (identity === null || composerOpen) return;
    const root = markdownRef.current;
    const wrapper = wrapperRef.current;
    const projection = projectionRef.current;
    if (root === null || wrapper === null || projection === null) return;
    const selection = root.ownerDocument.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
    const domRange = selection.getRangeAt(0);
    if (!root.contains(domRange.startContainer) || !root.contains(domRange.endContainer)) return;
    const range = projection.domRangeToSource(domRange);
    if (range === null) return;
    const rect = domRange.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    setPending({
      range,
      top: rect.bottom - wrapperRect.top + 8,
      left: Math.max(0, rect.left - wrapperRect.left),
    });
    setComposerOpen(false);
  }, [identity, composerOpen]);

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      if (composerOpen) return;
      const projection = projectionRef.current;
      const root = markdownRef.current;
      if (projection === null || root === null) return;
      const selection = root.ownerDocument.getSelection();
      if (selection !== null && !selection.isCollapsed) return; // a drag, not a click
      const offset = sourceOffsetAtPoint(projection, root.ownerDocument, event.clientX, event.clientY);
      if (offset === null) {
        onSelectThread(null);
        return;
      }
      let best: { threadId: string; width: number } | null = null;
      for (const { thread, resolution } of resolved) {
        const range = resolution.range;
        if (range === null || offset < range.start || offset >= range.end) continue;
        const width = range.end - range.start;
        if (best === null || width < best.width) best = { threadId: thread.id, width };
      }
      onSelectThread(best?.threadId ?? null);
      if (best === null) cancelPending();
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

  const submitThread = (commentBody: string): Promise<boolean> => {
    const selection = pending;
    if (selection === null || identity === null) return Promise.resolve(false);
    const renderBody = body;
    return apply((doc) => {
      // The document may have moved since the selection was made: keep the
      // offsets only while the body is byte-identical, otherwise re-find the
      // selected text and refuse ambiguity rather than anchor wrongly.
      let range = selection.range;
      if (doc.body !== renderBody) {
        const exact = renderBody.slice(selection.range.start, selection.range.end);
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
        <FrontmatterTable metadata={metadata} />
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- selection/hit-test layer over rendered text; the threads themselves are reachable through the comments panel */}
        <div ref={markdownRef} onMouseUp={onMouseUp} onClick={onClick} className="cursor-text">
          <AnnotatedMarkdownView source={body} className={BODY_STYLES} />
        </div>
        {pending !== null && !composerOpen && (
          <div
            className="absolute z-10"
            style={{ top: pending.top, left: Math.min(pending.left, 560) }}
          >
            <Button size="sm" variant="secondary" className="shadow-md" onClick={() => setComposerOpen(true)}>
              <MessageSquarePlusIcon aria-hidden className="size-3.5" /> Comment
            </Button>
          </div>
        )}
        {pending !== null && composerOpen && (
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
            {opError !== null && <p className="pt-1 text-xs text-red-700">{opError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
