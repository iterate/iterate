import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Play, RotateCcw } from "lucide-react";
import { parse as parseYaml } from "yaml";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  EventInput,
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  StreamPath,
} from "@iterate-com/shared/streams/types";
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
  defaultAgentSetupEvents,
  defaultAgentSystemPrompt,
} from "~/domains/agents/agent-presets.ts";
import { agentPathFromInput } from "~/lib/agent-links.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import { orpc, orpcClient } from "~/orpc/client.ts";

const emptyEventsYaml = "[]\n";

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/agents/new",
)({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

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
    description: "Workers AI, repos, workspace, subagents, OS2 oRPC, Slack",
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
  const [provider, setProvider] = useState<AgentLlmProvider>("openai-ws");
  const [model, setModel] = useState("gpt-5.5");
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
        to: "/orgs/$organizationSlug/projects/$projectSlug/agents/streams/$",
        params: {
          ...params,
          _splat: streamPathToSplat(preview.agentPath),
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
      if (nextProvider === "openai-ws" && current === "@cf/meta/llama-3.1-8b-instruct") {
        return "gpt-5.5";
      }
      if (nextProvider === "cloudflare-ai" && current === "gpt-5.5") {
        return "@cf/meta/llama-3.1-8b-instruct";
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
                  className="flex items-start gap-3 rounded-md border p-3 text-sm"
                >
                  <Checkbox
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
    const customEvents = parseCustomEvents(input.customEventsYaml);
    const runOpts = input.provider === "cloudflare-ai" ? parseRunOpts(input.runOpts) : {};
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
        ...agentSetupEvents({
          model: input.model.trim(),
          provider: input.provider,
          runOpts,
          systemPrompt: input.systemPrompt.trim(),
        }),
        ...customEvents,
        ...codemodeProviderRegistrationEvents(dedupeToolProviders(providers)),
        agentSubscriptionConfiguredEvent({
          agentPath,
          projectId: input.projectId,
        }),
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

function agentSetupEvents(input: {
  model: string;
  provider: AgentLlmProvider;
  runOpts: Record<string, unknown>;
  systemPrompt: string;
}): EventInput[] {
  return defaultAgentSetupEvents(input.provider).map((event, index) => ({
    idempotencyKey: `os2-agent-new:setup:${index}:${event.type}`,
    type: event.type,
    payload:
      input.provider === "openai-ws" && event.type === "events.iterate.com/openai-ws/config-updated"
        ? { model: input.model }
        : input.provider === "cloudflare-ai" &&
            event.type === "events.iterate.com/agent/llm-config-updated"
          ? {
              debounceMs: 1000,
              model: input.model,
              runOpts: input.runOpts,
            }
          : event.type === "events.iterate.com/agent/system-prompt-updated"
            ? { systemPrompt: input.systemPrompt }
            : event.payload,
  }));
}

function agentSubscriptionConfiguredEvent(input: {
  agentPath: StreamPath;
  projectId: string;
}): EventInput {
  const durableObjectName = deriveDurableObjectNameFromStructuredName({
    structuredName: {
      agentPath: input.agentPath,
      projectId: input.projectId,
    },
  });
  return {
    idempotencyKey: `stream-processor-websocket-subscription:AGENT:${durableObjectName}:${input.agentPath}:agent:${input.projectId}:${input.agentPath}`,
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    payload: {
      slug: `agent:${input.projectId}:${input.agentPath}`,
      type: "websocket",
      callable: {
        type: "fetch",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "AGENT",
          durableObject: {
            name: durableObjectName,
          },
        },
        fetchRequest: {
          path: {
            base: "/stream-subscription",
            mode: "replace",
          },
        },
      },
    },
  };
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

function parseCustomEvents(value: string) {
  const parsed = parseYaml(value.trim() || "[]") as unknown;
  return EventInput.array().parse(parsed);
}

function parseRunOpts(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Run options must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Run options must be valid JSON.");
  }
}
