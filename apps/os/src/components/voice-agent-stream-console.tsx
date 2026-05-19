import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, Mic, Play, Square, Volume2, Waves } from "lucide-react";
import {
  VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_INPUT_SAMPLE_RATE,
  VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_SAMPLE_RATE,
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
  const appendQueueRef = useRef(Promise.resolve());
  const inputSequenceRef = useRef(0);
  const outputSequenceRef = useRef(0);
  const playedOffsetsRef = useRef(new Set<number>());
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const inputNodeRef = useRef<AudioWorkletNode | null>(null);
  const inputMonitorRef = useRef<GainNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const outputNodeRef = useRef<AudioWorkletNode | null>(null);

  const [streamStatus, setStreamStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [captureStatus, setCaptureStatus] = useState<"idle" | "starting" | "capturing">("idle");
  const [playbackReady, setPlaybackReady] = useState(false);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [autoGainControl, setAutoGainControl] = useState(true);
  const [toneSeconds, setToneSeconds] = useState(1);
  const [inputStats, setInputStats] = useState<AudioStats>({ frames: 0, bytes: 0 });
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

    setStreamStatus("connecting");
    void (async () => {
      try {
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

        const stream = await createBrowserOpenApiClient().project.streams.streamEvents(
          {
            afterOffset: "end",
            projectSlugOrId: project.id,
            streamPath,
          },
          { signal: controller.signal },
        );
        iterator = stream[Symbol.asyncIterator]();
        if (!isCurrent || controller.signal.aborted) return;
        setStreamStatus("live");

        for await (const value of stream) {
          if (!isCurrent || controller.signal.aborted) return;
          const event = Event.parse(value);
          await handleStreamEvent(event);
        }
      } catch (error) {
        if (!isCurrent || controller.signal.aborted) return;
        setStreamStatus("error");
        setLastError(error instanceof Error ? error.message : String(error));
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

  async function handleStreamEvent(event: Event) {
    if (event.type === VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE) {
      await playOutputEvent(event);
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/gemini-live-websocket-connected") {
      setProviderStatus("Gemini connected");
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/openai-realtime-websocket-connected") {
      setProviderStatus("OpenAI connected");
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/grok-realtime-websocket-connected") {
      setProviderStatus("Grok connected");
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/gemini-live-setup-completed") {
      setProviderStatus("Gemini ready");
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/openai-realtime-session-updated") {
      setProviderStatus("OpenAI ready");
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/grok-realtime-session-updated") {
      setProviderStatus("Grok ready");
      return;
    }
    if (event.type === VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE) {
      clearPlayback();
      setProviderStatus("Speaker buffer cleared");
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/gemini-live-output-interrupted") {
      setProviderStatus("Gemini interrupted");
      return;
    }
    if (
      event.type === "events.iterate.com/voice-agent/gemini-live-turn-completed" ||
      event.type === "events.iterate.com/voice-agent/openai-realtime-response-done" ||
      event.type === "events.iterate.com/voice-agent/grok-realtime-response-done"
    ) {
      setProviderStatus("Turn complete");
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/transcription-appended") {
      const payload = event.payload as { direction?: unknown; text?: unknown };
      if (typeof payload.text === "string") {
        appendTranscriptLine({
          direction: payload.direction === "input" ? "input" : "output",
          eventOffset: event.offset,
          text: payload.text,
        });
      }
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/error-occurred") {
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
        await outputAudioContextRef.current.resume();
      }
      return outputNodeRef.current;
    }

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
  }

  async function playOutputEvent(event: Event) {
    if (playedOffsetsRef.current.has(event.offset)) return;
    playedOffsetsRef.current.add(event.offset);

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

    appendQueueRef.current = appendQueueRef.current
      .then(async () => {
        await createBrowserOpenApiClient().project.streams.append({
          projectSlugOrId: project.id,
          streamPath,
          event,
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
        if (message.includes("stream is paused")) {
          stopCapture();
          setProviderStatus("Stream paused");
        }
      });
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
            <div className="grid gap-3 p-4 md:grid-cols-3">
              <Metric label="Capture" value={captureStatusLabel(captureStatus)} />
              <Metric label="Input frames" value={String(inputStats.frames)} />
              <Metric label="Input bytes" value={formatBytes(inputStats.bytes)} />
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
