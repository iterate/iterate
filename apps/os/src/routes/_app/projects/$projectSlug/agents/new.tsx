import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { toast } from "@iterate-com/ui/components/sonner";
import { AgentSetupFormPage, type AgentSetupFormValues } from "~/components/agent-setup-form.tsx";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import {
  configuredAgentSetupEvents,
  parseAgentEventInputsYaml,
  parseAgentRunOptsJson,
} from "~/domains/agents/agent-presets.ts";
import {
  agentProcessorSubscriptionConfiguredEvents,
  defaultAgentProcessorSlugs,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import { agentPathFromInput } from "~/lib/agent-links.ts";
import { useItx } from "~/itx/itx-react.tsx";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/new")({
  ssr: false,
  loader: ({ context }) => ({
    breadcrumb: "New Agent",
    project: context.project,
  }),
  component: NewAgentPage,
});

type NewAgentPreview = { agentPath: StreamPath; error?: string; events: EventInput[] };

function NewAgentPage() {
  return (
    <ItxBoundary>
      <NewAgentContent />
    </ItxBoundary>
  );
}

function NewAgentContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const navigate = useNavigate();
  const itx = useItx();

  const createAgent = useMutation({
    mutationFn: async (preview: NewAgentPreview) => {
      if (preview.error) throw new Error(preview.error);
      await itx.streams.get(preview.agentPath).appendBatch(preview.events);
      return preview;
    },
    onSuccess: (preview) => {
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

  return (
    <AgentSetupFormPage
      title="New Agent"
      description="Assemble the events that will be appended to the agent stream."
      idPrefix="agent"
      pathLabel="Agent path"
      pathPlaceholder="/agents/assistant"
      initialPathInput="/agents/assistant"
      customEventsDescription="YAML array of EventInput objects appended before tool-provider registrations."
      buildPreview={(values) => buildPreviewEvents({ projectId: project.id, values })}
      previewTitle="Event preview"
      previewDescription={(preview) =>
        `YAML preview of events appendBatch will append to ${preview.agentPath}.`
      }
      submitIcon={<Play className="size-4" />}
      submitIdleLabel="Create agent"
      submitPendingLabel="Creating..."
      isPending={createAgent.isPending}
      onSubmit={({ preview }) => createAgent.mutate(preview)}
    />
  );
}

function buildPreviewEvents(input: {
  projectId: string;
  values: AgentSetupFormValues;
}): NewAgentPreview {
  const { values } = input;
  let agentPath = StreamPath.parse("/agents/assistant");
  try {
    agentPath = agentPathFromInput(values.pathInput);
    if (values.model.trim() === "") throw new Error("Model is required.");
    if (values.systemPrompt.trim() === "") throw new Error("System prompt is required.");
    const customEvents = parseAgentEventInputsYaml(values.customEventsYaml);
    const runOpts =
      values.provider === "cloudflare-ai" ? parseAgentRunOptsJson(values.runOpts) : {};

    // Tool capabilities are no longer compiled into stream events here: the
    // Agent Durable Object provides its tools onto its own itx context (the
    // itx/capability-provided events) on first wake.
    return {
      agentPath,
      events: [
        ...configuredAgentSetupEvents({
          idempotencyKeyPrefix: "os-agent-new:setup",
          model: values.model.trim(),
          provider: values.provider,
          runOpts,
          systemPrompt: values.systemPrompt.trim(),
        }),
        ...agentProcessorSubscriptionConfiguredEvents({
          agentPath,
          processorSlugs: defaultAgentProcessorSlugs(values.provider),
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
