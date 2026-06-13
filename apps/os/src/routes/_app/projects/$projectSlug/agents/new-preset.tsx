import { Suspense } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Save } from "lucide-react";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { toast } from "@iterate-com/ui/components/sonner";
import { AgentSetupFormPage, type AgentSetupFormValues } from "~/components/agent-setup-form.tsx";
import {
  AgentPresetEvent,
  configuredAgentSetupEvents,
  normalizeAgentPresetBasePath,
  parseAgentPresetEventsYaml,
  parseAgentRunOptsJson,
  presetConfiguredEvent,
} from "~/domains/agents/agent-presets.ts";
import { AGENTS_STREAM_PATH } from "~/domains/agents/agent-stream-subscriptions.ts";
import { useItx } from "~/itx/use-itx.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/new-preset")({
  ssr: false,
  loader: ({ context }) => ({
    breadcrumb: "New Preset",
    project: context.project,
  }),
  component: NewAgentPresetPage,
});

type PresetPreview = {
  basePath: StreamPath;
  customEvents: AgentPresetEvent[];
  error?: string;
  events: EventInput[];
};

function NewAgentPresetPage() {
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <NewAgentPresetContent />
    </Suspense>
  );
}

function NewAgentPresetContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const navigate = useNavigate();
  const itx = useItx(project.id);

  const savePreset = useMutation({
    mutationFn: async (input: { preview: PresetPreview; values: AgentSetupFormValues }) => {
      const { preview, values } = input;
      if (preview.error) throw new Error(preview.error);
      // Mirror the agents.configurePreset handler: append a preset-configured
      // event (basePath + the fully-assembled setup events) to the /agents root
      // stream. Reassemble events the same way the handler did
      // (configuredAgentSetupEvents + the custom preset events).
      const basePath = normalizeAgentPresetBasePath(preview.basePath);
      const events = [
        ...configuredAgentSetupEvents({
          model: values.model.trim(),
          provider: values.provider,
          runOpts: values.provider === "cloudflare-ai" ? parseAgentRunOptsJson(values.runOpts) : {},
          systemPrompt: values.systemPrompt.trim(),
        }),
        ...preview.customEvents,
      ];
      await itx.streams.get(AGENTS_STREAM_PATH).append(presetConfiguredEvent({ basePath, events }));
      return { basePath };
    },
    onSuccess: (result) => {
      toast.success(`Configured ${result.basePath}.`);
      void navigate({
        to: "/projects/$projectSlug/agents",
        params,
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  return (
    <AgentSetupFormPage
      title="New Agent Preset"
      description="Assemble the events that will seed matching agent streams."
      idPrefix="agent-preset"
      pathLabel="Path prefix"
      pathPlaceholder="/agents"
      initialPathInput="/agents"
      customEventsDescription="YAML array of extra EventInput objects appended after provider setup."
      buildPreview={buildPresetPreview}
      previewTitle="Preset event preview"
      previewDescription={(preview) => `YAML preview of events saved for ${preview.basePath}.`}
      submitIcon={<Save className="size-4" />}
      submitIdleLabel="Save preset"
      submitPendingLabel="Saving..."
      isPending={savePreset.isPending}
      onSubmit={(input) => savePreset.mutate(input)}
    />
  );
}

function buildPresetPreview(values: AgentSetupFormValues): PresetPreview {
  let basePath = StreamPath.parse("/agents");
  try {
    basePath = normalizeAgentPresetBasePath(values.pathInput);
    if (values.model.trim() === "") throw new Error("Model is required.");
    if (values.systemPrompt.trim() === "") throw new Error("System prompt is required.");
    const customEvents = parseAgentPresetEventsYaml(values.customEventsYaml);
    const runOpts =
      values.provider === "cloudflare-ai" ? parseAgentRunOptsJson(values.runOpts) : {};

    return {
      basePath,
      customEvents,
      events: [
        ...configuredAgentSetupEvents({
          model: values.model.trim(),
          provider: values.provider,
          runOpts,
          systemPrompt: values.systemPrompt.trim(),
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
