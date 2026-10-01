import { useSyncExternalStore } from "react";
import type { EditorView } from "@codemirror/view";
import {
  Bold,
  Code,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  MessageSquarePlus,
  Minus,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/ui/native-select";
import { Separator } from "@iterate-com/ui/components/ui/separator";
import {
  insertBlock,
  promptLink,
  setLinePrefix,
  TABLE_TEMPLATE,
  toggleWrap,
} from "../editor/commands.ts";
import type { DocMode, DocSession, DocStatus } from "../editor/doc-session.ts";
import { CommentsPanel } from "./comments-panel.tsx";

/** The views each kind of file switches between, by label; a code file has one. */
const modes: Record<"markdown" | "html" | "code", [DocMode, string][]> = {
  markdown: [
    ["rich", "Rich"],
    ["markdown", "Markdown"],
  ],
  html: [
    ["preview", "Preview"],
    ["source", "Source"],
  ],
  code: [],
};

/** The doc page's editor: formatting bar (markdown's), the view switch, the text (or an html
 *  file's preview) with its comments beside it, who else is here and where saving stands. */
export function DocEditor({
  session,
  path,
  back,
  stream,
}: {
  session: DocSession;
  path: string;
  /** a link back to the doc list */
  back: React.ReactNode;
  /** the doc's context in the dash (`StreamLink`) */
  stream: React.ReactNode;
}) {
  const state = useSyncExternalStore(session.subscribe, session.state, session.state);
  const { kind } = session.options;
  const views = modes[kind];
  return (
    <div className="flex flex-1 flex-col">
      <div className="sticky top-0 z-10 flex min-h-11 flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-1.5">
        {kind === "markdown" ? <FormattingBar session={session} /> : <span />}
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            title="Comment on the selection (⌘⌥M)"
            disabled={state.status.kind === "opening"}
            // keeps the editor's selection, which is what the comment is on
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => session.startComment()}
          >
            <MessageSquarePlus />
            Comment
          </Button>
          {views.length > 0 ? (
            <div role="group" aria-label="Mode" className="flex rounded-lg border p-0.5">
              {views.map(([mode, label]) => (
                <Button
                  key={mode}
                  size="xs"
                  variant={state.mode === mode ? "secondary" : "ghost"}
                  aria-pressed={state.mode === mode}
                  onClick={() => session.setMode(mode)}
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-1 flex-col md:flex-row">
        <div
          className={
            kind === "markdown"
              ? "mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 md:px-8"
              : "flex w-full min-w-0 flex-1 flex-col px-4"
          }
        >
          <div className="flex flex-wrap justify-between gap-2 pt-4 text-xs text-muted-foreground">
            <p className="flex gap-2 font-mono">
              {back}
              <span aria-hidden>/</span>
              <span>{path}</span>
            </p>
            <div className="flex gap-3">
              {state.others.length > 0 && (
                <p aria-label="Also here">Also here: {state.others.join(", ")}</p>
              )}
              {stream}
            </div>
          </div>
          {state.mode === "preview" ? (
            <iframe
              title={`Preview of ${path}`}
              // its own opaque origin: the page's scripts run, and reach nothing of the app's
              sandbox="allow-scripts allow-popups allow-forms"
              srcDoc={state.previewText}
              className="mt-3 min-h-[70vh] w-full flex-1 rounded-md border bg-white"
            />
          ) : null}
          {/* mounted in Preview too: the text stays live, and the preview follows it */}
          <div
            ref={session.mount}
            className={state.mode === "preview" ? "hidden" : "docs-editor pt-2"}
          />
        </div>
        {state.threads.length > 0 || state.draft ? (
          <CommentsPanel session={session} state={state} />
        ) : null}
      </div>
      <p
        role="status"
        className="sticky bottom-0 border-t bg-background px-4 py-1.5 text-xs text-muted-foreground"
      >
        <StatusText status={state.status} onRetry={() => session.reconnect()} />
      </p>
    </div>
  );
}

function StatusText({ status, onRetry }: { status: DocStatus; onRetry: () => void }) {
  if (status.kind === "opening") return "Opening…";
  if (status.kind === "editing") return "Editing…";
  if (status.kind === "save-failed")
    return (
      <span className="text-destructive">
        Couldn't save: {status.message}. The text is kept, and the next edit saves again.
      </span>
    );
  if (status.kind === "disconnected")
    return (
      <span className="text-destructive">
        Lost the connection: {status.message}. Your text is still here.{" "}
        <button type="button" className="underline" onClick={onRetry}>
          Try again
        </button>
      </span>
    );
  const saved = `Saved ${status.oid.slice(0, 7)}`;
  return status.by.length > 0 ? `${saved} (${status.by.join(", ")})` : saved;
}

/** MDXEditor's bar, more or less: every button is a text edit on the markdown (commands.ts), so it
 *  works in Markdown mode too. Buttons keep the editor's focus and selection (mousedown). */
function FormattingBar({ session }: { session: DocSession }) {
  const button = (label: string, icon: React.ReactNode, command: (view: EditorView) => boolean) =>
    action(label, icon, () => session.run(command));
  const action = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <Button
      key={label}
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5">
      {action("Undo", <Undo2 />, () => session.undo())}
      {action("Redo", <Redo2 />, () => session.redo())}
      <Separator orientation="vertical" className="mx-1 h-5" />
      {button("Bold", <Bold />, (view) => toggleWrap(view, "**"))}
      {button("Italic", <Italic />, (view) => toggleWrap(view, "_"))}
      {button("Strikethrough", <Strikethrough />, (view) => toggleWrap(view, "~~"))}
      {button("Inline code", <Code />, (view) => toggleWrap(view, "`"))}
      <Separator orientation="vertical" className="mx-1 h-5" />
      {button("Bulleted list", <List />, (view) => setLinePrefix(view, "- "))}
      {button("Numbered list", <ListOrdered />, (view) => setLinePrefix(view, "1. "))}
      {button("Checklist", <ListChecks />, (view) => setLinePrefix(view, "- [ ] "))}
      <Separator orientation="vertical" className="mx-1 h-5" />
      <NativeSelect
        size="sm"
        aria-label="Block type"
        value=""
        onChange={(event) => {
          const prefix = BLOCK_TYPES[event.target.value] || "";
          session.run((view) => setLinePrefix(view, prefix));
        }}
      >
        <NativeSelectOption value="" disabled>
          Block type
        </NativeSelectOption>
        <NativeSelectOption value="paragraph">Paragraph</NativeSelectOption>
        <NativeSelectOption value="h1">Heading 1</NativeSelectOption>
        <NativeSelectOption value="h2">Heading 2</NativeSelectOption>
        <NativeSelectOption value="h3">Heading 3</NativeSelectOption>
        <NativeSelectOption value="quote">Quote</NativeSelectOption>
      </NativeSelect>
      <Separator orientation="vertical" className="mx-1 h-5" />
      {button("Link", <Link />, promptLink)}
      {button("Table", <Table />, (view) => insertBlock(view, TABLE_TEMPLATE))}
      {button("Divider", <Minus />, (view) => insertBlock(view, "---"))}
    </div>
  );
}

/** The block-type menu's choices, by option value: the markers their lines start with. */
const BLOCK_TYPES: Record<string, string> = {
  paragraph: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  quote: "> ",
};
