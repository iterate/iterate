import { CheckIcon, ArrowUpIcon, FileCode2Icon, MessageSquareIcon, PlusIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "@iterate-com/ui/lib/utils";

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
      <div
        className={cn(
          "flex items-end gap-2 bg-background py-2 pl-1.5 pr-2",
          "shadow-[0_0_0_1px_var(--border),0_4px_16px_rgba(24,24,27,0.06)]",
          activeMode === "raw" ? "rounded-3xl" : "rounded-[26px]",
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                title="Composer mode"
                className="grid size-9 shrink-0 place-items-center rounded-full text-foreground hover:bg-muted"
              />
            }
          >
            <PlusIcon className="size-4.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-60">
            <DropdownMenuItem
              disabled={message == null}
              onClick={() => onModeChange("message")}
              className="items-start gap-2.5"
            >
              <MessageSquareIcon className="mt-0.5 size-4 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium">Message</span>
                <span className="text-[11px] text-muted-foreground">Chat with this agent</span>
              </span>
              {activeMode === "message" ? (
                <CheckIcon className="size-3.5 text-emerald-600" />
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onModeChange("raw")} className="items-start gap-2.5">
              <FileCode2Icon className="mt-0.5 size-4 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium">Raw event</span>
                <span className="text-[11px] text-muted-foreground">
                  Append YAML or JSON events directly
                </span>
              </span>
              {activeMode === "raw" ? <CheckIcon className="size-3.5 text-emerald-600" /> : null}
            </DropdownMenuItem>
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
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={message?.placeholder ?? "Message this stream"}
            className="field-sizing-content max-h-32 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-snug outline-none"
          />
        )}

        <button
          type="button"
          title={activeMode === "raw" ? "Append events (⌘↵)" : "Send message"}
          onClick={submit}
          disabled={!canSubmit}
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity",
            canSubmit ? "hover:opacity-80" : "opacity-30",
          )}
        >
          {isSubmitting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
        </button>
      </div>
    </div>
  );
}
