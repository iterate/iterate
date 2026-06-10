import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  agentProcessorSubscriptionConfiguredEvent,
  voiceProviderProcessorSlug,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_VOICE,
  DEFAULT_GROK_REALTIME_MODEL,
  DEFAULT_GROK_REALTIME_VOICE,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_REALTIME_VOICE,
  DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION,
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
  type VoiceAgentProvider,
} from "~/domains/agents/stream-processors/voice-agent/contract.ts";
import { StreamDebugLink } from "~/components/stream-debug-link.tsx";
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

const VOICE_AGENT_STREAM_PATH_PREFIX = "/agents/voice/";

export const Route = createFileRoute("/_app/projects/$projectSlug/voice-agents/")({
  loader: async ({ context }) => {
    const { project } = context;
    await context.queryClient.ensureQueryData(
      orpc.project.streams.list.queryOptions({ input: { projectSlugOrId: project.id } }),
    );
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
        .filter((stream) => stream.streamPath.startsWith(VOICE_AGENT_STREAM_PATH_PREFIX))
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
    const streamPath = StreamPath.parse(`/agents/voice/${slug}`);
    try {
      await createBrowserOpenApiClient().project.streams.create({
        projectSlugOrId: project.id,
        streamPath,
      });
      await createBrowserOpenApiClient().project.streams.appendBatch({
        projectSlugOrId: project.id,
        streamPath,
        events: [
          agentProcessorSubscriptionConfiguredEvent({
            processorSlug: voiceProviderProcessorSlug(selectedProvider),
            projectId: project.id,
            agentPath: streamPath,
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
        to: "/projects/$projectSlug/voice-agents/$voiceAgentSlug",
        params: { projectSlug: params.projectSlug, voiceAgentSlug: slug },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start voice agent.");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <section className="w-full space-y-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold">Voice agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Browser microphone in, realtime provider out, all through stream events.
          </p>
        </div>
        <StreamDebugLink label="Open root stream" projectSlug={project.slug} streamPath="/" />
      </div>

      <section className="rounded-lg border bg-background p-4">
        <div className="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Backend</div>
            <div className="mt-2 grid gap-1 rounded-lg border bg-muted/30 p-1">
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
          <label className="space-y-2" htmlFor="voice-agent-model">
            <span className="text-xs font-medium text-muted-foreground">Model</span>
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
          </label>
          <label className="space-y-2" htmlFor="voice-agent-voice">
            <span className="text-xs font-medium text-muted-foreground">Voice</span>
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
          </label>
        </div>

        <label className="mt-4 block space-y-2" htmlFor="voice-agent-system-instruction">
          <span className="text-xs font-medium text-muted-foreground">System instruction</span>
          <Textarea
            id="voice-agent-system-instruction"
            value={systemInstruction}
            onChange={(event) => setSystemInstruction(event.currentTarget.value)}
            rows={4}
          />
        </label>

        <div className="mt-4 flex justify-end">
          <Button type="button" disabled={isCreating} onClick={() => void startConversation()}>
            {isCreating ? "Starting..." : "Start conversation"}
          </Button>
        </div>
      </section>

      {voiceAgentStreams.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>No voice agents</EmptyTitle>
            <EmptyDescription>Start a conversation to create a voice stream.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stream</TableHead>
                <TableHead className="w-40">Last event</TableHead>
                <TableHead className="w-28 text-right">Debug</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {voiceAgentStreams.map((stream) => {
                const slug = stream.streamPath.slice(VOICE_AGENT_STREAM_PATH_PREFIX.length);
                return (
                  <TableRow key={stream.streamPath}>
                    <TableCell>
                      <Link
                        className="block min-w-0 rounded-sm text-sm font-medium hover:underline"
                        to="/projects/$projectSlug/voice-agents/$voiceAgentSlug"
                        params={{ projectSlug: params.projectSlug, voiceAgentSlug: slug }}
                      >
                        <EventsStreamPathLabel path={stream.streamPath} className="min-w-0" />
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelativeTime(stream.lastWokenAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <StreamDebugLink
                        label="Open"
                        projectSlug={project.slug}
                        streamPath={stream.streamPath}
                      />
                    </TableCell>
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

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "Never";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const deltaSeconds = Math.round((Date.now() - timestamp) / 1000);
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 48) return `${deltaHours}h ago`;
  return new Date(value).toLocaleString();
}
