import { describe, expect, it } from "vitest";
import type { ProcessorStreamApi, StreamEvent, StreamEventInput } from "../stream-processor.ts";
import {
  AGENT_INPUT_ADDED_EVENT_TYPE,
  DEFAULT_GROK_REALTIME_MODEL,
  DEFAULT_GROK_REALTIME_VOICE,
  VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VoiceAgentProcessorContract,
  type VoiceAgentState,
} from "./contract.ts";
import { createVoiceAgentProviderProcessor } from "./implementation.ts";

describe("createVoiceAgentProviderProcessor", () => {
  it("lets Grok ask the colocated code agent through a realtime tool call", async () => {
    const socket = new FakeWebSocket();
    const appended: StreamEventInput[] = [];
    const processor = createVoiceAgentProviderProcessor({
      geminiApiKey: "",
      openAiApiKey: "",
      openGrokRealtimeWebSocket: async () => socket as unknown as WebSocket,
      openOpenAiRealtimeWebSocket: undefined,
      openGeminiLiveWebSocket: undefined,
      processorSlug: "voice-agent/grok-realtime",
      provider: VOICE_AGENT_PROVIDER_GROK_REALTIME,
      xAiApiKey: "xai_test",
    });

    const afterAppend = processor.implementation.afterAppend?.({
      event: committedEvent({
        type: VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
        payload: { text: "Ask the agent to check the repo." },
      }),
      previousState: voiceAgentState(),
      state: voiceAgentState(),
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
            name: "ask_agent",
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
            name: "ask_agent",
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
          idempotencyKey: expect.stringContaining("grok-ask-agent:call_123:agent-input"),
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
        { type: "response.create" },
      ]),
    );
  });
});

function voiceAgentState(): VoiceAgentState {
  return VoiceAgentProcessorContract.stateSchema.parse({
    setup: {
      provider: VOICE_AGENT_PROVIDER_GROK_REALTIME,
      model: DEFAULT_GROK_REALTIME_MODEL,
      voiceName: DEFAULT_GROK_REALTIME_VOICE,
      systemInstruction: "You are concise.",
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
    streamPath: "/voice-agents/test",
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
