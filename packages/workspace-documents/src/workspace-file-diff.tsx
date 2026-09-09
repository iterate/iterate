import { useEffect, useMemo, useState, type ReactNode } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { GitCompareIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { workspaceFileKind } from "./file-kinds.ts";
import type { WorkspaceTransport } from "./types.ts";

/**
 * One file's uncommitted change against its mount at HEAD, as CodeMirror's
 * unified merge view (read-only, no chunk controls): the base is
 * `readBase`, the working side the merged view. Status calls a shadowed
 * file "modified" without comparing content, so an identical pair says so
 * instead of showing an empty diff. Documents diff as source.
 */
export function WorkspaceFileDiff({
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
  const [sides, setSides] = useState<{ base: string | null; working: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSides(null);
    setError(null);
    void transport
      .run(async (workspace) => {
        const [base, working] = await Promise.all([
          workspace.readBase(path),
          workspace.readFile(path),
        ]);
        return { base, working };
      })
      .then((read) => {
        if (!cancelled) setSides(read);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [path, transport]);

  const kind = workspaceFileKind(path);
  const language = kind.kind === "text" ? kind.language : "markdown";
  const extensions = useMemo(
    () =>
      sides === null
        ? []
        : [
            unifiedMergeView({
              original: sides.base ?? "",
              allowInlineDiffs: true,
              mergeControls: false,
            }),
          ],
    [sides],
  );

  return (
    <div className="flex min-h-full flex-1 flex-col bg-background">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3 py-2">
        {leading}
        <GitCompareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate font-mono text-xs">{path}</h1>
        <span className="shrink-0 text-xs text-muted-foreground">against HEAD</span>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </header>
      {error !== null ? (
        <p className="m-6 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>
      ) : sides === null ? (
        <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Spinner className="size-4" /> Comparing…
          </span>
        </div>
      ) : sides.base === sides.working ? (
        <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
          No textual change against HEAD.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto [&_.cm-editor]:min-h-full">
          <SourceCodeBlock
            code={sides.working ?? ""}
            language={language}
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

/** The header toggle between a file and its diff against HEAD. */
export function DiffToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <Button
      variant={active ? "secondary" : "outline"}
      size="icon-sm"
      aria-label={active ? "Show file" : "Show diff against HEAD"}
      title={active ? "Show file" : "Show diff against HEAD"}
      aria-pressed={active}
      onClick={onToggle}
    >
      <GitCompareIcon aria-hidden className="size-3.5" />
    </Button>
  );
}
