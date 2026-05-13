"use client";

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@iterate-com/ui/components/ai-elements/prompt-input";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { StreamEventType } from "@iterate-com/ui/components/events/stream-event-type";
import { CheckIcon, ListPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

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
  processorSlug?: string;
  eventType?: string;
  eventDescription?: string;
  eventDocsHref?: string;
  exampleName?: string;
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
              <RawPresetPicker
                presets={raw.presets}
                selectedPreset={selectedRawPreset}
                onSelectedPresetIdChange={raw.onSelectedPresetIdChange}
              />
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

function RawPresetPicker({
  presets,
  selectedPreset,
  onSelectedPresetIdChange,
}: {
  presets: readonly EventsStreamComposerRawPreset[];
  selectedPreset?: EventsStreamComposerRawPreset;
  onSelectedPresetIdChange?: (presetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const indexedPresets = useMemo(() => indexRawPresets(presets), [presets]);
  const filteredGroups = useMemo(
    () => groupRawPresetOptions(filterRawPresetOptions({ options: indexedPresets, filter })),
    [filter, indexedPresets],
  );

  const selectedOption = selectedPreset == null ? null : indexRawPreset(selectedPreset);

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2 text-xs"
          onClick={() => setOpen(true)}
        >
          <ListPlusIcon data-icon="inline-start" />
          Select example
        </Button>
        {selectedOption == null ? null : (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StreamEventType type={selectedOption.eventType} className="min-w-0 shrink truncate" />
            <span className="shrink-0">:</span>
            <span className="min-w-0 truncate">{selectedOption.exampleName}</span>
          </span>
        )}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(92vw,48rem)] data-[side=right]:sm:max-w-[min(92vw,48rem)]">
          <SheetHeader className="border-b px-4 py-3 pr-14">
            <SheetTitle>Select event example</SheetTitle>
            <SheetDescription>
              Choose an event template to load into the raw stream composer.
            </SheetDescription>
          </SheetHeader>
          <div className="border-b p-4">
            <Input
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder="Filter examples by raw event text..."
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {filteredGroups.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No event examples match.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {filteredGroups.map((group) => (
                  <section key={group.processorSlug} className="flex flex-col gap-2">
                    <h3 className="px-1 font-mono text-xs font-medium text-muted-foreground">
                      `{group.processorSlug}` processor
                    </h3>
                    <div className="flex flex-col gap-2">
                      {group.options.map((option) => (
                        <RawPresetTemplateCard
                          key={option.preset.id}
                          option={option}
                          selected={selectedPreset?.id === option.preset.id}
                          onUse={() => {
                            onSelectedPresetIdChange?.(option.preset.id);
                            setOpen(false);
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function RawPresetTemplateCard({
  option,
  selected,
  onUse,
}: {
  option: IndexedRawPresetOption;
  selected: boolean;
  onUse: () => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <StreamEventType
              type={option.eventType}
              href={option.eventDocsHref}
              className="min-w-0 shrink truncate"
            />
            <span className="shrink-0 text-muted-foreground">:</span>
            <span className="min-w-0 truncate text-sm font-medium">{option.exampleName}</span>
          </div>
          {option.eventDescription == null ? null : (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {option.eventDescription}
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant={selected ? "secondary" : "outline"}
          onClick={onUse}
        >
          {selected ? <CheckIcon data-icon="inline-start" /> : null}
          Use
        </Button>
      </div>
      {option.payloadPreview.length > 0 ? (
        <p className="mt-2 line-clamp-2 rounded bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-4 text-muted-foreground">
          {option.payloadPreview}
        </p>
      ) : null}
    </div>
  );
}

type IndexedRawPresetOption = {
  preset: EventsStreamComposerRawPreset;
  processorSlug: string;
  eventType: string;
  eventDescription?: string;
  eventDocsHref?: string;
  exampleName: string;
  payloadPreview: string;
  searchText: string;
};

function indexRawPresets(
  presets: readonly EventsStreamComposerRawPreset[],
): IndexedRawPresetOption[] {
  return presets.map(indexRawPreset);
}

function indexRawPreset(preset: EventsStreamComposerRawPreset): IndexedRawPresetOption {
  const eventType = preset.eventType ?? readYamlScalarLine({ yaml: preset.value, key: "type" });
  const processorSlug = preset.processorSlug ?? processorSlugFromEventType(eventType);
  const exampleName = preset.exampleName ?? preset.label;
  const payloadPreview = summarizeRawPresetValue(preset.value);

  return {
    preset,
    processorSlug,
    eventType,
    ...(preset.eventDescription == null ? {} : { eventDescription: preset.eventDescription }),
    ...(preset.eventDocsHref == null ? {} : { eventDocsHref: preset.eventDocsHref }),
    exampleName,
    payloadPreview,
    searchText: [
      preset.value,
      preset.label,
      processorSlug,
      eventType,
      exampleName,
      preset.eventDescription ?? "",
    ]
      .join("\n")
      .toLocaleLowerCase(),
  };
}

function filterRawPresetOptions(args: {
  options: readonly IndexedRawPresetOption[];
  filter: string;
}): IndexedRawPresetOption[] {
  const tokens = args.filter.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...args.options];

  return args.options.filter((option) =>
    tokens.every((token) => option.searchText.includes(token)),
  );
}

function groupRawPresetOptions(options: readonly IndexedRawPresetOption[]) {
  const groups = new Map<string, IndexedRawPresetOption[]>();
  for (const option of options) {
    const existing = groups.get(option.processorSlug);
    if (existing == null) {
      groups.set(option.processorSlug, [option]);
      continue;
    }

    existing.push(option);
  }

  return [...groups.entries()].map(([processorSlug, groupOptions]) => ({
    processorSlug,
    options: groupOptions,
  }));
}

function processorSlugFromEventType(eventType: string) {
  const withoutPrefix = eventType.replace(/^events\.iterate\.com\//, "");
  return withoutPrefix.split("/")[0] ?? "events";
}

function readYamlScalarLine(args: { yaml: string; key: string }) {
  const prefix = `${args.key}:`;
  const line = args.yaml.split("\n").find((candidate) => candidate.trimStart().startsWith(prefix));
  return line?.slice(line.indexOf(":") + 1).trim() || "events.iterate.com/unknown/event";
}

function summarizeRawPresetValue(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}
