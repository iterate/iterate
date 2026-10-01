import { MinusIcon, PencilIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { CodePreviewToggle, EmptyPane, ErrorPane, FileChrome } from "./file-chrome.tsx";
import { HtmlPreview } from "./html-preview.tsx";
import { MarkdownPreview } from "./markdown-preview.tsx";
import { RepoCodeEditor } from "./repo-code-editor.tsx";
import { isPreviewablePath, repoFileKind, type RepoFileLanguage } from "./repo-file-kinds.ts";
import { readRepoFile, useRead, type RepoProject } from "./repo-client.ts";
import { effectiveEntry, type FileChange, type FileEntry } from "./staged-changes.ts";
import { Button } from "#/components/ui/button.tsx";

/** What the pane does to one file's change: the IDE owns the working tree. */
export interface RepoFileHandlers {
  setWorking: (entry: FileEntry | undefined) => void;
  setStaged: (entry: FileEntry | undefined) => void;
  discard: () => void;
  stage: () => void;
  unstage: () => void;
  /** Leave the Index view for the editable working-tree file. */
  openWorking: () => void;
  /** Bring back a file marked for deletion. */
  restore: () => void;
  setDiff: (open: boolean) => void;
  setPreview: (open: boolean) => void;
}

/** How the pane shows the file: the URL's view state. */
export type RepoFileView = {
  diff: boolean;
  /** Markdown, html and svg files: the rendered preview instead of the editor. */
  preview: boolean;
  /** Opened from Staged Changes: a readonly diff of HEAD against the staged snapshot. */
  staged: boolean;
};

type FileStatus = "added" | "deleted" | "modified";

/**
 * The right-hand side of the repo IDE: one file, an editable CodeMirror buffer with a vscode-style
 * inline diff and per-chunk staging, a Code | Preview toggle for markdown and html, or the
 * readonly Index view of what is staged. Files the editor cannot show (images, archives) say so.
 */
export function RepoEditorPane({
  project,
  repoPath,
  path,
  headCommitOid,
  headHasPath,
  change,
  view,
  handlers,
}: {
  project: RepoProject;
  repoPath: string;
  path: string;
  headCommitOid: string | null;
  headHasPath: boolean;
  change: FileChange | undefined;
  view: RepoFileView;
  handlers: RepoFileHandlers;
}) {
  const kind = repoFileKind(path);
  // Keyed by commit oid so a commit, which moves HEAD, reads again; a file never committed has
  // nothing at HEAD to read.
  const headRead = useRead(
    async () =>
      kind.kind === "text" && headHasPath
        ? await readRepoFile(project, repoPath, path, headCommitOid || undefined)
        : undefined,
    [project, repoPath, path, headCommitOid, headHasPath, kind.kind],
  );
  const entry = change && effectiveEntry(change);
  const status: FileStatus | undefined = entry && (headHasPath ? "modified" : "added");

  if (entry?.type === "delete") {
    return (
      <DeletedFile
        path={path}
        staged={change?.staged?.type === "delete"}
        onRestore={handlers.restore}
      />
    );
  }
  if (kind.kind === "binary") {
    return (
      <FileChrome path={path} status={status}>
        <EmptyPane label="Binary file: the repo editor shows text files only." />
      </FileChrome>
    );
  }
  if (headRead.status !== "loaded") {
    return (
      <FileChrome path={path} status={status}>
        {headRead.status === "failed" ? (
          <ErrorPane message={headRead.message} />
        ) : (
          <EmptyPane label={`Loading ${path}…`} spinner />
        )}
      </FileChrome>
    );
  }
  const staged = change?.staged;
  if (view.staged && staged?.type === "write") {
    return (
      <StagedFileView
        path={path}
        language={kind.language}
        status={status}
        stagedText={staged.content}
        headContent={headRead.value}
        preview={view.preview}
        handlers={handlers}
      />
    );
  }
  return (
    <WorkingFileView
      path={path}
      language={kind.language}
      status={status}
      headHasPath={headHasPath}
      headContent={headRead.value}
      change={change}
      view={view}
      handlers={handlers}
    />
  );
}

/** A file marked for deletion: nothing to edit, one way back. */
function DeletedFile({
  path,
  staged,
  onRestore,
}: {
  path: string;
  staged: boolean;
  onRestore: () => void;
}) {
  return (
    <FileChrome path={path} status="deleted">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <span>
          <span className="font-mono">{path}</span> is {staged ? "staged" : "marked"} for deletion.
        </span>
        <Button variant="outline" size="sm" onClick={onRestore}>
          Restore
        </Button>
      </div>
    </FileChrome>
  );
}

function Preview({ language, text }: { language: RepoFileLanguage; text: string }) {
  return language === "markdown" ? (
    <MarkdownPreview markdown={text} />
  ) : (
    <HtmlPreview html={text} />
  );
}

/** The Index: HEAD against the staged snapshot, readonly, with the same Code | Preview toggle as
 *  the working file. */
function StagedFileView({
  path,
  language,
  status,
  stagedText,
  headContent,
  preview,
  handlers,
}: {
  path: string;
  language: RepoFileLanguage;
  status: FileStatus | undefined;
  stagedText: string;
  headContent: string | undefined;
  preview: boolean;
  handlers: RepoFileHandlers;
}) {
  const previewable = isPreviewablePath(path);
  const showPreview = preview && previewable;
  return (
    <FileChrome
      path={path}
      suffix={showPreview ? "(Index Preview)" : "(Index)"}
      readonly
      status={status}
      leading={
        previewable ? (
          <CodePreviewToggle preview={showPreview} onChange={handlers.setPreview} />
        ) : undefined
      }
      actions={
        <>
          <Button variant="secondary" size="sm" className="text-xs" disabled>
            Diff
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            title="Unstage changes"
            onClick={handlers.unstage}
          >
            <MinusIcon className="size-3.5" />
            Unstage
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            title="Open the editable working tree file"
            onClick={handlers.openWorking}
          >
            <PencilIcon className="size-3.5" />
            Open file
          </Button>
        </>
      }
    >
      {showPreview ? (
        <Preview language={language} text={stagedText} />
      ) : (
        <RepoCodeEditor
          key={`${path}:staged`}
          className="min-h-0 flex-1"
          readOnly
          label={path}
          value={stagedText}
          language={language}
          baseline={headContent || ""}
          diff
        />
      )}
    </FileChrome>
  );
}

/** The editable file: the buffer, its diff against the baseline (the staged snapshot when there is
 *  one, else HEAD), and stage and discard. */
function WorkingFileView({
  path,
  language,
  status,
  headHasPath,
  headContent,
  change,
  view,
  handlers,
}: {
  path: string;
  language: RepoFileLanguage;
  status: FileStatus | undefined;
  headHasPath: boolean;
  headContent: string | undefined;
  change: FileChange | undefined;
  view: RepoFileView;
  handlers: RepoFileHandlers;
}) {
  const working = change?.working;
  const staged = change?.staged;
  // a file never committed and never staged has no baseline to compare to
  const hasBaseline = headHasPath || staged?.type === "write";
  const baseline = staged?.type === "write" ? staged.content : headContent || "";
  const value = working?.type === "write" ? working.content : baseline;
  const previewable = isPreviewablePath(path);
  // Diff wins if a hand-edited URL sets both `preview` and `diff`, so the pane never renders
  // Preview while the header shows the Diff state.
  const showPreview = view.preview && !view.diff && previewable;
  const setBuffer = (content: string) => {
    // typing back to the baseline un-dirties the file, like vscode
    handlers.setWorking(content === baseline ? undefined : { type: "write", content });
  };
  let suffix: string | undefined;
  if (view.diff) suffix = "(Working Tree)";
  else if (showPreview) suffix = "(Preview)";
  return (
    <FileChrome
      path={path}
      suffix={suffix}
      status={status}
      leading={
        previewable ? (
          <CodePreviewToggle preview={showPreview} onChange={handlers.setPreview} />
        ) : undefined
      }
      actions={
        <WorkingFileActions
          showDiff={!showPreview && (headHasPath || Boolean(staged))}
          diff={view.diff}
          dirty={Boolean(working)}
          handlers={handlers}
        />
      }
    >
      {showPreview ? (
        <Preview language={language} text={value} />
      ) : (
        <RepoCodeEditor
          key={path}
          className="min-h-0 flex-1"
          label={path}
          value={value}
          language={language}
          baseline={hasBaseline ? baseline : undefined}
          diff={view.diff}
          onAcceptChunk={(content) =>
            handlers.setStaged(
              content === (headContent || "") ? undefined : { type: "write", content },
            )
          }
          onChange={setBuffer}
        />
      )}
    </FileChrome>
  );
}

/** The header's buttons for an editable file: Diff, and Discard and Stage while it has edits. */
function WorkingFileActions({
  showDiff,
  diff,
  dirty,
  handlers,
}: {
  showDiff: boolean;
  diff: boolean;
  dirty: boolean;
  handlers: RepoFileHandlers;
}) {
  return (
    <>
      {showDiff ? (
        <Button
          variant={diff ? "secondary" : "ghost"}
          size="sm"
          className="text-xs"
          onClick={() => handlers.setDiff(!diff)}
        >
          Diff
        </Button>
      ) : null}
      {dirty ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            title="Discard changes"
            onClick={handlers.discard}
          >
            <Undo2Icon className="size-3.5" />
            Discard
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            title="Stage changes"
            onClick={handlers.stage}
          >
            <PlusIcon className="size-3.5" />
            Stage
          </Button>
        </>
      ) : null}
    </>
  );
}
