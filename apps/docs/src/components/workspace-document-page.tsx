import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  Code2Icon,
  CopyIcon,
  EyeIcon,
  FileTextIcon,
  MessageSquarePlusIcon,
  SparklesIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { DocumentComments } from "@iterate-com/workspace-documents/comments";
import type { DocumentCommentsHandle } from "@iterate-com/workspace-documents/comments";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import {
  annotationsSourceForHtmlDocument,
  transformHtmlDocumentAnnotations,
} from "@iterate-com/workspace-documents/html-annotations";
import { authorColor, authorLabel } from "@iterate-com/workspace-documents/collab";
import { commentIdentityFor } from "@iterate-com/workspace-documents/identity";
import { MarkdownDocumentPreview } from "@iterate-com/workspace-documents/preview";
import type { WorkspaceDocumentTransport } from "@iterate-com/workspace-documents/types";
import { withDocsProject, withDocsProjectOnce } from "../lib/docs-client.ts";
import type { DocsUser, WorkspaceDocumentSnapshot } from "../lib/docs-api.ts";
import { DocumentError } from "./document-error.tsx";
import { HtmlDocumentPreview } from "./html-document-preview.tsx";
import { ViewButton } from "./view-button.tsx";

const WorkspaceDocumentEditor = lazy(async () => {
  const module = await import("@iterate-com/workspace-documents/editor");
  return { default: module.WorkspaceDocumentEditor };
});

export function WorkspaceDocumentPage({
  workspacePath,
  path,
}: {
  workspacePath: string;
  path: string;
}) {
  const [loaded, setLoaded] = useState<{
    snapshot: WorkspaceDocumentSnapshot;
    user: DocsUser;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [view, setView] = useState<"preview" | "source">("preview");
  const [status, setStatus] = useState("connecting…");
  const [showChanges, setShowChanges] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Everyone with a live caret on this document, self first — delivered by
  // the editor's collab session whenever the presence generation advances
  // (join announces + 25s heartbeats keep idle readers present).
  const [peers, setPeers] = useState<{ self: string; clientIds: string[] } | null>(null);
  const editorApiRef = useRef<CollabEditorApi | null>(null);
  const commentsRef = useRef<DocumentCommentsHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    setSelectedThreadId(null);
    void withDocsProject(async (project) => {
      const workspace = project.workspace(workspacePath);
      const [snapshot, user] = await Promise.all([workspace.inspect(path), project.whoami()]);
      return { snapshot, user };
    })
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
  }, [path, workspacePath]);

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

  const onTransform = useCallback(
    async (transform: (current: string) => string): Promise<boolean> => {
      const editor = editorApiRef.current;
      if (editor === null || !editor.isLive()) return false;
      editor.applyTransform(transform);
      return true;
    },
    [],
  );
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

  const copyLink = () => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  if (loadError !== null) {
    return <DocumentError workspacePath={workspacePath} path={path} message={loadError} />;
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

  const identity = commentIdentityFor(loaded.user);
  const displayName =
    loaded.user.name ?? loaded.user.email ?? loaded.user.userId ?? identity.authorDisplay;
  const busy = status === "connecting…";
  const commentsSource =
    loaded.snapshot.format === "html" ? annotationsSourceForHtmlDocument(source) : source;

  // div, not main: SidebarInset already renders the main landmark.
  return (
    <div className="flex min-h-svh flex-col bg-background lg:h-svh lg:overflow-hidden">
      {/* The tasks bar's language: one slim h-11 strip, the document path as
          the only text (sidebar carries workspace + view), icon-only
          controls with tooltips, status shown only while it is news. */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate font-mono text-xs">
          {loaded.snapshot.path.startsWith(`${workspacePath}/`)
            ? loaded.snapshot.path.slice(workspacePath.length + 1)
            : loaded.snapshot.path}
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <DocumentPresence peers={peers} />
          {!status.startsWith("live") && (
            <span className="hidden max-w-40 truncate text-[11px] text-muted-foreground md:block">
              {status}
            </span>
          )}
          <WithTooltip label="Comment on document">
            <Button
              size="sm"
              className="h-8 w-8 px-0"
              aria-label="Comment on document"
              onClick={() => commentsRef.current?.focusDocumentComment()}
            >
              <MessageSquarePlusIcon aria-hidden className="size-3.5" />
            </Button>
          </WithTooltip>
          <WithTooltip label={showChanges ? "Hide changes" : "Track changes"}>
            <Button
              variant={showChanges ? "secondary" : "outline"}
              size="sm"
              className="h-8 w-8 px-0"
              aria-label="Track changes"
              aria-pressed={showChanges}
              onClick={() => setShowChanges((value) => !value)}
            >
              <SparklesIcon aria-hidden className="size-3.5" />
            </Button>
          </WithTooltip>
          <WithTooltip label={copied ? "Copied!" : "Copy share link"}>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 px-0"
              aria-label="Copy share link"
              onClick={copyLink}
            >
              {copied ? (
                <CheckIcon aria-hidden className="size-3.5" />
              ) : (
                <CopyIcon aria-hidden className="size-3.5" />
              )}
            </Button>
          </WithTooltip>
          <div className="flex rounded-lg border bg-muted/30 p-0.5">
            <WithTooltip label="Preview">
              <ViewButton active={view === "preview"} onClick={() => setView("preview")}>
                <EyeIcon aria-hidden className="size-3.5" />
              </ViewButton>
            </WithTooltip>
            <WithTooltip label={`Source (${loaded.snapshot.format})`}>
              <ViewButton active={view === "source"} onClick={() => setView("source")}>
                <Code2Icon aria-hidden className="size-3.5" />
              </ViewButton>
            </WithTooltip>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <section className="relative flex min-h-[60svh] min-w-0 flex-col bg-background lg:min-h-0">
          <div className={view === "preview" ? "flex min-h-0 flex-1" : "hidden"}>
            {loaded.snapshot.format === "markdown" ? (
              <MarkdownDocumentPreview
                source={source}
                identity={identity}
                busy={busy}
                onTransform={onTransform}
                selectedThreadId={selectedThreadId}
                onSelectThread={setSelectedThreadId}
              />
            ) : (
              <HtmlDocumentPreview source={source} />
            )}
          </div>
          <div
            className={
              view === "source" ? "flex min-h-0 flex-1 flex-col [&_.cm-editor]:h-full" : "hidden"
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
                transport={transport}
                displayName={displayName}
                path={path}
                mode={loaded.snapshot.format}
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

        <aside className="min-h-0 border-t bg-muted/5 lg:border-t-0 lg:border-l">
          <DocumentComments
            ref={commentsRef}
            source={commentsSource}
            identity={identity}
            busy={busy}
            onTransform={onCommentTransform}
            selectedThreadId={selectedThreadId}
            onSelectThread={setSelectedThreadId}
          />
        </aside>
      </div>
    </div>
  );
}

/**
 * The presence avatar strip, ported from the tasks board: everyone with a
 * live caret on this document — yourself included, first, ringed in your own
 * author color — with the display name decoded from each session's clientId.
 */
function DocumentPresence({ peers }: { peers: { self: string; clientIds: string[] } | null }) {
  if (peers === null) return null;
  const everyone = [peers.self, ...peers.clientIds.filter((clientId) => clientId !== peers.self)];
  return (
    <div className="mr-1 flex items-center -space-x-1.5">
      {everyone.slice(0, 6).map((clientId) => (
        <span
          key={clientId}
          title={authorLabel(clientId)}
          style={{ borderColor: authorColor(clientId, 1) }}
          className="flex size-6 items-center justify-center rounded-full border-2 bg-background text-[10px] font-semibold uppercase"
        >
          {authorLabel(clientId).trim().slice(0, 1) || "?"}
        </span>
      ))}
      {everyone.length > 6 ? (
        <span className="pl-2 text-xs text-muted-foreground">+{everyone.length - 6}</span>
      ) : null}
    </div>
  );
}

/** Icon-only controls get their labels back as hover tooltips — the same
 * pattern as the tasks bar; shared properly when the apps combine. */
function WithTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
