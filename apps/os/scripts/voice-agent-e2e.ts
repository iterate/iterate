import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import { osContract } from "@iterate-com/os-contract";
import {
  AGENT_INPUT_ADDED_EVENT_TYPE,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_VOICE,
  DEFAULT_GROK_REALTIME_MODEL,
  DEFAULT_GROK_REALTIME_VOICE,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_REALTIME_VOICE,
  VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_INPUT_SAMPLE_RATE,
  VOICE_AGENT_OUTPUT_SAMPLE_RATE,
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
  type VoiceAgentProvider,
} from "@iterate-com/shared/stream-processors/voice-agent/contract";
import { EventInput, StreamPath, type Event } from "@iterate-com/shared/streams/types";
import {
  voiceAgentCircuitBreakerConfiguredEvent,
  streamProcessorSubscriptionConfiguredEvent,
  voiceAgentSubscriptionConfiguredEvent,
} from "~/domains/voice-agents/voice-agent-subscription.ts";
import {
  GEMINI_LIVE_VOICE_PROCESSOR_SLUG,
  GROK_REALTIME_VOICE_PROCESSOR_SLUG,
  OPENAI_REALTIME_VOICE_PROCESSOR_SLUG,
} from "~/domains/stream-processors/stream-processor-slugs.ts";
import type { appRouter } from "~/orpc/root.ts";

type OrpcClient = RouterClient<typeof appRouter>;

type Options = {
  baseUrl: string;
  chunkMs: number;
  createProject: boolean;
  expectMessageAgent: boolean;
  inputMode: "audio" | "text";
  model: string;
  minOutputBytes: number;
  outputPcm: string | null;
  pcmFile: string | null;
  play: boolean;
  provider: VoiceAgentProvider;
  projectSlugOrId: string | null;
  prompt: string;
  silenceMs: number;
  streamPath: StreamPath;
  timeoutMs: number;
  voiceName: string;
};

type SeenEvents = {
  error: string | null;
  outputBuffers: Buffer[];
  providerConnected: boolean;
  setupCompleted: boolean;
  turnCompleted: boolean;
  messageAgentInputAdded: boolean;
  agentOutputAdded: boolean;
  codemodeScriptCompleted: boolean;
  codeAgentVoiceTextAdded: boolean;
  codeAgentVoiceText: string | null;
};

const execFileAsync = promisify(execFile);

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const client = createClient(options.baseUrl);
  const runId = `voice-agent-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const projectSlugOrId = options.createProject
    ? (await createTestProject(client, runId)).id
    : await resolveProjectId(client, requireProjectSlugOrId(options.projectSlugOrId));
  const audio =
    options.inputMode === "audio"
      ? Buffer.concat([
          options.pcmFile
            ? await readFile(resolve(options.pcmFile))
            : await synthesizePromptPcm(options.prompt),
          silencePcm(options.silenceMs),
        ])
      : Buffer.alloc(0);

  console.log(
    JSON.stringify(
      {
        runId,
        baseUrl: options.baseUrl,
        provider: options.provider,
        projectSlugOrId,
        streamPath: options.streamPath,
        model: options.model,
        inputMode: options.inputMode,
        prompt: options.pcmFile ? `pcm-file:${options.pcmFile}` : options.prompt,
        inputBytes: audio.byteLength,
      },
      null,
      2,
    ),
  );

  await client.project.streams.create({
    projectSlugOrId,
    streamPath: options.streamPath,
  });
  const setupEvents = await client.project.streams.appendBatch({
    projectSlugOrId,
    streamPath: options.streamPath,
    events: [
      voiceAgentCircuitBreakerConfiguredEvent({
        projectId: projectSlugOrId,
        streamPath: options.streamPath,
      }),
      voiceAgentSubscriptionConfiguredEvent({
        projectId: projectSlugOrId,
        streamPath: options.streamPath,
      }),
      streamProcessorSubscriptionConfiguredEvent({
        processorSlug: voiceProviderProcessorSlug(options.provider),
        projectId: projectSlugOrId,
        streamPath: options.streamPath,
      }),
      EventInput.parse({
        idempotencyKey: `${runId}:voice-agent-setup`,
        type: VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
        payload: {
          provider: options.provider,
          model: options.model,
          voiceName: options.voiceName,
          messageAgentToolChoice: options.expectMessageAgent ? "required" : "auto",
          systemInstruction: options.expectMessageAgent
            ? [
                "You are running an automated voice smoke test.",
                "If the caller asks you to fetch, inspect, calculate, run code, or do any background work, you MUST call the Message Agent tool with the caller's request.",
                "After the tool call returns, say one short sentence telling the caller that you asked the background agent.",
              ].join(" ")
            : "You are running an automated voice test. Reply with one short sentence.",
        },
      }),
    ],
  });
  const afterOffset = Math.max(...setupEvents.events.map((event) => event.offset));
  const seen: SeenEvents = {
    error: null,
    outputBuffers: [],
    providerConnected: false,
    setupCompleted: false,
    turnCompleted: false,
    messageAgentInputAdded: false,
    agentOutputAdded: false,
    codemodeScriptCompleted: false,
    codeAgentVoiceTextAdded: false,
    codeAgentVoiceText: null,
  };

  const watchPromise = watchStream({
    afterOffset,
    client,
    projectSlugOrId,
    seen,
    streamPath: options.streamPath,
    timeoutMs: options.timeoutMs,
    minOutputBytes: options.minOutputBytes,
    expectMessageAgent: options.expectMessageAgent,
  });

  if (options.inputMode === "audio") {
    await appendPcmFrames({
      audio,
      chunkMs: options.chunkMs,
      client,
      projectSlugOrId,
      runId,
      streamPath: options.streamPath,
    });
  } else {
    await appendInputText({
      client,
      projectSlugOrId,
      runId,
      streamPath: options.streamPath,
      text: options.prompt,
    });
  }

  await watchPromise;

  const output = Buffer.concat(seen.outputBuffers);
  if (options.outputPcm) {
    await writeFile(resolve(options.outputPcm), output);
  }
  if (options.play && output.byteLength > 0) {
    await playOutputPcm(output);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: options.provider,
        providerConnected: seen.providerConnected,
        setupCompleted: seen.setupCompleted,
        turnCompleted: seen.turnCompleted,
        outputBytes: output.byteLength,
        outputPcm: options.outputPcm,
        messageAgentInputAdded: seen.messageAgentInputAdded,
        agentOutputAdded: seen.agentOutputAdded,
        codemodeScriptCompleted: seen.codemodeScriptCompleted,
        codeAgentVoiceTextAdded: seen.codeAgentVoiceTextAdded,
        codeAgentVoiceText: seen.codeAgentVoiceText,
      },
      null,
      2,
    ),
  );
}

async function watchStream(input: {
  afterOffset: number;
  client: OrpcClient;
  minOutputBytes: number;
  expectMessageAgent: boolean;
  projectSlugOrId: string;
  seen: SeenEvents;
  streamPath: StreamPath;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const stream = await input.client.project.streams.streamEvents(
    {
      afterOffset: input.afterOffset,
      projectSlugOrId: input.projectSlugOrId,
      streamPath: input.streamPath,
    },
    { signal: controller.signal },
  );

  try {
    for await (const event of stream as AsyncIterable<Event>) {
      console.log(`${event.offset} ${event.type}`);

      if (
        event.type === "events.iterate.com/voice-agent/gemini-live-websocket-connected" ||
        event.type === "events.iterate.com/voice-agent/openai-realtime-websocket-connected" ||
        event.type === "events.iterate.com/voice-agent/grok-realtime-websocket-connected"
      ) {
        input.seen.providerConnected = true;
      }
      if (
        event.type === "events.iterate.com/voice-agent/gemini-live-setup-completed" ||
        event.type === "events.iterate.com/voice-agent/openai-realtime-session-updated" ||
        event.type === "events.iterate.com/voice-agent/grok-realtime-session-updated"
      ) {
        input.seen.setupCompleted = true;
      }
      if (
        event.type === "events.iterate.com/voice-agent/gemini-live-turn-completed" ||
        event.type === "events.iterate.com/voice-agent/openai-realtime-response-done" ||
        event.type === "events.iterate.com/voice-agent/grok-realtime-response-done"
      ) {
        input.seen.turnCompleted = true;
      }
      if (event.type === VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE) {
        const payload = event.payload as { dataBase64?: unknown };
        if (typeof payload.dataBase64 === "string") {
          input.seen.outputBuffers.push(Buffer.from(payload.dataBase64, "base64"));
        }
      }
      if (event.type === "events.iterate.com/voice-agent/error-occurred") {
        const payload = event.payload as { message?: unknown };
        input.seen.error = typeof payload.message === "string" ? payload.message : "unknown error";
        throw new Error(input.seen.error);
      }
      if (event.type === AGENT_INPUT_ADDED_EVENT_TYPE) {
        const payload = event.payload as { content?: unknown; llmRequestPolicy?: unknown };
        if (typeof payload.content === "string") {
          console.log(`  agent input: ${payload.content.slice(0, 200)}`);
        }
        if (isMessageAgentInput(payload)) {
          input.seen.messageAgentInputAdded = true;
        }
      }
      if (event.type === "events.iterate.com/agent/output-added") {
        input.seen.agentOutputAdded = true;
      }
      if (event.type === "events.iterate.com/codemode/script-execution-completed") {
        input.seen.codemodeScriptCompleted = true;
      }
      if (event.type === VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE) {
        const payload = event.payload as { source?: unknown; text?: unknown };
        if (input.seen.messageAgentInputAdded) {
          input.seen.codeAgentVoiceTextAdded = true;
          input.seen.codeAgentVoiceText = typeof payload.text === "string" ? payload.text : null;
          console.log(`  voice input text: ${input.seen.codeAgentVoiceText ?? "<missing>"}`);
        }
      }

      const outputBytes = input.seen.outputBuffers.reduce(
        (total, buffer) => total + buffer.byteLength,
        0,
      );
      if (input.expectMessageAgent) {
        if (
          input.seen.setupCompleted &&
          input.seen.messageAgentInputAdded &&
          input.seen.codeAgentVoiceTextAdded
        ) {
          return;
        }
        continue;
      }

      if (input.seen.setupCompleted && outputBytes >= input.minOutputBytes) {
        return;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Timed out after ${input.timeoutMs}ms. providerConnected=${input.seen.providerConnected} setup=${input.seen.setupCompleted} outputFrames=${input.seen.outputBuffers.length}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function isMessageAgentInput(payload: { llmRequestPolicy?: unknown }) {
  const policy = payload.llmRequestPolicy as { behaviour?: unknown } | undefined;
  return policy?.behaviour === "after-current-request";
}

async function appendPcmFrames(input: {
  audio: Buffer;
  chunkMs: number;
  client: OrpcClient;
  projectSlugOrId: string;
  runId: string;
  streamPath: StreamPath;
}) {
  const bytesPerChunk = Math.max(
    2,
    Math.round((VOICE_AGENT_INPUT_SAMPLE_RATE * 2 * input.chunkMs) / 1000),
  );
  const evenBytesPerChunk = bytesPerChunk % 2 === 0 ? bytesPerChunk : bytesPerChunk + 1;
  let sequence = 0;

  for (let start = 0; start < input.audio.byteLength; start += evenBytesPerChunk) {
    const chunk = input.audio.subarray(
      start,
      Math.min(input.audio.byteLength, start + evenBytesPerChunk),
    );
    await input.client.project.streams.append({
      projectSlugOrId: input.projectSlugOrId,
      streamPath: input.streamPath,
      event: EventInput.parse({
        type: VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
        payload: {
          channels: 1,
          dataBase64: chunk.toString("base64"),
          durationMs: Math.round((chunk.byteLength / 2 / VOICE_AGENT_INPUT_SAMPLE_RATE) * 1000),
          encoding: "pcm_s16le",
          sampleRate: VOICE_AGENT_INPUT_SAMPLE_RATE,
          sequence,
          streamId: input.runId,
        },
      }),
    });
    sequence += 1;
    await delay(input.chunkMs);
  }
}

async function appendInputText(input: {
  client: OrpcClient;
  projectSlugOrId: string;
  runId: string;
  streamPath: StreamPath;
  text: string;
}) {
  await input.client.project.streams.append({
    projectSlugOrId: input.projectSlugOrId,
    streamPath: input.streamPath,
    event: EventInput.parse({
      idempotencyKey: `${input.runId}:voice-agent-input-text`,
      type: VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
      payload: {
        source: "voice-agent-e2e",
        text: input.text,
      },
    }),
  });
}

async function synthesizePromptPcm(prompt: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "voice-agent-e2e-"));
  const aiffPath = join(dir, "input.aiff");
  const pcmPath = join(dir, "input.pcm");
  try {
    await execFileAsync("say", ["-o", aiffPath, prompt]);
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      aiffPath,
      "-ac",
      "1",
      "-ar",
      String(VOICE_AGENT_INPUT_SAMPLE_RATE),
      "-f",
      "s16le",
      pcmPath,
    ]);
    return await readFile(pcmPath);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function silencePcm(durationMs: number) {
  const samples = Math.round((VOICE_AGENT_INPUT_SAMPLE_RATE * durationMs) / 1000);
  return Buffer.alloc(samples * 2);
}

async function playOutputPcm(output: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "voice-agent-output-"));
  const pcmPath = join(dir, "output.pcm");
  try {
    await writeFile(pcmPath, output);
    await execFileAsync("ffplay", [
      "-autoexit",
      "-nodisp",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(VOICE_AGENT_OUTPUT_SAMPLE_RATE),
      "-ac",
      "1",
      pcmPath,
    ]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function createTestProject(client: OrpcClient, runId: string) {
  return await client.projects.create({
    slug: runId,
  });
}

async function resolveProjectId(client: OrpcClient, slugOrId: string) {
  try {
    return (await client.projects.find({ id: slugOrId })).id;
  } catch {
    return (await client.projects.findBySlug({ slug: slugOrId })).id;
  }
}

function createClient(baseUrl: string) {
  const authHeaders = requireAuthHeaders();
  return createORPCClient(
    new OpenAPILink(osContract, {
      url: `${baseUrl}/api`,
      fetch: (input, init) => {
        const requestInit: RequestInit = init ?? {};
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        for (const [key, value] of new Headers(requestInit.headers)) headers.set(key, value);
        for (const [key, value] of Object.entries(authHeaders)) headers.set(key, value);
        if (input instanceof Request) return fetch(new Request(input, { ...requestInit, headers }));
        return fetch(input, { ...requestInit, headers });
      },
    }),
  ) as OrpcClient;
}

function requireAuthHeaders() {
  const bearerToken =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    process.env.OS_E2E_BEARER_TOKEN?.trim();
  const cookie = process.env.OS_E2E_COOKIE?.trim();
  if (!bearerToken && !cookie) {
    throw new Error(
      "OS_E2E_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, APP_CONFIG_ADMIN_API_SECRET, OS_E2E_BEARER_TOKEN, or OS_E2E_COOKIE is required.",
    );
  }

  return {
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function parseOptions(args: readonly string[]): Options {
  const values = parseArgs(args);
  const expectMessageAgent = booleanOption(values, "expect-message-agent", false);
  return {
    baseUrl: stringOption(values, "base-url", process.env.OS_BASE_URL ?? "http://127.0.0.1:5173"),
    chunkMs: numberOption(values, "chunk-ms", 100),
    createProject: booleanOption(values, "create-project", true),
    expectMessageAgent,
    inputMode: inputModeOption(values),
    provider: providerOption(values),
    model: modelOption(values),
    minOutputBytes: numberOption(values, "min-output-bytes", 4_800),
    outputPcm: optionalStringOption(values, "output-pcm"),
    pcmFile: optionalStringOption(values, "pcm-file"),
    play: booleanOption(values, "play", false),
    projectSlugOrId: optionalStringOption(values, "project"),
    prompt: stringOption(
      values,
      "prompt",
      expectMessageAgent
        ? "Message the background agent to fetch example dot com and tell me what it says."
        : "Please say success.",
    ),
    silenceMs: numberOption(values, "silence-ms", 1500),
    streamPath: StreamPath.parse(
      stringOption(values, "stream-path", `/agents/voice/e2e-${Date.now().toString(36)}`),
    ),
    timeoutMs: numberOption(values, "timeout-ms", expectMessageAgent ? 180_000 : 60_000),
    voiceName: voiceOption(values),
  };
}

function inputModeOption(values: Map<string, string>) {
  const raw = stringOption(values, "input-mode", "audio");
  if (raw === "audio" || raw === "text") return raw;
  throw new Error("--input-mode must be audio or text.");
}

function providerOption(values: Map<string, string>): VoiceAgentProvider {
  const raw = stringOption(values, "provider", VOICE_AGENT_PROVIDER_GEMINI_LIVE);
  if (
    raw === VOICE_AGENT_PROVIDER_GEMINI_LIVE ||
    raw === VOICE_AGENT_PROVIDER_OPENAI_REALTIME ||
    raw === VOICE_AGENT_PROVIDER_GROK_REALTIME
  ) {
    return raw;
  }
  throw new Error(
    `--provider must be ${VOICE_AGENT_PROVIDER_GEMINI_LIVE}, ${VOICE_AGENT_PROVIDER_OPENAI_REALTIME}, or ${VOICE_AGENT_PROVIDER_GROK_REALTIME}.`,
  );
}

function modelOption(values: Map<string, string>) {
  const explicit = optionalStringOption(values, "model");
  if (explicit) return explicit;
  switch (providerOption(values)) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return DEFAULT_GEMINI_LIVE_MODEL;
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return DEFAULT_OPENAI_REALTIME_MODEL;
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return DEFAULT_GROK_REALTIME_MODEL;
  }
}

function voiceOption(values: Map<string, string>) {
  const explicit = optionalStringOption(values, "voice");
  if (explicit) return explicit;
  switch (providerOption(values)) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return DEFAULT_GEMINI_LIVE_VOICE;
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return DEFAULT_OPENAI_REALTIME_VOICE;
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return DEFAULT_GROK_REALTIME_VOICE;
  }
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

function parseArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey ?? "";
    if (!key) throw new Error(`Invalid option: ${arg}`);
    if (inlineValue != null) {
      values.set(key, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next == null || next.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, next);
    index += 1;
  }
  return values;
}

function stringOption(values: Map<string, string>, key: string, fallback: string) {
  const value = values.get(key) ?? fallback;
  if (!value.trim()) throw new Error(`--${key} is required.`);
  return value.trim();
}

function optionalStringOption(values: Map<string, string>, key: string) {
  const value = values.get(key)?.trim();
  return value ? value : null;
}

function numberOption(values: Map<string, string>, key: string, fallback: number) {
  const raw = values.get(key) ?? String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${key} must be a positive number.`);
  }
  return value;
}

function booleanOption(values: Map<string, string>, key: string, fallback: boolean) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  throw new Error(`--${key} must be true or false.`);
}

function requireProjectSlugOrId(value: string | null) {
  if (!value) throw new Error("--project is required when --create-project=false.");
  return value;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
