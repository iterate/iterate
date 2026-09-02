import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AtSignIcon,
  CalendarPlusIcon,
  EyeIcon,
  FilePlusIcon,
  Link2Icon,
  NotebookPenIcon,
  PlusIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Input } from "@iterate-com/ui/components/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@iterate-com/ui/components/resizable";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "@iterate-com/ui/lib/utils";
import type { CollabEditorApi } from "@iterate-com/workspace-documents/editor-api";
import type {
  Reference,
  ReferenceCandidate,
  ReferenceHost,
  ReferenceKind,
} from "@iterate-com/workspace-documents/references";
import type { WorkspaceDocumentTransport } from "@iterate-com/workspace-documents/types";
import { withProject, withProjectOnce } from "../lib/project-rpc.ts";
import { notesWorkspacePath } from "../lib/board-shared.ts";
import type { TasksWorkspace } from "../lib/tasks-api.ts";
import { changeMap } from "../lib/use-workspace-board.ts";
import { parseTaskCard, setTaskCardAgent } from "../tasks-model.ts";
import {
  DEFAULT_NOTE,
  NOTES_DIR,
  ensureTodayHeading,
  logDateStamp,
  noteFileName,
  noteLabel,
  notesCommitMessage,
} from "../lib/notes-model.ts";

// The editor stack (CM6 + collab) loads only once a note opens.
const WorkspaceDocumentEditor = lazy(async () => {
  const module = await import("@iterate-com/workspace-documents/editor");
  return { default: module.WorkspaceDocumentEditor };
});

/** Quiet time after the last edit before the notes commit themselves. */
const NOTES_AUTO_COMMIT_MS = 30_000;

/**
 * Where the caret lands when a note opens: the very end (under today's
 * heading in the log, after the title in a fresh note). ONE module-level
 * object on purpose — the shared editor keys its whole setup effect on this
 * prop's identity, so an inline literal would tear CodeMirror down and
 * rebuild it on every render of this page (every keystroke, every tick).
 */
const CARET_AT_END = { caret: Number.MAX_SAFE_INTEGER };

/**
 * The things a note can point at, as plain text the editor draws as pills:
 * an agent (`@/agents/x`), a note (`[[notes/x.md]]`), a task
 * (`[[tasks/x.md]]`). The same syntax the config worker reads back on
 * commit to tell a mentioned agent. A path may contain dots but never ends
 * in one, so a sentence's full stop stays outside the mention.
 */
const REFERENCE_KINDS: ReferenceKind[] = [
  {
    kind: "agent",
    label: (target) => `Agent ${target}`,
    pattern: /@(\/agents\/[A-Za-z0-9_./-]*[A-Za-z0-9_/-])/g,
    trigger: "@",
  },
  {
    kind: "note",
    label: (target) => `Note ${target}`,
    pattern: /\[\[(notes\/[^\]\n]+)\]\]/g,
    trigger: "[[",
  },
  {
    kind: "task",
    label: (target) => `Task ${target}`,
    pattern: /\[\[((?:[A-Za-z0-9_./-]+\/)?tasks\/[^\]\n]+)\]\]/g,
    trigger: "[[",
  },
];

/** A `[[…]]` target as the file it names: `.md` is implied when omitted. */
function referencedFile(target: string): string {
  return /\.(?:md|markdown)$/i.test(target) ? target : `${target}.md`;
}

type CommitState =
  | { kind: "idle" }
  | { kind: "committing" }
  | { kind: "committed"; commitOid: string; amended: boolean }
  | { kind: "failed"; message: string };

/**
 * Notes: the files of a repo's notes/ folder, one plain editor at a time —
 * a list on the left, the shared collaborative editor on the right, and a
 * commit that happens by itself. Every keystroke is an ordinary workspace
 * edit (durable the moment it lands, visible to agents in that workspace);
 * after 30s of quiet, everything dirty under notes/ commits to the repo's
 * main as `Notes: <today>`. Same-day edits AMEND that commit rather than
 * stacking one commit per pause — unless someone else committed to the repo
 * in between, in which case an ordinary commit lands on top. The platform
 * decides that atomically (the workspace commit's `amendIfHead`); this page
 * only proposes the head it saw. The long-running log is the default note:
 * opening it appends today's `## YYYY-MM-DD` heading and puts the caret
 * under it.
 */
export function NotesPage({
  repoPath,
  note,
  onSelectNote,
}: {
  repoPath: string;
  /** The open note, repo-relative (notes/…). */
  note: string;
  onSelectNote: (note: string) => void;
}) {
  const lane = useCallback(
    <T,>(operation: (ws: TasksWorkspace) => PromiseLike<T>) =>
      // The stub is a capnweb Proxy; the local cast names the door.
      withProject((project) =>
        operation(
          (project as { notes(repoPath: string): unknown }).notes(repoPath) as TasksWorkspace,
        ),
      ),
    [repoPath],
  );
  const transport = useMemo<WorkspaceDocumentTransport>(
    () => ({
      run: (operation) => lane((ws) => operation(ws)),
      runOnce: (operation) =>
        withProjectOnce((project) =>
          operation(
            (project as { notes(repoPath: string): unknown }).notes(repoPath) as TasksWorkspace,
          ),
        ),
    }),
    [lane, repoPath],
  );

  const [notes, setNotes] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | undefined>();
  // Repo-relative paths with uncommitted edits (the platform's status is the
  // truth; a keystroke adds the open note optimistically).
  const [changes, setChanges] = useState<Set<string>>(() => new Set());
  const [dueAt, setDueAt] = useState<number>();
  const [commitState, setCommitState] = useState<CommitState>({ kind: "idle" });
  // The note whose file is confirmed to exist (the log gets today's
  // heading on the way in) — the editor mounts only for it.
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const editorApiRef = useRef<CollabEditorApi | null>(null);
  const committingRef = useRef(false);
  const navigate = useNavigate();
  // The `@` and `[[` completion sources. Agents load with the folder; task
  // files load the first time `[[` asks for them.
  const [agents, setAgents] = useState<{ path: string; title: string | null }[]>([]);
  const tasksRef = useRef<Promise<string[]> | null>(null);
  // The live text of the open note, for the watcher pill (frontmatter).
  const [liveSource, setLiveSource] = useState<string | null>(null);

  const refreshChanges = useCallback(async () => {
    const status = await lane((ws) => ws.status());
    const next = new Set(changeMap(status, repoPath).keys());
    setChanges(next);
    return next;
  }, [lane, repoPath]);

  // Seed: the folder listing, who is typing, and what is still uncommitted
  // (edits left behind by a closed tab get their timer here).
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      lane((ws) => ws.glob(`${NOTES_DIR}/**/*.md`)),
      refreshChanges(),
      withProject((project) => project.whoami()),
      withProject((project) => project.agents()).catch(() => []),
    ])
      .then(([paths, pending, user, agentList]) => {
        if (cancelled) return;
        setNotes(sortNotes(paths));
        setDisplayName(user.name ?? user.email ?? undefined);
        setAgents(agentList);
        if (pending.size > 0) setDueAt(Date.now() + NOTES_AUTO_COMMIT_MS);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [lane, refreshChanges]);

  // Opening a note: it must exist before the editor joins its session (no
  // lazy file create anywhere in the editor). The log is the one note the
  // app writes to on the way in — today's heading at the tail — and that
  // write alone never starts the commit timer: nothing commits until
  // something is actually written under it.
  useEffect(() => {
    let cancelled = false;
    setOpenNote(null);
    setNoteError(null);
    void lane(async (ws) => {
      const content = await ws.read(note);
      if (note === DEFAULT_NOTE) {
        const ensured = ensureTodayHeading(content, logDateStamp(new Date()));
        if (ensured !== content) {
          await ws.write(note, ensured);
          return { exists: true, wrote: true };
        }
        return { exists: true, wrote: false };
      }
      return { exists: content !== null, wrote: false };
    })
      .then(({ exists, wrote }) => {
        if (cancelled) return;
        if (!exists) {
          setNoteError(`${note} does not exist in ${repoPath}`);
          return;
        }
        if (wrote) {
          setChanges((current) => new Set(current).add(note));
          setNotes((current) =>
            current === null || current.includes(note) ? current : sortNotes([...current, note]),
          );
        }
        setOpenNote(note);
      })
      .catch((error: unknown) => {
        if (!cancelled) setNoteError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [lane, note, repoPath]);

  // The editor reports the opened text, then every change (debounced inside
  // the editor) — and the text again after a re-sync, notably right after a
  // commit re-baselines the session. Only text that DIFFERS from what was
  // last seen is an edit; a re-sync delivering the same bytes is not.
  const lastSeenRef = useRef<{ content: string; path: string } | null>(null);
  const onLiveContent = useCallback((path: string, content: string) => {
    const last = lastSeenRef.current;
    lastSeenRef.current = { content, path };
    setLiveSource(content);
    if (last === null || last.path !== path || last.content === content) return;
    setChanges((current) => (current.has(path) ? current : new Set(current).add(path)));
    setDueAt(Date.now() + NOTES_AUTO_COMMIT_MS);
    setCommitState((current) => (current.kind === "committing" ? current : { kind: "idle" }));
  }, []);

  const hasChanges = changes.size > 0;
  const commitNow = useCallback(async () => {
    if (committingRef.current || !hasChanges) return;
    committingRef.current = true;
    setDueAt(undefined);
    setCommitState({ kind: "committing" });
    try {
      // The last keystrokes must be in the session before the platform
      // settles it for the commit.
      await editorApiRef.current?.flushPending();
      const message = notesCommitMessage(logDateStamp(new Date()));
      const result = await lane(async (ws) => {
        const [head] = await ws.log(1);
        // The head is today's notes commit: propose replacing it. The
        // platform re-checks the head inside its serialized commit, so a
        // commit that lands in between simply turns this into a stack.
        const amendIfHead = head !== undefined && head.message === message ? head.oid : undefined;
        return ws.commit(message, amendIfHead === undefined ? {} : { amendIfHead });
      });
      await refreshChanges().catch(() => setChanges(new Set()));
      setCommitState({ amended: result.amended, commitOid: result.commitOid, kind: "committed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Nothing to commit/.test(message)) {
        // A commit from elsewhere carried the edits: nothing left to retry.
        setChanges(new Set());
        setCommitState({ kind: "idle" });
      } else {
        setCommitState({ kind: "failed", message: `commit failed: ${message}` });
        setDueAt(Date.now() + NOTES_AUTO_COMMIT_MS);
      }
    } finally {
      committingRef.current = false;
    }
  }, [hasChanges, lane, refreshChanges]);

  // The reference host the editor lights pills up with. ONE object per repo
  // (the editor rebuilds on identity change); it reads the live lists and
  // handlers through refs so completion and clicks always see the latest.
  const notesRef = useRef(notes);
  const agentsRef = useRef(agents);
  const onSelectNoteRef = useRef(onSelectNote);
  // Ref writes never happen during render — React may replay render work.
  useEffect(() => {
    notesRef.current = notes;
    agentsRef.current = agents;
    onSelectNoteRef.current = onSelectNote;
  }, [agents, notes, onSelectNote]);
  const references = useMemo<ReferenceHost>(
    () => ({
      complete: async (trigger, query) => {
        const needle = query.toLowerCase();
        if (trigger === "@") {
          return agentsRef.current
            .filter(
              (agent) =>
                agent.path.toLowerCase().includes(needle) ||
                (agent.title ?? "").toLowerCase().includes(needle),
            )
            .slice(0, 12)
            .map(
              (agent): ReferenceCandidate => ({
                detail: agent.title ?? undefined,
                insert: `@${agent.path} `,
                kind: "agent",
                label: agent.path,
              }),
            );
        }
        tasksRef.current ??= lane((ws) => ws.glob("**/tasks/**/*.md")).catch(() => []);
        const tasks = await tasksRef.current;
        const files = [...(notesRef.current ?? []), ...tasks];
        return files
          .filter((path) => path.toLowerCase().includes(needle))
          .slice(0, 12)
          .map(
            (path): ReferenceCandidate => ({
              detail: path.startsWith(`${NOTES_DIR}/`) ? "note" : "task",
              insert: `[[${path}]]`,
              kind: path.startsWith(`${NOTES_DIR}/`) ? "note" : "task",
              label: path.startsWith(`${NOTES_DIR}/`) ? noteLabel(path) : path,
            }),
          );
      },
      kinds: REFERENCE_KINDS,
      open: (reference: Reference) => {
        if (reference.kind === "agent") {
          void withProject((project) => project.agentUrl(reference.target)).then((url) =>
            window.open(url, "_blank", "noopener"),
          );
        } else if (reference.kind === "note") {
          onSelectNoteRef.current(referencedFile(reference.target));
        } else {
          void navigate({
            to: "/w",
            search: {
              group: "folder",
              q: "",
              repo: repoPath,
              task: referencedFile(reference.target),
              workspace: notesWorkspacePath(repoPath),
            },
          });
        }
      },
    }),
    [lane, navigate, repoPath],
  );

  // The `+` menu's insertions land at the caret of the open editor.
  const insertAtCaret = (text: string, completeAfter = false) => {
    const editor = editorApiRef.current;
    if (editor === null) return;
    editor.insert(text);
    if (completeAfter) editor.startCompletion();
  };
  const watcher =
    openNote === null || liveSource === null ? null : parseTaskCard(openNote, liveSource).agent;

  // One timer per due-at (the countdown ticks in its own leaf below); the
  // effect event reads the latest commitNow without re-arming the timer.
  const fireAutoCommit = useEffectEvent(() => void commitNow());
  useEffect(() => {
    if (dueAt === undefined) return;
    const timer = setTimeout(fireAutoCommit, Math.max(0, dueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [dueAt]);

  const createNote = async () => {
    const title = newTitle.trim();
    if (title === "") return;
    const path = noteFileName(title);
    setCreating(false);
    setNewTitle("");
    if (notes?.includes(path)) {
      onSelectNote(path);
      return;
    }
    try {
      await lane((ws) => ws.write(path, `# ${title}\n\n`));
      setNotes((current) => sortNotes([...(current ?? []), path]));
      setChanges((current) => new Set(current).add(path));
      setDueAt(Date.now() + NOTES_AUTO_COMMIT_MS);
      onSelectNote(path);
    } catch (error) {
      setCommitState({
        kind: "failed",
        message: `could not create ${path}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  if (loadError !== null) {
    return (
      <div className="mx-auto max-w-md p-8 text-sm text-muted-foreground">
        <SidebarTrigger className="mb-4 md:hidden" />
        <h1 className="mb-2 text-base font-semibold text-foreground">Could not open notes</h1>
        <p className="font-mono text-xs break-words text-red-700">{loadError}</p>
      </div>
    );
  }
  if (notes === null) {
    return (
      <div className="relative grid min-h-svh place-items-center bg-muted/20">
        <SidebarTrigger className="absolute top-3 left-3 md:hidden" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Opening notes…
        </div>
      </div>
    );
  }

  // div, not main: SidebarInset already renders the main landmark.
  return (
    <div className="flex min-h-svh flex-col bg-background lg:h-svh lg:overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-1 md:hidden" />
        <NotebookPenIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate font-mono text-xs">
          {repoPath}/{note}
        </h1>
        {watcher !== null ? (
          <span
            title={`${watcher} watches this note: it gets a message on every commit that changes it`}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            <EyeIcon aria-hidden className="size-3" />
            <span className="max-w-48 truncate">{watcher}</span>
          </span>
        ) : null}
        <InsertMenu
          agents={agents}
          disabled={openNote === null}
          onMentionAgent={() => insertAtCaret("@", true)}
          onLinkFile={() => insertAtCaret("[[", true)}
          onTodayHeading={() => insertAtCaret(`\n\n## ${logDateStamp(new Date())}\n\n`)}
          onNewNote={() => setCreating(true)}
          onWatchBy={(agentPath) =>
            editorApiRef.current?.applyTransform((source) => setTaskCardAgent(source, agentPath))
          }
        />
        <div className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          <CommitStatus
            pending={changes.size}
            dueAt={dueAt}
            state={commitState}
            onCommitNow={() => void commitNow()}
          />
        </div>
      </header>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="20%" minSize="10rem" className="flex min-w-0 flex-col">
          <NotesList
            notes={notes}
            selected={note}
            changes={changes}
            creating={creating}
            newTitle={newTitle}
            onSelect={onSelectNote}
            onStartCreate={() => setCreating(true)}
            onTitleChange={setNewTitle}
            onCancelCreate={() => {
              setCreating(false);
              setNewTitle("");
            }}
            onCreate={() => void createNote()}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel className="flex min-w-0 flex-col [&_.cm-editor]:h-full">
          {noteError !== null ? (
            <div className="grid flex-1 place-items-center p-6 text-sm text-muted-foreground">
              <p className="font-mono text-xs break-words text-red-700">{noteError}</p>
            </div>
          ) : openNote === null ? (
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Spinner className="size-4" /> Opening {noteLabel(note)}…
              </span>
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Spinner className="size-4" /> Connecting editor…
                  </span>
                </div>
              }
            >
              <WorkspaceDocumentEditor
                key={openNote}
                transport={transport}
                displayName={displayName}
                path={openNote}
                workspacePath={`${repoPath}/${openNote}`}
                mode="markdown"
                redline={false}
                emptyPlaceholder="Write…"
                focusHeadline={CARET_AT_END}
                apiRef={editorApiRef}
                references={references}
                onLiveContent={onLiveContent}
              />
            </Suspense>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

/**
 * The left panel: the folder's files, one row each, with the IDE's "name
 * the new file" row inlined at the top while a note is being created —
 * Enter creates, Escape (or leaving it empty) cancels.
 */
function NotesList({
  notes,
  selected,
  changes,
  creating,
  newTitle,
  onSelect,
  onStartCreate,
  onTitleChange,
  onCancelCreate,
  onCreate,
}: {
  notes: string[];
  selected: string;
  changes: Set<string>;
  creating: boolean;
  newTitle: string;
  onSelect: (note: string) => void;
  onStartCreate: () => void;
  onTitleChange: (title: string) => void;
  onCancelCreate: () => void;
  onCreate: () => void;
}) {
  const newTitleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (creating) newTitleRef.current?.focus();
  }, [creating]);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b px-2 py-1">
        <span className="text-xs font-medium text-muted-foreground">{NOTES_DIR}/</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          title="New note"
          aria-label="New note"
          onClick={onStartCreate}
        >
          <FilePlusIcon className="size-3.5" />
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {creating ? (
          <li className="px-2 py-0.5">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onCreate();
              }}
            >
              <Input
                ref={newTitleRef}
                value={newTitle}
                onChange={(event) => onTitleChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") onCancelCreate();
                }}
                onBlur={() => {
                  if (newTitle.trim() === "") onCancelCreate();
                }}
                placeholder="Note title, then Enter"
                aria-label="New note title"
                className="h-7 text-xs"
              />
            </form>
          </li>
        ) : null}
        {notes.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => onSelect(path)}
              aria-current={path === selected ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-accent/50",
                path === selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{noteLabel(path)}</span>
              {changes.has(path) ? (
                <span
                  aria-label="uncommitted"
                  title="Uncommitted"
                  className="size-1.5 shrink-0 rounded-full bg-amber-500"
                />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The `+` menu, the OS pill composer's shape: one quiet button, one menu.
 * Insert puts plain syntax at the caret (and opens completion where there is
 * something to pick); Enable writes a frontmatter key the note carries from
 * then on — here, the agent that watches it.
 */
function InsertMenu({
  agents,
  disabled,
  onMentionAgent,
  onLinkFile,
  onTodayHeading,
  onNewNote,
  onWatchBy,
}: {
  agents: { path: string; title: string | null }[];
  disabled: boolean;
  onMentionAgent: () => void;
  onLinkFile: () => void;
  onTodayHeading: () => void;
  onNewNote: () => void;
  onWatchBy: (agentPath: string) => void;
}) {
  // An item's action runs AFTER the menu has closed, not inside its click:
  // the insert actions move focus into the editor, and doing that mid-click
  // interrupts the menu's own close + focus-restore sequence (the menu stays
  // open and keeps the keyboard, so the completion the action opened never
  // sees a keystroke). One frame after close, the editor wins focus for good.
  const pendingRef = useRef<(() => void) | null>(null);
  const after = (action: () => void) => () => {
    pendingRef.current = action;
  };
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open || pendingRef.current === null) return;
        const action = pendingRef.current;
        pendingRef.current = null;
        requestAnimationFrame(action);
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="Insert"
            title="Insert"
            disabled={disabled}
          />
        }
      >
        <PlusIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {/* A label is a GROUP label in the menu primitive: it must sit inside
            a group, or the menu throws on open. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">Insert</DropdownMenuLabel>
          <DropdownMenuItem onClick={after(onMentionAgent)}>
            <AtSignIcon />
            <span>Mention an agent</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={after(onLinkFile)}>
            <Link2Icon />
            <span>Link a note or task</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={after(onTodayHeading)}>
            <CalendarPlusIcon />
            <span>Today&rsquo;s heading</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={after(onNewNote)}>
            <FilePlusIcon />
            <span>New note</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">Enable</DropdownMenuLabel>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <EyeIcon />
              <span>An agent watches this note</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-72 overflow-y-auto">
              {agents.length === 0 ? (
                <DropdownMenuItem disabled>No agents in this project yet</DropdownMenuItem>
              ) : (
                agents.map((agent) => (
                  <DropdownMenuItem key={agent.path} onClick={after(() => onWatchBy(agent.path))}>
                    <span className="min-w-0 truncate font-mono text-xs">{agent.path}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The log first, then the rest by name. */
function sortNotes(paths: string[]): string[] {
  return [...new Set(paths)].sort((left, right) =>
    left === DEFAULT_NOTE ? -1 : right === DEFAULT_NOTE ? 1 : left.localeCompare(right),
  );
}

/** The header's one line of commit truth, plus a way to skip the wait. */
function CommitStatus({
  pending,
  dueAt,
  state,
  onCommitNow,
}: {
  pending: number;
  dueAt: number | undefined;
  state: CommitState;
  onCommitNow: () => void;
}) {
  if (state.kind === "committing") return <span>Committing…</span>;
  if (state.kind === "failed") {
    return (
      <>
        <span className="max-w-72 truncate text-red-700" title={state.message}>
          {state.message}
        </span>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onCommitNow}>
          Retry
        </Button>
      </>
    );
  }
  if (pending > 0) {
    return (
      <>
        <span>
          Uncommitted{dueAt === undefined ? "" : " · commits in "}
          {dueAt === undefined ? null : <Countdown dueAt={dueAt} />}
        </span>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onCommitNow}>
          Commit now
        </Button>
      </>
    );
  }
  if (state.kind === "committed") {
    return (
      <span className="font-mono">
        {state.amended ? "amended" : "committed"} {state.commitOid.slice(0, 7)}
      </span>
    );
  }
  return <span>Up to date</span>;
}

/** Ticks in its own leaf so the page never re-renders on the clock. */
function Countdown({ dueAt }: { dueAt: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((dueAt - nowMs) / 1000));
  return <span className="tabular-nums">{secondsLeft <= 0 ? "…" : `${secondsLeft}s`}</span>;
}
