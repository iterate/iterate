import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@iterate-com/ui/components/ai-elements/prompt-input";

/**
 * Minimal stream composer for hosts that only need to append one user message.
 *
 * The events app keeps its richer JSON/YAML/template composer locally. This
 * package component is intentionally just the shared chat affordance.
 */
export function EventsStreamComposer({
  value,
  onValueChange,
  onSubmit,
  isSubmitting = false,
  placeholder = "Message this stream",
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  isSubmitting?: boolean;
  placeholder?: string;
}) {
  return (
    <PromptInput className="relative w-full" onSubmit={onSubmit}>
      <PromptInputBody>
        <PromptInputTextarea
          value={value}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          placeholder={placeholder}
          className="min-h-11 max-h-[35vh] text-sm leading-5"
        />
      </PromptInputBody>
      <PromptInputFooter className="justify-end border-t p-2.5">
        <PromptInputSubmit
          disabled={isSubmitting || value.trim().length === 0}
          onClick={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
          status={isSubmitting ? "submitted" : "ready"}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}
