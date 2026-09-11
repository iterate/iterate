import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { changedLinesGutter } from "./change-gutter.ts";
import { workspaceFileKind } from "./file-kinds.ts";
import type { WorkspaceTransport } from "./types.ts";

/**
 * One file of a workspace, read-only: source text in the shared CodeMirror
 * block (highlighted by extension — documents as their Markdown or HTML
 * source), or a note for files nothing renders. A host with a collaborative
 * editor opens documents there instead; editing everything else is an
 * agent's job for now.
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
  // The mount's version at HEAD, for the change bars in the gutter; null
  // for a file the mount does not have (an addition, or the own directory).
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (kind.kind === "opaque") return;
    let cancelled = false;
    setContent(null);
    setError(null);
    void transport
      .run(async (workspace) => {
        const [read, head] = await Promise.all([
          workspace.readFile(path),
          workspace.readBase(path),
        ]);
        return { read, head };
      })
      .then(({ read, head }) => {
        if (cancelled) return;
        if (read === null) setError(`file "${path}" does not exist`);
        else {
          setContent(read);
          setBase(head);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [kind.kind, path, transport, attempt]);
  const extensions = useMemo(
    () => (base === null || base === content ? [] : [changedLinesGutter(base)]),
    [base, content],
  );

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
            language={kind.language}
            codeMirrorExtensions={extensions}
            plainChrome
            showCopyButton={false}
            wrapLongLines={false}
          />
        </div>
      )}
    </div>
  );
}
