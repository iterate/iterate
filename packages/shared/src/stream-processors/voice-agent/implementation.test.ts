import { describe, expect, it } from "vitest";
import {
  getInitialProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import {
  AGENT_INPUT_ADDED_EVENT_TYPE,
  VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE,
  VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE,
  VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
  VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
  VoiceAgentProcessorContract,
  type VoiceAgentProvider,
  type VoiceAgentSetup,
  type VoiceAgentState,
} from "./contract.ts";
import {
  createVoiceAgentProcessor,
  redactLargeStringsForAudit,
  resamplePcm16Base64,
} from "./implementation.ts";

describe("createVoiceAgentProcessor", () => {
  it("lets Gemini ask the colocated code agent through a Live API tool call", async () => {
    const harness = createHarness(VOICE_AGENT_PROVIDER_GEMINI_LIVE);

    const afterAppend = harness.ingestText("Ask the agent to check the repo.");

    await waitFor(() => harness.socket.sent.length === 1);
    expect(harness.socket.sent[0]).toMatchObject({
      setup: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "messageAgent",
              },
            ],
          },
        ],
      },
    });

    harness.socket.receive({ setupComplete: {} });
    await afterAppend;

    harness.socket.receive({
      toolCall: {
        functionCalls: [
          {
            name: "messageAgent",
            id: "call_123",
            args: { message: "Please inspect the failing tests." },
          },
        ],
      },
    });

    await waitFor(() =>
      harness.appended.some((event) => event.type === AGENT_INPUT_ADDED_EVENT_TYPE),
    );
    expect(harness.appended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: AGENT_INPUT_ADDED_EVENT_TYPE,
          idempotencyKey: expect.stringContaining("gemini-live:message-agent:call_123:agent-input"),
          payload: {
            content: "Please inspect the failing tests.",
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        }),
      ]),
    );
    await waitFor(() =>
      harness.socket.sent.some(
        (message) => (message as { toolResponse?: unknown }).toolResponse != null,
      ),
    );
    expect(harness.socket.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolResponse: {
            functionResponses: [
              expect.objectContaining({
                id: "call_123",
                name: "messageAgent",
              }),
            ],
          },
        }),
      ]),
    );
  });

  it("forces Gemini to call messageAgent through the system instruction when required", async () => {
    const harness = createHarness(VOICE_AGENT_PROVIDER_GEMINI_LIVE, {
      messageAgentToolChoice: "required",
    });

    void harness.ingestText("Ask the agent to check the repo.");

    await waitFor(() => harness.socket.sent.length === 1);
    // Gemini Live v1beta rejects toolConfig in setup, so "required" rides on the
    // system instruction instead.
    const setup = harness.socket.sent[0] as {
      setup: { systemInstruction: { parts: Array<{ text: string }> }; toolConfig?: unknown };
    };
    expect(setup.setup.toolConfig).toBeUndefined();
    expect(setup.setup.systemInstruction.parts[0]?.text).toContain(
      "MUST call the messageAgent tool",
    );
  });

  it.each([
    { label: "OpenAI", provider: VOICE_AGENT_PROVIDER_OPENAI_REALTIME },
    { label: "Grok", provider: VOICE_AGENT_PROVIDER_GROK_REALTIME },
  ] satisfies Array<{ label: string; provider: VoiceAgentProvider }>)(
    "lets $label ask the colocated code agent through a realtime function call",
    async ({ provider }) => {
      const harness = createHarness(provider);

      const afterAppend = harness.ingestText("Ask the agent to check the repo.");

      await waitFor(() => harness.socket.sent.length === 1);
      expect(harness.socket.sent[0]).toMatchObject({
        type: "session.update",
        session: {
          tools: [
            {
              type: "function",
              name: "messageAgent",
            },
          ],
        },
      });

      harness.socket.receive({ type: "session.updated" });
      await afterAppend;

      harness.socket.receive({
        type: "response.done",
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              name: "messageAgent",
              call_id: "call_123",
              arguments: JSON.stringify({ message: "Please inspect the failing tests." }),
            },
          ],
        },
      });

      await waitFor(() =>
        harness.appended.some((event) => event.type === AGENT_INPUT_ADDED_EVENT_TYPE),
      );
      expect(harness.appended).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: AGENT_INPUT_ADDED_EVENT_TYPE,
            idempotencyKey: expect.stringContaining(
              `${provider}:message-agent:call_123:agent-input`,
            ),
            payload: {
              content: "Please inspect the failing tests.",
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          }),
        ]),
      );
      await waitFor(() =>
        harness.socket.sent.some(
          (message) => (message as { type?: unknown }).type === "response.create",
        ),
      );
      expect(harness.socket.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "conversation.item.create",
            item: expect.objectContaining({
              type: "function_call_output",
              call_id: "call_123",
            }),
          }),
          expect.objectContaining({ type: "response.create" }),
        ]),
      );
    },
  );

  it.each([
    { label: "Gemini", provider: VOICE_AGENT_PROVIDER_GEMINI_LIVE },
    { label: "OpenAI", provider: VOICE_AGENT_PROVIDER_OPENAI_REALTIME },
    { label: "Grok", provider: VOICE_AGENT_PROVIDER_GROK_REALTIME },
  ] satisfies Array<{ label: string; provider: VoiceAgentProvider }>)(
    "wraps $label code-agent text so the voice model relays it to the caller",
    async ({ provider }) => {
      const harness = createHarness(provider);

      const afterAppend = harness.ingestText("What occupation should I put on your profile?", {
        source: "code-agent",
      });

      await waitFor(() => harness.socket.sent.length === 1);
      harness.socket.receive(
        provider === VOICE_AGENT_PROVIDER_GEMINI_LIVE
          ? { setupComplete: {} }
          : { type: "session.updated" },
      );
      await afterAppend;

      const providerText = providerSentText(harness.socket.sent, provider);
      expect(providerText).toContain(
        "BACKGROUND AGENT MESSAGE TO RELAY TO THE HUMAN YOU ARE SPEAKING TO:",
      );
      expect(providerText).toContain("What occupation should I put on your profile?");
      expect(providerText).toContain("This message is not from the caller.");
      expect(providerText).toContain("ask that question to the human you are speaking to");
      expect(providerText).toContain("Do not say thanks, thank you");
    },
  );

  it("forwards Gemini input audio verbatim and redacts it in the audit event", async () => {
    const harness = createHarness(VOICE_AGENT_PROVIDER_GEMINI_LIVE);
    const dataBase64 = pcm16ToBase64(Array.from({ length: 400 }, (_, index) => index));

    const afterAppend = harness.ingestAudio(dataBase64);
    await waitFor(() => harness.socket.sent.length === 1);
    harness.socket.receive({ setupComplete: {} });
    await afterAppend;

    expect(harness.socket.sent[1]).toMatchObject({
      realtimeInput: {
        audio: {
          data: dataBase64,
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });

    await waitFor(() =>
      harness.appended.some((event) => {
        if (event.type !== "events.iterate.com/voice-agent/provider-message-sent") return false;
        const message = (event.payload as { message?: { realtimeInput?: unknown } }).message;
        return message?.realtimeInput != null;
      }),
    );
    const audit = harness.appended.find((event) => {
      if (event.type !== "events.iterate.com/voice-agent/provider-message-sent") return false;
      const message = (event.payload as { message?: { realtimeInput?: unknown } }).message;
      return message?.realtimeInput != null;
    });
    if (audit == null) throw new Error("Expected a provider-message-sent audit event.");
    const auditedData = (
      audit.payload as {
        message: { realtimeInput: { audio: { data: string } } };
      }
    ).message.realtimeInput.audio.data;
    expect(auditedData).toContain("more chars redacted");
    expect(auditedData.length).toBeLessThan(dataBase64.length);
  });

  it("resamples input audio to 24 kHz for OpenAI and passes Grok audio through", async () => {
    const samples = Array.from({ length: 160 }, (_, index) => index * 10);
    const dataBase64 = pcm16ToBase64(samples);

    const openAi = createHarness(VOICE_AGENT_PROVIDER_OPENAI_REALTIME);
    const openAiAfterAppend = openAi.ingestAudio(dataBase64);
    await waitFor(() => openAi.socket.sent.length === 1);
    openAi.socket.receive({ type: "session.updated" });
    await openAiAfterAppend;
    const openAiAudio = (openAi.socket.sent[1] as { audio: string }).audio;
    expect(base64ToPcm16(openAiAudio).length).toBe(Math.round(samples.length * 1.5));

    const grok = createHarness(VOICE_AGENT_PROVIDER_GROK_REALTIME);
    const grokAfterAppend = grok.ingestAudio(dataBase64);
    await waitFor(() => grok.socket.sent.length === 1);
    grok.socket.receive({ type: "session.updated" });
    await grokAfterAppend;
    expect((grok.socket.sent[1] as { audio: string }).audio).toBe(dataBase64);
  });

  it("appends provider output audio frames in provider order", async () => {
    const harness = createHarness(VOICE_AGENT_PROVIDER_GEMINI_LIVE);
    const afterAppend = harness.ingestText("Say something.");
    await waitFor(() => harness.socket.sent.length === 1);
    harness.socket.receive({ setupComplete: {} });
    await afterAppend;

    const first = pcm16ToBase64([1, 2, 3, 4]);
    const second = pcm16ToBase64([5, 6, 7, 8]);
    harness.socket.receive({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: first } }] } },
    });
    harness.socket.receive({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: second } }] } },
    });

    await waitFor(
      () =>
        harness.appended.filter(
          (event) => event.type === VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
        ).length === 2,
    );
    const frames = harness.appended
      .filter((event) => event.type === VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE)
      .map((event) => event.payload as { dataBase64: string; sequence: number });
    expect(frames[0]).toMatchObject({ dataBase64: first, sequence: 0 });
    expect(frames[1]).toMatchObject({ dataBase64: second, sequence: 1 });
  });

  it("requests a speaker buffer clear when Gemini output is interrupted", async () => {
    const harness = createHarness(VOICE_AGENT_PROVIDER_GEMINI_LIVE);
    const afterAppend = harness.ingestText("Say something.");
    await waitFor(() => harness.socket.sent.length === 1);
    harness.socket.receive({ setupComplete: {} });
    await afterAppend;

    harness.socket.receive({ serverContent: { interrupted: true } });

    await waitFor(() =>
      harness.appended.some(
        (event) => event.type === VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
      ),
    );
    expect(harness.appended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
          payload: expect.objectContaining({ reason: "output-interrupted" }),
        }),
        expect.objectContaining({
          type: VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE,
          payload: expect.objectContaining({ status: "output-interrupted" }),
        }),
      ]),
    );
  });

  it("requests a speaker buffer clear when OpenAI-compatible speech starts", async () => {
    const harness = createHarness(VOICE_AGENT_PROVIDER_OPENAI_REALTIME);
    const afterAppend = harness.ingestText("Say something.");
    await waitFor(() => harness.socket.sent.length === 1);
    harness.socket.receive({ type: "session.updated" });
    await afterAppend;

    harness.socket.receive({ type: "input_audio_buffer.speech_started" });

    await waitFor(() =>
      harness.appended.some(
        (event) => event.type === VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
      ),
    );
    expect(harness.appended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
          payload: expect.objectContaining({ reason: "input-speech-started" }),
        }),
      ]),
    );
  });

  it("surfaces Gemini goAway as a going-away status event", async () => {
    const harness = createHarness(VOICE_AGENT_PROVIDER_GEMINI_LIVE);
    const afterAppend = harness.ingestText("Say something.");
    await waitFor(() => harness.socket.sent.length === 1);
    harness.socket.receive({ setupComplete: {} });
    await afterAppend;

    harness.socket.receive({ goAway: { timeLeft: "10s" } });

    await waitFor(() =>
      harness.appended.some(
        (event) =>
          event.type === VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE &&
          (event.payload as { status?: unknown }).status === "going-away",
      ),
    );
  });

  it("wakes the code agent at most once per processor instance", async () => {
    let ensureCalls = 0;
    const socket = new FakeWebSocket();
    const appended: StreamEventInput[] = [];
    const processor = createVoiceAgentProcessor({
      geminiApiKey: "gemini_test",
      openAiApiKey: "openai_test",
      xAiApiKey: "xai_test",
      ensureCodeAgent: async () => {
        ensureCalls += 1;
      },
      openProviderWebSocket: async () => socket as unknown as WebSocket,
    });
    const state = voiceAgentState(VOICE_AGENT_PROVIDER_GEMINI_LIVE);

    for (const text of ["First.", "Second."]) {
      const afterAppend = processor.implementation.afterAppend?.({
        event: committedEvent({
          type: VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
          payload: { text },
        }),
        previousState: state,
        state,
        streamApi: testStreamApi(appended),
        signal: new AbortController().signal,
      });
      await waitFor(() => socket.sent.length >= 1);
      socket.receive({ setupComplete: {} });
      await afterAppend;
    }

    expect(ensureCalls).toBe(1);
  });
});

describe("VoiceAgentProcessorContract.reduce", () => {
  type ContractReduce = NonNullable<typeof VoiceAgentProcessorContract.reduce>;

  function reduceContractEvent(event: Parameters<ContractReduce>[0]["event"]) {
    const reduce = VoiceAgentProcessorContract.reduce;
    if (reduce == null) throw new Error("VoiceAgentProcessorContract must define reduce.");
    const initial = getInitialProcessorState(VoiceAgentProcessorContract);
    return (
      reduce({
        contract: VoiceAgentProcessorContract,
        state: initial,
        event,
      }) ?? initial
    );
  }

  it("stores parsed setup from setup-configured", () => {
    const payload = VoiceAgentProcessorContract.events[
      VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE
    ].payloadSchema.parse({ provider: VOICE_AGENT_PROVIDER_OPENAI_REALTIME });

    const next = reduceContractEvent(
      committedEvent({
        type: VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
        payload,
      }),
    );

    expect(next.setup?.provider).toBe(VOICE_AGENT_PROVIDER_OPENAI_REALTIME);
    expect(next.setup?.model.length).toBeGreaterThan(0);
  });

  it("maps legacy config-updated onto a Gemini setup", () => {
    const payload = VoiceAgentProcessorContract.events[
      VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE
    ].payloadSchema.parse({});

    const next = reduceContractEvent(
      committedEvent({
        type: VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE,
        payload,
      }),
    );

    expect(next.setup?.provider).toBe(VOICE_AGENT_PROVIDER_GEMINI_LIVE);
  });
});

describe("resamplePcm16Base64", () => {
  it("returns the input untouched when rates match", () => {
    const dataBase64 = pcm16ToBase64([1, 2, 3]);
    expect(resamplePcm16Base64({ dataBase64, fromSampleRate: 16_000, toSampleRate: 16_000 })).toBe(
      dataBase64,
    );
  });

  it("linearly interpolates when upsampling 16 kHz to 24 kHz", () => {
    const dataBase64 = pcm16ToBase64([0, 300, 600]);
    const result = base64ToPcm16(
      resamplePcm16Base64({ dataBase64, fromSampleRate: 16_000, toSampleRate: 24_000 }),
    );
    expect(result).toEqual([0, 200, 400, 600, 600]);
  });
});

describe("redactLargeStringsForAudit", () => {
  it("truncates long strings anywhere in the structure and keeps short ones", () => {
    const long = "x".repeat(5_000);
    const redacted = redactLargeStringsForAudit({
      keep: "short string",
      audio: long,
      nested: [{ delta: long }],
    }) as { keep: string; audio: string; nested: [{ delta: string }] };

    expect(redacted.keep).toBe("short string");
    expect(redacted.audio).toContain("more chars redacted");
    expect(redacted.audio.length).toBeLessThan(200);
    expect(redacted.nested[0].delta).toContain("more chars redacted");
  });
});

type Harness = {
  socket: FakeWebSocket;
  appended: StreamEventInput[];
  ingestText: (text: string, options?: { source?: string }) => Promise<void>;
  ingestAudio: (dataBase64: string) => Promise<void>;
};

function createHarness(
  provider: VoiceAgentProvider,
  setupOverrides: Partial<VoiceAgentSetup> = {},
): Harness {
  const socket = new FakeWebSocket();
  const appended: StreamEventInput[] = [];
  const processor = createVoiceAgentProcessor({
    geminiApiKey: "gemini_test",
    openAiApiKey: "openai_test",
    xAiApiKey: "xai_test",
    openProviderWebSocket: async () => socket as unknown as WebSocket,
  });
  const state = voiceAgentState(provider, setupOverrides);
  const streamApi = testStreamApi(appended);

  const ingest = async (event: StreamEvent) => {
    await processor.implementation.afterAppend?.({
      event: event as never,
      previousState: state,
      state,
      streamApi,
      signal: new AbortController().signal,
    });
  };

  return {
    socket,
    appended,
    ingestText: (text, options = {}) =>
      ingest(
        committedEvent({
          type: VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
          payload: { text, ...(options.source == null ? {} : { source: options.source }) },
        }),
      ),
    ingestAudio: (dataBase64) =>
      ingest(
        committedEvent({
          type: VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
          payload: {
            streamId: "client-1",
            sequence: 0,
            encoding: "pcm_s16le",
            sampleRate: 16_000,
            channels: 1,
            durationMs: 100,
            dataBase64,
          },
        }),
      ),
  };
}

function providerSentText(sent: unknown[], provider: VoiceAgentProvider) {
  if (provider === VOICE_AGENT_PROVIDER_GEMINI_LIVE) {
    const message = sent.find(
      (candidate) => (candidate as { clientContent?: unknown }).clientContent != null,
    ) as { clientContent?: { turns?: Array<{ parts?: Array<{ text?: string }> }> } } | undefined;
    return message?.clientContent?.turns?.[0]?.parts?.[0]?.text ?? "";
  }

  const message = sent.find(
    (candidate) => (candidate as { type?: unknown }).type === "conversation.item.create",
  ) as { item?: { content?: Array<{ type?: string; text?: string }> } } | undefined;
  return message?.item?.content?.find((part) => part.type === "input_text")?.text ?? "";
}

function voiceAgentState(
  provider: VoiceAgentProvider,
  overrides: Partial<VoiceAgentSetup> = {},
): VoiceAgentState {
  return VoiceAgentProcessorContract.stateSchema.parse({
    setup: {
      provider,
      systemInstruction: "You are concise.",
      ...overrides,
    },
  });
}

function testStreamApi(
  appended: StreamEventInput[],
): ProcessorStreamApi<typeof VoiceAgentProcessorContract> {
  return {
    append: async ({ event }) => {
      appended.push(event);
      return committedEvent(event as StreamEventInput);
    },
    appendBatch: async ({ events }) => {
      const committed: StreamEvent[] = [];
      for (const event of events) {
        appended.push(event);
        committed.push(committedEvent(event as StreamEventInput));
      }
      return committed;
    },
    read: async () => [],
    subscribe: async function* () {},
  } as ProcessorStreamApi<typeof VoiceAgentProcessorContract>;
}

function committedEvent<const Type extends string, Payload>(
  input: StreamEventInput<Type, Payload>,
  offset = 1,
): StreamEvent<Type, Payload> {
  return {
    createdAt: "2026-05-19T00:00:00.000Z",
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
    offset,
    payload: input.payload,
    streamPath: "/agents/voice/test",
    type: input.type,
  };
}

function pcm16ToBase64(samples: number[]) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToPcm16(base64: string) {
  const binary = atob(base64);
  const samples: number[] = [];
  for (let index = 0; index + 1 < binary.length; index += 2) {
    const low = binary.charCodeAt(index);
    const high = binary.charCodeAt(index + 1);
    const value = (high << 8) | low;
    samples.push(value >= 0x8000 ? value - 0x10000 : value);
  }
  return samples;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
}

class FakeWebSocket {
  readonly sent: unknown[] = [];
  readyState = 1;
  #listeners = new Map<string, EventListener[]>();

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  receive(message: unknown) {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) } as MessageEvent);
    }
  }
}
