// Which brief is current, on a stream that is mostly audio.
//
// This is the fourth design of that answer, and the first that cannot be wrong
// by degrees. The three before it all tried to FIND the newest brief by reading,
// and filtered stream reads only go forward:
//
//   1. `getEvents({eventTypes, limit: 500})` reads from offset zero, so it
//      returned the first brief ever installed while claiming to compare the
//      head. A diagnostic tool removed from the device stayed in the prompt.
//   2. A bounded tail, `afterOffset: head - 10_000`, worked until the brief fell
//      out of the window. Two full sessions of audio frames move the head about
//      that far, and session 3 of a ten-session run died with "no brief is at
//      the head" seconds after refreshing one.
//   3. Paging the filter to the end is exact but still walks history, and its
//      page cap is one more arbitrary number.
//
// So setup states the answer: it appends the brief under its own setup identity,
// then a marker naming it, and the processor folds that marker from the same
// filtered delivery a conversation-requested arrives on. The test below is the shape
// that killed designs 1 and 2 — tens of thousands of audio events between
// markers — and the fold does not care how many there are.
import { describe, expect, it } from "vitest";

import { briefMarkerFromEvent } from "./voice-agent.ts";

/** A stream of mostly audio, with markers buried in it. */
function history(markers: { setupId: string; briefKey: string }[], audioBetween: number) {
  const events: { type: string; payload?: unknown }[] = [];
  for (const marker of markers) {
    for (let frame = 0; frame < audioBetween; frame++) {
      /* The bulk: both directions of audio, plus the stats that ride along. */
      events.push({ type: "events.iterate.com/voice-agent/spk-frame", payload: { seq: frame } });
      events.push({ type: "events.iterate.com/voice-agent/mic-frame", payload: { seq: frame } });
      if (frame % 50 === 0)
        events.push({
          type: "events.iterate.com/voice-agent/dev-stats",
          payload: { spkPlayed: frame },
        });
    }
    events.push({
      type: "events.iterate.com/voice-agent/brief-current",
      payload: { ...marker, contentHash: `hash-of-${marker.setupId}` },
    });
  }
  return events;
}

/** Fold exactly as the processor's reduce does: newest marker wins. */
function fold(events: readonly { type: string; payload?: unknown }[]) {
  let current: ReturnType<typeof briefMarkerFromEvent> = null;
  for (const event of events) {
    const marker = briefMarkerFromEvent(event);
    if (marker !== null) current = marker;
  }
  return current;
}

describe("briefMarkerFromEvent", () => {
  it("finds the exact newest brief across >10,000 interleaved audio events", () => {
    const markers = [
      { setupId: "setup-one", briefKey: "voice-agent/brief:aaa:setup:setup-one" },
      { setupId: "setup-two", briefKey: "voice-agent/brief:bbb:setup:setup-two" },
      { setupId: "setup-three", briefKey: "voice-agent/brief:aaa:setup:setup-three" },
    ];
    /* 3 × 2500 frames × 2 directions ≈ 15,000 audio events, half of them
     * between the second marker and the third — comfortably past the window
     * that failed on real hardware. */
    const events = history(markers, 2500);
    const audio = events.filter((event) => event.type.endsWith("-frame")).length;
    expect(audio).toBeGreaterThan(10_000);

    const current = fold(events);
    expect(current).toEqual({
      setupId: "setup-three",
      briefKey: "voice-agent/brief:aaa:setup:setup-three",
      contentHash: "hash-of-setup-three",
    });
  });

  it("distinguishes a prompt that changed and changed back", () => {
    /*
     * THE CASE THE CONTENT-HASH KEY GOT WRONG. A → B → A deduplicated the third
     * append against the first, so the newest brief on the stream stayed B and
     * the model kept being told about a tool that had been removed. Per-setup
     * identities make the third install its own event, and its marker names it.
     */
    const current = fold(
      history(
        [
          { setupId: "s1", briefKey: "voice-agent/brief:A:setup:s1" },
          { setupId: "s2", briefKey: "voice-agent/brief:B:setup:s2" },
          { setupId: "s3", briefKey: "voice-agent/brief:A:setup:s3" },
        ],
        10,
      ),
    );
    expect(current?.setupId).toBe("s3");
    expect(current?.briefKey).toBe("voice-agent/brief:A:setup:s3");
  });

  it("is null before any setup has marked a brief", () => {
    /* Which is what setup's bounded failure reports, rather than acknowledging
     * a brief nobody named. */
    expect(fold(history([], 100))).toBeNull();
    expect(
      fold([{ type: "events.iterate.com/voice-agent/spk-frame", payload: { seq: 1 } }]),
    ).toBeNull();
  });

  it("refuses a marker missing either half of its identity", () => {
    /* Both halves are required: the key alone could belong to an identical brief
     * from another setup, and the setupId alone names no context event. */
    expect(
      briefMarkerFromEvent({ type: "events.iterate.com/voice-agent/brief-current", payload: {} }),
    ).toBeNull();
    expect(
      briefMarkerFromEvent({
        type: "events.iterate.com/voice-agent/brief-current",
        payload: { setupId: "s1" },
      }),
    ).toBeNull();
    expect(
      briefMarkerFromEvent({
        type: "events.iterate.com/voice-agent/brief-current",
        payload: { briefKey: "k", contentHash: "h" },
      }),
    ).toBeNull();
    expect(
      briefMarkerFromEvent({
        type: "events.iterate.com/voice-agent/brief-current",
        payload: { setupId: "", briefKey: "k", contentHash: "h" },
      }),
    ).toBeNull();
  });

  it("ignores every other event type, including one carrying a brief payload", () => {
    /* The type is the whole signal. A context event with the same fields is the
     * brief itself, not the statement about which brief is current. */
    expect(
      briefMarkerFromEvent({
        type: "events.iterate.com/agents/context-added",
        payload: { setupId: "s1", briefKey: "k", contentHash: "h" },
      }),
    ).toBeNull();
  });
});
