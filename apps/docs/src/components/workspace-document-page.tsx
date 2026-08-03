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
import { parseAnnotatedMarkdown } from "iterate/annotated-markdown";
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
  const title = documentTitle(source, loaded.snapshot.format, path);
  const commentsSource =
    loaded.snapshot.format === "html" ? annotationsSourceForHtmlDocument(source) : source;

  // div, not main: SidebarInset already renders the main landmark.
  return (
    <div className="flex min-h-svh flex-col bg-background lg:h-svh lg:overflow-hidden">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <FileTextIcon aria-hidden className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <span className="hidden rounded-full border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
              {loaded.snapshot.format}
            </span>
          </div>
          {/* HIERARCHY order, full paths (always leading-slashed): which
              workspace › which view › the file — relative when it lives in
              the workspace's own directory, the full mount path otherwise. */}
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {workspacePath}
            <span className="px-1.5 text-border">›</span>
            docs
            <span className="px-1.5 text-border">›</span>
            {loaded.snapshot.path.startsWith(`${workspacePath}/`)
              ? loaded.snapshot.path.slice(workspacePath.length + 1)
              : loaded.snapshot.path}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <DocumentPresence peers={peers} />
          <span className="hidden max-w-40 truncate text-[11px] text-muted-foreground md:block">
            {status}
          </span>
          <Button size="sm" onClick={() => commentsRef.current?.focusDocumentComment()}>
            <MessageSquarePlusIcon aria-hidden />
            <span className="hidden sm:inline">Comment on document</span>
            <span className="sm:hidden">Comment</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowChanges((value) => !value)}
            aria-pressed={showChanges}
            className={showChanges ? "bg-muted" : undefined}
          >
            <SparklesIcon aria-hidden />
            <span className="hidden sm:inline">Changes</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={copyLink}>
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            <span className="hidden sm:inline">{copied ? "Copied" : "Copy link"}</span>
          </Button>
          <div className="ml-1 flex rounded-lg border bg-muted/30 p-0.5">
            <ViewButton active={view === "preview"} onClick={() => setView("preview")}>
              <EyeIcon aria-hidden /> Preview
            </ViewButton>
            <ViewButton active={view === "source"} onClick={() => setView("source")}>
              <Code2Icon aria-hidden /> Source
            </ViewButton>
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

function documentTitle(source: string, format: "html" | "markdown", path: string): string {
  const parsed = parseAnnotatedMarkdown(source);
  const body = parsed.kind === "structured" ? parsed.body : source;
  if (format === "html") {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    if (title !== undefined) {
      const plain = title
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (plain !== "") return plain;
    }
  } else {
    const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim();
    if (heading !== undefined && heading !== "") return heading;
  }
  return path.split("/").at(-1) ?? path;
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
