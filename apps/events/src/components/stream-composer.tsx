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
import { Button } from "@iterate-com/ui/components/button";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { eventInputTemplates, getEventInputTemplateById } from "~/lib/event-type-pages.ts";
import type { StreamComposerMode } from "~/lib/stream-view-search.ts";

/**
 * App-owned composer for appending stream events.
 *
 * The package-level stream layout owns where the message input region lives.
 * This component owns the Events app's current composer controls: raw JSON/YAML
 * append modes plus the agent-message mode that the reduced input slot can
 * prefill.
 */
export function StreamComposer({
  composerMode,
  onComposerModeChange,
  selectedTemplateId,
  onSelectedTemplateIdChange,
  agentInputText,
  onAgentInputTextChange,
  appendInputJson,
  onAppendInputJsonChange,
  appendInputYaml,
  onAppendInputYamlChange,
  isSubmitting,
  onSubmit,
  onDebugInfoRequest,
}: {
  composerMode: StreamComposerMode;
  onComposerModeChange?: (mode: StreamComposerMode) => void;
  selectedTemplateId: string;
  onSelectedTemplateIdChange: (templateId: string) => void;
  agentInputText: string;
  onAgentInputTextChange: (text: string) => void;
  appendInputJson: string;
  onAppendInputJsonChange: (text: string) => void;
  appendInputYaml: string;
  onAppendInputYamlChange: (text: string) => void;
  isSubmitting: boolean;
  onSubmit: () => void | Promise<void>;
  onDebugInfoRequest: () => void | Promise<void>;
}) {
  return (
    <PromptInput className="relative w-full" onSubmit={onSubmit}>
      <PromptInputBody>
        {composerMode === "agent" ? (
          <PromptInputTextarea
            value={agentInputText}
            onChange={(event) => onAgentInputTextChange(event.currentTarget.value)}
            placeholder="Message this agent"
            className="min-h-11 max-h-[45vh] text-sm leading-5"
          />
        ) : composerMode === "yaml" ? (
          <SourceCodeBlock
            code={appendInputYaml}
            language="yaml"
            editable
            onChange={onAppendInputYamlChange}
            onModEnter={onSubmit}
            showCopyButton={false}
            className="w-full max-h-[45vh]"
          />
        ) : (
          <SourceCodeBlock
            code={appendInputJson}
            language="json"
            editable
            onChange={onAppendInputJsonChange}
            onModEnter={onSubmit}
            showCopyButton={false}
            className="w-full max-h-[45vh]"
          />
        )}
      </PromptInputBody>
      <PromptInputFooter className="items-center justify-between gap-2 border-t p-2.5">
        <PromptInputTools className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Tabs
              value={composerMode}
              onValueChange={(value) => onComposerModeChange?.(value as StreamComposerMode)}
            >
              <TabsList className="h-8">
                <TabsTrigger value="json" className="px-2 text-xs">
                  JSON
                </TabsTrigger>
                <TabsTrigger value="yaml" className="px-2 text-xs">
                  YAML
                </TabsTrigger>
                <TabsTrigger value="agent" className="px-2 text-xs">
                  Agent
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {composerMode !== "agent" ? (
              <PromptInputSelect
                value={selectedTemplateId}
                onValueChange={(value) => {
                  onSelectedTemplateIdChange(value as string);
                }}
              >
                <PromptInputSelectTrigger className="h-8 max-w-full min-w-0 text-xs sm:max-w-[18rem]">
                  <span className="truncate">
                    {getEventInputTemplateById(selectedTemplateId)?.label ?? "Event template"}
                  </span>
                </PromptInputSelectTrigger>
                <PromptInputSelectContent align="start" className="w-fit">
                  {eventInputTemplates.map((template) => (
                    <PromptInputSelectItem key={template.id} value={template.id}>
                      {template.label}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-xs"
                disabled={isSubmitting}
                onClick={() => {
                  void onDebugInfoRequest();
                }}
              >
                Debug info
              </Button>
            )}
          </div>
        </PromptInputTools>
        <PromptInputSubmit
          className="shrink-0"
          disabled={
            isSubmitting ||
            (composerMode === "agent"
              ? !agentInputText.trim()
              : composerMode === "yaml"
                ? !appendInputYaml.trim()
                : !appendInputJson.trim())
          }
          status={isSubmitting ? "submitted" : "ready"}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}
