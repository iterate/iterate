import { describe, expect, test } from "vitest";
import { KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE } from "../userspace/config-worker/provider-event-stream.ts";
import {
  completedProviderToolCall,
  completedProviderOutputTranscript,
  parseProductionGrokProviderEvents,
} from "./production-grok-provider-events.ts";

describe("production Grok provider event evidence", () => {
  test("returns the exact ordered raw frames for only the current PCM session", () => {
    /*
     * A project stream outlives every worker and provider generation. The
     * proof must select by session identity—not merely recent offsets—so an
     * earlier model's transcript cannot make a failed current run look good.
     */
    const responseDoneRaw = '{"type":"response.done"}';
    const events = [
      {
        createdAt: "2026-07-31T22:00:00.000Z",
        offset: 41,
        path: "/devices/m5sticks3",
        payload: {
          providerType: "response.done",
          raw: responseDoneRaw,
          receivedAtMs: 2_000,
          sequence: 2,
          sessionId: "current",
        },
        type: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
      },
      {
        createdAt: "2026-07-31T21:59:59.000Z",
        offset: 40,
        path: "/devices/m5sticks3",
        payload: {
          providerType: "error",
          raw: '{"type":"error"}',
          receivedAtMs: 1_000,
          sequence: 9,
          sessionId: "old",
        },
        type: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
      },
      {
        createdAt: "2026-07-31T22:00:00.000Z",
        offset: 39,
        path: "/devices/m5sticks3",
        payload: {
          providerType: "input_audio_buffer.committed",
          raw: '{"type":"input_audio_buffer.committed"}',
          receivedAtMs: 1_500,
          sequence: 1,
          sessionId: "current",
        },
        type: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
      },
    ];

    expect(parseProductionGrokProviderEvents(events, "current")).toEqual([
      {
        createdAt: "2026-07-31T22:00:00.000Z",
        offset: 39,
        providerType: "input_audio_buffer.committed",
        raw: '{"type":"input_audio_buffer.committed"}',
        receivedAtMs: 1_500,
        sequence: 1,
        sessionId: "current",
      },
      {
        createdAt: "2026-07-31T22:00:00.000Z",
        offset: 41,
        providerType: "response.done",
        raw: responseDoneRaw,
        receivedAtMs: 2_000,
        sequence: 2,
        sessionId: "current",
      },
    ]);
  });

  test("extracts the completed spoken transcript from the exact raw frame", () => {
    /*
     * The acoustic oracle must compare the microphone's independent STT result
     * with what Grok says it synthesized. Deriving that expectation from the
     * raw stream—not a prompt literal or worker summary—keeps provider output
     * as the source of truth even when Grok legitimately changes its wording.
     */
    const raw = JSON.stringify({
      transcript: "The physical Stick spoke this sentence.",
      type: "response.output_audio_transcript.done",
    });
    const events = [
      {
        createdAt: "2026-07-31T22:00:00.000Z",
        offset: 41,
        providerType: "response.output_audio_transcript.done",
        raw,
        receivedAtMs: 2_000,
        sequence: 1,
        sessionId: "current",
      },
    ];

    expect(completedProviderOutputTranscript(events)).toBe(
      "The physical Stick spoke this sentence.",
    );
  });

  test("rejects a missing or malformed completed spoken transcript", () => {
    expect(() => completedProviderOutputTranscript([])).toThrow(
      "completed output-audio transcript",
    );
    expect(() =>
      completedProviderOutputTranscript([
        {
          createdAt: "2026-07-31T22:00:00.000Z",
          offset: 41,
          providerType: "response.output_audio_transcript.done",
          raw: '{"type":"response.output_audio_transcript.done","transcript":""}',
          receivedAtMs: 2_000,
          sequence: 1,
          sessionId: "current",
        },
      ]),
    ).toThrow("non-empty transcript");
  });

  test("correlates a successful tool result with the raw Grok call id", () => {
    /*
     * The model saying it changed a colour is not proof. The event journal
     * must contain both Grok's call and the later function_call_output that
     * carries the device acknowledgement, even when that acknowledgement is
     * the terminal event after an already-spoken response.done.
     */
    const event = (sequence: number, providerType: string, raw: Record<string, unknown>) => ({
      createdAt: "2026-07-31T22:00:00.000Z",
      offset: 40 + sequence,
      providerType,
      raw: JSON.stringify({ type: providerType, ...raw }),
      receivedAtMs: 2_000 + sequence,
      sequence,
      sessionId: "current",
    });
    const events = [
      event(1, "response.function_call_arguments.done", {
        arguments: '{"colour":"green"}',
        call_id: "call_green",
        name: "changeColour",
      }),
      event(2, "response.done", {}),
      event(3, "conversation.item.added", {
        item: {
          call_id: "call_green",
          output: '{"colour":"green","ok":true}',
          type: "function_call_output",
        },
      }),
    ];

    expect(completedProviderToolCall(events, "changeColour")).toEqual({
      arguments: { colour: "green" },
      callId: "call_green",
      output: { colour: "green", ok: true },
    });
  });
});
