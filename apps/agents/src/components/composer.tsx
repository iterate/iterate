// apps/os's pill composer, at this page's size: a `+` menu (Message / Raw event, and Attach files),
// the CodeMirror message editor that grows with the draft, a raw-event editor that appends YAML or
// JSON to the agent's log, attachment chips with drag-and-drop, and one round button that sends —
// or, while a turn runs, STOPS it (an interruption is a property of the person's next input).
import { useState, type DragEvent, type ReactNode } from "react";
import { parse as parseYaml } from "yaml";
import {
  ArrowUpIcon,
  FileCode2Icon,
  MessageSquareIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { CodeEditor } from "@iterate-com/ui/components/code-editor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "@iterate-com/ui/lib/utils";
import { AttachmentChips, AttachmentFileInput } from "./composer-attachments.tsx";
import { ComposerTextarea } from "./composer-textarea.tsx";
import { useComposerAttachments } from "./use-composer-attachments.ts";

export type AgentComposerMode = "message" | "raw";

type AgentComposerMessageConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
  attachments?: ReactNode;
  canSubmit: boolean;
  /** Open the file picker (the hidden input lives in the parent). */
  onAttach: () => void;
  /** Accept dropped or picked files (the same path as the picker). */
  onAddFiles: (files: FileList | null) => void;
  placeholder: string;
};

type AgentComposerRawConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
};

/** The pill itself — apps/os's `AgentPillComposer` without its examples mode. */
export function AgentPillComposer({
  mode,
  onModeChange,
  message,
  raw,
  disabled = false,
  isSubmitting = false,
  error,
  autoFocusMessage = false,
  isInterrupting = false,
  onInterrupt,
}: {
  mode: AgentComposerMode;
  onModeChange: (mode: AgentComposerMode) => void;
  message: AgentComposerMessageConfig;
  raw: AgentComposerRawConfig;
  disabled?: boolean;
  isSubmitting?: boolean;
  error?: string;
  autoFocusMessage?: boolean;
  isInterrupting?: boolean;
  onInterrupt?: () => Promise<void> | void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const canSubmit =
    !disabled &&
    !isSubmitting &&
    (mode === "message" ? message.canSubmit : raw.value.trim() !== "");
  const showInterrupt = mode === "message" && !!onInterrupt;
  const acceptsFileDrop = !isSubmitting;

  function submit() {
    if (!canSubmit) return;
    if (mode === "message") void message.onSubmit();
    else void raw.onSubmit();
  }

  function interrupt() {
    if (disabled || isSubmitting || isInterrupting || !onInterrupt) return;
    void onInterrupt();
  }

  // Always claim file drags (even while submitting): letting the browser take the drop would
  // navigate the tab to the dropped file.
  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (acceptsFileDrop) setIsDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = acceptsFileDrop ? "copy" : "none";
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsDragging(false);
    if (!acceptsFileDrop) return;
    if (mode !== "message") onModeChange("message");
    message.onAddFiles(event.dataTransfer.files);
  }

  return (
    <div className="w-full">
      {error ? (
        <p className="mb-2 ml-4 truncate font-mono text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-drop-active={isDragging ? "true" : undefined}
        className={cn(
          "flex items-end gap-2 rounded-3xl border bg-background py-2 pl-1.5 pr-2 shadow-sm transition-shadow",
          isDragging && "ring-2 ring-primary/40 border-primary/40",
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                title="Composer mode"
                className="rounded-full"
              />
            }
          >
            <PlusIcon className="size-4.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-60">
            <DropdownMenuRadioGroup
              value={mode}
              onValueChange={(value) => onModeChange(value === "raw" ? "raw" : "message")}
            >
              <DropdownMenuRadioItem value="message" closeOnClick>
                <MessageSquareIcon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col py-0.5">
                  <span className="font-medium">Message</span>
                  <span className="text-xs text-muted-foreground">Chat with this agent</span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="raw" closeOnClick>
                <FileCode2Icon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col py-0.5">
                  <span className="font-medium">Raw event</span>
                  <span className="text-xs text-muted-foreground">Append YAML or JSON</span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isSubmitting}
              onClick={() => {
                // Attachments belong to the message draft; leaving raw mode here keeps the picked
                // files visible.
                if (mode !== "message") onModeChange("message");
                message.onAttach();
              }}
            >
              <PaperclipIcon className="text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col py-0.5">
                <span className="font-medium">Attach files</span>
                <span className="text-xs text-muted-foreground">Send along with a message</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {mode === "raw" ? (
          <CodeEditor
            value={raw.value}
            onValueChange={raw.onValueChange}
            onSubmit={submit}
            focusOnMount
            placeholder={"type: events.iterate.com/notes/added\npayload:\n  text: hello"}
            className="min-w-0 flex-1 px-2 py-1.5"
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            {message.attachments ? <div className="px-1 pb-1">{message.attachments}</div> : null}
            <ComposerTextarea
              value={message.value}
              onValueChange={message.onValueChange}
              onSubmit={submit}
              focusOnMount={autoFocusMessage}
              placeholder={message.placeholder}
            />
          </div>
        )}

        <Button
          size="icon-lg"
          data-spinner={showInterrupt ? "true" : undefined}
          title={
            showInterrupt
              ? "Stop generation"
              : mode === "raw"
                ? "Append events (⌘↵)"
                : "Send message"
          }
          onClick={showInterrupt ? interrupt : submit}
          disabled={showInterrupt ? disabled || isSubmitting || isInterrupting : !canSubmit}
          className="relative overflow-hidden rounded-full"
        >
          {showInterrupt ? (
            <>
              <span
                aria-hidden
                className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary border-r-primary/40 animate-spin"
              />
              {isInterrupting ? (
                <Spinner className="size-4" />
              ) : (
                <SquareIcon className="size-3.5 fill-current" />
              )}
            </>
          ) : isSubmitting ? (
            <Spinner className="size-4" />
          ) : (
            <ArrowUpIcon className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

/** An in-flight turn's interrupt affordance, owned by the page (the queued-messages panel shows
 *  the same one). `error` surfaces in the composer's error line beside submit failures. */
export type StreamInterrupt = {
  run: () => Promise<void>;
  isInterrupting: boolean;
  error?: string;
};

/** A file as the agent's `message()` takes it: a data URL for `data`. */
export type OutgoingFile = { contentType: string; filename: string; data: string };

/** Browser files as the agent's `message()` takes them. */
function filesToPayload(files: readonly File[]): Promise<OutgoingFile[]> {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<OutgoingFile>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              contentType: file.type || "application/octet-stream",
              filename: file.name,
              data: String(reader.result),
            });
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }),
    ),
  );
}

/** The composer's state — mode, drafts, attachments, the submit error — around the pill; the page
 *  supplies only what a submit does and the running turn's interrupt. */
export function AgentComposer({
  onSubmit,
  onAppendRaw,
  interrupt,
  disabled = false,
  autoFocusMessage = false,
}: {
  onSubmit: (input: { message: string; files: OutgoingFile[] }) => Promise<void>;
  onAppendRaw: (events: unknown[]) => Promise<void>;
  /** Null while no turn is running. */
  interrupt: StreamInterrupt | null;
  disabled?: boolean;
  autoFocusMessage?: boolean;
}) {
  const [mode, setMode] = useState<AgentComposerMode>("message");
  const [message, setMessage] = useState("");
  const attachments = useComposerAttachments();
  const [rawText, setRawText] = useState(
    "type: events.iterate.com/notes/added\npayload:\n  text: Hello from the agents page\n",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  async function runSubmit(action: () => Promise<void>): Promise<boolean> {
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      await action();
      return true;
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitMessage() {
    const text = message.trim();
    if (text === "" && attachments.files.length === 0) return;
    const didSubmit = await runSubmit(async () =>
      onSubmit({
        message: text || "(see attached)",
        files: await filesToPayload(attachments.files),
      }),
    );
    if (didSubmit) {
      setMessage("");
      attachments.clearFiles();
    }
  }

  async function submitRawEvents() {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    await runSubmit(async () => {
      const parsed: unknown = parseYaml(trimmed);
      await onAppendRaw(Array.isArray(parsed) ? parsed : [parsed]);
    });
  }

  // File validation, submit, and interrupt failures have independent lifecycles, so none may
  // mask the others — show all active messages.
  const error =
    [attachments.fileError, submitError, interrupt?.error].filter(Boolean).join(" · ") || undefined;

  return (
    <>
      <AttachmentFileInput attachments={attachments} />
      <AgentPillComposer
        mode={mode}
        onModeChange={setMode}
        autoFocusMessage={autoFocusMessage}
        message={{
          value: message,
          onValueChange: setMessage,
          onSubmit: submitMessage,
          canSubmit: message.trim() !== "" || attachments.files.length > 0,
          attachments:
            attachments.entries.length === 0 ? undefined : (
              <AttachmentChips entries={attachments.entries} onRemove={attachments.removeFile} />
            ),
          onAttach: attachments.openFilePicker,
          onAddFiles: attachments.addFiles,
          placeholder: "Message this agent",
        }}
        raw={{ value: rawText, onValueChange: setRawText, onSubmit: submitRawEvents }}
        isSubmitting={isSubmitting}
        disabled={disabled}
        error={error}
        isInterrupting={interrupt?.isInterrupting}
        onInterrupt={interrupt?.run}
      />
    </>
  );
}
