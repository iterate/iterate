import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  ArrowUpIcon,
  FileCode2Icon,
  MessageSquareIcon,
  PaperclipIcon,
  PlusIcon,
  SparklesIcon,
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
import { ComposerTextarea } from "~/components/composer-textarea.tsx";
import type { ComposerSuggestionProvider } from "~/components/composer-suggestions.ts";

export type AgentComposerMode = "message" | "raw" | "examples";

type AgentComposerMessageConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
  attachments?: ReactNode;
  canSubmit?: boolean;
  /** Open the file picker (hidden input lives in the parent). */
  onAttach?: () => void;
  /** Accept dropped/selected files (same path as the file picker). */
  onAddFiles?: (files: FileList | null) => void;
  placeholder?: string;
  suggestionProviders?: readonly ComposerSuggestionProvider[];
};

type AgentComposerRawConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
};

/**
 * The quiet pill composer: a `+` button opens the mode menu (Message / Raw
 * event) plus the attach-files action, the textarea grows with content, and a
 * single round send button submits. Attachment lives INSIDE the `+` menu — a
 * second icon button next to the textarea left too little typing room on
 * phones. Raw mode accepts YAML or JSON — the parser handles both, so there
 * is deliberately no format toggle.
 */
export function AgentPillComposer({
  mode,
  onModeChange,
  message,
  raw,
  examples,
  disabled = false,
  isSubmitting = false,
  error,
  autoFocusMessage = false,
  isInterrupting = false,
  onInterrupt,
}: {
  mode: AgentComposerMode;
  onModeChange: (mode: AgentComposerMode) => void;
  message?: AgentComposerMessageConfig;
  /** Omit for a message-only composer: no mode menu, attach becomes a direct button. */
  raw?: AgentComposerRawConfig;
  /** The example picker rendered as the composer body in "examples" mode. */
  examples?: ReactNode;
  disabled?: boolean;
  isSubmitting?: boolean;
  error?: string;
  autoFocusMessage?: boolean;
  isInterrupting?: boolean;
  onInterrupt?: () => Promise<void> | void;
}) {
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Clamp to a mode the supplied configs can actually render.
  const activeMode: AgentComposerMode =
    mode === "message" && message == null
      ? "raw"
      : mode !== "message" && raw == null
        ? "message"
        : mode;
  const isExamples = activeMode === "examples";
  const canSubmit =
    !disabled &&
    !isSubmitting &&
    !isExamples &&
    (activeMode === "message"
      ? (message?.canSubmit ?? (message?.value.trim() ?? "") !== "")
      : (raw?.value.trim() ?? "") !== "");
  const showInterrupt = activeMode === "message" && onInterrupt != null;
  const acceptsFileDrop = message?.onAddFiles != null && !isSubmitting;

  useEffect(() => {
    if (autoFocusMessage && activeMode === "message") messageRef.current?.focus();
  }, [activeMode, autoFocusMessage]);

  function submit() {
    if (!canSubmit) return;
    if (activeMode === "message") void message?.onSubmit();
    else void raw?.onSubmit();
  }

  function interrupt() {
    if (disabled || isSubmitting || isInterrupting || onInterrupt == null) return;
    void onInterrupt();
  }

  // Always claim file drags (even while submitting): letting the browser take
  // the drop would navigate the tab to the dropped file.
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
    if (activeMode !== "message") onModeChange("message");
    message?.onAddFiles?.(event.dataTransfer.files);
  }

  return (
    <div className="w-full">
      {error == null ? null : (
        <p className="mb-2 ml-4 truncate font-mono text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-drop-active={isDragging ? "true" : undefined}
        className={cn(
          "flex gap-2 rounded-3xl border bg-background py-2 pl-1.5 pr-2 shadow-sm transition-shadow",
          isExamples ? "items-start" : "items-end",
          isDragging && "ring-2 ring-primary/40 border-primary/40",
        )}
      >
        {raw == null ? (
          message?.onAttach == null ? null : (
            <Button
              variant="ghost"
              size="icon-lg"
              title="Attach files"
              className="rounded-full"
              disabled={isSubmitting}
              onClick={() => message.onAttach?.()}
            >
              <PaperclipIcon className="size-4.5" />
            </Button>
          )
        ) : (
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
                value={activeMode}
                onValueChange={(value) => onModeChange(value as AgentComposerMode)}
              >
                <DropdownMenuRadioItem value="message" closeOnClick disabled={message == null}>
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
                {examples == null ? null : (
                  <DropdownMenuRadioItem value="examples" closeOnClick>
                    <SparklesIcon className="text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col py-0.5">
                      <span className="font-medium">Examples</span>
                      <span className="text-xs text-muted-foreground">
                        From processor contracts
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                )}
              </DropdownMenuRadioGroup>
              {message?.onAttach == null ? null : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isSubmitting}
                    onClick={() => {
                      // Attachments belong to the message draft; leaving raw or
                      // examples mode here keeps the picked files visible.
                      if (activeMode !== "message") onModeChange("message");
                      message.onAttach?.();
                    }}
                  >
                    <PaperclipIcon className="text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col py-0.5">
                      <span className="font-medium">Attach files</span>
                      <span className="text-xs text-muted-foreground">
                        Send along with a message
                      </span>
                    </span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {isExamples ? (
          <div className="max-h-80 min-w-0 flex-1 overflow-y-auto px-2 py-1">{examples}</div>
        ) : activeMode === "raw" && raw != null ? (
          <CodeEditor
            value={raw.value}
            onValueChange={raw.onValueChange}
            onSubmit={submit}
            focusOnMount
            placeholder={"type: events.iterate.com/os/manual-event\npayload:\n  message: hello"}
            className="min-w-0 flex-1 px-2 py-1.5"
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            {message?.attachments == null ? null : (
              <div className="px-1 pb-1">{message.attachments}</div>
            )}
            <ComposerTextarea
              value={message?.value ?? ""}
              onValueChange={(value) => message?.onValueChange(value)}
              onSubmit={submit}
              textareaRef={messageRef}
              placeholder={message?.placeholder ?? "Message this stream"}
              providers={message?.suggestionProviders}
            />
          </div>
        )}

        {isExamples ? null : (
          <Button
            size="icon-lg"
            title={
              showInterrupt
                ? "Stop generation"
                : activeMode === "raw"
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
        )}
      </div>
    </div>
  );
}
