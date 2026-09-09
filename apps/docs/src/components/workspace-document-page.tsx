import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { DocumentComments } from "@iterate-com/ui/components/document-comments";
import type { DocumentCommentsHandle } from "@iterate-com/ui/components/document-comments";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import {
  annotationsSourceForHtmlDocument,
  transformHtmlDocumentAnnotations,
} from "@iterate-com/workspace-documents/html-annotations";
import { commentIdentityFor } from "@iterate-com/workspace-documents/identity";
import { useDocumentReview } from "@iterate-com/workspace-documents/review";
import { Drawer, DrawerContent, DrawerTitle } from "@iterate-com/ui/components/drawer";
import type { WorkspaceDocumentTransport } from "@iterate-com/workspace-documents/types";
import {
  isSessionTransportError,
  withDocsProject,
  withDocsProjectOnce,
} from "../lib/docs-client.ts";
import { withRetries } from "../lib/retry.ts";
import type { DocsUser, WorkspaceDocumentSnapshot } from "../lib/docs-api.ts";
import { DocumentError } from "./document-error.tsx";
import { HtmlDocumentPreview } from "./html-document-preview.tsx";
import { DocumentToolbar } from "./document-toolbar.tsx";

const WorkspaceDocumentEditor = lazy(async () => {
  const module = await import("@iterate-com/workspace-documents/editor");
  return { default: module.WorkspaceDocumentEditor };
});

export function WorkspaceDocumentPage({
  workspacePath,
  path,
  actions,
}: {
  workspacePath: string;
  path: string;
  actions?: ReactNode;
}) {
  const [loaded, setLoaded] = useState<{
    snapshot: WorkspaceDocumentSnapshot;
    user: DocsUser;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by the error page's Try again: the load effect runs once more.
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Bumped by Reconnect: the editor remounts (its teardown flushes what it
  // still holds; the new one reopens the session) — never a page reload,
  // which would drop unsent edits on the floor.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [source, setSource] = useState("");
  const [view, setView] = useState<"rich" | "source">("rich");
  const [status, setStatus] = useState("connecting…");
  const [showChanges, setShowChanges] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // Everyone with a live caret on this document, self first — delivered by
  // the editor's collab session whenever the presence generation advances
  // (join announces + 25s heartbeats keep idle readers present).
  const [peers, setPeers] = useState<{ self: string; clientIds: string[] } | null>(null);
  const editorApiRef = useRef<CollabEditorApi | null>(null);
  const commentsRef = useRef<DocumentCommentsHandle | null>(null);
  const mobileCommentsRef = useRef<DocumentCommentsHandle | null>(null);
  const focusMobileComposer = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    setCommentsOpen(false);
    // A transport failure here is a socket that died under us (a laptop
    // waking, a colo hiccup): the shared client re-dials, and this waits
    // out a network that is still coming back. An application error (no
    // such document) is final at once.
    void withRetries(
      () =>
        withDocsProject(async (project) => {
          const workspace = project.workspace(workspacePath);
          const [snapshot, user] = await Promise.all([workspace.inspect(path), project.whoami()]);
          return { snapshot, user };
        }),
      { attempts: 3, delayMs: (attempt) => attempt * 1_500, shouldRetry: isSessionTransportError },
    )
      .then((result) => {
        if (cancelled) return;
        setSource(result.snapshot.content);
        setLoaded(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, workspacePath, loadAttempt]);

  const transport = useMemo<WorkspaceDocumentTransport>(
    () => ({
      run: (operation) => withDocsProject((project) => operation(project.workspace(workspacePath))),
      runOnce: (operation) =>
        withDocsProjectOnce((project) => operation(project.workspace(workspacePath))),
    }),
    [workspacePath],
  );

  const onLiveContent = useCallback((_path: string, content: string) => {
    setSource(content);
  }, []);

  const onTransform = useCallback((transform: (current: string) => string) => {
    const editor = editorApiRef.current;
    if (editor === null || !editor.isLive()) return false;
    editor.applyTransform(transform);
    return true;
  }, []);
  const format = loaded?.snapshot.format;
  const onCommentTransform = useCallback(
    (transform: (current: string) => string) =>
      onTransform((current) =>
        format === "html"
          ? transformHtmlDocumentAnnotations(current, transform)
          : transform(current),
      ),
    [format, onTransform],
  );

  const identity = loaded ? commentIdentityFor(loaded.user) : null;
  const busy = status === "connecting…";
  const reviewSource = useMemo(() => {
    try {
      return {
        source: format === "html" ? annotationsSourceForHtmlDocument(source) : source,
        error: null,
      };
    } catch (error) {
      return { source: "", error: error instanceof Error ? error.message : String(error) };
    }
  }, [source, format]);
  const review = useDocumentReview({
    source: reviewSource.source,
    identity: reviewSource.error ? null : identity,
    busy,
    onTransform: editorApiRef.current?.isLive() ? onCommentTransform : undefined,
  });
  if (reviewSource.error)
    review.comments.notice = (
      <p role="alert" className="p-3 text-sm text-destructive">
        {reviewSource.error}
      </p>
    );
  const editorReview = {
    ...review.editor,
    onSelectThread: (id: string | null) => {
      review.editor.onSelectThread(id);
      if (!id || !window.matchMedia("(max-width: 1023px)").matches) return;
      focusMobileComposer.current = false;
      setCommentsOpen(true);
    },
  };

  if (loadError !== null) {
    return (
      <DocumentError
        workspacePath={workspacePath}
        path={path}
        message={loadError}
        onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
      />
    );
  }
  if (loaded === null) {
    return (
      <div className="relative grid min-h-svh place-items-center bg-muted/20">
        <SidebarTrigger className="absolute top-3 left-3 md:hidden" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Opening document…
        </div>
      </div>
    );
  }

  const displayName = identity?.authorDisplay ?? identity?.author;

  // div, not main: SidebarInset already renders the main landmark.
  return (
    <div className="flex min-h-svh flex-col bg-background lg:h-svh lg:overflow-hidden">
      <DocumentToolbar
        path={
          loaded.snapshot.path.startsWith(`${workspacePath}/`)
            ? loaded.snapshot.path.slice(workspacePath.length + 1)
            : loaded.snapshot.path
        }
        format={loaded.snapshot.format}
        peers={peers}
        status={status}
        onReconnect={() => {
          setStatus("connecting…");
          setEditorEpoch((epoch) => epoch + 1);
        }}
        canComment={Boolean(review.comments.onAction)}
        onComment={() => {
          if (window.matchMedia("(max-width: 1023px)").matches) {
            if (commentsOpen) mobileCommentsRef.current?.focusDocumentComment();
            else {
              focusMobileComposer.current = true;
              setCommentsOpen(true);
            }
          } else commentsRef.current?.focusDocumentComment();
        }}
        showChanges={showChanges}
        onShowChangesChange={setShowChanges}
        view={view}
        onViewChange={setView}
        actions={actions}
      />

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <section className="relative flex min-h-[60svh] min-w-0 flex-col bg-background lg:min-h-0">
          {loaded.snapshot.format === "html" && view === "rich" ? (
            <div className="flex min-h-0 flex-1">
              <HtmlDocumentPreview source={source} />
            </div>
          ) : null}
          <div
            className={
              loaded.snapshot.format === "markdown" || view === "source"
                ? "flex min-h-0 flex-1 flex-col [&_.cm-editor]:h-full"
                : "hidden"
            }
          >
            <Suspense
              fallback={
                <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Spinner className="size-4" /> Connecting editor…
                  </span>
                </div>
              }
            >
              <WorkspaceDocumentEditor
                key={editorEpoch}
                transport={transport}
                displayName={displayName}
                path={path}
                mode={loaded.snapshot.format}
                presentation={view}
                review={loaded.snapshot.format === "markdown" ? editorReview : undefined}
                redline={showChanges}
                emptyPlaceholder={
                  loaded.snapshot.format === "html" ? "Write HTML…" : "Write in Markdown…"
                }
                apiRef={editorApiRef}
                onLiveContent={onLiveContent}
                onPeers={setPeers}
                onStatus={setStatus}
              />
            </Suspense>
          </div>
        </section>

        <aside className="hidden min-h-0 border-l bg-muted/5 lg:block">
          <DocumentComments ref={commentsRef} {...review.comments} />
        </aside>
        <Drawer
          open={commentsOpen}
          onOpenChange={(open) => {
            if (!open) focusMobileComposer.current = false;
            setCommentsOpen(open);
          }}
        >
          <DrawerContent
            className="h-[80svh]"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              if (!focusMobileComposer.current) return;
              event.preventDefault();
              focusMobileComposer.current = false;
              mobileCommentsRef.current?.focusDocumentComment();
            }}
          >
            <DrawerTitle className="sr-only">Comments</DrawerTitle>
            <DocumentComments ref={mobileCommentsRef} {...review.comments} />
          </DrawerContent>
        </Drawer>
      </div>
    </div>
  );
}
