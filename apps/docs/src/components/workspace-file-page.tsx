import { useEffect, useState, type ReactNode } from "react";
import { FileIcon } from "lucide-react";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { withDocsProject } from "../lib/docs-client.ts";
import { workspaceFileKind } from "../lib/file-kinds.ts";
import { DocumentError } from "./document-error.tsx";

/**
 * A non-document file of the workspace, read-only: source text in the
 * shared CodeMirror block (highlighted by extension), or a note for files
 * the app does not render. Documents (.md/.html) open in the collaborative
 * editor instead; editing everything else is an agent's job for now.
 */
export function WorkspaceFilePage({
  workspacePath,
  path,
  actions,
}: {
  workspacePath: string;
  /** Fully qualified. */
  path: string;
  actions?: ReactNode;
}) {
  const kind = workspaceFileKind(path);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (kind.kind !== "text") return;
    let cancelled = false;
    setContent(null);
    setError(null);
    void withDocsProject((project) => project.workspace(workspacePath).readFile(path))
      .then((read) => {
        if (cancelled) return;
        if (read === null) setError(`file "${path}" does not exist`);
        else setContent(read);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [kind.kind, path, workspacePath, attempt]);

  if (error !== null) {
    return (
      <DocumentError
        workspacePath={workspacePath}
        path={path}
        message={error}
        onRetry={() => setAttempt((current) => current + 1)}
      />
    );
  }
  return (
    <div className="flex min-h-svh flex-col bg-background lg:h-svh lg:overflow-hidden">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3 py-2">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate font-mono text-xs">{path}</h1>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </header>
      {kind.kind === "opaque" ? (
        <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
          This file type is not rendered here.
        </div>
      ) : content === null ? (
        <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Spinner className="size-4" /> Opening file…
          </span>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto [&_.cm-editor]:min-h-full">
          <SourceCodeBlock
            code={content}
            language={kind.kind === "text" ? kind.language : "text"}
            plainChrome
            showCopyButton={false}
            wrapLongLines={false}
          />
        </div>
      )}
    </div>
  );
}
