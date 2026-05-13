import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Save } from "lucide-react";
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
  AgentPresetEvent,
  type AgentLlmProvider,
  DEFAULT_CLOUDFLARE_AGENT_MODEL,
  configuredAgentSetupEvents,
  defaultAgentSystemPrompt,
  normalizeAgentPresetBasePath,
  parseAgentPresetEventsYaml,
  parseAgentRunOptsJson,
} from "~/domains/agents/agent-presets.ts";
import { orpc, orpcClient } from "~/orpc/client.ts";

const emptyEventsYaml = "[]\n";

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/agents/new-preset",
)({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: "New Preset",
      project,
    };
  },
  component: NewAgentPresetPage,
});

function NewAgentPresetPage() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [basePathInput, setBasePathInput] = useState("/agents");
  const [provider, setProvider] = useState<AgentLlmProvider>("cloudflare-ai");
  const [model, setModel] = useState(DEFAULT_CLOUDFLARE_AGENT_MODEL);
  const [runOpts, setRunOpts] = useState('{"gateway":{"id":"default"}}');
  const [systemPrompt, setSystemPrompt] = useState(defaultAgentSystemPrompt());
  const [customEventsYaml, setCustomEventsYaml] = useState(emptyEventsYaml);

  const preview = useMemo(
    () =>
      buildPresetPreview({
        basePathInput,
        customEventsYaml,
        model,
        provider,
        runOpts,
        systemPrompt,
      }),
    [basePathInput, customEventsYaml, model, provider, runOpts, systemPrompt],
  );

  const presetsQueryOptions = orpc.project.agents.listPresets.queryOptions({
    input: { projectSlugOrId: project.id },
  });
  const savePreset = useMutation({
    mutationFn: async () => {
      if (preview.error) throw new Error(preview.error);
      return await orpcClient.project.agents.configurePreset({
        basePath: preview.basePath,
        events: preview.customEvents,
        model: model.trim(),
        projectSlugOrId: project.id,
        provider,
        runOpts: provider === "cloudflare-ai" ? parseAgentRunOptsJson(runOpts) : {},
        systemPrompt: systemPrompt.trim(),
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: presetsQueryOptions.queryKey });
      toast.success(`Configured ${result.basePath}.`);
      void navigate({
        to: "/orgs/$organizationSlug/projects/$projectSlug/agents",
        params,
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const submit = useCallback(() => {
    savePreset.mutate();
  }, [savePreset]);

  function selectProvider(nextProvider: AgentLlmProvider) {
    setProvider(nextProvider);
    setModel((current) => {
      if (nextProvider === "openai-ws" && current === DEFAULT_CLOUDFLARE_AGENT_MODEL) {
        return "gpt-5.5";
      }
      if (nextProvider === "cloudflare-ai" && current === "gpt-5.5") {
        return DEFAULT_CLOUDFLARE_AGENT_MODEL;
      }
      return current;
    });
  }

  return (
    <section className="w-full max-w-7xl space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">New Agent Preset</h2>
        <p className="text-sm text-muted-foreground">
          Assemble the events that will seed matching agent streams.
        </p>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(440px,1.05fr)]">
        <div className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-preset-base-path">Path prefix</FieldLabel>
              <Input
                id="agent-preset-base-path"
                value={basePathInput}
                onChange={(event) => setBasePathInput(event.currentTarget.value)}
                placeholder="/agents"
              />
            </Field>

            <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
              <Field>
                <FieldLabel htmlFor="agent-preset-provider">Provider</FieldLabel>
                <NativeSelect
                  id="agent-preset-provider"
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
                <FieldLabel htmlFor="agent-preset-model">Model</FieldLabel>
                <Input
                  id="agent-preset-model"
                  value={model}
                  onChange={(event) => setModel(event.currentTarget.value)}
                />
              </Field>
            </div>

            {provider === "cloudflare-ai" ? (
              <Field>
                <FieldLabel htmlFor="agent-preset-run-opts">Run options JSON</FieldLabel>
                <Textarea
                  id="agent-preset-run-opts"
                  className="min-h-20 font-mono text-xs"
                  value={runOpts}
                  onChange={(event) => setRunOpts(event.currentTarget.value)}
                />
              </Field>
            ) : null}

            <Field>
              <FieldLabel htmlFor="agent-preset-system-prompt">System prompt</FieldLabel>
              <Textarea
                id="agent-preset-system-prompt"
                className="min-h-32 font-mono text-xs"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.currentTarget.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-preset-custom-events">Custom events</FieldLabel>
              <SourceCodeBlock
                code={customEventsYaml}
                className="min-h-44"
                editable
                language="yaml"
                onChange={setCustomEventsYaml}
              />
              <FieldDescription>
                YAML array of extra EventInput objects appended after provider setup.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </div>

        <aside className="min-h-[42rem] space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold">Preset event preview</p>
              <p className="text-sm text-muted-foreground">
                YAML preview of events saved for {preview.basePath}.
              </p>
            </div>
            <Button onClick={submit} disabled={savePreset.isPending || preview.error != null}>
              <Save className="size-4" />
              {savePreset.isPending ? "Saving..." : "Save preset"}
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

function buildPresetPreview(input: {
  basePathInput: string;
  customEventsYaml: string;
  model: string;
  provider: AgentLlmProvider;
  runOpts: string;
  systemPrompt: string;
}): {
  basePath: StreamPath;
  customEvents: AgentPresetEvent[];
  error?: string;
  events: EventInput[];
} {
  let basePath = StreamPath.parse("/agents");
  try {
    basePath = normalizeAgentPresetBasePath(input.basePathInput);
    if (input.model.trim() === "") throw new Error("Model is required.");
    if (input.systemPrompt.trim() === "") throw new Error("System prompt is required.");
    const customEvents = parseAgentPresetEventsYaml(input.customEventsYaml);
    const runOpts = input.provider === "cloudflare-ai" ? parseAgentRunOptsJson(input.runOpts) : {};

    return {
      basePath,
      customEvents,
      events: [
        ...configuredAgentSetupEvents({
          model: input.model.trim(),
          provider: input.provider,
          runOpts,
          systemPrompt: input.systemPrompt.trim(),
        }),
        ...customEvents,
      ],
    };
  } catch (error) {
    return {
      basePath,
      customEvents: [],
      error: error instanceof Error ? error.message : String(error),
      events: [],
    };
  }
}
