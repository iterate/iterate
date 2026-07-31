import { describe, expect, test, vi } from "vitest";
import {
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  ProviderEventStreamJournal,
  kitDeviceEventStreamPath,
} from "./provider-event-stream.ts";

describe("Grok non-PCM event stream journal", () => {
  test("keeps each authenticated device's provider evidence in its own stream", () => {
    expect(kitDeviceEventStreamPath("m5sticks3")).toBe("/devices/m5sticks3");
    expect(kitDeviceEventStreamPath("stackchan")).toBe("/devices/stackchan");
  });
  test("appends the exact provider frame with its session and ordering coordinates", async () => {
    /*
     * This is the durable harness seam: an operator must be able to read what
     * Grok actually emitted from a normal Iterate stream after the realtime
     * socket is gone. The raw text is the independent source of truth; parsed
     * summaries alone hid the provider's spoken WebSocket failure before.
     */
    const append = vi.fn(async () => undefined);
    const journal = new ProviderEventStreamJournal({ append });
    const raw =
      '{"type":"conversation.item.input_audio_transcription.updated","transcript":"web socket failed"}';

    journal.observe(
      {
        event: JSON.parse(raw),
        raw,
        type: "conversation.item.input_audio_transcription.updated",
      },
      "prj_test:session_one",
      12_345,
    );
    await journal.settled();

    expect(append).toHaveBeenCalledWith({
      idempotencyKey: "kit-provider-event:prj_test:session_one:1",
      payload: {
        providerType: "conversation.item.input_audio_transcription.updated",
        raw,
        receivedAtMs: 12_345,
        sequence: 1,
        sessionId: "prj_test:session_one",
      },
      type: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
    });
    expect(journal.metrics()).toEqual({
      appendFailures: 0,
      appendedEvents: 1,
      droppedEvents: 0,
      lastAppendError: null,
      lastAppendedSequence: 1,
      observedEvents: 1,
      pendingRawBytes: 0,
      pendingEvents: 0,
      pendingRawHighWaterBytes: raw.length,
    });
  });
});
