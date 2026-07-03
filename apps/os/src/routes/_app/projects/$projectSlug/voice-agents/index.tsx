import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { StreamExplorerTreePage } from "~/components/stream-explorer.tsx";
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
} from "~/domains/agents/voice-agent-processor-contract.ts";
import { VOICE_AGENT_PATH_PREFIX } from "~/domains/agents/voice-agent-code-agent.ts";
import { connectItxBrowser, useItx } from "~/itx/itx-react.tsx";
import { StreamPath } from "~/lib/stream-links.ts";

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

export const Route = createFileRoute("/_app/projects/$projectSlug/voice-agents/")({
  // Voice agents ARE agent streams under /agents/voice: the listing is the
  // stream explorer scoped there, plus a "start conversation" form that
  // appends the setup-configured birth fact.
  ssr: false,
  loader: ({ context }) => ({
    breadcrumb: "Voice agents",
    project: context.project,
  }),
  component: VoiceAgentsIndexPage,
});

function VoiceAgentsIndexPage() {
  return (
    <ItxBoundary>
      <VoiceAgentsIndexContent />
    </ItxBoundary>
  );
}

function VoiceAgentsIndexContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const navigate = useNavigate();
  const itx = useItx();
  const source = useMemo(() => (streamPath: string) => itx.streams.get(streamPath), [itx]);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<VoiceAgentProvider>(
    VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  );
  const [models, setModels] = useState<Record<VoiceAgentProvider, string>>(DEFAULT_MODELS);
  const [voices, setVoices] = useState<Record<VoiceAgentProvider, string>>(DEFAULT_VOICES);
  const [systemInstruction, setSystemInstruction] = useState(
    DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION,
  );

  function openPath(streamPath: string) {
    // /agents/voice itself is not a conversation — open its raw stream.
    if (streamPath === VOICE_AGENT_PATH_PREFIX) {
      void navigate({
        to: "/projects/$projectSlug/streams/$",
        params: { projectSlug: params.projectSlug, _splat: streamPath },
      });
      return;
    }
    void navigate({
      to: "/projects/$projectSlug/voice-agents/$",
      params: { projectSlug: params.projectSlug, _splat: streamPath },
    });
  }

  async function startConversation() {
    const model = models[selectedProvider].trim();
    const voiceName = voices[selectedProvider].trim();
    if (!model || !voiceName) {
      toast.error("Model and voice are required.");
      return;
    }

    setIsCreating(true);
    const streamPath = StreamPath.parse(
      `${VOICE_AGENT_PATH_PREFIX}/voice-${Date.now().toString(36)}`,
    );
    try {
      // The first append creates the stream; the project processor reacts to
      // the child-stream-created fact by appending the voice agent's birth
      // certificate (processor subscriptions + code-agent prompt).
      const itxHandle = await connectItxBrowser({ projectId: project.id });
      await itxHandle.streams.get(streamPath).append({
        type: VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
        idempotencyKey: `voice-agent-setup:${project.id}:${streamPath}`,
        payload: {
          provider: selectedProvider,
          model,
          voiceName,
          systemInstruction: systemInstruction.trim() || DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION,
        },
      });
      void navigate({
        to: "/projects/$projectSlug/voice-agents/$",
        params: {
          projectSlug: params.projectSlug,
          _splat: streamPath,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start voice agent.");
    } finally {
      setIsCreating(false);
    }
  }

  const header = (
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
  );

  return (
    <StreamExplorerTreePage
      header={header}
      source={source}
      rootPath={VOICE_AGENT_PATH_PREFIX}
      onOpenPath={openPath}
    />
  );
}
