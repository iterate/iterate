// Shared form for the two agent-setup surfaces: "new agent" (appends setup
// events to one agent stream) and "new preset" (saves setup events for a path
// prefix). The pages own path normalization, preview building, and the submit
// mutation; this component owns the field state and layout.

import { useMemo, useState, type ReactNode } from "react";
import type { EventInput } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Textarea } from "@iterate-com/ui/components/textarea";
import {
  type AgentLlmProvider,
  DEFAULT_AGENT_LLM_PROVIDER,
  DEFAULT_CLOUDFLARE_AGENT_MODEL,
  DEFAULT_OPENAI_AGENT_MODEL,
  defaultAgentSystemPrompt,
} from "~/domains/agents/agent-presets.ts";

const emptyEventsYaml = "[]\n";

export type AgentSetupFormValues = {
  customEventsYaml: string;
  model: string;
  pathInput: string;
  provider: AgentLlmProvider;
  runOpts: string;
  systemPrompt: string;
};

export function AgentSetupFormPage<
  Preview extends { error?: string; events: EventInput[] },
>(props: {
  buildPreview: (values: AgentSetupFormValues) => Preview;
  customEventsDescription: string;
  description: string;
  idPrefix: string;
  initialPathInput: string;
  isPending: boolean;
  onSubmit: (input: { preview: Preview; values: AgentSetupFormValues }) => void;
  pathLabel: string;
  pathPlaceholder: string;
  previewDescription: (preview: Preview) => string;
  previewTitle: string;
  submitIcon: ReactNode;
  submitIdleLabel: string;
  submitPendingLabel: string;
  title: string;
}) {
  const [pathInput, setPathInput] = useState(props.initialPathInput);
  const [provider, setProvider] = useState<AgentLlmProvider>(DEFAULT_AGENT_LLM_PROVIDER);
  const [model, setModel] = useState(DEFAULT_OPENAI_AGENT_MODEL);
  const [runOpts, setRunOpts] = useState('{"gateway":{"id":"default"}}');
  const [systemPrompt, setSystemPrompt] = useState(defaultAgentSystemPrompt());
  const [customEventsYaml, setCustomEventsYaml] = useState(emptyEventsYaml);

  const { buildPreview } = props;
  const values = useMemo<AgentSetupFormValues>(
    () => ({ customEventsYaml, model, pathInput, provider, runOpts, systemPrompt }),
    [customEventsYaml, model, pathInput, provider, runOpts, systemPrompt],
  );
  const preview = useMemo(() => buildPreview(values), [buildPreview, values]);

  function selectProvider(nextProvider: AgentLlmProvider) {
    setProvider(nextProvider);
    setModel((current) => {
      if (nextProvider === "openai-ws" && current === DEFAULT_CLOUDFLARE_AGENT_MODEL) {
        return DEFAULT_OPENAI_AGENT_MODEL;
      }
      if (nextProvider === "cloudflare-ai" && current === DEFAULT_OPENAI_AGENT_MODEL) {
        return DEFAULT_CLOUDFLARE_AGENT_MODEL;
      }
      return current;
    });
  }

  return (
    <section className="w-full max-w-7xl space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{props.title}</h2>
        <p className="text-sm text-muted-foreground">{props.description}</p>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(440px,1.05fr)]">
        <div className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${props.idPrefix}-path`}>{props.pathLabel}</FieldLabel>
              <Input
                id={`${props.idPrefix}-path`}
                value={pathInput}
                onChange={(event) => setPathInput(event.currentTarget.value)}
                placeholder={props.pathPlaceholder}
              />
            </Field>

            <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
              <Field>
                <FieldLabel htmlFor={`${props.idPrefix}-provider`}>Provider</FieldLabel>
                <NativeSelect
                  id={`${props.idPrefix}-provider`}
                  value={provider}
                  onChange={(event) =>
                    selectProvider(event.currentTarget.value as AgentLlmProvider)
                  }
                >
                  <NativeSelectOption value="openai-ws">OpenAI WebSocket</NativeSelectOption>
                  <NativeSelectOption value="cloudflare-ai">
                    Cloudflare AI Gateway
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${props.idPrefix}-model`}>Model</FieldLabel>
                <Input
                  id={`${props.idPrefix}-model`}
                  value={model}
                  onChange={(event) => setModel(event.currentTarget.value)}
                />
              </Field>
            </div>

            {provider === "cloudflare-ai" ? (
              <Field>
                <FieldLabel htmlFor={`${props.idPrefix}-run-opts`}>Run options JSON</FieldLabel>
                <Textarea
                  id={`${props.idPrefix}-run-opts`}
                  className="min-h-20 font-mono text-xs"
                  value={runOpts}
                  onChange={(event) => setRunOpts(event.currentTarget.value)}
                />
              </Field>
            ) : null}

            <Field>
              <FieldLabel htmlFor={`${props.idPrefix}-system-prompt`}>System prompt</FieldLabel>
              <Textarea
                id={`${props.idPrefix}-system-prompt`}
                className="min-h-32 font-mono text-xs"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.currentTarget.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`${props.idPrefix}-custom-events`}>Custom events</FieldLabel>
              <SourceCodeBlock
                code={customEventsYaml}
                className="min-h-44"
                editable
                language="yaml"
                onChange={setCustomEventsYaml}
              />
              <FieldDescription>{props.customEventsDescription}</FieldDescription>
            </Field>
          </FieldGroup>
        </div>

        <aside className="min-h-[42rem] space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold">{props.previewTitle}</p>
              <p className="text-sm text-muted-foreground">{props.previewDescription(preview)}</p>
            </div>
            <Button
              onClick={() => props.onSubmit({ preview, values })}
              disabled={props.isPending || preview.error != null}
            >
              {props.submitIcon}
              {props.isPending ? props.submitPendingLabel : props.submitIdleLabel}
            </Button>
          </div>

          {preview.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {preview.error}
            </div>
          ) : (
            <SerializedObjectCodeBlock
              data={preview.events}
              className="h-[42rem]"
              initialFormat="yaml"
              showToggle
            />
          )}
        </aside>
      </div>
    </section>
  );
}
