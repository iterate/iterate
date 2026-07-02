import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowUpIcon,
  FileCode2Icon,
  MessageSquareIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { CodeEditor } from "@iterate-com/ui/components/code-editor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "@iterate-com/ui/lib/utils";

export type AgentComposerMode = "message" | "raw" | "examples";

type AgentComposerMessageConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
  placeholder?: string;
};

type AgentComposerRawConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
};

/**
 * The quiet pill composer: a `+` button opens the mode menu (Message / Raw
 * event), the textarea grows with content, and a single round send button
 * submits. Raw mode accepts YAML or JSON — the parser handles both, so there
 * is deliberately no format toggle.
 */
export function AgentPillComposer({
  mode,
  onModeChange,
  message,
  raw,
  examples,
  isSubmitting = false,
  error,
  autoFocusMessage = false,
  isInterrupting = false,
  onInterrupt,
}: {
  mode: AgentComposerMode;
  onModeChange: (mode: AgentComposerMode) => void;
  message?: AgentComposerMessageConfig;
  raw: AgentComposerRawConfig;
  /** The example picker rendered as the composer body in "examples" mode. */
  examples?: ReactNode;
  isSubmitting?: boolean;
  error?: string;
  autoFocusMessage?: boolean;
  isInterrupting?: boolean;
  onInterrupt?: () => Promise<void> | void;
}) {
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const activeMode: AgentComposerMode = mode === "message" && message == null ? "raw" : mode;
  const isExamples = activeMode === "examples";
  const canSubmit =
    !isSubmitting &&
    !isExamples &&
    (activeMode === "message" ? (message?.value.trim() ?? "") !== "" : raw.value.trim() !== "");
  const showInterrupt = activeMode === "message" && onInterrupt != null;

  useEffect(() => {
    if (autoFocusMessage && activeMode === "message") messageRef.current?.focus();
  }, [activeMode, autoFocusMessage]);

  function submit() {
    if (!canSubmit) return;
    if (activeMode === "message") void message?.onSubmit();
    else void raw.onSubmit();
  }

  function interrupt() {
    if (isSubmitting || isInterrupting || onInterrupt == null) return;
    void onInterrupt();
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {error == null ? null : (
        <p className="mb-2 ml-4 truncate font-mono text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div
        className={cn(
          "flex gap-2 rounded-3xl border bg-background py-2 pl-1.5 pr-2 shadow-sm",
          isExamples ? "items-start" : "items-end",
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
              <DropdownMenuRadioItem value="examples" closeOnClick>
                <SparklesIcon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col py-0.5">
                  <span className="font-medium">Examples</span>
                  <span className="text-xs text-muted-foreground">From processor contracts</span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {isExamples ? (
          <div className="max-h-80 min-w-0 flex-1 overflow-y-auto px-2 py-1">{examples}</div>
        ) : activeMode === "raw" ? (
          <CodeEditor
            value={raw.value}
            onValueChange={raw.onValueChange}
            onSubmit={submit}
            focusOnMount
            placeholder={"type: events.iterate.com/os/manual-event\npayload:\n  message: hello"}
            className="min-w-0 flex-1 px-2 py-1.5"
          />
        ) : (
          <textarea
            ref={messageRef}
            value={message?.value ?? ""}
            onChange={(event) => message?.onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={message?.placeholder ?? "Message this stream"}
            className="field-sizing-content max-h-32 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-snug outline-none"
          />
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
            disabled={showInterrupt ? isSubmitting || isInterrupting : !canSubmit}
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
