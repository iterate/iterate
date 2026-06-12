import { ArrowUpIcon, FileCode2Icon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Spinner } from "@iterate-com/ui/components/spinner";

export type AgentComposerMode = "message" | "raw";

export type AgentComposerMessageConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
  placeholder?: string;
};

export type AgentComposerRawConfig = {
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
  isSubmitting = false,
  error,
}: {
  mode: AgentComposerMode;
  onModeChange: (mode: AgentComposerMode) => void;
  message?: AgentComposerMessageConfig;
  raw: AgentComposerRawConfig;
  isSubmitting?: boolean;
  error?: string;
}) {
  const activeMode: AgentComposerMode = mode === "message" && message == null ? "raw" : mode;
  const canSubmit =
    !isSubmitting &&
    (activeMode === "message" ? (message?.value.trim() ?? "") !== "" : raw.value.trim() !== "");

  function submit() {
    if (!canSubmit) return;
    if (activeMode === "message") void message?.onSubmit();
    else void raw.onSubmit();
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {error == null ? null : (
        <p className="mb-2 ml-4 truncate font-mono text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2 rounded-3xl border bg-background py-2 pl-1.5 pr-2 shadow-sm">
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
              <DropdownMenuRadioItem value="message" disabled={message == null}>
                <MessageSquareIcon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col py-0.5">
                  <span className="font-medium">Message</span>
                  <span className="text-xs text-muted-foreground">Chat with this agent</span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="raw">
                <FileCode2Icon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col py-0.5">
                  <span className="font-medium">Raw event</span>
                  <span className="text-xs text-muted-foreground">
                    Append YAML or JSON events directly
                  </span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {activeMode === "raw" ? (
          <textarea
            value={raw.value}
            onChange={(event) => raw.onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            rows={6}
            spellCheck={false}
            placeholder={"type: events.iterate.com/os/manual-event\npayload:\n  message: hello"}
            className="min-w-0 flex-1 resize-y bg-transparent px-2 py-1.5 font-mono text-xs leading-relaxed outline-none"
          />
        ) : (
          <textarea
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

        <Button
          size="icon-lg"
          title={activeMode === "raw" ? "Append events (⌘↵)" : "Send message"}
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-full"
        >
          {isSubmitting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
