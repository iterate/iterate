import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_GROK_REALTIME_MODEL,
  DEFAULT_GROK_REALTIME_VOICE,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_VOICE,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_REALTIME_VOICE,
  DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
  type VoiceAgentProvider,
} from "@iterate-com/shared/stream-processors/voice-agent/contract";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { Input } from "@iterate-com/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  voiceAgentCircuitBreakerConfiguredEvent,
  streamProcessorSubscriptionConfiguredEvent,
  voiceAgentSubscriptionConfiguredEvent,
} from "~/domains/voice-agents/voice-agent-subscription.ts";
import { voiceAgentCodeAgentEvents } from "~/domains/voice-agents/voice-agent-code-agent.ts";
import {
  GEMINI_LIVE_VOICE_PROCESSOR_SLUG,
  GROK_REALTIME_VOICE_PROCESSOR_SLUG,
  OPENAI_REALTIME_VOICE_PROCESSOR_SLUG,
} from "~/domains/stream-processors/stream-processor-slugs.ts";
import { createBrowserOpenApiClient, orpc } from "~/orpc/client.ts";

type ProviderOption = {
  provider: VoiceAgentProvider;
  label: string;
  model: string;
  voiceName: string;
};

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    provider: VOICE_AGENT_PROVIDER_GEMINI_LIVE,
    label: "Gemini Live",
    model: DEFAULT_GEMINI_LIVE_MODEL,
    voiceName: DEFAULT_GEMINI_LIVE_VOICE,
  },
  {
    provider: VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
    label: "OpenAI Realtime",
    model: DEFAULT_OPENAI_REALTIME_MODEL,
    voiceName: DEFAULT_OPENAI_REALTIME_VOICE,
  },
  {
    provider: VOICE_AGENT_PROVIDER_GROK_REALTIME,
    label: "Grok Realtime",
    model: DEFAULT_GROK_REALTIME_MODEL,
    voiceName: DEFAULT_GROK_REALTIME_VOICE,
  },
];

const DEFAULT_MODELS = Object.fromEntries(
  PROVIDER_OPTIONS.map((option) => [option.provider, option.model]),
) as Record<VoiceAgentProvider, string>;

const DEFAULT_VOICES = Object.fromEntries(
  PROVIDER_OPTIONS.map((option) => [option.provider, option.voiceName]),
) as Record<VoiceAgentProvider, string>;

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/voice-agents/",
)({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.project.streams.list.queryOptions({ input: { projectSlugOrId: project.id } }),
      staleTime: 10_000,
    });

    return {
      breadcrumb: "Voice agents",
      project,
    };
  },
  component: VoiceAgentsIndexPage,
});

function VoiceAgentsIndexPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project } = Route.useLoaderData();
  const [isCreating, setIsCreating] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<VoiceAgentProvider>(
    VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  );
  const [models, setModels] = useState<Record<VoiceAgentProvider, string>>(DEFAULT_MODELS);
  const [voices, setVoices] = useState<Record<VoiceAgentProvider, string>>(DEFAULT_VOICES);
  const [systemInstruction, setSystemInstruction] = useState(
    DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION,
  );
  const streamsQueryOptions = orpc.project.streams.list.queryOptions({
    input: { projectSlugOrId: project.id },
  });
  const { data } = useQuery({
    ...streamsQueryOptions,
    staleTime: 10_000,
    refetchInterval: 5_000,
  });
  const voiceAgentStreams = useMemo(
    () =>
      (data?.streams ?? [])
        .filter((stream) => stream.streamPath.startsWith("/voice-agents/"))
        .toSorted((left, right) => right.lastWokenAt.localeCompare(left.lastWokenAt)),
    [data?.streams],
  );

  async function startConversation() {
    const model = models[selectedProvider].trim();
    const voiceName = voices[selectedProvider].trim();
    if (!model || !voiceName) {
      toast.error("Model and voice are required.");
      return;
    }

    setIsCreating(true);
    const slug = `voice-${Date.now().toString(36)}`;
    const streamPath = StreamPath.parse(`/voice-agents/${slug}`);
    try {
      await createBrowserOpenApiClient().project.streams.create({
        projectSlugOrId: project.id,
        streamPath,
      });
      await createBrowserOpenApiClient().project.streams.appendBatch({
        projectSlugOrId: project.id,
        streamPath,
        events: [
          voiceAgentCircuitBreakerConfiguredEvent({
            projectId: project.id,
            streamPath,
          }),
          voiceAgentSubscriptionConfiguredEvent({
            projectId: project.id,
            streamPath,
          }),
          streamProcessorSubscriptionConfiguredEvent({
            processorSlug: voiceProviderProcessorSlug(selectedProvider),
            projectId: project.id,
            streamPath,
          }),
          ...voiceAgentCodeAgentEvents({
            projectId: project.id,
            streamPath,
          }),
          EventInput.parse({
            idempotencyKey: `voice-agent-setup:${project.id}:${streamPath}`,
            type: VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
            payload: {
              provider: selectedProvider,
              model,
              voiceName,
              systemInstruction: systemInstruction.trim() || DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION,
            },
          }),
        ],
      });
      await queryClient.invalidateQueries({ queryKey: streamsQueryOptions.queryKey });
      void navigate({
        to: "/orgs/$organizationSlug/projects/$projectSlug/voice-agents/$voiceAgentSlug",
        params: {
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
          voiceAgentSlug: slug,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start voice agent.");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <section className="w-full space-y-4 p-4">
      <div>
        <h1 className="text-base font-semibold">Voice agents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browser microphone in, stream events through a realtime voice provider, stream output
          frames back out.
        </p>
      </div>

      <section className="rounded-lg border bg-background p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <h2 className="text-sm font-semibold">New conversation</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Pick the backend before the stream starts.
              </p>
            </div>

            <div className="grid gap-3 xl:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(0,1fr)]">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Backend</div>
                <div className="mt-2 grid grid-cols-1 gap-1 rounded-lg border bg-muted/30 p-1">
                  {PROVIDER_OPTIONS.map((option) => (
                    <button
                      key={option.provider}
                      type="button"
                      aria-pressed={selectedProvider === option.provider}
                      className={cn(
                        "rounded-md px-3 py-2 text-left text-sm font-medium transition-colors",
                        selectedProvider === option.provider
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                      )}
                      onClick={() => setSelectedProvider(option.provider)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="voice-agent-model"
                >
                  Model
                </label>
                <Input
                  id="voice-agent-model"
                  value={models[selectedProvider]}
                  onChange={(event) =>
                    setModels((current) => ({
                      ...current,
                      [selectedProvider]: event.currentTarget.value,
                    }))
                  }
                />
              </div>

              <div className="space-y-2">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="voice-agent-voice"
                >
                  Voice
                </label>
                <Input
                  id="voice-agent-voice"
                  value={voices[selectedProvider]}
                  onChange={(event) =>
                    setVoices((current) => ({
                      ...current,
                      [selectedProvider]: event.currentTarget.value,
                    }))
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="voice-agent-system-instruction"
              >
                System instruction
              </label>
              <Textarea
                id="voice-agent-system-instruction"
                className="min-h-20"
                value={systemInstruction}
                onChange={(event) => setSystemInstruction(event.currentTarget.value)}
              />
            </div>
          </div>

          <Button
            type="button"
            className="w-full lg:w-auto"
            disabled={isCreating}
            onClick={() => void startConversation()}
          >
            {isCreating ? "Starting..." : "Start conversation"}
          </Button>
        </div>
      </section>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Conversations</h2>
        </div>
      </div>

      {voiceAgentStreams.length === 0 ? (
        <Empty className="min-h-72 border">
          <EmptyHeader>
            <EmptyTitle>No voice conversations</EmptyTitle>
            <EmptyDescription>Start one to create a /voice-agents stream.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stream</TableHead>
                <TableHead>Stream name</TableHead>
                <TableHead>Last active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {voiceAgentStreams.map((stream) => {
                const slug = stream.streamPath.replace(/^\/voice-agents\//, "");
                return (
                  <TableRow key={stream.name}>
                    <TableCell>
                      <Link
                        className="font-medium underline-offset-4 hover:underline"
                        to="/orgs/$organizationSlug/projects/$projectSlug/voice-agents/$voiceAgentSlug"
                        params={{
                          organizationSlug: params.organizationSlug,
                          projectSlug: params.projectSlug,
                          voiceAgentSlug: slug,
                        }}
                      >
                        <EventsStreamPathLabel path={stream.streamPath} />
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {stream.name}
                    </TableCell>
                    <TableCell>{new Date(stream.lastWokenAt).toLocaleString()}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function voiceProviderProcessorSlug(provider: VoiceAgentProvider) {
  switch (provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return GEMINI_LIVE_VOICE_PROCESSOR_SLUG;
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return OPENAI_REALTIME_VOICE_PROCESSOR_SLUG;
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return GROK_REALTIME_VOICE_PROCESSOR_SLUG;
  }
}
