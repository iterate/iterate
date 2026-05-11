import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@iterate-com/ui/components/ai-elements/prompt-input";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";

/**
 * Minimal stream composer for hosts that need message and/or raw event input.
 *
 * The events app keeps its richer JSON/YAML/template composer locally. This
 * package component is intentionally a controlled, lightweight shared affordance.
 */
export type EventsStreamComposerMode = "message" | "raw";

export type EventsStreamComposerRawPreset = {
  id: string;
  label: string;
  value: string;
};

export type EventsStreamComposerMessageConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  placeholder?: string;
};

export type EventsStreamComposerRawConfig = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  presets?: readonly EventsStreamComposerRawPreset[];
  selectedPresetId?: string;
  onSelectedPresetIdChange?: (presetId: string) => void;
};

export function EventsStreamComposer({
  mode,
  onModeChange,
  message,
  raw,
  isSubmitting = false,
}: {
  mode: EventsStreamComposerMode;
  onModeChange?: (mode: EventsStreamComposerMode) => void;
  message?: EventsStreamComposerMessageConfig;
  raw?: EventsStreamComposerRawConfig;
  isSubmitting?: boolean;
}) {
  const availableModes = [
    ...(message == null ? [] : (["message"] satisfies EventsStreamComposerMode[])),
    ...(raw == null ? [] : (["raw"] satisfies EventsStreamComposerMode[])),
  ];
  const activeMode = availableModes.includes(mode) ? mode : availableModes[0];
  const selectedRawPreset =
    raw?.presets?.find((preset) => preset.id === raw.selectedPresetId) ?? raw?.presets?.[0];
  const activeValue = activeMode === "raw" ? raw?.value : message?.value;
  const activeSubmit = activeMode === "raw" ? raw?.onSubmit : message?.onSubmit;

  if (activeMode == null || activeSubmit == null || activeValue == null) {
    return null;
  }

  const submit = () => {
    void activeSubmit();
  };

  return (
    <PromptInput className="relative w-full" onSubmit={submit}>
      <PromptInputBody>
        {activeMode === "raw" && raw != null ? (
          <SourceCodeBlock
            code={raw.value}
            language="yaml"
            editable
            onChange={raw.onValueChange}
            onModEnter={raw.onSubmit}
            showCopyButton={false}
            className="min-h-36 max-h-[35vh] w-full"
          />
        ) : message != null ? (
          <PromptInputTextarea
            value={message.value}
            onChange={(event) => message.onValueChange(event.currentTarget.value)}
            placeholder={message.placeholder ?? "Message this stream"}
            className="min-h-11 max-h-[35vh] text-sm leading-5"
          />
        ) : null}
      </PromptInputBody>
      <PromptInputFooter className="items-center justify-between gap-2 border-t p-2.5">
        <PromptInputTools className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {availableModes.length > 1 ? (
              <Tabs
                value={activeMode}
                onValueChange={(value) => onModeChange?.(value as EventsStreamComposerMode)}
              >
                <TabsList className="h-8">
                  <TabsTrigger value="message" className="px-2 text-xs">
                    Message
                  </TabsTrigger>
                  <TabsTrigger value="raw" className="px-2 text-xs">
                    Raw
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}

            {activeMode === "raw" && raw?.presets != null && raw.presets.length > 0 ? (
              <PromptInputSelect
                value={selectedRawPreset?.id}
                onValueChange={(value) => raw.onSelectedPresetIdChange?.(value as string)}
              >
                <PromptInputSelectTrigger className="h-8 max-w-full min-w-0 text-xs sm:max-w-[18rem]">
                  <span className="truncate">{selectedRawPreset?.label ?? "Event preset"}</span>
                </PromptInputSelectTrigger>
                <PromptInputSelectContent align="start" className="w-fit">
                  {raw.presets.map((preset) => (
                    <PromptInputSelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            ) : null}
          </div>
        </PromptInputTools>
        <PromptInputSubmit
          className="shrink-0"
          disabled={isSubmitting || activeValue.trim().length === 0}
          onClick={(event) => {
            event.preventDefault();
            submit();
          }}
          status={isSubmitting ? "submitted" : "ready"}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}
