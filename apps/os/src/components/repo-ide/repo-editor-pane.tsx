import { useMemo } from "react";
import { toast } from "@iterate-com/ui/components/sonner";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { CodeDiffBlock } from "@iterate-com/ui/components/code-diff-block";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { repoFileKind } from "./repo-file-kinds.ts";
import { localFileToBase64, pickLocalFile } from "./local-file.ts";
import type { StagedEntry } from "./staged-changes.ts";
import { useItxQuery } from "~/itx/itx-react.tsx";

/**
 * The right-hand side of the repo IDE: one file, rendered by kind — an
 * editable CodeMirror buffer (with a vscode-style HEAD↔staged diff toggle),
 * an image or PDF preview with Replace, or the opaque-binary fallback.
 * Suspends on the HEAD read; mount under the IDE's Suspense boundary.
 */
export function RepoEditorPane({
  projectId,
  repoPath,
  path,
  headCommitOid,
  headHasPath,
  staged,
  diffOpen,
  onToggleDiff,
  onStage,
  onDiscard,
}: {
  projectId: string;
  repoPath: string;
  path: string;
  headCommitOid: string;
  headHasPath: boolean;
  staged: StagedEntry | undefined;
  diffOpen: boolean;
  onToggleDiff: (open: boolean) => void;
  onStage: (entry: StagedEntry) => void;
  onDiscard: () => void;
}) {
  const kind = repoFileKind(path);
  const lane = kind.kind === "text" ? "utf8" : "base64";
  // Keyed by commit oid so a commit (which changes HEAD) naturally refetches;
  // staged-only files skip the read — there is nothing at HEAD to fetch.
  const headRead = useItxQuery({
    key: ["repo-file", projectId, repoPath, headCommitOid, lane, path, headHasPath],
    query: async (itx) =>
      headHasPath ? await itx.repos.get(repoPath).readFile({ path, encoding: lane }) : null,
  });
  const headContent = headRead?.content;

  const replaceFile = async () => {
    const file = await pickLocalFile(kind.kind === "image" ? "image/*" : undefined);
    if (!file) return;
    try {
      onStage({ type: "write-base64", contentBase64: await localFileToBase64(file) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the picked file.");
    }
  };

  if (staged?.type === "delete") {
    return (
      <FileChrome path={path} status="deleted">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <span>
            <span className="font-mono">{path}</span> is staged for deletion.
          </span>
          <Button variant="outline" size="sm" onClick={onDiscard}>
            Restore
          </Button>
        </div>
      </FileChrome>
    );
  }

  if (kind.kind === "text" && staged?.type !== "write-base64") {
    const value = staged?.type === "write" ? staged.content : (headContent ?? "");
    const dirty = staged !== undefined;
    const stageText = (content: string) => {
      // Typing back to the HEAD content un-dirties the file, like vscode.
      if (content === headContent) onDiscard();
      else onStage({ type: "write", content });
    };
    return (
      <FileChrome
        path={path}
        status={dirty ? (headHasPath ? "modified" : "added") : undefined}
        actions={
          <>
            {dirty && headHasPath ? (
              <Button
                variant={diffOpen ? "secondary" : "ghost"}
                size="sm"
                className="text-xs"
                onClick={() => onToggleDiff(!diffOpen)}
              >
                Diff
              </Button>
            ) : null}
            {dirty ? (
              <Button variant="ghost" size="sm" className="text-xs" onClick={onDiscard}>
                Discard
              </Button>
            ) : null}
          </>
        }
      >
        {diffOpen && dirty && headHasPath ? (
          <CodeDiffBlock
            className="min-h-0 flex-1"
            original={headContent ?? ""}
            modified={value}
            language={kind.language}
            onModifiedChange={stageText}
          />
        ) : (
          <SourceCodeBlock
            key={path}
            className="min-h-0 flex-1"
            plainChrome
            showLineNumbers
            editable
            wrapLongLines={false}
            code={value}
            language={kind.language}
            onChange={stageText}
          />
        )}
      </FileChrome>
    );
  }

  // Binary lanes from here down. Content precedence: staged bytes, then HEAD.
  const base64 =
    staged?.type === "write-base64"
      ? staged.contentBase64
      : staged?.type === "write"
        ? undefined
        : headContent;
  const status = staged === undefined ? undefined : headHasPath ? "modified" : "added";
  const binaryActions = (
    <>
      <Button variant="outline" size="sm" className="text-xs" onClick={() => void replaceFile()}>
        Replace…
      </Button>
      {staged === undefined ? null : (
        <Button variant="ghost" size="sm" className="text-xs" onClick={onDiscard}>
          Discard
        </Button>
      )}
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
