/**
 * The voice agent's second cut, against a pretend Grok realtime server.
 *
 * WHAT THE FAKE IS FOR. Every claim this file makes is a claim about a
 * conversation with a provider that behaves badly in specific, observed ways:
 * it fires `speech_started` on echo residue, it finishes generating long before
 * the listener has heard the answer, and it never cancels anything on its own.
 * A fake is the only way to stage those on purpose — and `fetch` is mocked
 * rather than the dial injected, so `dialGrokSocket` itself is under test too.
 *
 * THE SEQUENCE NUMBERS ARE THE POINT. Most of what follows is an assertion
 * about `deviceSpeakerFrameSeq`: that it is contiguous, that a flush names one,
 * and that nothing after a flush's watermark is ever lost. The bug this file
 * exists to prevent — a boolean `drop` chopping an answer it did not mean — is
 * only expressible if those numbers are absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import {
  dialGrokSocket,
  MAX_DEVICE_SPEAKER_BACKLOG_BYTES,
  MAX_SPEAKER_PAYLOAD_BYTES,
  VoiceAgent2Contract,
  VoiceAgent2Processor,
} from "./voice-agent2.ts";

/* ========================================================================== */
/* A PRETEND GROK                                                             */
/* ========================================================================== */

/**
 * 16 kHz mono PCM16: sixteen samples, thirty-two bytes, per millisecond.
 *
 * ONE NUMBER NOW, where there were two. The wire carried mu-law at half this
 * and the ring held PCM16 at all of it, so every length in this file had to
 * say which of the two it meant — and the day it got that wrong the call went
 * silent with nothing logged. Same units end to end is the point of the
 * change.
 */
const PCM16_BYTES_PER_MS = 32;
/**
 * The tick this file advances the clock by, and nothing more.
 *
 * NOT A CONSTANT OF THE SYSTEM. It read "must match the constants in
 * voice-agent2.ts", and the constant it was matching — a fixed 100 ms speaker
 * frame — no longer exists: a frame is now whatever a delta gave us, up to
 * MAX_SPEAKER_PAYLOAD_BYTES. What is left is a step size for the pretend clock,
 * chosen because it is the largest frame the pacer can emit and so advances
 * the drain by exactly one frame per tick.
 */
const SPEAKER_FRAME_MS = MAX_SPEAKER_PAYLOAD_BYTES / PCM16_BYTES_PER_MS;
/* IMPORTED, not re-declared: a copy under a "must match" comment passes
 * silently the day the two diverge. */
const MAX_DEVICE_SPEAKER_BUFFER_MS = MAX_DEVICE_SPEAKER_BACKLOG_BYTES / PCM16_BYTES_PER_MS;
const IDLE_TIMEOUT_MS = 60_000;

/**
 * The pretend provider, and the pretend socket it speaks over.
 *
 * Deliberately not a WebSocket subclass: the facet only ever calls
 * `addEventListener`, `send`, `close` and `accept`, and a fake that offers
 * exactly those is a readable statement of the surface being depended on.
 */
class FakeGrok {
  /** Everything the facet sent us, parsed, oldest first. */
  readonly sent: Record<string, unknown>[] = [];
  /** True once the facet closed its end. */
  closed = false;
  binaryType = "blob";
  accepted = false;

  #listeners = new Map<string, ((event: unknown) => void)[]>();

  accept(): void {
    this.accepted = true;
  }

  addEventListener(kind: string, listener: (event: unknown) => void): void {
    const existing = this.#listeners.get(kind) ?? [];
    existing.push(listener);
    this.#listeners.set(kind, existing);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    for (const listener of this.#listeners.get("close") ?? []) listener({});
  }

  /* ------------------------------------------------- the provider's voice */

  /** Push something the provider should never send: bad JSON, or bytes. */
  pushRaw(data: unknown): void {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data });
  }

  /** Push one raw provider message at the facet. */
  push(message: Record<string, unknown>): void {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }

  /** The two edges that make a session usable. */
  completeHandshake(): void {
    this.push({ type: "session.created" });
    this.push({ type: "session.updated" });
  }

  /**
   * One audio delta carrying `ms` of speech.
   *
   * The samples are a ramp rather than silence so a test that loses audio can
   * say WHICH audio it lost, and so mu-law encoding has something to do.
   */
  answerAudio(ms: number): void {
    const pcm = new Uint8Array(ms * PCM16_BYTES_PER_MS);
    for (let index = 0; index < pcm.length; index++) pcm[index] = index % 251;
    this.push({ type: "response.output_audio.delta", delta: base64(pcm) });
  }

  /** The provider decides somebody in the room is talking. */
  speechStarted(): void {
    this.push({ type: "input_audio_buffer.speech_started" });
  }

  /** A new answer begins. */
  responseCreated(): void {
    this.push({ type: "response.created" });
  }

  /**
   * Generation is finished — which is NOT the same as the listener hearing it.
   *
   * BOTH EDGES, in the order the real provider sends them. The facet acts on
   * `response.output_audio.done`, because that one is specifically about the
   * audio; a fake that sent only `response.done` let two tests pass against a
   * facet that would never have marked the end of an answer at all.
   */
  answerComplete(): void {
    this.push({ type: "response.output_audio.done" });
    this.push({ type: "response.done" });
  }

  /** Everything the facet sent, of one type. */
  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message.type === type);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ========================================================================== */
/* HARNESS                                                                    */
/* ========================================================================== */

/*
 * WHO TAKES THE TURNS is now a setting on the birth certificate, not a guess
 * from the client's name. These two read as the old board names on purpose —
 * the behaviours are the same two behaviours — but nothing about the string
 * decides anything any more, which is the whole repair.
 */
const GROK_LISTENS = false;
const CLIENT_TAKES_TURNS = true;

function makeHarness() {
  /*
   * ONE FAKE SOCKET PER DIAL, because that is what a provider does.
   * Re-using a single fake across an eviction leaves the DEAD incarnation's
   * message listener attached to the same object as the live one, so every
   * push reaches two processors and the suite quietly tests a situation that
   * cannot happen. It also makes "the old socket goes quiet" unassertable.
   */
  const sockets: FakeGrok[] = [];
  const grokDialledUrls: string[] = [];
  /*
   * `fetch` IS THE SEAM, because that is what `dialGrokSocket` uses. Mocking
   * the dial dependency instead would leave the one function that has actually
   * broken in production — the `response.webSocket ?? null` line — untested.
   */
  vi.stubGlobal("fetch", async (url: string) => {
    grokDialledUrls.push(String(url));
    const socket = new FakeGrok();
    sockets.push(socket);
    return { webSocket: socket } as unknown as Response;
  });

  const harness = makeProcessorHarness<VoiceAgent2Contract, VoiceAgent2Processor>({
    path: "/agents/voice/test",
    createProcessor: (deps) =>
      new VoiceAgent2Processor({
        ...deps,
        nowAtFacetMs: deps.now,
        /* The REAL dial, so the mocked `fetch` above is what stands in for the
         * provider — including the `response.webSocket ?? null` line that has
         * broken in production. */
        dialGrok: (baseUrl) => dialGrokSocket(baseUrl),
      }),
  });
  /* `grok` is always the socket of the CURRENT dial; `sockets` is every one
   * ever opened, so a test can address an abandoned socket on purpose. */
  return {
    ...harness,
    sockets,
    get grok() {
      return sockets[sockets.length - 1]!;
    },
    grokDialledUrls,
  };
}

type Harness = ReturnType<typeof makeHarness>;

/* ------------------------------------------------------------ read helpers */
/* Named for the QUESTION they answer, so an assertion reads as a sentence. */

/** Every speaker frame the device was sent, oldest first. */
function speakerFrames(h: Harness) {
  return h
    .events()
    .filter((event) => event.type === "events.iterate.com/voice-agent/spk-frame")
    .map(
      (event) =>
        event.payload as {
          deviceSpeakerFrameSeq: number;
          fromGrokAudioDeltaSeq: number;
          pcm: string;
          clearSpeakerBufferBeforeFrame?: boolean;
          lastFrameOfAnswer?: boolean;
        },
    );
}

/** Every flush decision, oldest first. */
function speakerFlushes(h: Harness) {
  return h
    .events()
    .filter((event) => event.type === "events.iterate.com/voice-agent/speaker-flush")
    .map(
      (event) => event.payload as { clearedThroughDeviceSpeakerFrameSeq: number; reason: string },
    );
}

function eventsOfType(h: Harness, type: string) {
  return h.events().filter((event) => event.type === `events.iterate.com/voice-agent/${type}`);
}

/** How much audio, in milliseconds, actually reached the device. */
function speakerMsDelivered(h: Harness): number {
  return speakerFrames(h).reduce(
    (total, frame) => total + atob(frame.pcm).length / PCM16_BYTES_PER_MS,
    0,
  );
}

/* ----------------------------------------------------------- write helpers */

/** One microphone frame, as the device would send it. */
function micFrame(deviceMicFrameSeq: number) {
  return {
    type: "events.iterate.com/voice-agent/mic-frame" as const,
    payload: {
      deviceMicFrameSeq,
      pcm: base64(new Uint8Array(20 * PCM16_BYTES_PER_MS)),
      capturedAtDeviceMs: deviceMicFrameSeq * 20,
    },
  };
}

/**
 * Get to "a live call with a usable provider session", which almost every test
 * needs and none of them is about.
 */
async function callIsLive(h: Harness, clientTakesTurns = GROK_LISTENS): Promise<string> {
  await h.append({
    type: "events.iterate.com/voice-agent/created",
    payload: { grokBaseUrl: "https://fake.grok.test/v1/realtime", clientTakesTurns },
  });
  await h.append(micFrame(1));
  await h.settle();
  h.grok.completeHandshake();
  await h.settle();
  const started = eventsOfType(h, "call-started");
  return (started[0]!.payload as { conversationId: string }).conversationId;
}

/**
 * Let the paced drain loop run until it has nothing left to hand over.
 *
 * The lane deliberately holds audio back, so a test that wants to see a whole
 * answer has to spend the time the listener would have spent hearing it.
 */
async function playOutEverything(h: Harness, ms: number): Promise<void> {
  for (let spent = 0; spent < ms; spent += SPEAKER_FRAME_MS) {
    await h.advanceTime(SPEAKER_FRAME_MS);
    await h.settle();
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/* THE HANDSHAKE                                                              */
/* ========================================================================== */

describe("warm-up", () => {
  it("says nothing until it knows its brief", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/warmup",
      payload: { token: "tok-1" },
    });
    await h.settle();
    expect(eventsOfType(h, "warmup-ready")).toHaveLength(0);
  });

  it("echoes the token once the brief is current", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/brief-current",
      payload: { setupId: "setup-1", briefKey: "brief-1", contentHash: "abc" },
    });
    await h.append({
      type: "events.iterate.com/voice-agent/warmup",
      payload: { token: "tok-1" },
    });
    await h.settle();
    expect(
      eventsOfType(h, "warmup-ready").map((event) => (event.payload as { token: string }).token),
    ).toEqual(["tok-1"]);
  });
});

describe("opening a call", () => {
  it("opens exactly one call however many frames arrive first", async () => {
    const h = makeHarness();
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append(micFrame(1), micFrame(2), micFrame(3));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(1);
  });

  it("holds capture through the handshake and releases it in one go", async () => {
    const h = makeHarness();
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append(micFrame(1), micFrame(2), micFrame(3));
    await h.settle();
    /* Nothing has reached the provider: it has not finished handshaking. */
    expect(h.grok.sentOfType("input_audio_buffer.append")).toHaveLength(0);

    h.grok.completeHandshake();
    await h.settle();
    expect(h.grok.sentOfType("input_audio_buffer.append")).toHaveLength(3);
    const accepted = eventsOfType(h, "conversation-accepted")[0]!.payload as {
      heldMicFrames: number;
    };
    expect(accepted.heldMicFrames).toBe(3);
  });

  /*
   * THE WHOLE ORDINARY CASE: speak, release, and have both halves survive the
   * connect. Holding the audio and dropping the question is worse than holding
   * neither — the provider receives a complete sentence, waits to be asked
   * about it, and is still waiting when the idle deadline kills the call a
   * minute later. Measured on a real session: `heldMicFrames: 296`, no answer,
   * `conversation-end-requested` at 80.7s for "no input from the device".
   */
  it("holds the end of the turn through the handshake too, and then asks", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/created",
      payload: { clientTakesTurns: CLIENT_TAKES_TURNS },
    });
    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.append(micFrame(1), micFrame(2), micFrame(3));
    await h.append({ type: "events.iterate.com/voice-agent/ptt-end", payload: {} });
    await h.settle();
    expect(h.grok.sentOfType("response.create")).toHaveLength(0);

    h.grok.completeHandshake();
    await h.settle();
    /* Every frame, and then exactly one question about them. */
    expect(h.grok.sentOfType("input_audio_buffer.append")).toHaveLength(3);
    expect(h.grok.sentOfType("input_audio_buffer.commit")).toHaveLength(1);
    expect(h.grok.sentOfType("response.create")).toHaveLength(1);
    /* THE COMMIT COMES AFTER THE AUDIO IT COMMITS. */
    const order = h.grok.sent.map((message) => message.type);
    expect(order.lastIndexOf("input_audio_buffer.append")).toBeLessThan(
      order.indexOf("input_audio_buffer.commit"),
    );
  });

  /** And a client whose turns the provider takes never commits, early or late. */
  it("does not commit a held turn when the provider owns the turns", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/created",
      payload: { clientTakesTurns: GROK_LISTENS },
    });
    await h.append(micFrame(1));
    await h.append({ type: "events.iterate.com/voice-agent/ptt-end", payload: {} });
    await h.settle();
    h.grok.completeHandshake();
    await h.settle();
    expect(h.grok.sentOfType("input_audio_buffer.commit")).toHaveLength(0);
  });

  it("sends later capture straight through", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const before = h.grok.sentOfType("input_audio_buffer.append").length;
    await h.append(micFrame(2), micFrame(3));
    await h.settle();
    expect(h.grok.sentOfType("input_audio_buffer.append")).toHaveLength(before + 2);
  });

  it("lets Grok listen by default and stands down when the client owns turns", async () => {
    const open = makeHarness();
    await callIsLive(open, GROK_LISTENS);
    const openSession = open.grok.sentOfType("session.update")[0] as {
      session: { audio: { input: { turn_detection: unknown } } };
    };
    expect(openSession.session.audio.input.turn_detection).toMatchObject({
      type: "server_vad",
      threshold: 0.85,
    });

    const button = makeHarness();
    await callIsLive(button, CLIENT_TAKES_TURNS);
    const buttonSession = button.grok.sentOfType("session.update")[0] as {
      session: { audio: { input: { turn_detection: unknown } } };
    };
    expect(buttonSession.session.audio.input.turn_detection).toBeNull();
  });

  /*
   * THE MICROPHONE ARRIVES AS PCM16 AND IS HANDED ON UNTOUCHED.
   *
   * There was a mu-law decode here and a test asserting it doubled the length.
   * Both are gone with the codec. The assertion that remains is the one that
   * matters: whatever the device sent reaches Grok the same size, because
   * nothing in between is allowed to have an opinion about the encoding. The
   * bug this replaces was exactly such an opinion, held wrongly, in silence.
   */
  it("hands the device's PCM16 to Grok untouched", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/created",
      payload: { grokBaseUrl: "https://fake.grok.test/v1/realtime" },
    });
    const pcmBytes = 320;
    await h.append({
      type: "events.iterate.com/voice-agent/mic-frame",
      payload: {
        deviceMicFrameSeq: 1,
        pcm: base64(new Uint8Array(pcmBytes)),
        capturedAtDeviceMs: 20,
      },
    });
    await h.settle();
    h.grok.completeHandshake();
    await h.settle();

    const appended = h.grok.sentOfType("input_audio_buffer.append") as { audio: string }[];
    expect(appended).toHaveLength(1);
    expect(atob(appended[0]!.audio).length).toBe(pcmBytes);
  });

  /*
   * EVERY CHUNK IS A WHOLE NUMBER OF THE DEVICE'S WIRE FRAMES.
   *
   * 320 mu-law bytes is the only length the board's speaker path accepts, and a
   * chunk with a remainder is counted as a protocol violation and DROPPED — it
   * will not splice one frame onto the next at an arbitrary phase. Grok's
   * deltas are whatever length they are, so cutting each independently left a
   * runt on nearly every one: 118 dropped chunks in a three-turn call against
   * the real provider, which no unit test here could see because none of them
   * asserted on chunk length.
   */
  it("cuts a delta only to fit the device, and loses none of it", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* Lengths chosen to be awkward on purpose: no two divide the same way, and
     * not one is a multiple of anything the device cares about. Measured
     * against the real provider, 0 of 77 deltas in one answer were. */
    const sizes = [1234, 999, 4567, 321];
    for (const pcmBytes of sizes) {
      h.grok.push({
        type: "response.output_audio.delta",
        delta: base64(new Uint8Array(pcmBytes * 2)),
      });
    }
    h.grok.answerComplete();
    await playOutEverything(h, 5_000);
    const frames = speakerFrames(h).filter((frame) => frame.pcm !== "");
    expect(frames.length).toBeGreaterThan(0);
    /*
     * THE ONLY RULE LEFT IS THE CEILING. This asserted `% 320 === 0` when a
     * 640-byte wire frame was a unit rather than a maximum, and enforcing that
     * cost a residual carry on this side and a remainder-is-a-violation
     * counter on the device's. Neither survives; what survives is that no
     * single frame exceeds the device's receive buffer.
     */
    for (const frame of frames) {
      expect(atob(frame.pcm).length).toBeLessThanOrEqual(MAX_SPEAKER_PAYLOAD_BYTES);
    }
    /* EVERY BYTE, AND NO EXTRA ONES. Nothing is carried between deltas and
     * nothing is padded, so what the provider generated is exactly what the
     * device is handed. */
    const generated = sizes.reduce((total, pcmBytes) => total + pcmBytes * 2, 0);
    expect(speakerMsDelivered(h) * PCM16_BYTES_PER_MS).toBe(generated);
  });

  /** And an answer smaller than one wire frame goes out at once, unpadded. */
  it("sends a fragment shorter than a wire frame without waiting or padding", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /*
     * 200 bytes. Under the alignment rule this could not be sent at all until
     * the answer ended, and then went out padded to 640 — a whole wire frame
     * of manufactured silence appended to somebody's last syllable. It is now
     * simply a short frame, sent as soon as the pacer reaches it.
     */
    h.grok.push({
      type: "response.output_audio.delta",
      delta: base64(new Uint8Array(200)),
    });
    /* 5s, not 60: the idle deadline is a minute, and a test that advances the
     * clock past it hangs up the call it is measuring. */
    await playOutEverything(h, 5_000);
    const audible = speakerFrames(h).filter((f) => atob(f.pcm).length > 0);
    expect(audible).toHaveLength(1);
    expect(atob(audible[0]!.pcm).length).toBe(200);
  });

  it("commits a turn only for a client that owns them", async () => {
    const button = makeHarness();
    await callIsLive(button, CLIENT_TAKES_TURNS);
    await button.append({
      type: "events.iterate.com/voice-agent/ptt-end",
      payload: {},
    });
    await button.settle();
    expect(button.grok.sentOfType("input_audio_buffer.commit")).toHaveLength(1);
    expect(button.grok.sentOfType("response.create")).toHaveLength(1);

    /*
     * AND A BUTTON PRESS ON AN OPEN MICROPHONE SAYS NOTHING, which is the half
     * that used to be an allowlist. Server VAD on top of a commit answers
     * halfway through a sentence.
     */
    const open = makeHarness();
    await callIsLive(open, GROK_LISTENS);
    await open.append({
      type: "events.iterate.com/voice-agent/ptt-end",
      payload: {},
    });
    await open.settle();
    expect(open.grok.sentOfType("input_audio_buffer.commit")).toHaveLength(0);
  });
});

/* ========================================================================== */
/* THE SPEAKER LANE                                                           */
/* ========================================================================== */

describe("the speaker lane", () => {
  it("numbers every frame contiguously from one", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(1_000);
    h.grok.answerComplete();
    await playOutEverything(h, 2_000);

    const seqs = speakerFrames(h).map((frame) => frame.deviceSpeakerFrameSeq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
    expect(seqs.length).toBeGreaterThan(0);
  });

  it("says which Grok delta each frame was cut from", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(400); /* delta 1 -> four 100ms frames */
    h.grok.answerAudio(400); /* delta 2 -> four 100ms frames */
    h.grok.answerComplete();
    await playOutEverything(h, 2_000);

    const frames = speakerFrames(h);
    /* The audio frames, by which delta they were cut from. */
    expect(
      frames.filter((frame) => frame.pcm !== "").map((frame) => frame.fromGrokAudioDeltaSeq),
    ).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    /* And behind them the end-of-answer marker, carrying no audio of its own.
     * It is numbered like any other frame, because a device that skipped it
     * would score the next one as a gap. */
    const last = frames.at(-1)!;
    expect(last.pcm).toBe("");
    expect(last.lastFrameOfAnswer).toBe(true);
  });

  it("delivers every millisecond the provider generated", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(3_000);
    h.grok.answerComplete();
    await playOutEverything(h, 5_000);
    expect(speakerMsDelivered(h)).toBe(3_000);
  });

  it("never hands the device more than the lead", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* Ten seconds of answer, generated in one burst, as the real provider
     * does — the whole point of pacing is that the device does not get it. */
    h.grok.answerAudio(10_000);
    await h.settle();
    expect(speakerMsDelivered(h)).toBeLessThanOrEqual(
      MAX_DEVICE_SPEAKER_BUFFER_MS + SPEAKER_FRAME_MS,
    );
  });

  it("tells the device nothing about the answer ending", async () => {
    /* A device that plays what arrives needs no end marker: its speaker goes
     * quiet when nothing more comes. The flag used to cost a completion flag,
     * a rule for attaching it, and a bug on answers shorter than the head
     * start. Nothing in the payload should have come back. */
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(1_000);
    h.grok.answerComplete();
    await playOutEverything(h, 3_000);
    expect(speakerMsDelivered(h)).toBe(1_000);
    for (const frame of speakerFrames(h)) {
      expect(Object.keys(frame)).not.toContain("last");
    }
  });

  it("never asks the device to hold more than the byte budget", async () => {
    /*
     * THE ONE CLAIM THE DEVICE'S RAM DEPENDS ON, stated in bytes because bytes
     * are what it runs out of. Grok hands over ninety seconds — about 1.4 MB of
     * mu-law — in a single burst. An ESP32-S3 has a few hundred KB in total, so
     * exceeding the budget is not a glitch, it is the firmware dying.
     */
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(90_000);
    let elapsedMs = 0;
    let worstOutstandingBytes = 0;
    for (let tick = 0; tick < 60; tick++) {
      await h.advanceTime(SPEAKER_FRAME_MS);
      await h.settle();
      elapsedMs += SPEAKER_FRAME_MS;
      /* Sent, minus what the board has had time to play at 16 bytes/ms. */
      const outstandingBytes =
        speakerMsDelivered(h) * PCM16_BYTES_PER_MS - elapsedMs * PCM16_BYTES_PER_MS;
      worstOutstandingBytes = Math.max(worstOutstandingBytes, outstandingBytes);
    }
    /* One frame of slack: the frame that crosses the line is sent whole. */
    expect(worstOutstandingBytes).toBeLessThanOrEqual(
      MAX_DEVICE_SPEAKER_BACKLOG_BYTES + SPEAKER_FRAME_MS * PCM16_BYTES_PER_MS,
    );
    /* And the budget is actually being used — a pacer that dribbled would pass
     * the bound above while sounding terrible on a jittery network. */
    expect(worstOutstandingBytes).toBeGreaterThan(MAX_DEVICE_SPEAKER_BACKLOG_BYTES / 2);
  });

  it("sends at the rate the audio plays, so the backlog cannot grow", async () => {
    /* THE ONE INVARIANT KEEPING THE DEVICE'S BUFFER SAFE. Grok hands over
     * thirty seconds in a single burst; at no point may the device have been
     * given more than the head start beyond what it has had time to play. */
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(30_000);
    let elapsedMs = 0;
    for (let tick = 0; tick < 40; tick++) {
      await h.advanceTime(SPEAKER_FRAME_MS);
      await h.settle();
      elapsedMs += SPEAKER_FRAME_MS;
      expect(speakerMsDelivered(h) - elapsedMs).toBeLessThanOrEqual(
        MAX_DEVICE_SPEAKER_BUFFER_MS + SPEAKER_FRAME_MS,
      );
    }
    /* And it really is still sending — a pacer that had stalled would also
     * pass the bound above. */
    expect(speakerMsDelivered(h)).toBeGreaterThan(elapsedMs);
  });
});

/* ========================================================================== */
/* THE BUG THIS FILE EXISTS FOR                                               */
/* ========================================================================== */

describe("a flush names a sequence number", () => {
  /**
   * THE STUTTER, staged.
   *
   * Five tentative onsets during one answer is not a hypothetical: it is what
   * the board's own drop counter reported, and with a boolean `drop` each one
   * emptied the speaker and the count restarted. Here the second through fifth
   * name a watermark that has already been passed, so they are no-ops, and the
   * audio generated afterwards is untouched.
   */
  it("survives five spurious onsets during one answer", async () => {
    const h = makeHarness();
    await callIsLive(h);

    h.grok.answerAudio(4_000);
    await playOutEverything(h, 600);

    for (let blip = 0; blip < 5; blip++) {
      h.grok.speechStarted();
      await h.settle();
    }
    expect(speakerFlushes(h)).toHaveLength(1);

    /* The answer continues — the provider never cancelled it — and every
     * millisecond after the flush still reaches the device. */
    const before = speakerMsDelivered(h);
    h.grok.answerAudio(1_000);
    h.grok.answerComplete();
    await playOutEverything(h, 3_000);
    expect(speakerMsDelivered(h) - before).toBe(1_000);
  });

  it("flushes through the highest frame minted at that moment, and no further", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(2_000);
    await playOutEverything(h, 600);
    const mintedBefore = Math.max(...speakerFrames(h).map((frame) => frame.deviceSpeakerFrameSeq));

    h.grok.speechStarted();
    await h.settle();
    const flush = speakerFlushes(h)[0]!;
    expect(flush.clearedThroughDeviceSpeakerFrameSeq).toBeGreaterThanOrEqual(mintedBefore);
    expect(flush.reason).toBe("input_audio_buffer.speech_started");

    /* Everything the device is sent from now on is beyond the watermark, so
     * nothing it plays was ever declared dead. */
    h.grok.responseCreated();
    h.grok.answerAudio(1_000);
    h.grok.answerComplete();
    await playOutEverything(h, 3_000);
    const afterFlush = speakerFrames(h).filter(
      (frame) => frame.deviceSpeakerFrameSeq > flush.clearedThroughDeviceSpeakerFrameSeq,
    );
    expect(afterFlush.length).toBeGreaterThan(0);
    for (const frame of afterFlush) {
      expect(frame.deviceSpeakerFrameSeq).toBeGreaterThan(
        flush.clearedThroughDeviceSpeakerFrameSeq,
      );
    }
  });

  it("drops the queued tail of the answer that was interrupted", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(8_000);
    await playOutEverything(h, 600);
    const deliveredBeforeBarge = speakerMsDelivered(h);

    h.grok.speechStarted();
    await h.settle();
    /* Time passes with nothing new generated. A lane that had merely stopped
     * being topped up would keep playing out the eight seconds it holds. */
    await playOutEverything(h, 4_000);
    expect(speakerMsDelivered(h)).toBe(deliveredBeforeBarge);
  });

  /*
   * THE CASE THAT HAD NO CALLER, and the one push-to-talk actually uses.
   *
   * Both flush triggers above are provider events, and a client that owns its
   * turns is configured with `turn_detection: null` — so the provider never
   * reports speech starting, and the only other trigger is the NEXT answer.
   * Measured on a real session: the button went down, the device kept playing
   * the dead answer for the whole press, and the queue was not dropped until
   * seconds later when the reply to the interruption began.
   */
  it("drops the answer when a push-to-talk client takes the floor", async () => {
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    h.grok.answerAudio(8_000);
    await playOutEverything(h, 600);
    const deliveredBeforeBarge = speakerMsDelivered(h);
    expect(deliveredBeforeBarge).toBeGreaterThan(0);

    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();
    expect(speakerFlushes(h).map((flush) => flush.reason)).toEqual([
      "events.iterate.com/voice-agent/ptt-start",
    ]);
    /*
     * THE CLEAR RIDES A FRAME, so the device learns about it in sequence order
     * rather than on a lane that could arrive behind the audio it cancels.
     * Filtered to the empty ones: the session's opening frame also carries a
     * clear, and that one has audio on it.
     */
    const clearing = speakerFrames(h).filter(
      (frame) => frame.clearSpeakerBufferBeforeFrame && frame.pcm === "",
    );
    expect(clearing).toHaveLength(1);
    expect(clearing[0]!.deviceSpeakerFrameSeq).toBeGreaterThan(0);

    /* And the seven and a half seconds still queued never go out. */
    await playOutEverything(h, 4_000);
    expect(speakerMsDelivered(h)).toBe(deliveredBeforeBarge);
  });

  /** A button held down while nothing is playing costs one comparison. */
  it("says nothing when the floor was already free", async () => {
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    for (let press = 0; press < 3; press++) {
      await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
      await h.settle();
    }
    expect(speakerFlushes(h)).toHaveLength(0);
    expect(speakerFrames(h)).toHaveLength(0);
  });

  it("treats a new answer as a flush of the old one", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(2_000);
    await playOutEverything(h, 400);
    h.grok.responseCreated();
    await h.settle();
    expect(speakerFlushes(h).map((flush) => flush.reason)).toEqual(["response.created"]);
  });
});

/* ========================================================================== */
/* ENDING                                                                     */
/* ========================================================================== */

describe("ending a call", () => {
  it("ends after a minute with no input from the device", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await h.advanceTime(IDLE_TIMEOUT_MS + 10_000);
    await h.settle();

    const requested = eventsOfType(h, "conversation-end-requested");
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { reason: string }).reason).toContain("no input");
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    expect(h.state().call).toBeNull();
  });

  /*
   * A LONG ANSWER IS NOT AN ABANDONED CALL.
   *
   * The deadline watches the device's input because that is the only side that
   * leaves durable events, and a listener hearing out a two-minute answer sends
   * nothing at all. "Count to one hundred" therefore ran the clock out
   * mid-sentence and hung up: six dropped calls in one ten-minute run against
   * real Grok, every one of them a working conversation cut off in the middle.
   */
  it("does not end a call while it is still speaking", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* Three minutes of answer, which is longer than the deadline. */
    h.grok.answerAudio(180_000);
    await h.settle();
    await h.advanceTime(IDLE_TIMEOUT_MS + 10_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(0);
    expect(h.state().call).not.toBeNull();

    /*
     * AND THE CLOCK RESTARTS WHEN THE ANSWER ENDS, rather than resuming from a
     * stamp that aged behind it.
     *
     * Merely refusing to hang up while speaking left the durable stamp 70
     * seconds stale, so the call died one tick after the audio drained —
     * measured on preview-3 as `conversation-ended` 1.1s after a 64s answer
     * finished, with the listener about to take their turn. Immediately after
     * playout the call must still be up.
     */
    await playOutEverything(h, 200_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(0);
    expect(h.state().call).not.toBeNull();

    /* A minute of silence AFTER it stopped talking does end it: the deadline is
     * postponed and restarted, never removed. */
    await h.advanceTime(IDLE_TIMEOUT_MS + 10_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(1);
  });

  it("does not end a call the device keeps feeding", async () => {
    const h = makeHarness();
    await callIsLive(h);
    for (let tick = 0; tick < 8; tick++) {
      await h.advanceTime(10_000);
      await h.append(micFrame(tick + 2));
      await h.settle();
    }
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(0);
  });

  it("asks to end when the provider hangs up", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.close();
    await h.settle();
    const requested = eventsOfType(h, "conversation-end-requested");
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { reason: string }).reason).toContain("socket closed");
  });

  it("closes the provider socket when the call ends", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "the person said goodbye" },
    });
    await h.settle();
    expect(h.grok.closed).toBe(true);
    expect(h.state().call).toBeNull();
  });

  it("writes the provider's error where somebody can read it", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.push({ type: "error", error: { message: "commit on an empty buffer" } });
    await h.settle();
    const errors = eventsOfType(h, "provider-error");
    expect(errors).toHaveLength(1);
    expect((errors[0]!.payload as { message: string }).message).toContain("empty buffer");
  });
});

/* ========================================================================== */
/* SURVIVING AN EVICTION                                                      */
/* ========================================================================== */

describe("eviction", () => {
  it("re-dials a call the log still says is open", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const dialsBefore = h.grokDialledUrls.length;

    h.crash();
    await h.append(micFrame(9));
    await h.settle();

    expect(h.grokDialledUrls.length).toBe(dialsBefore + 1);
  });

  it("does not re-dial a call that has been ended", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "done" },
    });
    await h.settle();
    const dialsBefore = h.grokDialledUrls.length;

    h.crash();
    await h.append(micFrame(9));
    await h.settle();
    /* A new call may be opened by that frame, but the ENDED one is not revived. */
    const revived = eventsOfType(h, "call-started").filter(
      (event) => (event.payload as { conversationId: string }).conversationId === conversationId,
    );
    expect(revived).toHaveLength(1);
    expect(h.grokDialledUrls.length).toBeGreaterThanOrEqual(dialsBefore);
  });
});

/* ========================================================================== */
/* THE DUMB CLIENT'S CONTRACT                                                 */
/* ========================================================================== */

describe("what the device is told", () => {
  it("carries the clear on a numbered frame, not on a lane of its own", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(2_000);
    await playOutEverything(h, 600);
    const highestBefore = Math.max(...speakerFrames(h).map((frame) => frame.deviceSpeakerFrameSeq));

    h.grok.speechStarted();
    await h.settle();

    /* The instruction is a frame: empty, numbered, and above everything it
     * cancels — so a device ordering by sequence number cannot apply it to the
     * wrong audio however late it arrives. (The session's first frame carries a
     * clear too, for a different reason; the barge's own is the empty one.) */
    const barge = speakerFrames(h).filter(
      (frame) => frame.clearSpeakerBufferBeforeFrame === true && frame.pcm === "",
    );
    expect(barge).toHaveLength(1);
    expect(barge[0]!.deviceSpeakerFrameSeq).toBeGreaterThan(highestBefore);
  });

  it("clears once at the start of a session and never again unprompted", async () => {
    /* The first frame of a fresh socket empties whatever the board was holding
     * from a session that is gone. After that, an uninterrupted answer must not
     * clear at all — a clear mid-answer is the stutter. */
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(1_000);
    h.grok.answerComplete();
    await playOutEverything(h, 3_000);
    const frames = speakerFrames(h);
    expect(frames[0]!.clearSpeakerBufferBeforeFrame).toBe(true);
    expect(
      frames.slice(1).filter((frame) => frame.clearSpeakerBufferBeforeFrame === true),
    ).toHaveLength(0);
  });

  it("never hands over a frame the device did not ask to be able to hold", async () => {
    /* The pacing claim, stated as the device would feel it: at no instant is
     * the unplayed audio it has been given more than the lead plus the frame
     * that crossed it. */
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(20_000);
    let played = 0;
    for (let tick = 0; tick < 20; tick++) {
      await h.advanceTime(SPEAKER_FRAME_MS);
      await h.settle();
      played += SPEAKER_FRAME_MS;
      expect(speakerMsDelivered(h) - played).toBeLessThanOrEqual(
        MAX_DEVICE_SPEAKER_BUFFER_MS + SPEAKER_FRAME_MS,
      );
    }
  });
});

describe("recovery holes the review found", () => {
  it("empties the device before playing anything from a fresh socket", async () => {
    /* The board may still hold frames from the incarnation that died, numbered
     * higher than the ones about to arrive. Rather than remembering how high —
     * durable state written to survive a thing that cannot be survived — the
     * first frame of the new session says "clear". Whatever it was holding
     * belonged to an answer whose socket is gone. */
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(2_000);
    await playOutEverything(h, 600);
    const framesBefore = speakerFrames(h).length;
    expect(framesBefore).toBeGreaterThan(0);

    h.crash();
    await h.append(micFrame(9));
    await h.settle();
    h.grok.completeHandshake();
    h.grok.answerAudio(1_000);
    await h.settle();

    const afterRecovery = speakerFrames(h).slice(framesBefore);
    expect(afterRecovery.length).toBeGreaterThan(0);
    expect(afterRecovery[0]!.clearSpeakerBufferBeforeFrame).toBe(true);
  });

  it("writes the obituary an incarnation died before writing", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    /* The decision lands, but the incarnation that would perform it is gone
     * before it can. Nothing re-dials a call with `endRequested` set, so
     * without a recovery pass this call is stuck open for ever. */
    await h.stream.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "the person hung up" },
    });
    h.crash();

    await h.append(micFrame(9));
    await h.settle();
    const ended = eventsOfType(h, "conversation-ended").filter(
      (event) => (event.payload as { conversationId: string }).conversationId === conversationId,
    );
    expect(ended).toHaveLength(1);
    expect((ended[0]!.payload as { reason: string }).reason).toBe("the person hung up");
  });

  it("ignores a superseded socket that is still talking", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    const abandoned = h.grok;
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "done" },
    });
    await h.settle();
    const micSentBefore = abandoned.sentOfType("input_audio_buffer.append").length;

    /* close() is not instant: a message already in flight arrives after it.
     * It must not revive the call or empty the microphone queue into a dead
     * connection. */
    abandoned.push({ type: "session.updated" });
    await h.settle();
    expect(abandoned.sentOfType("input_audio_buffer.append")).toHaveLength(micSentBefore);
    expect(h.state().call).toBeNull();
  });
});

/* ========================================================================== */
/* BUGS A REVIEW PROVED, EACH PINNED HERE                                     */
/* ========================================================================== */

describe("bugs the review proved", () => {
  it("sends a short answer in one go rather than pacing it out", async () => {
    /* An answer that fits inside the head start has no reason to be dribbled
     * out: the whole point of the head start is that the first second of any
     * answer goes immediately. This is the latency claim, and it used to be
     * where the end-of-answer marker went missing. */
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(600);
    await h.settle();
    expect(speakerMsDelivered(h)).toBe(600);
  });

  it("does not let another call's obituary hang up the live one", async () => {
    const h = makeHarness();
    const first = await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId: first, reason: "done" },
    });
    await h.settle();

    await h.append(micFrame(20));
    await h.settle();
    h.grok.completeHandshake();
    await h.settle();
    const live = h.state().call!.conversationId;
    expect(live).not.toBe(first);
    const sentBefore = h.grok.sentOfType("input_audio_buffer.append").length;

    /* At-least-once delivery means the first call's obituary can arrive
     * again — or a replay from offset 0 can. It named a call that is over. */
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId: first, reason: "done" },
    });
    await h.append(micFrame(21));
    await h.settle();

    expect(h.state().call!.conversationId).toBe(live);
    expect(h.grok.closed).toBe(false);
    expect(h.grok.sentOfType("input_audio_buffer.append").length).toBeGreaterThan(sentBefore);
  });

  it("lets a re-dial record its own handshake", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.crash();
    await h.append(micFrame(9));
    await h.settle();
    h.grok.completeHandshake();
    await h.settle();
    /* Keyed on the conversation alone, the second acceptance is refused and
     * the number a cold call is judged on is lost. */
    expect(eventsOfType(h, "conversation-accepted").length).toBeGreaterThanOrEqual(2);
  });
});

describe("edges nothing was holding down", () => {
  it("sends the short tail of an answer that is not a whole number of frames", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.answerAudio(250);
    h.grok.answerComplete();
    await playOutEverything(h, 1_000);
    /*
     * 250 ms is 8,000 bytes of PCM16, and the only thing that shapes it on the
     * way out is the 3,200-byte ceiling: 3,200 + 3,200 + 1,600, so three
     * frames of 100, 100 and 50 ms.
     *
     * WHAT THIS USED TO SAY, because the difference is the whole change. The
     * device's frame was 640 bytes and a chunk with a remainder was dropped
     * rather than spliced, so 250 ms went out as 100 + 100 + 40 and then a
     * fourth frame carrying the last 10 ms PADDED OUT to 20 — 260 ms
     * delivered for 250 generated, ten milliseconds of manufactured silence
     * welded to the end of somebody's sentence. Nothing is padded now and the
     * tail is simply short.
     */
    const frames = speakerFrames(h).filter((frame) => frame.pcm !== "");
    expect(frames).toHaveLength(3);
    expect(speakerMsDelivered(h)).toBe(250);
    expect(atob(frames[2]!.pcm).length / PCM16_BYTES_PER_MS).toBe(50);
  });

  it("ends the call when the provider refuses the upgrade", async () => {
    const h = makeHarness();
    /* A Response with no `webSocket` at all — the shape a refusal takes, and
     * the one that used to become a TypeError on the next line. */
    vi.stubGlobal("fetch", async () => ({}) as unknown as Response);
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append(micFrame(1));
    await h.settle();
    const requested = eventsOfType(h, "conversation-end-requested");
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { reason: string }).reason).toContain("refused");
  });

  it("survives a malformed provider message and keeps listening", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.grok.pushRaw("{not json");
    h.grok.pushRaw(new ArrayBuffer(8));
    await h.settle();
    h.grok.answerAudio(400);
    h.grok.answerComplete();
    await playOutEverything(h, 1_000);
    expect(speakerMsDelivered(h)).toBe(400);
  });

  it("sends the credential to x.ai and to nobody else", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url: String(url), headers: init.headers });
      return { webSocket: new FakeGrok() } as unknown as Response;
    });
    await dialGrokSocket("https://fake.grok.test/v1/realtime");
    await dialGrokSocket(null);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(seen[1]!.headers.Authorization).toContain("/secrets/xai");
    expect(seen[1]!.url).toContain("model=grok-voice-think-fast-2.0");
  });
});
