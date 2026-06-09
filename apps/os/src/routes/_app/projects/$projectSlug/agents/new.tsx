import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Play, RotateCcw } from "lucide-react";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { toast } from "@iterate-com/ui/components/sonner";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { CodemodeAdHocProviderFields } from "~/components/codemode-session-controls.tsx";
import {
  type CodemodeAdHocProviderFieldsValue,
  buildAdHocProviderInputs,
  createEmptyAdHocProviderFields,
} from "~/domains/codemode/ad-hoc-provider-inputs.ts";
import { createDefaultCodemodeProviderRegistrations } from "~/domains/codemode/default-provider-registrations.ts";
import { createExampleCapabilityProviders } from "~/domains/codemode/example-provider-registrations.ts";
import {
  codemodeProviderRegistrationEvents,
  providersForCodemodeProviderInputs,
} from "~/domains/codemode/examples.ts";
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

type ToolProviderKey = "default" | "rpcTour" | "adHoc";

const toolProviderOptions = [
  {
    key: "default",
    label: "Default runtime tools",
    description: "fetch, streams, Slack",
  },
  {
    key: "rpcTour",
    label: "RPC capability tour",
    description: "Workers AI, repos, workspace, subagents, OS oRPC, Slack",
  },
  {
    key: "adHoc",
    label: "Ad-hoc providers",
    description: "Outbound MCP and OpenAPI forms below",
  },
] satisfies Array<{ description: string; key: ToolProviderKey; label: string }>;

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
  const [selectedToolProviders, setSelectedToolProviders] = useState<Set<ToolProviderKey>>(
    () => new Set(["default", "rpcTour", "adHoc"]),
  );
  const [adHocProviderFields, setAdHocProviderFields] = useState(createEmptyAdHocProviderFields);

  const preview = useMemo(
    () =>
      buildPreviewEvents({
        agentPathInput,
        adHocProviderFields,
        customEventsYaml,
        model,
        projectId: project.id,
        provider,
        runOpts,
        selectedToolProviders,
        systemPrompt,
      }),
    [
      adHocProviderFields,
      agentPathInput,
      customEventsYaml,
      model,
      project.id,
      provider,
      runOpts,
      selectedToolProviders,
      systemPrompt,
    ],
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

  function toggleToolProvider(key: ToolProviderKey) {
    setSelectedToolProviders((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
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

          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Tool providers</p>
                <p className="text-sm text-muted-foreground">
                  Selected providers compile into codemode tool registration events.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedToolProviders(new Set(["default", "rpcTour", "adHoc"]));
                  setAdHocProviderFields(createEmptyAdHocProviderFields());
                }}
              >
                <RotateCcw className="size-4" />
                Reset
              </Button>
            </div>

            <div className="grid gap-2">
              {toolProviderOptions.map((option) => (
                <label
                  key={option.key}
                  htmlFor={`agent-tool-provider-${option.key}`}
                  className="flex items-start gap-3 rounded-md border p-3 text-sm"
                >
                  <Checkbox
                    id={`agent-tool-provider-${option.key}`}
                    checked={selectedToolProviders.has(option.key)}
                    onCheckedChange={() => toggleToolProvider(option.key)}
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-muted-foreground">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>

            {selectedToolProviders.has("adHoc") ? (
              <CodemodeAdHocProviderFields
                value={adHocProviderFields}
                onChange={setAdHocProviderFields}
              />
            ) : null}
          </div>
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
  adHocProviderFields: CodemodeAdHocProviderFieldsValue;
  agentPathInput: string;
  customEventsYaml: string;
  model: string;
  projectId: string;
  provider: AgentLlmProvider;
  runOpts: string;
  selectedToolProviders: Set<ToolProviderKey>;
  systemPrompt: string;
}): { agentPath: StreamPath; error?: string; events: EventInput[] } {
  let agentPath = StreamPath.parse("/agents/assistant");
  try {
    agentPath = agentPathFromInput(input.agentPathInput);
    if (input.model.trim() === "") throw new Error("Model is required.");
    if (input.systemPrompt.trim() === "") throw new Error("System prompt is required.");
    const customEvents = parseAgentEventInputsYaml(input.customEventsYaml);
    const runOpts = input.provider === "cloudflare-ai" ? parseAgentRunOptsJson(input.runOpts) : {};
    const providers = [
      ...(input.selectedToolProviders.has("default")
        ? createDefaultCodemodeProviderRegistrations({
            projectId: input.projectId,
            streamPath: agentPath,
          })
        : []),
      ...(input.selectedToolProviders.has("rpcTour")
        ? createExampleCapabilityProviders({ projectId: input.projectId })
        : []),
      createAgentChatToolProvider({
        agentPath,
        projectId: input.projectId,
      }),
      ...(input.selectedToolProviders.has("adHoc")
        ? providersForCodemodeProviderInputs({
            projectId: input.projectId,
            providers: buildAdHocProviderInputs(input.adHocProviderFields),
          })
        : []),
    ];

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
        ...codemodeProviderRegistrationEvents(dedupeToolProviders(providers)),
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

function createAgentChatToolProvider(input: {
  agentPath: StreamPath;
  projectId: string;
}): ToolProviderRegistration {
  return {
    path: ["chat"],
    instructions:
      "Use ctx.chat.sendMessage({ message }) to send a visible response to the user. Prefer this over appending chat events manually.",
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "AGENT",
          durableObject: {
            name: deriveDurableObjectNameFromStructuredName({
              structuredName: {
                agentPath: input.agentPath,
                projectId: input.projectId,
              },
            }),
          },
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
  };
}

function dedupeToolProviders(providers: ToolProviderRegistration[]) {
  const byPath = new Map<string, ToolProviderRegistration>();
  for (const provider of providers) {
    const key = provider.path.join("/");
    if (!byPath.has(key)) byPath.set(key, provider);
  }
  return [...byPath.values()];
}
