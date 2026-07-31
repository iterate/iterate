import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_KIT_DEVICE_ID,
  KIT_DEVICE_EVENT_STREAM_PATH,
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  ProviderEventStreamJournal,
  kitDeviceEventStreamPath,
} from "./provider-event-stream.ts";

describe("Grok non-PCM event stream journal", () => {
  test("keeps each authenticated device's provider evidence in its own stream", () => {
    expect(DEFAULT_KIT_DEVICE_ID).toBe("m5sticks3");
    expect(KIT_DEVICE_EVENT_STREAM_PATH).toBe("/devices/m5sticks3");
    expect(kitDeviceEventStreamPath("m5sticks3")).toBe("/devices/m5sticks3");
    expect(kitDeviceEventStreamPath("stackchan")).toBe("/devices/stackchan");
  });

  test.each(["", "StackChan", "-stackchan", "stackchan-", "stack/chan", "a".repeat(64)])(
    "rejects ambiguous device identity %j before constructing a stream path",
    (deviceId) => {
      /*
       * The device identity selects both an RPC child and a durable evidence
       * stream. Accepting a slash, an empty segment, or a second spelling here
       * would let a CLI read evidence from a path the authenticated worker can
       * never own, or silently attribute one board's run to another.
       */
      expect(() => kitDeviceEventStreamPath(deviceId)).toThrow("device id");
    },
  );
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
