import { useMemo } from "react";
import { getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { PlusIcon, Undo2Icon } from "lucide-react";
import { toast } from "@iterate-com/ui/components/sonner";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { changedLinesGutter } from "./change-gutter.ts";
import { repoFileKind } from "./repo-file-kinds.ts";
import { localFileToBase64, pickLocalFile } from "./local-file.ts";
import { effectiveEntry, type FileChange, type FileEntry } from "./staged-changes.ts";
import { useItxQuery } from "~/itx/itx-react.tsx";

/**
 * The right-hand side of the repo IDE: one file, rendered by kind — an
 * editable CodeMirror buffer (with a vscode-style inline diff and per-chunk
 * staging), an image or PDF preview with Replace, or the opaque-binary
 * fallback. Suspends on the HEAD read; mount under the IDE's Suspense
 * boundary.
 */
export function RepoEditorPane({
  projectId,
  repoPath,
  path,
  headCommitOid,
  headHasPath,
  change,
  diffOpen,
  onToggleDiff,
  onSetWorking,
  onSetStaged,
  onStageFile,
  onRestore,
}: {
  projectId: string;
  repoPath: string;
  path: string;
  headCommitOid: string;
  headHasPath: boolean;
  change: FileChange | undefined;
  diffOpen: boolean;
  onToggleDiff: (open: boolean) => void;
  onSetWorking: (entry: FileEntry | undefined) => void;
  onSetStaged: (entry: FileEntry | undefined) => void;
  onStageFile: () => void;
  onRestore: () => void;
}) {
  const kind = repoFileKind(path);
  const lane = kind.kind === "text" ? "utf8" : "base64";
  // Keyed by commit oid so a commit (which changes HEAD) naturally refetches;
  // never-committed files skip the read — there is nothing at HEAD to fetch.
  const headRead = useItxQuery({
    key: ["repo-file", projectId, repoPath, headCommitOid, lane, path, headHasPath],
    query: async (itx) =>
      headHasPath ? await itx.repos.get(repoPath).readFile({ path, encoding: lane }) : null,
  });
  const headContent = headRead?.content;
  const working = change?.working;
  const staged = change?.staged;

  // Diffs and dirty checks run against the git-shaped baseline: the staged
  // snapshot when one exists, else HEAD.
  const textBaseline = staged?.type === "write" ? staged.content : (headContent ?? undefined);

  // The plain editor carries vscode-style gutter bars for lines differing
  // from the baseline; diff mode swaps in the unified (inline) merge view on
  // the same document, whose per-chunk "+" controls STAGE the chunk — the
  // merge view's accept-chunk applies it to its original doc, and the
  // listener below writes that doc back as the staged snapshot. Memoized so
  // the editor view survives re-renders.
  const editorExtensions = useMemo(() => {
    if (kind.kind !== "text" || textBaseline === undefined) return [];
    if (!diffOpen) return [changedLinesGutter(textBaseline)];
    return [
      unifiedMergeView({
        original: textBaseline,
        allowInlineDiffs: true,
        mergeControls: (type, action) => {
          const button = document.createElement("button");
          button.textContent = type === "accept" ? "+" : "⨯";
          button.title = type === "accept" ? "Stage block" : "Discard block";
          button.onmousedown = action;
          return button;
        },
      }),
      EditorView.updateListener.of((update) => {
        const original = getOriginalDoc(update.state);
        if (original.eq(getOriginalDoc(update.startState))) return;
        const content = original.toString();
        onSetStaged(content === headContent ? undefined : { type: "write", content });
      }),
      EditorView.baseTheme({
        ".cm-chunkButtons button": {
          cursor: "pointer",
          border: "1px solid #d0d7de",
          borderRadius: "3px",
          background: "#fff",
          margin: "0 1px",
          padding: "0 5px",
          fontSize: "11px",
          lineHeight: "16px",
        },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks are stable store methods; content inputs drive recreation
  }, [kind.kind, textBaseline, headContent, diffOpen]);

  const replaceFile = async () => {
    const file = await pickLocalFile(kind.kind === "image" ? "image/*" : undefined);
    if (!file) return;
    try {
      onSetWorking({ type: "write-base64", contentBase64: await localFileToBase64(file) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the picked file.");
    }
  };

  const stageAndDiscardButtons = (
    <>
      {working !== undefined ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          title="Discard changes"
          onClick={() => onSetWorking(undefined)}
        >
          <Undo2Icon className="size-3.5" />
          Discard
        </Button>
      ) : null}
      {working !== undefined ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          title="Stage changes"
          onClick={onStageFile}
        >
          <PlusIcon className="size-3.5" />
          Stage
        </Button>
      ) : null}
    </>
  );

  const entry = change === undefined ? undefined : effectiveEntry(change);
  if (entry?.type === "delete") {
    return (
      <FileChrome path={path} status="deleted">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <span>
            <span className="font-mono">{path}</span> is{" "}
            {staged?.type === "delete" ? "staged" : "marked"} for deletion.
          </span>
          <Button variant="outline" size="sm" onClick={onRestore}>
            Restore
          </Button>
        </div>
      </FileChrome>
    );
  }

  const status =
    entry === undefined ? undefined : headHasPath ? ("modified" as const) : ("added" as const);

  if (kind.kind === "text" && working?.type !== "write-base64" && staged?.type !== "write-base64") {
    const value = working?.type === "write" ? working.content : (textBaseline ?? "");
    const stageText = (content: string) => {
      // Typing back to the baseline un-dirties the file, like vscode.
      if (content === textBaseline) onSetWorking(undefined);
      else onSetWorking({ type: "write", content });
    };
    return (
      <FileChrome
        path={path}
        status={status}
        actions={
          <>
            {headHasPath || staged !== undefined ? (
              <Button
                variant={diffOpen ? "secondary" : "ghost"}
                size="sm"
                className="text-xs"
                onClick={() => onToggleDiff(!diffOpen)}
              >
                Diff
              </Button>
            ) : null}
            {stageAndDiscardButtons}
          </>
        }
      >
        <SourceCodeBlock
          key={path}
          className="min-h-0 flex-1"
          plainChrome
          showLineNumbers
          editable
          wrapLongLines={false}
          code={value}
          language={kind.language}
          codeMirrorExtensions={editorExtensions}
          onChange={stageText}
        />
      </FileChrome>
    );
  }

  // Binary lanes from here down. Content precedence: live edit, staged
  // snapshot, then HEAD.
  const base64 =
    working?.type === "write-base64"
      ? working.contentBase64
      : staged?.type === "write-base64"
        ? staged.contentBase64
        : headContent;
  const binaryActions = (
    <>
      <Button variant="outline" size="sm" className="text-xs" onClick={() => void replaceFile()}>
        Replace…
      </Button>
      {stageAndDiscardButtons}
    </>
  );

  if (base64 === undefined || base64 === null) {
    return (
      <FileChrome path={path} status={status} actions={binaryActions}>
        <EmptyPane label="No content." />
      </FileChrome>
    );
  }

  const approximateBytes = Math.round((base64.length * 3) / 4);
  if (kind.kind === "image") {
    return (
      <FileChrome path={path} status={status} actions={binaryActions}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto p-6">
          {/* Checkerboard so transparent images read against both themes. */}
          <img
            src={`data:${kind.mimeType};base64,${base64}`}
            alt={path}
            className="max-h-full max-w-full rounded border bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
          />
          <span className="text-xs text-muted-foreground">{formatBytes(approximateBytes)}</span>
        </div>
      </FileChrome>
    );
  }

  if (kind.kind === "pdf") {
    return (
      <FileChrome path={path} status={status} actions={binaryActions}>
        <PdfPreview base64={base64} />
      </FileChrome>
    );
  }

  return (
    <FileChrome path={path} status={status} actions={binaryActions}>
      <EmptyPane label={`Binary file · ${formatBytes(approximateBytes)}`} />
    </FileChrome>
  );
}

function FileChrome({
  path,
  status,
  actions,
  children,
}: {
  path: string;
  status?: "added" | "deleted" | "modified";
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 truncate font-mono text-xs">{path}</span>
        {status === undefined ? null : (
          <Badge
            variant={status === "deleted" ? "destructive" : "secondary"}
            className="text-[10px]"
          >
            {status}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </div>
      {children}
    </div>
  );
}

function EmptyPane({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function PdfPreview({ base64 }: { base64: string }) {
  // A blob URL, not a data: URL — Chrome's PDF viewer refuses data: URLs in
  // nested browsing contexts. Rebuilt only when the bytes change.
  const url = useMemo(() => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }, [base64]);
  return <iframe title="PDF preview" src={url} className="min-h-0 flex-1" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
