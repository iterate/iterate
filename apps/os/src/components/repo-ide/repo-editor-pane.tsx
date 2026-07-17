import { useEffect, useMemo } from "react";
import { getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { LockIcon, MinusIcon, PencilIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { toast } from "@iterate-com/ui/components/sonner";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Table, TableBody, TableCell, TableRow } from "@iterate-com/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { useItxQuery } from "iterate/react";
import { changedLinesGutter } from "./change-gutter.ts";
import { HtmlPreview } from "./html-preview.tsx";
import { projectMarkdownPreview } from "./markdown-frontmatter.ts";
import { isPreviewablePath, repoFileKind } from "./repo-file-kinds.ts";
import { useRepoFileJsonSchema } from "./repo-json-schema.ts";
import { useRepoTypeScriptExtensions } from "./repo-typescript.ts";
import { localFileToBase64, pickLocalFile } from "./local-file.ts";
import {
  effectiveEntry,
  textContentForEntry,
  type FileChange,
  type FileEntry,
} from "./staged-changes.ts";

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
  previewOpen,
  onTogglePreview,
  onSetWorking,
  onSetStaged,
  onDiscardFile,
  onStageFile,
  onUnstageFile,
  onOpenWorking,
  stagedView,
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
  /** Markdown, html, and svg files: show the rendered preview (markdown HTML,
   * or the sandboxed html iframe) instead of the editor — of the current buffer,
   * or of the staged snapshot in the Index view. */
  previewOpen: boolean;
  onTogglePreview: (open: boolean) => void;
  onSetWorking: (entry: FileEntry | undefined) => void;
  onSetStaged: (entry: FileEntry | undefined) => void;
  onDiscardFile: () => void;
  onStageFile: () => void;
  onUnstageFile: () => void;
  /** Leave the Index view for the editable working-tree file. */
  onOpenWorking: () => void;
  /** Opened from Staged Changes: a READONLY diff of HEAD vs the staged
   * snapshot — the non-diff (editable) version is deliberately unreachable. */
  stagedView: boolean;
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
  const workingText = kind.kind === "text" ? textContentForEntry(working) : undefined;
  const stagedText = kind.kind === "text" ? textContentForEntry(staged) : undefined;
  const hasUndecodableTextEntry =
    kind.kind === "text" &&
    ((working?.type === "write-base64" && workingText === undefined) ||
      (staged?.type === "write-base64" && stagedText === undefined));

  // Diffs and dirty checks run against the git-shaped baseline: the staged
  // snapshot when one exists, else HEAD.
  const textBaseline = stagedText ?? headContent ?? undefined;

  // TypeScript language service (diagnostics, hover, autocomplete) for
  // ts/tsx/js/jsx working-tree buffers — empty for everything else, and for
  // the readonly Index view (an inspection surface, not a live buffer).
  const typeScriptExtensions = useRepoTypeScriptExtensions({
    projectId,
    repoPath,
    commitOid: headCommitOid,
    path,
    enabled: kind.kind === "text" && !stagedView,
  });

  // json-schema diagnostics/hover/completion for JSON and YAML buffers: an
  // explicit $schema (prop or yaml modeline) wins, else the well-known
  // filename map (package.json, tsconfig, …). Resolved against the live
  // buffer so adding a $schema line applies before any commit; the schema
  // itself is fetched from schemastore/wherever by the browser and failure
  // just means no squigglies. (TS and json/yaml are disjoint kinds, so the two
  // extension sets never both apply to one buffer.)
  const schemaLanguage =
    kind.kind === "text" &&
    (kind.language === "json" || kind.language === "jsonc" || kind.language === "yaml")
      ? kind.language
      : null;
  const jsonSchema = useRepoFileJsonSchema({
    path,
    language: schemaLanguage,
    content: workingText ?? textBaseline ?? "",
  });
  // The readonly Index view renders the STAGED snapshot, so it must validate
  // against the schema that snapshot declares — not the working buffer's, whose
  // `$schema` may have diverged (e.g. added/changed after staging).
  const stagedJsonSchema = useRepoFileJsonSchema({
    path,
    language: schemaLanguage,
    content: stagedText ?? "",
  });

  // The plain editor carries vscode-style gutter bars for lines differing
  // from the baseline; diff mode swaps in the unified (inline) merge view on
  // the same document, whose per-chunk "+" controls STAGE the chunk — the
  // merge view's accept-chunk applies it to its original doc, and the
  // listener below writes that doc back as the staged snapshot. Memoized so
  // the editor view survives re-renders.
  const editorExtensions = useMemo(() => {
    if (kind.kind !== "text") return [];
    // A never-committed file has no baseline to diff against, but the
    // language service still applies.
    if (textBaseline === undefined) return typeScriptExtensions;
    if (!diffOpen) return [...typeScriptExtensions, changedLinesGutter(textBaseline)];
    return [
      ...typeScriptExtensions,
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
  }, [kind.kind, textBaseline, headContent, diffOpen, typeScriptExtensions]);

  // The readonly staged view diffs HEAD against the staged snapshot with no
  // chunk controls — inspection only.
  const stagedDiffExtensions = useMemo(
    () =>
      stagedView && stagedText !== undefined
        ? [
            unifiedMergeView({
              original: headContent ?? "",
              allowInlineDiffs: true,
              mergeControls: false,
            }),
          ]
        : [],
    [stagedView, stagedText, headContent],
  );

  const editorExtensionsWithSchema = useMemo(
    () => [...editorExtensions, jsonSchema.extensions],
    [editorExtensions, jsonSchema.extensions],
  );
  const stagedDiffExtensionsWithSchema = useMemo(
    () => [...stagedDiffExtensions, stagedJsonSchema.extensions],
    [stagedDiffExtensions, stagedJsonSchema.extensions],
  );

  // Subtle header note: which schema is validating the buffer, or that the
  // fetch failed (in which case there are simply no squigglies). The Index view
  // names its own (staged-snapshot) schema.
  const schemaNoteFor = (result: typeof jsonSchema) =>
    result.status === "active" ? (
      <span title={result.url} className="text-[10px] text-muted-foreground">
        {new URL(result.url).pathname.split("/").pop() || result.url}
      </span>
    ) : result.status === "unavailable" ? (
      <span title={result.url} className="text-[10px] text-muted-foreground italic">
        schema unavailable
      </span>
    ) : null;
  const schemaNote = schemaNoteFor(jsonSchema);
  const stagedSchemaNote = schemaNoteFor(stagedJsonSchema);

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
          onClick={onDiscardFile}
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

  if (stagedView && stagedText !== undefined && kind.kind === "text") {
    // Same Code/Preview toggle as the working view, over the staged snapshot
    // — the Index pseudo-file stays readonly either way.
    const showStagedPreview = previewOpen && isPreviewablePath(path);
    return (
      <FileChrome
        path={path}
        suffix={showStagedPreview ? "(Index Preview)" : "(Index)"}
        readonly
        status={status}
        leading={
          isPreviewablePath(path) ? (
            <CodePreviewToggle preview={showStagedPreview} onChange={onTogglePreview} />
          ) : undefined
        }
        actions={
          <>
            {stagedSchemaNote}
            <Button variant="secondary" size="sm" className="text-xs" disabled>
              Diff
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              title="Unstage changes"
              onClick={onUnstageFile}
            >
              <MinusIcon className="size-3.5" />
              Unstage
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              title="Open the editable working tree file"
              onClick={onOpenWorking}
            >
              <PencilIcon className="size-3.5" />
              Open file
            </Button>
          </>
        }
      >
        {showStagedPreview ? (
          kind.language === "markdown" ? (
            <MarkdownPreview markdown={stagedText} />
          ) : (
            <HtmlPreview html={stagedText} />
          )
        ) : (
          <SourceCodeBlock
            key={`${path}:staged`}
            className="min-h-0 flex-1"
            plainChrome
            showLineNumbers
            editable={false}
            wrapLongLines={false}
            code={stagedText}
            language={kind.language}
            codeMirrorExtensions={stagedDiffExtensionsWithSchema}
            onChange={() => {}}
          />
        )}
      </FileChrome>
    );
  }

  if (kind.kind === "text" && !hasUndecodableTextEntry) {
    const value = workingText ?? textBaseline ?? "";
    const stageText = (content: string) => {
      // Typing back to the baseline un-dirties the file, like vscode.
      if (content === textBaseline) onSetWorking(undefined);
      else onSetWorking({ type: "write", content });
    };
    // Markdown, html, and svg files get a vscode-style Code | Preview toggle;
    // the preview renders the CURRENT buffer (unsaved edits included). Diff wins
    // if a hand-edited URL sets both `preview` and `diff` (the toggles keep them
    // mutually exclusive, but honor that invariant here too) so the pane never
    // renders Preview while the header shows the Diff/"Working Tree" state.
    const showPreview = previewOpen && !diffOpen && isPreviewablePath(path);
    return (
      <FileChrome
        path={path}
        {...(diffOpen ? { suffix: "(Working Tree)" } : showPreview ? { suffix: "(Preview)" } : {})}
        status={status}
        leading={
          isPreviewablePath(path) ? (
            <CodePreviewToggle preview={showPreview} onChange={onTogglePreview} />
          ) : undefined
        }
        actions={
          <>
            {schemaNote}
            {/* The preview replaces the editor, diff and all. */}
            {!showPreview && (headHasPath || staged !== undefined) ? (
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
        {showPreview ? (
          kind.language === "markdown" ? (
            <MarkdownPreview markdown={value} />
          ) : (
            <HtmlPreview html={value} />
          )
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
            codeMirrorExtensions={editorExtensionsWithSchema}
            onChange={stageText}
          />
        )}
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

/** Shared editor-pane chrome (path header + status badge + actions slot) —
 * exported for the sibling readonly commit-diff pane so every pane matches. */
export function FileChrome({
  path,
  suffix,
  readonly = false,
  status,
  leading,
  actions,
  children,
}: {
  path: string;
  /** vscode-style pseudo-file name: "(Index)", "(Working Tree)". */
  suffix?: string;
  readonly?: boolean;
  status?: "added" | "deleted" | "modified";
  /** Top-left slot before the path — the Code | Preview toggle lives here. */
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        {leading}
        <span className="min-w-0 truncate font-mono text-xs">
          {path}
          {suffix === undefined ? null : <span className="text-muted-foreground"> {suffix}</span>}
        </span>
        {readonly ? <LockIcon className="size-3 shrink-0 text-muted-foreground" /> : null}
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

/** vscode's "Code | Preview" tab pair for previewable (markdown / html) files. */
function CodePreviewToggle({
  preview,
  onChange,
}: {
  preview: boolean;
  onChange: (preview: boolean) => void;
}) {
  return (
    <Tabs
      value={preview ? "preview" : "code"}
      onValueChange={(value) => onChange(value === "preview")}
      className="shrink-0"
    >
      <TabsList className="h-7">
        <TabsTrigger value="code" className="px-2 text-xs">
          Code
        </TabsTrigger>
        <TabsTrigger value="preview" className="px-2 text-xs">
          Preview
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/**
 * Rendered markdown for the current working-tree buffer, via MessageResponse
 * (streamdown) — already the agent feed's chat renderer, so no new dependency
 * and no dangerouslySetInnerHTML. SECURITY INVARIANT: repo content is
 * user-supplied, and the layer that actually defuses it is rehype-sanitize's
 * default (GitHub) schema in streamdown's DEFAULT rehype pipeline — its
 * rehype-harden config is wide open (`allowedProtocols: ["*"]` etc.). That
 * default only holds because nothing here passes `rehypePlugins`; don't add
 * that prop without re-checking sanitization.
 */
function MarkdownPreview({ markdown }: { markdown: string }) {
  const preview = projectMarkdownPreview(markdown);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-6 text-sm">
        {preview.metadata.length === 0 ? null : (
          <div className="mb-6 overflow-hidden rounded-lg border bg-muted/20">
            <Table className="text-xs">
              <TableBody>
                {preview.metadata.map((property) => (
                  <TableRow key={property.key} className="hover:bg-transparent">
                    <TableCell className="w-36 py-1.5 font-medium text-muted-foreground">
                      {property.key}
                    </TableCell>
                    <TableCell className="py-1.5 font-mono whitespace-normal">
                      {property.value}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {/* A settled document, not a stream — skip streamdown's unpaired-
            marker balancing (it appends a phantom `*` to text like "17 * 23"). */}
        <MessageResponse parseIncompleteMarkdown={false}>{preview.body}</MessageResponse>
      </div>
    </div>
  );
}

export function EmptyPane({ label }: { label: string }) {
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
  // Revoked on change/unmount: an object URL pins its blob in memory until
  // the page unloads otherwise.
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <iframe title="PDF preview" src={url} className="min-h-0 flex-1" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
