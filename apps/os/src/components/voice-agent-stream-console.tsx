import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, Mic, Play, Square, Volume2, Waves } from "lucide-react";
import {
  VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE,
  VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_INPUT_SAMPLE_RATE,
  VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_SAMPLE_RATE,
  VOICE_AGENT_PROVIDER_CONNECTED_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_SESSION_READY_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE,
  VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
} from "@iterate-com/shared/stream-processors/voice-agent/contract";
import { STREAM_RESUMED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import { Event, EventInput, type StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Switch } from "@iterate-com/ui/components/switch";
import { toast } from "@iterate-com/ui/components/sonner";
import { EventsDebugLink } from "~/components/events-debug-link.tsx";
import {
  voiceAgentCircuitBreakerConfiguredEvent,
  voiceAgentSubscriptionConfiguredEvent,
} from "~/domains/voice-agents/voice-agent-subscription.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import { createBrowserOpenApiClient } from "~/orpc/client.ts";

const CHANNELS = 1;
const INPUT_CHUNK_MS = 100;
const OUTPUT_MIN_BUFFER_MS = 80;
const OUTPUT_TONE_CHUNK_MS = 40;
// Bounded mic upload queue: if append round trips fall behind realtime, drop the
// oldest frames instead of growing voice latency for the rest of the session.
const MAX_PENDING_INPUT_FRAMES = 20;
const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;

type VoiceAudioFramePayload = {
  streamId: string;
  sequence: number;
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: number;
  durationMs: number;
  dataBase64: string;
};

type AudioStats = {
  frames: number;
  bytes: number;
};

type ProviderLabel = "Gemini" | "OpenAI" | "Grok";

function providerLabel(provider: unknown): ProviderLabel | "Provider" {
  if (provider === "gemini-live") return "Gemini";
  if (provider === "openai-realtime") return "OpenAI";
  if (provider === "grok-realtime") return "Grok";
  return "Provider";
}

type TranscriptLine = {
  id: number;
  direction: "input" | "output";
  text: string;
};

type VoiceAgentStreamConsoleProps = {
  organizationSlug: string;
  project: { id: string; slug: string };
  projectSlug: string;
  streamPath: StreamPath;
  title: string;
  enableVoiceAgentProcessor: boolean;
};

export function VoiceAgentStreamConsole({
  enableVoiceAgentProcessor,
  organizationSlug,
  project,
  projectSlug,
  streamPath,
  title,
}: VoiceAgentStreamConsoleProps) {
  const streamIdRef = useRef(crypto.randomUUID());
  const pendingInputEventsRef = useRef<EventInput[]>([]);
  const inputFlushInFlightRef = useRef(false);
  const inputSequenceRef = useRef(0);
  const outputSequenceRef = useRef(0);
  // Stream offsets are monotonic, so one number replaces an ever-growing Set.
  const lastPlayedOffsetRef = useRef(0);
  const lastSeenOffsetRef = useRef<number | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const inputNodeRef = useRef<AudioWorkletNode | null>(null);
  const inputMonitorRef = useRef<GainNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const outputNodeRef = useRef<AudioWorkletNode | null>(null);
  const outputNodePromiseRef = useRef<Promise<AudioWorkletNode> | null>(null);

  const [streamStatus, setStreamStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [captureStatus, setCaptureStatus] = useState<"idle" | "starting" | "capturing">("idle");
  const [playbackReady, setPlaybackReady] = useState(false);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [toneSeconds, setToneSeconds] = useState(1);
  const [inputStats, setInputStats] = useState<AudioStats>({ frames: 0, bytes: 0 });
  const [droppedInputFrames, setDroppedInputFrames] = useState(0);
  const [outputStats, setOutputStats] = useState<AudioStats>({ frames: 0, bytes: 0 });
  const [outputQueueMs, setOutputQueueMs] = useState(0);
  const [outputUnderruns, setOutputUnderruns] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState("Waiting for audio");
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);

  const streamHrefParams = useMemo(
    () => ({
      organizationSlug,
      projectSlug,
      _splat: streamPathToSplat(streamPath),
    }),
    [organizationSlug, projectSlug, streamPath],
  );

  useEffect(() => {
    const controller = new AbortController();
    let isCurrent = true;
    let iterator: AsyncIterator<Event> | undefined;
    lastSeenOffsetRef.current = null;

    const stopped = () => !isCurrent || controller.signal.aborted;

    // Subscribe and keep the console alive across transport drops: resume from
    // the last seen offset with backoff instead of dying on the first error.
    void (async () => {
      let reconnectDelayMs = RECONNECT_DELAY_MS;
      let initialized = false;

      while (!stopped()) {
        setStreamStatus("connecting");
        try {
          if (!initialized) {
            await createBrowserOpenApiClient().project.streams.create({
              projectSlugOrId: project.id,
              streamPath,
            });
            if (enableVoiceAgentProcessor) {
              await ensureVoiceAgentStreamInfrastructure({
                projectId: project.id,
                streamPath,
              });
            }
            initialized = true;
          }

          const stream = await createBrowserOpenApiClient().project.streams.streamEvents(
            {
              afterOffset: lastSeenOffsetRef.current ?? "end",
              projectSlugOrId: project.id,
              streamPath,
            },
            { signal: controller.signal },
          );
          iterator = stream[Symbol.asyncIterator]();
          if (stopped()) return;
          setStreamStatus("live");
          reconnectDelayMs = RECONNECT_DELAY_MS;

          for await (const value of stream) {
            if (stopped()) return;
            // One malformed or unplayable event must not kill the subscription.
            try {
              const event = Event.parse(value);
              lastSeenOffsetRef.current = event.offset;
              handleStreamEvent(event);
            } catch (error) {
              setLastError(error instanceof Error ? error.message : String(error));
            }
          }
        } catch (error) {
          if (stopped()) return;
          setLastError(error instanceof Error ? error.message : String(error));
        }

        if (stopped()) return;
        setStreamStatus("error");
        await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
      }
    })();

    return () => {
      isCurrent = false;
      controller.abort();
      void iterator?.return?.();
    };
  }, [enableVoiceAgentProcessor, project.id, streamPath]);

  useEffect(() => {
    return () => {
      stopCapture();
      closeOutputAudio();
    };
  }, []);

  function handleStreamEvent(event: Event) {
    if (event.type === VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE) {
      // Playback must never block the subscription loop: a suspended
      // AudioContext can keep resume() pending until a user gesture arrives.
      void playOutputEvent(event).catch((error) => {
        setLastError(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (event.type === VOICE_AGENT_PROVIDER_CONNECTED_EVENT_TYPE) {
      const payload = event.payload as { provider?: unknown };
      setProviderStatus(`${providerLabel(payload.provider)} connected`);
      return;
    }
    if (event.type === VOICE_AGENT_PROVIDER_SESSION_READY_EVENT_TYPE) {
      const payload = event.payload as { provider?: unknown };
      setProviderStatus(`${providerLabel(payload.provider)} ready`);
      return;
    }
    if (event.type === VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE) {
      const payload = event.payload as { provider?: unknown; status?: unknown };
      const label = providerLabel(payload.provider);
      if (payload.status === "output-interrupted") setProviderStatus(`${label} interrupted`);
      else if (payload.status === "turn-completed" || payload.status === "response-done") {
        setProviderStatus("Turn complete");
      } else if (payload.status === "going-away") {
        setProviderStatus(`${label} session ending soon`);
      } else if (payload.status === "speech-started") setProviderStatus("Listening…");
      else if (payload.status === "speech-stopped") setProviderStatus("Thinking…");
      return;
    }
    if (event.type === VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE) {
      clearPlayback();
      setProviderStatus("Speaker buffer cleared");
      return;
    }
    if (event.type === VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE) {
      const payload = event.payload as { source?: unknown; text?: unknown };
      if (typeof payload.text === "string") {
        appendTranscriptLine({
          direction: payload.source === "input-transcription" ? "input" : "output",
          eventOffset: event.offset,
          text: payload.text,
        });
      }
      return;
    }
    if (event.type === VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE) {
      const payload = event.payload as { message?: unknown };
      setLastError(typeof payload.message === "string" ? payload.message : "Voice agent error");
    }
  }

  function appendTranscriptLine(input: {
    direction: TranscriptLine["direction"];
    eventOffset: number;
    text: string;
  }) {
    setTranscriptLines((current) => {
      const lastLine = current.at(-1);
      if (lastLine?.direction === input.direction) {
        return [
          ...current.slice(0, -1),
          {
            ...lastLine,
            text: `${lastLine.text}${input.text}`,
          },
        ];
      }

      return [
        ...current,
        {
          id: input.eventOffset,
          direction: input.direction,
          text: input.text,
        },
      ];
    });
  }

  async function ensureOutputAudio() {
    if (outputAudioContextRef.current && outputNodeRef.current) {
      if (outputAudioContextRef.current.state !== "running") {
        // Never await resume(): without a user gesture the promise can stay
        // pending forever under autoplay policy. The worklet buffers messages
        // posted to a suspended context, so playback starts once it resumes.
        void outputAudioContextRef.current.resume().catch(() => {});
      }
      return outputNodeRef.current;
    }

    // Concurrent callers (output frames arrive in bursts) must share one context.
    outputNodePromiseRef.current ??= (async () => {
      const context = new AudioContext();
      await context.audioWorklet.addModule("/voice-agent-poc/output-worklet.js");
      const node = new AudioWorkletNode(context, "pcm-output-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.postMessage({
        type: "configure",
        minBufferMs: OUTPUT_MIN_BUFFER_MS,
        sourceSampleRate: VOICE_AGENT_OUTPUT_SAMPLE_RATE,
      });
      node.port.onmessage = (event) => {
        if (event.data?.type === "status") {
          setOutputQueueMs(event.data.queuedMs ?? 0);
          setOutputUnderruns(event.data.underruns ?? 0);
        }
      };
      node.connect(context.destination);
      outputAudioContextRef.current = context;
      outputNodeRef.current = node;
      setPlaybackReady(true);
      return node;
    })();
    try {
      return await outputNodePromiseRef.current;
    } catch (error) {
      outputNodePromiseRef.current = null;
      throw error;
    }
  }

  async function playOutputEvent(event: Event) {
    if (event.offset <= lastPlayedOffsetRef.current) return;
    lastPlayedOffsetRef.current = event.offset;

    const payload = parseAudioPayload(event.payload);
    if (!payload || payload.sampleRate !== VOICE_AGENT_OUTPUT_SAMPLE_RATE) return;

    const node = await ensureOutputAudio();
    const buffer = base64ToArrayBuffer(payload.dataBase64);
    node.port.postMessage({ type: "enqueue", buffer }, [buffer]);
    setOutputStats((stats) => ({
      frames: stats.frames + 1,
      bytes: stats.bytes + buffer.byteLength,
    }));
  }

  async function startCapture() {
    if (captureStatus !== "idle") return;
    setCaptureStatus("starting");
    setLastError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation,
          noiseSuppression,
          autoGainControl,
        },
      });
      const context = new AudioContext();
      await context.audioWorklet.addModule("/voice-agent-poc/input-worklet.js");
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "pcm-input-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const monitor = context.createGain();
      monitor.gain.value = 0;
      node.port.postMessage({
        type: "configure",
        targetSampleRate: VOICE_AGENT_INPUT_SAMPLE_RATE,
        chunkMs: INPUT_CHUNK_MS,
      });
      node.port.onmessage = (event) => {
        if (event.data?.type !== "pcm" || !(event.data.buffer instanceof ArrayBuffer)) {
          return;
        }
        appendInputFrame(event.data.buffer, event.data.samples ?? 0);
      };
      source.connect(node);
      node.connect(monitor);
      monitor.connect(context.destination);
      node.port.postMessage({ type: "set-enabled", enabled: true });

      micStreamRef.current = stream;
      inputAudioContextRef.current = context;
      inputNodeRef.current = node;
      inputMonitorRef.current = monitor;
      setCaptureStatus("capturing");
    } catch (error) {
      setCaptureStatus("idle");
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  function stopCapture() {
    inputNodeRef.current?.port.postMessage({ type: "set-enabled", enabled: false });
    inputNodeRef.current?.disconnect();
    inputNodeRef.current = null;
    inputMonitorRef.current?.disconnect();
    inputMonitorRef.current = null;
    void inputAudioContextRef.current?.close();
    inputAudioContextRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    setCaptureStatus("idle");
  }

  function appendInputFrame(buffer: ArrayBuffer, sampleCount: number) {
    const sequence = inputSequenceRef.current++;
    const event = audioFrameEvent({
      type: VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
      streamId: streamIdRef.current,
      sequence,
      sampleRate: VOICE_AGENT_INPUT_SAMPLE_RATE,
      durationMs: Math.round((sampleCount / VOICE_AGENT_INPUT_SAMPLE_RATE) * 1000),
      buffer,
    });

    setInputStats((stats) => ({
      frames: stats.frames + 1,
      bytes: stats.bytes + buffer.byteLength,
    }));

    const pending = pendingInputEventsRef.current;
    pending.push(event);
    if (pending.length > MAX_PENDING_INPUT_FRAMES) {
      const dropped = pending.length - MAX_PENDING_INPUT_FRAMES;
      pending.splice(0, dropped);
      setDroppedInputFrames((count) => count + dropped);
    }
    void flushInputFrames();
  }

  // Single in-flight uploader: whatever accumulated while the previous request
  // was on the wire goes out as one batch, so latency stays bounded.
  async function flushInputFrames() {
    if (inputFlushInFlightRef.current) return;
    inputFlushInFlightRef.current = true;
    try {
      while (pendingInputEventsRef.current.length > 0) {
        const events = pendingInputEventsRef.current.splice(
          0,
          pendingInputEventsRef.current.length,
        );
        await createBrowserOpenApiClient().project.streams.appendBatch({
          projectSlugOrId: project.id,
          streamPath,
          events,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      if (message.includes("stream is paused")) {
        stopCapture();
        setProviderStatus("Stream paused");
      }
    } finally {
      inputFlushInFlightRef.current = false;
    }
  }

  async function appendTone() {
    setLastError(null);
    await ensureOutputAudio();
    const events = createToneEvents({
      seconds: toneSeconds,
      streamId: streamIdRef.current,
      startSequence: outputSequenceRef.current,
    });
    outputSequenceRef.current += events.length;

    try {
      await createBrowserOpenApiClient().project.streams.appendBatch({
        projectSlugOrId: project.id,
        streamPath,
        events,
      });
      toast.success(`Appended ${events.length} output audio frame events.`);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  function clearPlayback() {
    outputNodeRef.current?.port.postMessage({ type: "clear" });
    setOutputQueueMs(0);
    setOutputUnderruns(0);
  }

  function closeOutputAudio() {
    outputNodeRef.current?.disconnect();
    outputNodeRef.current = null;
    void outputAudioContextRef.current?.close();
    outputAudioContextRef.current = null;
    outputNodePromiseRef.current = null;
    setPlaybackReady(false);
  }

  const canCapture = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="border-b px-4 py-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h1 className="text-base font-semibold">{title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{enableVoiceAgentProcessor ? providerStatus : "Stream source of truth"}</span>
              <Link
                className="font-medium text-foreground underline-offset-4 hover:underline"
                to="/orgs/$organizationSlug/projects/$projectSlug/streams/$"
                params={streamHrefParams}
              >
                {streamPath}
              </Link>
              <span>{streamStatusLabel(streamStatus)}</span>
            </div>
          </div>
          <EventsDebugLink namespace={project.id} streamPath={streamPath} />
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,34rem)]">
        <main className="space-y-4">
          <section className="rounded-lg border bg-background">
            <div className="flex flex-col gap-3 border-b p-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-sm font-semibold">Output playback</h2>
                <p className="text-sm text-muted-foreground">
                  Plays 24 kHz PCM output only after the stream delivers frame events.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => void ensureOutputAudio()}>
                  <Volume2 />
                  Enable speaker
                </Button>
                <Button type="button" variant="outline" onClick={() => void appendTone()}>
                  <Play />
                  Inject tone
                </Button>
                <Button type="button" variant="outline" onClick={clearPlayback}>
                  <Square />
                  Clear buffer
                </Button>
              </div>
            </div>
            <div className="grid gap-3 p-4 md:grid-cols-5">
              <Metric label="Playback" value={playbackReady ? "Ready" : "Idle"} />
              <Metric label="Output frames" value={String(outputStats.frames)} />
              <Metric label="Output bytes" value={formatBytes(outputStats.bytes)} />
              <Metric label="Queued" value={`${outputQueueMs} ms`} />
              <Metric label="Underruns" value={String(outputUnderruns)} />
            </div>
            <div className="flex items-center gap-3 border-t p-4">
              <label className="text-sm font-medium" htmlFor="tone-seconds">
                Tone seconds
              </label>
              <Input
                id="tone-seconds"
                className="h-9 w-24"
                type="number"
                min={0.2}
                max={5}
                step={0.1}
                value={toneSeconds}
                onChange={(event) => setToneSeconds(Number(event.currentTarget.value))}
              />
            </div>
          </section>

          <section className="rounded-lg border bg-background">
            <div className="flex flex-col gap-3 border-b p-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-sm font-semibold">Microphone input</h2>
                <p className="text-sm text-muted-foreground">
                  Captures browser mic audio as 16 kHz PCM and appends each chunk to the stream.
                </p>
              </div>
              <div className="flex gap-2">
                {captureStatus === "capturing" ? (
                  <Button type="button" variant="outline" onClick={stopCapture}>
                    <Square />
                    Stop mic
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={!canCapture || captureStatus === "starting"}
                    onClick={() => void startCapture()}
                  >
                    <Mic />
                    {captureStatus === "starting" ? "Starting..." : "Start mic"}
                  </Button>
                )}
              </div>
            </div>
            <div className="grid gap-3 p-4 md:grid-cols-4">
              <Metric label="Capture" value={captureStatusLabel(captureStatus)} />
              <Metric label="Input frames" value={String(inputStats.frames)} />
              <Metric label="Input bytes" value={formatBytes(inputStats.bytes)} />
              <Metric label="Dropped" value={String(droppedInputFrames)} />
            </div>
            <div className="grid gap-3 border-t p-4 md:grid-cols-3">
              <ToggleRow
                checked={echoCancellation}
                label="Echo cancellation"
                onCheckedChange={setEchoCancellation}
              />
              <ToggleRow
                checked={noiseSuppression}
                label="Noise suppression"
                onCheckedChange={setNoiseSuppression}
              />
              <ToggleRow
                checked={autoGainControl}
                label="Auto gain"
                onCheckedChange={setAutoGainControl}
              />
            </div>
          </section>
        </main>

        <aside className="space-y-4">
          <section className="min-h-[24rem] rounded-lg border bg-background p-4">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="size-4" />
              <h2 className="text-sm font-semibold">Status</h2>
            </div>
            <div className="space-y-4 text-sm">
              <p className="text-muted-foreground">{providerStatus}</p>
              {transcriptLines.length > 0 ? (
                <div className="space-y-3">
                  {transcriptLines.map((line) => (
                    <div key={line.id} className="rounded-md border bg-muted/30 p-3">
                      <div className="mb-1 text-xs font-medium text-muted-foreground">
                        {line.direction === "input" ? "You" : "Agent"}
                      </div>
                      <p className="whitespace-pre-wrap text-foreground">{line.text}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              {lastError ? <p className="text-destructive">{lastError}</p> : null}
            </div>
          </section>

          <section className="rounded-lg border bg-background p-4">
            <div className="mb-3 flex items-center gap-2">
              <Waves className="size-4" />
              <h2 className="text-sm font-semibold">Frame contract</h2>
            </div>
            <dl className="space-y-3 text-sm">
              <KeyValue label="Input" value="pcm_s16le mono, 16 kHz" />
              <KeyValue label="Output" value="pcm_s16le mono, 24 kHz" />
              <KeyValue label="Chunking" value="100 ms input, provider-sized output" />
              <KeyValue label="Stream ID" value={streamIdRef.current} />
            </dl>
          </section>
        </aside>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

function ToggleRow({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

async function ensureVoiceAgentStreamInfrastructure(input: {
  projectId: string;
  streamPath: StreamPath;
}) {
  const events = [
    voiceAgentCircuitBreakerConfiguredEvent({
      projectId: input.projectId,
      streamPath: input.streamPath,
    }),
    voiceAgentSubscriptionConfiguredEvent({
      projectId: input.projectId,
      streamPath: input.streamPath,
    }),
  ];

  try {
    await createBrowserOpenApiClient().project.streams.appendBatch({
      projectSlugOrId: input.projectId,
      streamPath: input.streamPath,
      events,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("stream is paused")) throw error;

    await createBrowserOpenApiClient().project.streams.append({
      projectSlugOrId: input.projectId,
      streamPath: input.streamPath,
      event: EventInput.parse({
        type: STREAM_RESUMED_TYPE,
        payload: {
          reason: "voice agent setup resumed paused stream",
        },
      }),
    });
    await createBrowserOpenApiClient().project.streams.appendBatch({
      projectSlugOrId: input.projectId,
      streamPath: input.streamPath,
      events,
    });
  }
}

function audioFrameEvent(input: {
  buffer: ArrayBuffer;
  durationMs: number;
  sampleRate: number;
  sequence: number;
  streamId: string;
  type:
    | typeof VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE
    | typeof VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE;
}): EventInput {
  const payload: VoiceAudioFramePayload = {
    channels: CHANNELS,
    dataBase64: arrayBufferToBase64(input.buffer),
    durationMs: input.durationMs,
    encoding: "pcm_s16le",
    sampleRate: input.sampleRate,
    sequence: input.sequence,
    streamId: input.streamId,
  };

  return EventInput.parse({
    type: input.type,
    payload,
  });
}

function createToneEvents(input: {
  seconds: number;
  startSequence: number;
  streamId: string;
}): EventInput[] {
  const seconds = Math.min(5, Math.max(0.2, input.seconds || 1));
  const frameSamples = Math.round((VOICE_AGENT_OUTPUT_SAMPLE_RATE * OUTPUT_TONE_CHUNK_MS) / 1000);
  const totalSamples = Math.round(VOICE_AGENT_OUTPUT_SAMPLE_RATE * seconds);
  const events: EventInput[] = [];
  let sequence = input.startSequence;

  for (let start = 0; start < totalSamples; start += frameSamples) {
    const sampleCount = Math.min(frameSamples, totalSamples - start);
    const pcm = new Int16Array(sampleCount);
    for (let index = 0; index < sampleCount; index++) {
      const sampleIndex = start + index;
      const envelope = Math.min(1, sampleIndex / 480, (totalSamples - sampleIndex) / 480);
      const value = Math.sin((2 * Math.PI * 440 * sampleIndex) / VOICE_AGENT_OUTPUT_SAMPLE_RATE);
      pcm[index] = Math.round(value * envelope * 12000);
    }
    events.push(
      audioFrameEvent({
        buffer: pcm.buffer.slice(0),
        durationMs: Math.round((sampleCount / VOICE_AGENT_OUTPUT_SAMPLE_RATE) * 1000),
        sampleRate: VOICE_AGENT_OUTPUT_SAMPLE_RATE,
        sequence,
        streamId: input.streamId,
        type: VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
      }),
    );
    sequence++;
  }

  return events;
}

function parseAudioPayload(payload: unknown): VoiceAudioFramePayload | null {
  if (payload == null || typeof payload !== "object") return null;
  const value = payload as Partial<VoiceAudioFramePayload>;
  if (
    value.encoding !== "pcm_s16le" ||
    typeof value.dataBase64 !== "string" ||
    typeof value.sampleRate !== "number" ||
    typeof value.sequence !== "number"
  ) {
    return null;
  }
  return value as VoiceAudioFramePayload;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function streamStatusLabel(status: "connecting" | "live" | "error") {
  if (status === "connecting") return "Connecting";
  if (status === "live") return "Live";
  return "Stream error";
}

function captureStatusLabel(status: "idle" | "starting" | "capturing") {
  if (status === "starting") return "Starting";
  if (status === "capturing") return "Capturing";
  return "Idle";
}
