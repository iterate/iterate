import { useEffect, useState, type ReactNode } from "react";
import { FileIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { workspaceFileKind } from "./file-kinds.ts";
import type { WorkspaceTransport } from "./types.ts";

/**
 * One file of a workspace, read-only: source text in the shared CodeMirror
 * block (highlighted by extension), or a note for files nothing renders.
 * Hosts open documents (.md/.html) in the collaborative editor instead;
 * editing everything else is an agent's job for now.
 */
export function WorkspaceFileView({
  transport,
  path,
  leading,
  actions,
}: {
  transport: WorkspaceTransport;
  /** Fully qualified. */
  path: string;
  /** Rendered at the left of the header (a sidebar trigger, say). */
  leading?: ReactNode;
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
    void transport
      .run((workspace) => workspace.readFile(path))
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
  }, [kind.kind, path, transport, attempt]);

  return (
    <div className="flex min-h-full flex-1 flex-col bg-background">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3 py-2">
        {leading}
        <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate font-mono text-xs">{path}</h1>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </header>
      {error !== null ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          <div className="flex max-w-xl flex-col gap-3 text-sm">
            <p className="rounded-lg bg-destructive/5 p-3 text-destructive">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setAttempt((current) => current + 1)}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : kind.kind === "opaque" ? (
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
