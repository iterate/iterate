import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { toast } from "@iterate-com/ui/components/sonner";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Textarea } from "@iterate-com/ui/components/textarea";
import {
  type AgentLlmProvider,
  DEFAULT_AGENT_LLM_PROVIDER,
  DEFAULT_CLOUDFLARE_AGENT_MODEL,
  DEFAULT_OPENAI_AGENT_MODEL,
  configuredAgentSetupEvents,
  defaultAgentSystemPrompt,
  parseAgentEventInputsYaml,
  parseAgentRunOptsJson,
} from "~/domains/agents/agent-presets.ts";
import {
  agentProcessorSubscriptionConfiguredEvents,
  defaultAgentProcessorSlugs,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import { agentPathFromInput } from "~/lib/agent-links.ts";
import { orpcClient } from "~/orpc/client.ts";

const emptyEventsYaml = "[]\n";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/new")({
  loader: async ({ context }) => {
    const { project } = context;

    return {
      breadcrumb: "New Agent",
      project,
    };
  },
  component: NewAgentPage,
});

function NewAgentPage() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const navigate = useNavigate();
  const [agentPathInput, setAgentPathInput] = useState("/agents/assistant");
  const [provider, setProvider] = useState<AgentLlmProvider>(DEFAULT_AGENT_LLM_PROVIDER);
  const [model, setModel] = useState(DEFAULT_OPENAI_AGENT_MODEL);
  const [runOpts, setRunOpts] = useState('{"gateway":{"id":"default"}}');
  const [systemPrompt, setSystemPrompt] = useState(defaultAgentSystemPrompt());
  const [customEventsYaml, setCustomEventsYaml] = useState(emptyEventsYaml);

  const preview = useMemo(
    () =>
      buildPreviewEvents({
        agentPathInput,
        customEventsYaml,
        model,
        projectId: project.id,
        provider,
        runOpts,
        systemPrompt,
      }),
    [agentPathInput, customEventsYaml, model, project.id, provider, runOpts, systemPrompt],
  );

  const createAgent = useMutation({
    mutationFn: async () => {
      if (preview.error) throw new Error(preview.error);
      return await orpcClient.project.streams.appendBatch({
        events: preview.events,
        projectSlugOrId: project.id,
        streamPath: preview.agentPath,
      });
    },
    onSuccess: () => {
      void navigate({
        to: "/projects/$projectSlug/agents/streams/$",
        params: {
          ...params,
          _splat: preview.agentPath,
        },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const submit = useCallback(() => {
    createAgent.mutate();
  }, [createAgent]);

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
        <h2 className="text-sm font-semibold">New Agent</h2>
        <p className="text-sm text-muted-foreground">
          Assemble the events that will be appended to the agent stream.
        </p>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(440px,1.05fr)]">
        <div className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-path">Agent path</FieldLabel>
              <Input
                id="agent-path"
                value={agentPathInput}
                onChange={(event) => setAgentPathInput(event.currentTarget.value)}
                placeholder="/agents/assistant"
              />
            </Field>

            <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
              <Field>
                <FieldLabel htmlFor="agent-provider">Provider</FieldLabel>
                <NativeSelect
                  id="agent-provider"
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
                <FieldLabel htmlFor="agent-model">Model</FieldLabel>
                <Input
                  id="agent-model"
                  value={model}
                  onChange={(event) => setModel(event.currentTarget.value)}
                />
              </Field>
            </div>

            {provider === "cloudflare-ai" ? (
              <Field>
                <FieldLabel htmlFor="agent-run-opts">Run options JSON</FieldLabel>
                <Textarea
                  id="agent-run-opts"
                  className="min-h-20 font-mono text-xs"
                  value={runOpts}
                  onChange={(event) => setRunOpts(event.currentTarget.value)}
                />
              </Field>
            ) : null}

            <Field>
              <FieldLabel htmlFor="agent-system-prompt">System prompt</FieldLabel>
              <Textarea
                id="agent-system-prompt"
                className="min-h-32 font-mono text-xs"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.currentTarget.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-custom-events">Custom events</FieldLabel>
              <SourceCodeBlock
                code={customEventsYaml}
                className="min-h-44"
                editable
                language="yaml"
                onChange={setCustomEventsYaml}
              />
              <FieldDescription>
                YAML array of EventInput objects appended before tool-provider registrations.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </div>

        <aside className="min-h-[42rem] space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold">Event preview</p>
              <p className="text-sm text-muted-foreground">
                YAML preview of events appendBatch will append to {preview.agentPath}.
              </p>
            </div>
            <Button onClick={submit} disabled={createAgent.isPending || preview.error != null}>
              <Play className="size-4" />
              {createAgent.isPending ? "Creating..." : "Create agent"}
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

function buildPreviewEvents(input: {
  agentPathInput: string;
  customEventsYaml: string;
  model: string;
  projectId: string;
  provider: AgentLlmProvider;
  runOpts: string;
  systemPrompt: string;
}): { agentPath: StreamPath; error?: string; events: EventInput[] } {
  let agentPath = StreamPath.parse("/agents/assistant");
  try {
    agentPath = agentPathFromInput(input.agentPathInput);
    if (input.model.trim() === "") throw new Error("Model is required.");
    if (input.systemPrompt.trim() === "") throw new Error("System prompt is required.");
    const customEvents = parseAgentEventInputsYaml(input.customEventsYaml);
    const runOpts = input.provider === "cloudflare-ai" ? parseAgentRunOptsJson(input.runOpts) : {};

    // Tool capabilities are no longer compiled into stream events here: the
    // Agent Durable Object seeds its itx context (and the matching
    // capability-noted events) on first wake.
    return {
      agentPath,
      events: [
        ...configuredAgentSetupEvents({
          idempotencyKeyPrefix: "os-agent-new:setup",
          model: input.model.trim(),
          provider: input.provider,
          runOpts,
          systemPrompt: input.systemPrompt.trim(),
        }),
        ...agentProcessorSubscriptionConfiguredEvents({
          agentPath,
          processorSlugs: defaultAgentProcessorSlugs(input.provider),
          projectId: input.projectId,
        }),
        ...customEvents,
      ],
    };
  } catch (error) {
    return {
      agentPath,
      error: error instanceof Error ? error.message : String(error),
      events: [],
    };
  }
}
