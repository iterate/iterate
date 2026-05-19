import { describe, expect, it } from "vitest";
import type { ProcessorStreamApi, StreamEvent, StreamEventInput } from "../stream-processor.ts";
import {
  AGENT_INPUT_ADDED_EVENT_TYPE,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_VOICE,
  DEFAULT_GROK_REALTIME_MODEL,
  DEFAULT_GROK_REALTIME_VOICE,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_REALTIME_VOICE,
  VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  VoiceAgentProcessorContract,
  type VoiceAgentProvider,
  type VoiceAgentState,
} from "./contract.ts";
import { createVoiceAgentProviderProcessor } from "./implementation.ts";

describe("createVoiceAgentProviderProcessor", () => {
  it("lets Gemini ask the colocated code agent through a Live API tool call", async () => {
    const socket = new FakeWebSocket();
    const appended: StreamEventInput[] = [];
    const processor = providerProcessor({
      provider: VOICE_AGENT_PROVIDER_GEMINI_LIVE,
      socket,
    });

    const afterAppend = processor.implementation.afterAppend?.({
      event: committedEvent({
        type: VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
        payload: { text: "Ask the agent to check the repo." },
      }),
      previousState: voiceAgentState(VOICE_AGENT_PROVIDER_GEMINI_LIVE),
      state: voiceAgentState(VOICE_AGENT_PROVIDER_GEMINI_LIVE),
      streamApi: testStreamApi(appended),
      signal: new AbortController().signal,
    });

    await waitFor(() => socket.sent.length === 1);
    expect(socket.sent[0]).toMatchObject({
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

    socket.receive({ setupComplete: {} });
    await afterAppend;

    socket.receive({
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

    await waitFor(() => appended.some((event) => event.type === AGENT_INPUT_ADDED_EVENT_TYPE));
    expect(appended).toEqual(
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
    expect(socket.sent).toEqual(
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

  it.each([
    { label: "OpenAI", provider: VOICE_AGENT_PROVIDER_OPENAI_REALTIME },
    { label: "Grok", provider: VOICE_AGENT_PROVIDER_GROK_REALTIME },
  ] satisfies Array<{ label: string; provider: VoiceAgentProvider }>)(
    "lets $label ask the colocated code agent through a realtime function call",
    async ({ provider }) => {
      const socket = new FakeWebSocket();
      const appended: StreamEventInput[] = [];
      const processor = providerProcessor({ provider, socket });

      const afterAppend = processor.implementation.afterAppend?.({
        event: committedEvent({
          type: VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
          payload: { text: "Ask the agent to check the repo." },
        }),
        previousState: voiceAgentState(provider),
        state: voiceAgentState(provider),
        streamApi: testStreamApi(appended),
        signal: new AbortController().signal,
      });

      await waitFor(() => socket.sent.length === 1);
      expect(socket.sent[0]).toMatchObject({
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

      socket.receive({ type: "session.updated" });
      await afterAppend;

      socket.receive({
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

      await waitFor(() => appended.some((event) => event.type === AGENT_INPUT_ADDED_EVENT_TYPE));
      expect(appended).toEqual(
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
      expect(socket.sent).toEqual(
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
      const socket = new FakeWebSocket();
      const processor = providerProcessor({ provider, socket });

      const afterAppend = processor.implementation.afterAppend?.({
        event: committedEvent({
          type: VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
          payload: {
            source: "code-agent",
            text: "What occupation should I put on your profile?",
          },
        }),
        previousState: voiceAgentState(provider),
        state: voiceAgentState(provider),
        streamApi: testStreamApi([]),
        signal: new AbortController().signal,
      });

      await waitFor(() => socket.sent.length === 1);
      socket.receive(
        provider === VOICE_AGENT_PROVIDER_GEMINI_LIVE
          ? { setupComplete: {} }
          : { type: "session.updated" },
      );
      await afterAppend;

      const providerText = providerSentText(socket.sent, provider);
      expect(providerText).toContain(
        "BACKGROUND AGENT MESSAGE TO RELAY TO THE HUMAN YOU ARE SPEAKING TO:",
      );
      expect(providerText).toContain("What occupation should I put on your profile?");
      expect(providerText).toContain("This message is not from the caller.");
      expect(providerText).toContain("ask that question to the human you are speaking to");
      expect(providerText).toContain("Do not say thanks, thank you");
    },
  );
});

function providerProcessor(input: { provider: VoiceAgentProvider; socket: FakeWebSocket }) {
  return createVoiceAgentProviderProcessor({
    geminiApiKey: "gemini_test",
    openAiApiKey: "openai_test",
    openGeminiLiveWebSocket:
      input.provider === VOICE_AGENT_PROVIDER_GEMINI_LIVE
        ? async () => input.socket as unknown as WebSocket
        : undefined,
    openGrokRealtimeWebSocket:
      input.provider === VOICE_AGENT_PROVIDER_GROK_REALTIME
        ? async () => input.socket as unknown as WebSocket
        : undefined,
    openOpenAiRealtimeWebSocket:
      input.provider === VOICE_AGENT_PROVIDER_OPENAI_REALTIME
        ? async () => input.socket as unknown as WebSocket
        : undefined,
    processorSlug: `voice-agent/${input.provider}`,
    provider: input.provider,
    xAiApiKey: "xai_test",
  });
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

function voiceAgentState(provider: VoiceAgentProvider): VoiceAgentState {
  const providerDefaults = providerConfigDefaults(provider);
  return VoiceAgentProcessorContract.stateSchema.parse({
    setup: {
      provider,
      model: providerDefaults.model,
      voiceName: providerDefaults.voiceName,
      systemInstruction: "You are concise.",
    },
  });
}

function providerConfigDefaults(provider: VoiceAgentProvider) {
  switch (provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return {
        model: DEFAULT_GEMINI_LIVE_MODEL,
        voiceName: DEFAULT_GEMINI_LIVE_VOICE,
      };
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return {
        model: DEFAULT_OPENAI_REALTIME_MODEL,
        voiceName: DEFAULT_OPENAI_REALTIME_VOICE,
      };
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return {
        model: DEFAULT_GROK_REALTIME_MODEL,
        voiceName: DEFAULT_GROK_REALTIME_VOICE,
      };
  }
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
