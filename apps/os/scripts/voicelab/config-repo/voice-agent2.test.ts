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
  dialProviderSocket,
  IDLE_TIMEOUT_MS,
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

/**
 * The pretend provider, and the pretend socket it speaks over.
 *
 * Deliberately not a WebSocket subclass: the facet only ever calls
 * `addEventListener`, `send`, `close` and `accept`, and a fake that offers
 * exactly those is a readable statement of the surface being depended on.
 */
class FakeProvider {
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
  answerAudio(ms: number, itemId = "item_fake"): void {
    const pcm = new Uint8Array(ms * PCM16_BYTES_PER_MS);
    for (let index = 0; index < pcm.length; index++) pcm[index] = index % 251;
    this.push({
      type: "response.output_audio.delta",
      delta: base64(pcm),
      item_id: itemId,
      content_index: 0,
    });
  }

  /** The provider's own transcript of the answer, streamed beside the audio. */
  answerTranscript(text: string): void {
    this.push({ type: "response.output_audio_transcript.delta", delta: text });
  }

  /** The provider decides somebody in the room is talking. */
  speechStarted(): void {
    this.push({ type: "input_audio_buffer.speech_started" });
  }

  /**
   * The room went quiet again. On its own — no commit, no new response —
   * this is how a tentative onset retracts: the measured echo-residue blip
   * is a started/stopped pair and nothing else. A REAL turn follows it with
   * `input_audio_buffer.committed` in the same server tick.
   */
  speechStopped(): void {
    this.push({ type: "input_audio_buffer.speech_stopped" });
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
  const sockets: FakeProvider[] = [];
  const dialledUrls: string[] = [];
  /*
   * `fetch` IS THE SEAM, because that is what `dialGrokSocket` uses. Mocking
   * the dial dependency instead would leave the one function that has actually
   * broken in production — the `response.webSocket ?? null` line — untested.
   */
  vi.stubGlobal("fetch", async (url: string) => {
    dialledUrls.push(String(url));
    const socket = new FakeProvider();
    sockets.push(socket);
    return { webSocket: socket } as unknown as Response;
  });

  /* What a tool expression walks: a stand-in for the project root that a
   * test replaces with whatever capabilities its tool needs. */
  const projectRoot: { current: unknown } = { current: {} };

  const harness = makeProcessorHarness<VoiceAgent2Contract, VoiceAgent2Processor>({
    path: "/agents/voice/test",
    createProcessor: (deps) =>
      new VoiceAgent2Processor({
        ...deps,
        nowAtFacetMs: deps.now,
        /* The REAL dial, so the mocked `fetch` above is what stands in for the
         * provider — including the `response.webSocket ?? null` line that has
         * broken in production. */
        dialProvider: (provider, baseUrl, model) => dialProviderSocket(provider, baseUrl, model),
        withProject: (fn) => fn(projectRoot.current),
      }),
  });
  /* `grok` is always the socket of the CURRENT dial; `sockets` is every one
   * ever opened, so a test can address an abandoned socket on purpose. */
  return {
    ...harness,
    sockets,
    get provider() {
      return sockets[sockets.length - 1]!;
    },
    dialledUrls,
    projectRoot,
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
          pcm: string;
          clearSpeakerBufferBeforeFrame?: boolean;
          lastFrameOfAnswer?: boolean;
        },
    );
}

/**
 * Every clear the device was told about, oldest first — the empty frames
 * carrying `clearSpeakerBufferBeforeFrame`. (A durable speaker-flush record
 * used to exist beside these; nothing read it, so the frames ARE the record.)
 */
function speakerClears(h: Harness) {
  return speakerFrames(h).filter(
    (frame) => frame.clearSpeakerBufferBeforeFrame === true && frame.pcm === "",
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
 * needs and none of them is about. Appends `configured` alone: existence is
 * the fold's default state, so `created` (an empty strict payload under a
 * stable key, setup's job) adds nothing a unit test could observe.
 */
async function callIsLive(h: Harness, clientTakesTurns = GROK_LISTENS): Promise<string> {
  await h.append({
    type: "events.iterate.com/voice-agent/configured",
    payload: { providerBaseUrl: "https://fake.provider.test/v1/realtime", clientTakesTurns },
  });
  await h.append(micFrame(1));
  await h.settle();
  h.provider.completeHandshake();
  await h.settle();
  const started = eventsOfType(h, "call-started");
  return (started[0]!.payload as { conversationId: string }).conversationId;
}

/**
 * Let the paced drain loop run until it has nothing left to hand over.
 *
 * The lane deliberately holds audio back, so a test that wants to see a whole
 * answer has to spend the time the listener would have spent hearing it — but
 * not at 100 ms per step: the harness cascades nested timers and background
 * closures across one big advance (the idle test drives a 70 s tick chain
 * with a single advanceTime), so coarse 1 s steps buy the same playout at a
 * tenth of the settle cycles. `Math.min` keeps totals EXACT — a 600 ms
 * playout still spends exactly 600, which the frozen heard-ms pins depend on.
 */
async function playOutEverything(h: Harness, ms: number): Promise<void> {
  /* Settle FIRST: the pacer's opening burst must anchor before the clock
   * moves, or a coarse first jump lands the burst at its far edge and a
   * press "600ms in" finds nothing heard (the pacer's anti-credit clamp
   * eats the lead). */
  await h.settle();
  for (let spent = 0; spent < ms; ) {
    const step = Math.min(1_000, ms - spent);
    await h.advanceTime(step);
    await h.settle();
    spent += step;
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
    expect(h.provider.sentOfType("input_audio_buffer.append")).toHaveLength(0);

    h.provider.completeHandshake();
    await h.settle();
    expect(h.provider.sentOfType("input_audio_buffer.append")).toHaveLength(3);
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
      type: "events.iterate.com/voice-agent/configured",
      payload: { clientTakesTurns: CLIENT_TAKES_TURNS },
    });
    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.append(micFrame(1), micFrame(2), micFrame(3));
    await h.append({ type: "events.iterate.com/voice-agent/ptt-end", payload: {} });
    await h.settle();
    expect(h.provider.sentOfType("response.create")).toHaveLength(0);

    h.provider.completeHandshake();
    await h.settle();
    /* Every frame, and then exactly one question about them. */
    expect(h.provider.sentOfType("input_audio_buffer.append")).toHaveLength(3);
    expect(h.provider.sentOfType("input_audio_buffer.commit")).toHaveLength(1);
    expect(h.provider.sentOfType("response.create")).toHaveLength(1);
    /* THE COMMIT COMES AFTER THE AUDIO IT COMMITS. */
    const order = h.provider.sent.map((message) => message.type);
    expect(order.lastIndexOf("input_audio_buffer.append")).toBeLessThan(
      order.indexOf("input_audio_buffer.commit"),
    );
  });

  /** And a client whose turns the provider takes never commits, early or late. */
  it("does not commit a held turn when the provider owns the turns", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { clientTakesTurns: GROK_LISTENS },
    });
    await h.append(micFrame(1));
    await h.append({ type: "events.iterate.com/voice-agent/ptt-end", payload: {} });
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    expect(h.provider.sentOfType("input_audio_buffer.commit")).toHaveLength(0);
  });

  it("sends later capture straight through", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const before = h.provider.sentOfType("input_audio_buffer.append").length;
    await h.append(micFrame(2), micFrame(3));
    await h.settle();
    expect(h.provider.sentOfType("input_audio_buffer.append")).toHaveLength(before + 2);
  });

  it("lets Grok listen by default and stands down when the client owns turns", async () => {
    const open = makeHarness();
    await callIsLive(open, GROK_LISTENS);
    const openSession = open.provider.sentOfType("session.update")[0] as {
      session: { audio: { input: { turn_detection: unknown } } };
    };
    expect(openSession.session.audio.input.turn_detection).toMatchObject({
      type: "server_vad",
      threshold: 0.85,
    });

    const button = makeHarness();
    await callIsLive(button, CLIENT_TAKES_TURNS);
    const buttonSession = button.provider.sentOfType("session.update")[0] as {
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
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: "https://fake.provider.test/v1/realtime" },
    });
    const pcmBytes = 320;
    const devicePcm = base64(new Uint8Array(pcmBytes));
    await h.append({
      type: "events.iterate.com/voice-agent/mic-frame",
      payload: {
        deviceMicFrameSeq: 1,
        pcm: devicePcm,
        capturedAtDeviceMs: 20,
      },
    });
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();

    const appended = h.provider.sentOfType("input_audio_buffer.append") as { audio: string }[];
    expect(appended).toHaveLength(1);
    /* The EXACT string, not merely the same byte count: the identity path
     * forwards the device's own base64 with no decode/re-encode round trip. */
    expect(appended[0]!.audio).toBe(devicePcm);
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
      h.provider.push({
        type: "response.output_audio.delta",
        delta: base64(new Uint8Array(pcmBytes * 2)),
      });
    }
    h.provider.answerComplete();
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
    h.provider.push({
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
    expect(button.provider.sentOfType("input_audio_buffer.commit")).toHaveLength(1);
    expect(button.provider.sentOfType("response.create")).toHaveLength(1);

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
    expect(open.provider.sentOfType("input_audio_buffer.commit")).toHaveLength(0);
  });
});

/* ========================================================================== */
/* THE OTHER PROVIDER                                                         */
/* ========================================================================== */

describe("the openai provider", () => {
  /** A live call whose birth certificate names OpenAI. */
  async function openaiCallIsLive(h: Harness): Promise<void> {
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: "https://fake.provider.test/v1/realtime", provider: "openai" },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
  }

  it("asks the session for 24 kHz audio and the provider's voice", async () => {
    const h = makeHarness();
    await openaiCallIsLive(h);
    const update = h.provider.sentOfType("session.update")[0] as {
      session: {
        audio: {
          input: { format: { rate: number } };
          output: { format: { rate: number }; voice: string };
        };
      };
    };
    expect(update.session.audio.input.format.rate).toBe(24_000);
    expect(update.session.audio.output.format.rate).toBe(24_000);
    expect(update.session.audio.output.voice).toBe("marin");
  });

  it("pins the server-VAD knobs the barge machinery assumes, and far-field NR", async () => {
    /* The VAD barge arm never sends response.cancel BECAUSE the provider
     * cancels server-side at the onset — on OpenAI that is
     * `interrupt_response`, a default today. A default is a dependency
     * nobody can grep for, so the session pins it (and its siblings)
     * explicitly. Grok stays bare: its support for these knobs is unprobed. */
    const h = makeHarness();
    await openaiCallIsLive(h);
    const update = h.provider.sentOfType("session.update")[0] as {
      session: {
        audio: { input: { turn_detection: Record<string, unknown>; noise_reduction: unknown } };
      };
    };
    expect(update.session.audio.input.turn_detection).toMatchObject({
      type: "server_vad",
      threshold: 0.85,
      interrupt_response: true,
      create_response: true,
      silence_duration_ms: 500,
    });
    expect(update.session.audio.input.noise_reduction).toEqual({ type: "far_field" });

    const grok = makeHarness();
    await callIsLive(grok, GROK_LISTENS);
    const grokUpdate = grok.provider.sentOfType("session.update")[0] as {
      session: {
        audio: { input: { turn_detection: Record<string, unknown>; noise_reduction?: unknown } };
      };
    };
    expect(grokUpdate.session.audio.input.turn_detection).not.toHaveProperty("interrupt_response");
    expect(grokUpdate.session.audio.input.noise_reduction).toBeUndefined();
  });

  it("a certificate turn_detection rides the session verbatim, beating the defaults", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {
        providerBaseUrl: "https://fake.provider.test/v1/realtime",
        provider: "openai",
        turnDetection: { type: "semantic_vad", eagerness: "high", create_response: true },
      },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    const update = h.provider.sentOfType("session.update")[0] as {
      session: { audio: { input: { turn_detection: Record<string, unknown> } } };
    };
    /* VERBATIM: the certificate's object, not a merge with the defaults —
     * a stream that names its VAD owns every knob of it. */
    expect(update.session.audio.input.turn_detection).toEqual({
      type: "semantic_vad",
      eagerness: "high",
      create_response: true,
    });
  });

  it("a push-to-talk client's button beats any certificate turn_detection", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {
        providerBaseUrl: "https://fake.provider.test/v1/realtime",
        clientTakesTurns: true,
        turnDetection: { type: "server_vad", threshold: 0.2 },
      },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    const update = h.provider.sentOfType("session.update")[0] as {
      session: { audio: { input: { turn_detection: unknown } } };
    };
    expect(update.session.audio.input.turn_detection).toBeNull();
  });

  it("upsamples the device's 16 kHz capture on its way in", async () => {
    const h = makeHarness();
    await openaiCallIsLive(h);
    /* 20 ms is 640 bytes at 16 kHz and 960 at 24. The FIRST append runs a
     * couple of ms short — the filter holds its half-kernel of input until
     * the next frame proves what follows — and only the first: the debt is
     * fixed, so from then on every 20 ms in is exactly 20 ms out. */
    const flushed = h.provider.sentOfType("input_audio_buffer.append")[0] as { audio: string };
    expect(atob(flushed.audio).length).toBeGreaterThanOrEqual(800);
    expect(atob(flushed.audio).length).toBeLessThanOrEqual(960);
    await h.append(micFrame(2));
    await h.settle();
    const live = h.provider.sentOfType("input_audio_buffer.append")[1] as { audio: string };
    expect(atob(live.audio).length).toBe(960);
  });

  it("downsamples the provider's 24 kHz answer before the device hears it", async () => {
    const h = makeHarness();
    await openaiCallIsLive(h);
    /* 100 ms at 24 kHz: 2,400 samples, 4,800 bytes. */
    const pcm = new Uint8Array(4_800);
    for (let index = 0; index < pcm.length; index++) pcm[index] = index % 251;
    h.provider.push({ type: "response.output_audio.delta", delta: base64(pcm) });
    await h.settle();
    await playOutEverything(h, 200);
    const frames = speakerFrames(h).filter((frame) => frame.pcm !== "");
    const deliveredBytes = frames.reduce((sum, frame) => sum + atob(frame.pcm).length, 0);
    /* The same 100 ms at the pipeline's 16 kHz is 3,200 bytes, less the
     * resampler's held half-kernel — the next delta would carry it. */
    expect(deliveredBytes).toBeGreaterThanOrEqual(3_100);
    expect(deliveredBytes).toBeLessThanOrEqual(3_200);
  });

  it("leaves grok's audio untouched", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const flushed = h.provider.sentOfType("input_audio_buffer.append")[0] as { audio: string };
    expect(atob(flushed.audio).length).toBe(640);
  });
});

/* ========================================================================== */
/* TOOLS                                                                      */
/* ========================================================================== */

describe("tools on the birth certificate", () => {
  const HANG_UP = { name: "hang_up", description: "End the call." };

  /** A live push-to-talk call whose certificate names some tools. */
  async function callWithTools(
    h: Harness,
    tools: {
      name: string;
      description: string;
      parameters?: Record<string, unknown>;
      expression?: (string | [string, ...unknown[]])[];
    }[],
  ): Promise<string> {
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {
        providerBaseUrl: "https://fake.provider.test/v1/realtime",
        clientTakesTurns: CLIENT_TAKES_TURNS,
        tools,
      },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    const started = eventsOfType(h, "call-started");
    return (started[0]!.payload as { conversationId: string }).conversationId;
  }

  /** Every tool debt the facet answered, oldest first. */
  function toolOutputs(h: Harness) {
    return h.provider
      .sentOfType("conversation.item.create")
      .map((message) => message.item as { type: string; call_id: string; output: string })
      .filter((item) => item.type === "function_call_output");
  }

  it("declares the certificate's tools in the one session.update", async () => {
    const h = makeHarness();
    await callWithTools(h, [
      HANG_UP,
      {
        name: "add_note",
        description: "Add a note.",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        expression: ["notes", "add"],
      },
    ]);
    const update = h.provider.sentOfType("session.update")[0] as {
      session: {
        tool_choice?: string;
        tools?: { type: string; name: string; parameters: unknown }[];
      };
    };
    expect(update.session.tool_choice).toBe("auto");
    expect(update.session.tools!.map((tool) => tool.name)).toEqual(["hang_up", "add_note"]);
    /* A no-argument tool still declares an argument shape — the provider
     * requires one. */
    expect(update.session.tools![0]!.parameters).toEqual({ type: "object", properties: {} });
  });

  it("declares nothing when the certificate has no tools", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const update = h.provider.sentOfType("session.update")[0] as {
      session: Record<string, unknown>;
    };
    expect(update.session.tools).toBeUndefined();
    expect(update.session.tool_choice).toBeUndefined();
  });

  it("walks the expression to a function, applies the model's arguments, answers the debt", async () => {
    const h = makeHarness();
    const added: unknown[] = [];
    h.projectRoot.current = {
      notes: {
        for(day: string) {
          return {
            add: async (args: unknown) => {
              added.push(args);
              return { noted: day };
            },
          };
        },
      },
    };
    await callWithTools(h, [
      {
        name: "add_note",
        description: "Add a note.",
        expression: ["notes", ["for", "today"], "add"],
      },
    ]);
    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "add_note",
      arguments: JSON.stringify({ text: "buy milk" }),
    });
    await h.settle();
    expect(added).toEqual([{ text: "buy milk" }]);
    const outputs = toolOutputs(h);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.call_id).toBe("call_1");
    expect(JSON.parse(outputs[0]!.output)).toEqual({ noted: "today" });
    /* An expression's result deserves a spoken follow-up: exactly one. */
    expect(h.provider.sentOfType("response.create")).toHaveLength(1);
  });

  it("a failing expression answers the model with the error", async () => {
    const h = makeHarness();
    h.projectRoot.current = {
      boom() {
        throw new Error("the capability said no");
      },
    };
    await callWithTools(h, [{ name: "boom", description: "Fails.", expression: ["boom"] }]);
    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_2",
      name: "boom",
      arguments: "{}",
    });
    await h.settle();
    const outputs = toolOutputs(h);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.output).toContain("the capability said no");
    /* The follow-up is what turns the error into the model SAYING so. */
    expect(h.provider.sentOfType("response.create")).toHaveLength(1);
  });

  it("an unknown tool name is answered, never ignored", async () => {
    const h = makeHarness();
    await callWithTools(h, [HANG_UP]);
    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_3",
      name: "does_not_exist",
      arguments: "{}",
    });
    await h.settle();
    expect(JSON.parse(toolOutputs(h)[0]!.output)).toEqual({ error: "no such tool" });
  });

  it("a barged response's tool call never runs", async () => {
    const h = makeHarness();
    let ran = 0;
    h.projectRoot.current = {
      count: async () => {
        ran += 1;
        return ran;
      },
    };
    await callWithTools(h, [{ name: "count", description: "Count.", expression: ["count"] }]);
    h.provider.responseCreated();
    h.provider.answerAudio(100);
    await h.settle();
    /* The press cancels the response; the tool call is its residue — an
     * intent the user erased, and a side effect must not survive it. */
    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();
    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_4",
      name: "count",
      arguments: "{}",
    });
    await h.settle();
    expect(ran).toBe(0);
    expect(toolOutputs(h)).toHaveLength(0);
  });

  it("hang_up ends the call only after the goodbye finishes playing", async () => {
    const h = makeHarness();
    await callWithTools(h, [HANG_UP]);
    h.provider.responseCreated();
    h.provider.answerAudio(200);
    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_5",
      name: "hang_up",
      arguments: "{}",
    });
    h.provider.answerComplete();
    await h.settle();
    /* The debt is answered at once; the call is NOT over yet. */
    expect(toolOutputs(h)[0]!.output).toContain("hanging up");
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(0);
    await playOutEverything(h, 400);
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    const requested = eventsOfType(h, "conversation-end-requested")[0]!.payload as {
      reason: string;
    };
    expect(requested.reason).toBe("the model hung up");
    /* Something the assistant DID, not something to talk about. */
    expect(h.provider.sentOfType("response.create")).toHaveLength(0);
  });

  it("note_to_self mints the conversation's colleague and reads its reply back", async () => {
    const h = makeHarness();
    const gotten: string[] = [];
    const created: string[] = [];
    const briefs: { type: string; payload: { role?: string; content?: string } }[] = [];
    const asked: string[] = [];
    let resolveReply!: (reply: { payload: { message: string } }) => void;
    h.projectRoot.current = {
      agents: {
        get(path: string) {
          gotten.push(path);
          return {
            create: async () => {
              created.push(path);
            },
            append: async (event: (typeof briefs)[number]) => {
              briefs.push(event);
            },
            ask: async ({ message }: { message: string }) => {
              asked.push(message);
              return new Promise((resolve) => {
                resolveReply = resolve;
              });
            },
          };
        },
      },
    };
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {
        providerBaseUrl: "https://fake.provider.test/v1/realtime",
        clientTakesTurns: CLIENT_TAKES_TURNS,
        colleague: true,
      },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    const conversationId = (
      eventsOfType(h, "call-started")[0]!.payload as { conversationId: string }
    ).conversationId;

    /* The certificate had no tools; the colleague flag alone arms the one
     * injected tool and the fast-half framing. */
    const update = h.provider.sentOfType("session.update")[0] as {
      session: { instructions?: string; tools?: { name: string }[] };
    };
    expect(update.session.tools!.map((tool) => tool.name)).toEqual(["note_to_self"]);
    expect(update.session.instructions).toContain("fast half");

    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_9",
      name: "note_to_self",
      arguments: JSON.stringify({ note: "look up the March invoice" }),
    });
    await h.settle();
    /* The debt settles NOW; the model keeps the floor. */
    expect(toolOutputs(h)[0]!.output).toContain("noted");
    /* One colleague, on ITS OWN fresh agent stream named for the call. */
    expect(gotten[0]).toBe(`/agents/voice-notes/${conversationId}`);
    expect(created).toEqual([`/agents/voice-notes/${conversationId}`]);
    /* Born briefed, as a system context item that triggers no turn. */
    expect(briefs[0]!.type).toBe("events.iterate.com/agents/context-added");
    expect(briefs[0]!.payload.role).toBe("system");
    expect(briefs[0]!.payload.content).toContain("careful, thinking half");
    expect(asked).toEqual(["look up the March invoice"]);

    /* The reply lands mid-call: injected as a bracketed note, and the
     * model is nudged to speak because the floor is free. */
    resolveReply({ payload: { message: "The March invoice was never sent." } });
    await h.settle();
    const items = h.provider.sentOfType("conversation.item.create") as {
      item: { type: string; content?: { text: string }[] };
    }[];
    const note = items.find((entry) => entry.item.type === "message");
    expect(note).toBeDefined();
    expect(note!.item.content![0]!.text).toBe(
      "[note from your thinking half] The March invoice was never sent.",
    );
    expect(h.provider.sentOfType("response.create")).toHaveLength(1);
  });

  it("a press during the goodbye un-decides the hang-up", async () => {
    const h = makeHarness();
    await callWithTools(h, [HANG_UP]);
    h.provider.responseCreated();
    h.provider.answerAudio(200);
    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_6",
      name: "hang_up",
      arguments: "{}",
    });
    h.provider.answerComplete();
    await h.settle();
    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();
    await playOutEverything(h, 400);
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(0);
  });

  it("a tool finishing after its call ended answers nobody", async () => {
    /* The identity fence in #runTool's closure is the ONLY thing between a
     * slow tool's completion and a function_call_output written into the
     * wrong session — nothing ever nulls dial.socket, so without the fence
     * the debt lands on the dead socket and the follow-up on nobody's
     * question. Staged with end-plus-new-call rather than h.crash(),
     * because the fence lives per-instance: a crash orphans the old
     * instance whose #dial still points at the old dial, and the fence
     * would pass vacuously. */
    const h = makeHarness();
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    h.projectRoot.current = { slow: () => gate };
    const conversationId = await callWithTools(h, [
      { name: "slow", description: "Slow.", expression: ["slow"] },
    ]);
    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_slow_1",
      name: "slow",
      arguments: "{}",
    });
    await h.settle();

    /* The call ends while the tool is still running… */
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "goodbye" },
    });
    await h.settle();
    /* …and a NEW call opens on a fresh socket. */
    await h.append(micFrame(50));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    const followUpsBefore = h.provider.sentOfType("response.create").length;

    release({ done: true });
    await h.settle();
    /* The completion reaches a dead dial and is dropped whole: no output on
     * ANY socket — the dead one still records sends, which is exactly what
     * catches a broken fence — and no follow-up on the new one. */
    for (const socket of h.sockets) {
      const outputs = socket
        .sentOfType("conversation.item.create")
        .map((message) => message.item as { type: string })
        .filter((item) => item.type === "function_call_output");
      expect(outputs).toHaveLength(0);
    }
    expect(h.provider.sentOfType("response.create")).toHaveLength(followUpsBefore);
  });

  it("a tool finishing after a barge answers the debt but asks for nothing", async () => {
    /* A tool that STARTED before the press completes after it: the side
     * effect happened, so the debt is real and the output must go out — but
     * the press owns the floor it took, so no follow-up response.create.
     * Unpinned until now: a future edit could silently start talking over
     * the user's press. */
    const h = makeHarness();
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    h.projectRoot.current = { slow: () => gate };
    await callWithTools(h, [{ name: "slow", description: "Slow.", expression: ["slow"] }]);
    h.provider.responseCreated();
    h.provider.answerAudio(200);
    h.provider.push({
      type: "response.function_call_arguments.done",
      call_id: "call_slow_2",
      name: "slow",
      arguments: "{}",
    });
    await h.settle();

    /* The press barges mid-run: response cancelled, residue window open. */
    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();

    release({ done: true });
    await h.settle();
    expect(toolOutputs(h)).toHaveLength(1);
    expect(h.provider.sentOfType("response.create")).toHaveLength(0);
  });
});

/* ========================================================================== */
/* THE PROVIDER'S TIMELINE, FOR INSTRUMENTS                                   */
/* ========================================================================== */

describe("the grok-event lane", () => {
  it("replaces an audio delta's bytes with their decoded length", async () => {
    /*
     * The delta's content already goes out once, cut and paced, on
     * `spk-frame`. Riding this lane too meant every answer went out twice —
     * the second time whole, in one message, to every subscriber.
     */
    const h = makeHarness();
    await callIsLive(h);
    h.provider.answerAudio(100);
    await h.settle();
    const deltas = eventsOfType(h, "grok-event")
      .map((event) => event.payload as Record<string, unknown>)
      .filter((payload) => payload.type === "response.output_audio.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.delta).toBeUndefined();
    /* 100 ms of 16 kHz PCM16 is 3,200 bytes, and the field means BYTES —
     * not the base64 string's length, which is a third longer. */
    expect(deltas[0]!.deltaBytes).toBe(100 * PCM16_BYTES_PER_MS);
  });

  it("still carries every other provider event whole", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.push({ type: "response.done", usage: { total_tokens: 7 } });
    await h.settle();
    const done = eventsOfType(h, "grok-event")
      .map((event) => event.payload as Record<string, unknown>)
      .filter((payload) => payload.type === "response.done");
    expect(done).toHaveLength(1);
    expect(done[0]!.usage).toEqual({ total_tokens: 7 });
  });
});

/* ========================================================================== */
/* THE SPEAKER LANE                                                           */
/* ========================================================================== */

describe("the speaker lane", () => {
  it("numbers every frame contiguously from one", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.answerAudio(1_000);
    h.provider.answerComplete();
    await playOutEverything(h, 2_000);

    const seqs = speakerFrames(h).map((frame) => frame.deviceSpeakerFrameSeq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
    expect(seqs.length).toBeGreaterThan(0);
  });

  it("numbers the end-of-answer marker like any other frame", async () => {
    /* (Frames used to carry `fromProviderDeltaSeq` too — which delta each was
     * cut from; "debugging, not ordering" by its own docstring, read by
     * nobody, deleted with the field.) */
    const h = makeHarness();
    await callIsLive(h);
    h.provider.answerAudio(400); /* delta 1 -> five frames of ~99.94ms (3,198-byte slices) */
    h.provider.answerAudio(400); /* delta 2 -> five more */
    h.provider.answerComplete();
    await playOutEverything(h, 2_000);

    const frames = speakerFrames(h);
    /* Behind the audio sits the end-of-answer marker, carrying no audio of
     * its own. It is numbered like any other frame, because a device that
     * skipped it would score the next one as a gap. */
    const last = frames.at(-1)!;
    expect(last.pcm).toBe("");
    expect(last.lastFrameOfAnswer).toBe(true);
    expect(last.deviceSpeakerFrameSeq).toBe(frames.length);
  });

  it("delivers every millisecond the provider generated", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.answerAudio(3_000);
    h.provider.answerComplete();
    await playOutEverything(h, 5_000);
    expect(speakerMsDelivered(h)).toBe(3_000);
  });

  it("never hands the device more than the lead", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* Ten seconds of answer, generated in one burst, as the real provider
     * does — the whole point of pacing is that the device does not get it. */
    h.provider.answerAudio(10_000);
    await h.settle();
    expect(speakerMsDelivered(h)).toBeLessThanOrEqual(
      MAX_DEVICE_SPEAKER_BUFFER_MS + SPEAKER_FRAME_MS,
    );
  });

  /* (A "tells the device nothing about the answer ending" test sat here,
   * left over from the deleted no-marker design: its prose contradicted the
   * restored lastFrameOfAnswer pin above, and its negative assertion looked
   * for a literal "last" key nothing ever produced — a check that could not
   * fail. The marker behavior is pinned at "numbers the end-of-answer
   * marker"; the delivery total at "delivers every millisecond". ) */

  it("never asks the device to hold more than the byte budget", async () => {
    /*
     * THE ONE CLAIM THE DEVICE'S RAM DEPENDS ON, stated in bytes because bytes
     * are what it runs out of. Grok hands over ninety seconds — about 1.4 MB of
     * mu-law — in a single burst. An ESP32-S3 has a few hundred KB in total, so
     * exceeding the budget is not a glitch, it is the firmware dying.
     */
    const h = makeHarness();
    await callIsLive(h);
    h.provider.answerAudio(90_000);
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
    /* And it really is still sending — a pacer that had stalled would also
     * pass both bounds above. (Two further tests asserted the same drain
     * inequality per tick in MILLISECONDS — the byte bound divided by 32,
     * over fewer ticks; strict subsets of this one, deleted whole.) */
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
   * audio generated afterwards is untouched. Each blip is a started/stopped
   * PAIR because that is the measured signature — a false onset retracts as a
   * `speech_stopped` with no commit behind it; five bare starts would be one
   * onset the provider never settled, and the pacer rightly holds for that.
   */
  it("survives five spurious onsets during one answer", async () => {
    const h = makeHarness();
    await callIsLive(h);

    h.provider.answerAudio(4_000);
    await playOutEverything(h, 600);

    for (let blip = 0; blip < 5; blip++) {
      h.provider.speechStarted();
      h.provider.speechStopped();
      await h.settle();
    }
    expect(speakerClears(h)).toHaveLength(1);

    /* The answer continues — the provider never cancelled it — and every
     * millisecond after the flush still reaches the device. */
    const before = speakerMsDelivered(h);
    h.provider.answerAudio(1_000);
    h.provider.answerComplete();
    await playOutEverything(h, 3_000);
    expect(speakerMsDelivered(h) - before).toBe(1_000);
  });

  it("flushes through the highest frame minted at that moment, and no further", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.answerAudio(2_000);
    await playOutEverything(h, 600);
    const mintedBefore = Math.max(...speakerFrames(h).map((frame) => frame.deviceSpeakerFrameSeq));

    h.provider.speechStarted();
    await h.settle();
    /* Exactly ONE clear, riding a frame of its own: empty, numbered, and
     * above everything it cancels — so a device ordering by sequence number
     * cannot apply it to the wrong audio however late it arrives. */
    const clears = speakerClears(h);
    expect(clears).toHaveLength(1);
    const clear = clears[0]!;
    expect(clear.deviceSpeakerFrameSeq).toBeGreaterThan(mintedBefore);

    /* Everything the device is sent from now on is beyond the watermark, so
     * nothing it plays was ever declared dead. */
    h.provider.responseCreated();
    h.provider.answerAudio(1_000);
    h.provider.answerComplete();
    await playOutEverything(h, 3_000);
    const afterClear = speakerFrames(h).filter(
      (frame) => frame.deviceSpeakerFrameSeq > clear.deviceSpeakerFrameSeq,
    );
    expect(afterClear.length).toBeGreaterThan(0);
  });

  /*
   * UPDATED for the provider-cancellation policy: the queued tail is
   * destroyed on an onset only when the provider CANCELLED the response
   * server-side at that onset — openai's server_vad `interrupt_response`,
   * which is why this test pins the openai provider. So the tail is dead
   * for certain and holding it would resume an answer the provider already
   * killed. On grok NOTHING cancels at an onset (no interrupt_response; a
   * client cancel drew an error every time), so even a mid-burst onset
   * HOLDS the tail; that policy is pinned in "the open-mic barge" below.
   */
  it("drops the queued tail of the answer that was interrupted mid-generation", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: "https://fake.provider.test/v1/realtime", provider: "openai" },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    h.provider.responseCreated();
    h.provider.answerAudio(8_000);
    await playOutEverything(h, 600);
    const deliveredBeforeBarge = speakerMsDelivered(h);

    h.provider.speechStarted();
    await h.settle();
    /* Time passes with nothing new generated. A lane that had merely stopped
     * being topped up would keep playing out the seconds it holds — and a
     * RETRACTION must resume nothing, because the answer is dead server-side. */
    h.provider.speechStopped();
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
    h.provider.answerAudio(8_000);
    await playOutEverything(h, 600);
    const deliveredBeforeBarge = speakerMsDelivered(h);
    expect(deliveredBeforeBarge).toBeGreaterThan(0);

    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();
    /*
     * THE CLEAR RIDES A FRAME, so the device learns about it in sequence order
     * rather than on a lane that could arrive behind the audio it cancels.
     * Filtered to the empty ones: the session's opening frame also carries a
     * clear, and that one has audio on it.
     */
    const clearing = speakerClears(h);
    expect(clearing).toHaveLength(1);
    expect(clearing[0]!.deviceSpeakerFrameSeq).toBeGreaterThan(0);

    /* And the seven and a half seconds still queued never go out. */
    await playOutEverything(h, 4_000);
    expect(speakerMsDelivered(h)).toBe(deliveredBeforeBarge);
  });

  /*
   * THE HALF THE QUEUE-DROP CANNOT DO. Emptying the queue kills what already
   * arrived; a provider that streams near real time (gpt-realtime) has barely
   * anything queued and keeps generating — measured 2026-08-18, "count to a
   * hundred" counted straight through a barge. The press must also CANCEL the
   * response, and the cancelled answer's late deltas must stay dead.
   */
  it("cancels the provider's response on a barge and deafens its residue", async () => {
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    h.provider.responseCreated();
    h.provider.answerAudio(8_000);
    await playOutEverything(h, 600);
    const deliveredBeforeBarge = speakerMsDelivered(h);
    expect(deliveredBeforeBarge).toBeGreaterThan(0);

    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(1);

    /* The cancel is asynchronous: residue of the dead answer still arrives —
     * and none of it may reach the speaker, nor mark an end nobody heard. */
    h.provider.answerAudio(2_000);
    h.provider.answerComplete();
    await playOutEverything(h, 4_000);
    expect(speakerMsDelivered(h)).toBe(deliveredBeforeBarge);
    expect(speakerFrames(h).filter((frame) => frame.lastFrameOfAnswer === true)).toHaveLength(0);

    /* The NEXT answer is live again from its first delta. */
    h.provider.responseCreated();
    h.provider.answerAudio(400);
    await playOutEverything(h, 1_000);
    expect(speakerMsDelivered(h)).toBeGreaterThan(deliveredBeforeBarge);
  });

  /*
   * CANCELLING STOPS THE SOUND; THE REPAIR FIXES THE MEMORY. The provider's
   * conversation still holds the ENTIRE answer it generated, so barged mid-
   * count it will swear it "counted all the way to one hundred" — the model
   * remembers what it said, not what anybody heard. On a provider whose
   * truncate works, the item is trimmed to the heard milliseconds. On grok
   * — this harness's default — NO wire verb repairs an assistant item
   * (truncate: silent no-op; delete: "Item not found"; both probed live
   * 2026-08-18), so the heard-prefix note is the entire repair there.
   */
  it("repairs the barged answer's memory — on grok, the note is the whole repair", async () => {
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    h.provider.responseCreated();
    h.provider.answerAudio(400, "item_count");
    h.provider.answerTranscript("one two three four five");
    h.provider.answerAudio(7_600, "item_count");
    await playOutEverything(h, 600);
    expect(speakerMsDelivered(h)).toBeGreaterThan(0);

    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();

    /* Not yet: repairing an item its own response is still finalizing races
     * the transcript write — observed live, the ack shared a millisecond with
     * the response's done and the model still remembered the full count. */
    expect(h.provider.sentOfType("conversation.item.create")).toHaveLength(0);

    /* Transcript that arrives AFTER the press models the transcriber's lag:
     * residue, never part of what the note says was heard. */
    h.provider.answerTranscript(" six seven eight nine ten twenty");
    h.provider.answerComplete();
    await h.settle();
    /* Neither verb goes out on grok — a truncate is swallowed silently and
     * a delete draws "Item not found"; either would be noise on the wire. */
    expect(h.provider.sentOfType("conversation.item.truncate")).toHaveLength(0);
    expect(h.provider.sentOfType("conversation.item.delete")).toHaveLength(0);

    /* The note is the answer's only memory — the heard PREFIX, never the
     * whole thing. */
    const notes = h.provider.sentOfType("conversation.item.create");
    expect(notes).toHaveLength(1);
    const noteText = JSON.stringify(notes[0]);
    expect(noteText).toContain("heard only this much");
    expect(noteText).toContain("one");
    expect(noteText).not.toContain("twenty");
  });

  it("repairs immediately when the barged answer had already finished generating", async () => {
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    h.provider.responseCreated();
    h.provider.answerAudio(400, "item_done");
    h.provider.answerTranscript("one two three");
    h.provider.answerAudio(7_600, "item_done");
    h.provider.answerComplete();
    await playOutEverything(h, 600);

    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();
    /* Immediate on grok means the NOTE goes now — no deferral, no verb. */
    const notes = h.provider.sentOfType("conversation.item.create");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("heard only this much");
    /* No cancel: there was nothing generating to cancel. */
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(0);
  });

  it("sends no repair and no cancel when the press finds nothing playing", async () => {
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    h.provider.responseCreated();
    h.provider.answerAudio(400, "item_short");
    h.provider.answerComplete();
    await playOutEverything(h, 2_000);

    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();
    /* Fully played: nothing to repair — no note, no truncate — and nothing
     * generating to cancel. Three zeros, two distinct guards (the heard-ms
     * slack test and the was-streaming snapshot), one staging. */
    expect(h.provider.sentOfType("conversation.item.create")).toHaveLength(0);
    expect(h.provider.sentOfType("conversation.item.truncate")).toHaveLength(0);
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(0);
  });

  it("a redelivered ptt-end with no new audio commits nothing", async () => {
    /* The ephemeral lane redelivers by design; a duplicate ptt-end against
     * an empty provider buffer drew input_audio_buffer_commit_empty and,
     * sometimes, an unprompted second answer spoken from bare context. Only
     * a turn that carried audio since the last commit may ask. */
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    await h.append({ type: "events.iterate.com/voice-agent/ptt-end", payload: {} });
    await h.settle();
    const commitsAfterFirstEnd = h.provider.sentOfType("input_audio_buffer.commit").length;
    await h.append({ type: "events.iterate.com/voice-agent/ptt-end", payload: {} });
    await h.settle();
    expect(h.provider.sentOfType("input_audio_buffer.commit")).toHaveLength(commitsAfterFirstEnd);
    /* New audio re-arms the gate. */
    await h.append(micFrame(2));
    await h.append({ type: "events.iterate.com/voice-agent/ptt-end", payload: {} });
    await h.settle();
    expect(h.provider.sentOfType("input_audio_buffer.commit")).toHaveLength(
      commitsAfterFirstEnd + 1,
    );
  });

  /** A button held down while nothing is playing costs one comparison. */
  it("says nothing when the floor was already free", async () => {
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    for (let press = 0; press < 3; press++) {
      await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
      await h.settle();
    }
    expect(speakerClears(h)).toHaveLength(0);
    expect(speakerFrames(h)).toHaveLength(0);
  });

  it("treats a new answer as a flush of the old one", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.answerAudio(2_000);
    await playOutEverything(h, 400);
    h.provider.responseCreated();
    await h.settle();
    expect(speakerClears(h)).toHaveLength(1);
  });
});

/* ========================================================================== */
/* THE OPEN-MIC BARGE                                                         */
/* ========================================================================== */

/*
 * `input_audio_buffer.speech_started` is the ONLY interruption an open-mic
 * board ever produces — no button, so the whole ptt barge chain used to be
 * unreachable from it: the in-flight answer was dropped and the model went on
 * believing it said everything it generated. And the onset is TENTATIVE
 * (five per turn measured from echo residue), so what it may and may not
 * destroy depends on whether the provider is still generating.
 */
describe("the face", () => {
  /** An answer with real spectral shape, so the classifier has something to
   * classify — silence classifies as SIL, which proves nothing moved. */
  function voicedAudio(ms: number): string {
    const samples = new Int16Array(ms * 16);
    for (let index = 0; index < samples.length; index++) {
      samples[index] = Math.round(
        9_000 * Math.sin((2 * Math.PI * 220 * index) / 16_000) +
          4_000 * Math.sin((2 * Math.PI * 700 * index) / 16_000),
      );
    }
    return base64(new Uint8Array(samples.buffer));
  }

  async function faceOf(h: Harness) {
    const state = (await h.processor().getRuntimeState()) as {
      runtime: { face: { viseme: number; answer: number; at: number } | null };
    };
    return state.runtime.face;
  }

  it("a visemes certificate publishes mouth shapes in the runtime bag", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {
        providerBaseUrl: "https://fake.provider.test/v1/realtime",
        clientTakesTurns: CLIENT_TAKES_TURNS,
        visemes: true,
      },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    expect(await faceOf(h)).toBeNull();

    h.provider.responseCreated();
    h.provider.push({
      type: "response.output_audio.delta",
      delta: voicedAudio(600),
      item_id: "item_face",
      content_index: 0,
    });
    await h.settle();
    const face = await faceOf(h);
    expect(face).not.toBeNull();
    expect(face!.answer).toBe(1);
    /* The mouth closes with SIL when the answer's track ends. */
    h.provider.answerComplete();
    await h.settle();
    expect((await faceOf(h))!.viseme).toBe(14);
  });

  it("a barge shuts the mouth immediately", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {
        providerBaseUrl: "https://fake.provider.test/v1/realtime",
        clientTakesTurns: CLIENT_TAKES_TURNS,
        visemes: true,
      },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    h.provider.responseCreated();
    h.provider.push({
      type: "response.output_audio.delta",
      delta: voicedAudio(2_000),
      item_id: "item_face",
      content_index: 0,
    });
    await h.settle();

    await h.append({ type: "events.iterate.com/voice-agent/ptt-start", payload: {} });
    await h.settle();
    const face = await faceOf(h);
    expect(face!.viseme).toBe(14);
    expect(face!.answer).toBe(1);
  });

  it("without the certificate flag the bag stays empty and nothing classifies", async () => {
    const h = makeHarness();
    await callIsLive(h, CLIENT_TAKES_TURNS);
    h.provider.responseCreated();
    h.provider.push({
      type: "response.output_audio.delta",
      delta: voicedAudio(600),
      item_id: "item_noface",
      content_index: 0,
    });
    await h.settle();
    expect(await faceOf(h)).toBeNull();
  });
});

describe("the open-mic barge", () => {
  it("repairs the memory of a barged active response, and never sends cancel", async () => {
    /* An OPENAI call, because the destructive mid-stream arm is openai's:
     * its server_vad `interrupt_response` (pinned true in the session)
     * cancelled the response server-side at the onset, so the tail is dead
     * for certain. Grok's mid-burst onset takes the hold instead — pinned
     * below. */
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: "https://fake.provider.test/v1/realtime", provider: "openai" },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    h.provider.responseCreated();
    h.provider.answerAudio(400, "item_vad");
    h.provider.answerTranscript("one two three four five");
    h.provider.answerAudio(7_600, "item_vad");
    await playOutEverything(h, 600);
    const deliveredBeforeBarge = speakerMsDelivered(h);
    expect(deliveredBeforeBarge).toBeGreaterThan(0);

    h.provider.speechStarted();
    await h.settle();
    /*
     * NO `response.cancel` from this arm, ever: the provider cancelled this
     * response server-side at the very onset, and a client cancel on top is
     * a second owner of one cancellation. (On grok a VAD-triggered cancel
     * drew an error every time it was tried — and this arm never runs
     * there.)
     */
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(0);
    /* And not yet: repairing an item its own response is still finalizing
     * races the transcript write — the repair waits for `response.done`. */
    expect(h.provider.sentOfType("conversation.item.create")).toHaveLength(0);

    /* The provider finalizes the barged response on its own. */
    h.provider.answerComplete();
    await h.settle();
    /* On openai the truncate WORKS, so the settled repair is the verb plus
     * the note — the item trimmed to the heard milliseconds, the note
     * restoring the heard prefix the truncation deleted. */
    const truncations = h.provider.sentOfType("conversation.item.truncate");
    expect(truncations).toHaveLength(1);
    expect(truncations[0]).toMatchObject({ item_id: "item_vad", content_index: 0 });
    const notes = h.provider.sentOfType("conversation.item.create");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("heard only this much");
    expect(JSON.stringify(notes[0])).toContain("one");
    /* Still none — the finalization did not sneak one out. */
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(0);
  });

  /*
   * THE BURST-WINDOW BLIP, grok's worst case: `speech_started` lands while
   * the burst is STILL STREAMING — several seconds of a long answer, exactly
   * when the board's speaker is loudest and echo residue likeliest. Grok
   * cancelled nothing server-side (no interrupt_response; a client cancel
   * errors), so destroying the answer here was the counting bug resurrected
   * inside the burst window: the answer died after ~1.5 s, the user sat in
   * silence, and a note told the model it was interrupted when nobody spoke.
   */
  it("holds a mid-burst onset on grok and resumes the still-growing tail", async () => {
    const h = makeHarness();
    await callIsLive(h, GROK_LISTENS);
    h.provider.responseCreated();
    h.provider.answerAudio(8_000);
    await playOutEverything(h, 600);
    const deliveredAtOnset = speakerMsDelivered(h);
    expect(deliveredAtOnset).toBeGreaterThan(0);
    expect(deliveredAtOnset).toBeLessThan(8_000);

    /* The blip, mid-generation. NO answerComplete has arrived. */
    h.provider.speechStarted();
    await h.settle();
    /* The burst continues into the hold: deltas keep queueing behind the
     * pause, which is exactly what the hold wants. */
    h.provider.answerAudio(1_000);
    await playOutEverything(h, 2_000);
    expect(speakerMsDelivered(h)).toBe(deliveredAtOnset);

    /* The retraction: quiet again, no commit — echo residue. Everything
     * resumes, the late deltas included. */
    h.provider.speechStopped();
    h.provider.answerComplete();
    await playOutEverything(h, 12_000);
    expect(speakerMsDelivered(h)).toBe(9_000);
    /* Nobody cancelled and nobody's memory was touched. */
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(0);
    expect(h.provider.sentOfType("conversation.item.truncate")).toHaveLength(0);
    expect(h.provider.sentOfType("conversation.item.create")).toHaveLength(0);
  });

  it("a committed mid-burst barge on grok discards the tail and repairs at response.done", async () => {
    const h = makeHarness();
    await callIsLive(h, GROK_LISTENS);
    h.provider.responseCreated();
    h.provider.answerAudio(400);
    h.provider.answerTranscript("one two three");
    h.provider.answerAudio(7_600);
    await playOutEverything(h, 600);
    const deliveredAtOnset = speakerMsDelivered(h);

    h.provider.speechStarted();
    await h.settle();
    /* A real turn: stopped and committed in the same server tick. The
     * confirm discards the held tail with the heard-ms frozen at the
     * onset's clear. */
    h.provider.speechStopped();
    h.provider.push({ type: "input_audio_buffer.committed" });
    await h.settle();
    /* The rest of the burst is residue now: dead on arrival. */
    h.provider.answerAudio(2_000);
    h.provider.answerComplete();
    await playOutEverything(h, 4_000);
    expect(speakerMsDelivered(h) - deliveredAtOnset).toBeLessThanOrEqual(SPEAKER_FRAME_MS);
    /* An answer that died unheard marks no end. */
    expect(speakerFrames(h).filter((frame) => frame.lastFrameOfAnswer === true)).toHaveLength(0);
    /* The repair settles at response.done — on grok, note only, no verb,
     * and never a cancel. */
    const notes = h.provider.sentOfType("conversation.item.create");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("heard only this much");
    expect(h.provider.sentOfType("conversation.item.truncate")).toHaveLength(0);
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(0);
  });

  it("a response.created that finds a live hold settles it with no repair", async () => {
    /* A created that finds a live hold can only be one this agent asked
     * for itself — every real turn's committed precedes its created — so
     * nobody interrupted and there is nothing to repair. The old
     * confirm-on-created here fabricated "the user interrupted your
     * previous spoken reply" out of an echo blip. */
    const h = makeHarness();
    await callIsLive(h, GROK_LISTENS);
    h.provider.responseCreated();
    h.provider.answerAudio(8_000, "item_held");
    h.provider.answerTranscript("one two three");
    h.provider.answerComplete();
    await playOutEverything(h, 600);
    h.provider.speechStarted();
    await h.settle();
    const deliveredAtOnset = speakerMsDelivered(h);

    /* An unrelated created lands while the hold is open (this one was not
     * asked for by a tool, so it also flushes the old tail — a new answer
     * is a flush of the old one). */
    h.provider.responseCreated();
    h.provider.answerAudio(1_000);
    h.provider.answerComplete();
    await playOutEverything(h, 4_000);
    /* No note, no truncate — and the pacer is unparked: the new answer
     * plays. */
    expect(h.provider.sentOfType("conversation.item.create")).toHaveLength(0);
    expect(h.provider.sentOfType("conversation.item.truncate")).toHaveLength(0);
    expect(speakerMsDelivered(h)).toBe(deliveredAtOnset + 1_000);

    /* A commit arriving later finds nothing to confirm: the stale frozen
     * heard-ms died with the hold and cannot touch the fresh answer. */
    h.provider.push({ type: "input_audio_buffer.committed" });
    await h.settle();
    expect(h.provider.sentOfType("conversation.item.create")).toHaveLength(0);
    expect(h.provider.sentOfType("conversation.item.truncate")).toHaveLength(0);
  });

  it("a provider-created reply confirms the hold BEFORE the answer swap — grok's wire order", async () => {
    /* Measured live 2026-08-19 (wiretap, stream notecheck-074638): at a real
     * grok barge the reply's `response.created` arrives at .456, the barged
     * turn's `speech_stopped` at .652 and its `committed` at .708 — created
     * FIRST. A created arm that only dropped the hold (waiting for the
     * commit to confirm) erased the barged answer's identity and transcript
     * in the swap, and the note never went out: the model recalled a count
     * nobody heard. The provider's own created IS the confirmation. */
    const h = makeHarness();
    await callIsLive(h, GROK_LISTENS);
    h.provider.responseCreated();
    h.provider.answerAudio(400, "item_stream");
    h.provider.answerTranscript("one two three");
    h.provider.answerAudio(15_600, "item_stream");
    await playOutEverything(h, 12_000);
    expect(speakerMsDelivered(h)).toBeGreaterThan(0);

    /* Grok cancels the streaming response server-side at the onset: a bare
     * response.done with empty output, then the onset, in one breath. */
    h.provider.push({ type: "response.done", response: { output: [] } });
    h.provider.speechStarted();
    await h.settle();

    /* The reply's created lands BEFORE stopped/committed. */
    h.provider.responseCreated();
    h.provider.speechStopped();
    h.provider.push({ type: "input_audio_buffer.committed" });
    await h.settle();

    /* The repair went out, built from the BARGED answer: the note carries
     * its transcript, not the fresh reply's empty one. */
    const notes = h.provider.sentOfType("conversation.item.create");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("one two three");
  });

  it("holds the finished answer's tail through a false onset and resumes it", async () => {
    const h = makeHarness();
    await callIsLive(h, GROK_LISTENS);
    /* Grok's shape: the whole answer bursts up front and generation is over
     * long before the listener has heard it — the tail lives ONLY in the
     * facet's queue, which is exactly what an onset must not destroy. */
    h.provider.responseCreated();
    h.provider.answerAudio(8_000);
    h.provider.answerComplete();
    await playOutEverything(h, 600);
    const deliveredAtOnset = speakerMsDelivered(h);
    expect(deliveredAtOnset).toBeGreaterThan(0);
    expect(deliveredAtOnset).toBeLessThan(8_000);

    h.provider.speechStarted();
    await h.settle();
    /* The device is silenced at once — the interrupt still FEELS instant. */
    expect(speakerClears(h)).toHaveLength(1);
    /* But the tail is held, not destroyed: nothing more goes out while the
     * onset's verdict is pending. */
    await playOutEverything(h, 2_000);
    expect(speakerMsDelivered(h)).toBe(deliveredAtOnset);

    /* The retraction: quiet again, no commit — it was echo residue. The
     * tail resumes; what the false onset cost is the HOLE where the
     * device's cleared lead was, not the remaining thirty-odd seconds. */
    h.provider.speechStopped();
    await playOutEverything(h, 12_000);
    expect(speakerMsDelivered(h)).toBe(8_000);
    /* Nobody's memory was touched: no commit means nothing to repair. */
    expect(h.provider.sentOfType("conversation.item.delete")).toHaveLength(0);
    expect(h.provider.sentOfType("conversation.item.truncate")).toHaveLength(0);
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(0);
  });

  it("a confirmed onset discards the held tail and repairs with heard-ms frozen at the clear", async () => {
    /* An OPENAI open-mic call, deliberately: the frozen number rides the
     * truncate's audio_end_ms, and grok's repair (delete) carries no number
     * to pin. OpenAI's 24 kHz deltas mean the fake's byte counts are 1.5x
     * the real milliseconds — inputs below are scaled so the frozen number
     * stays the same round 600 as the grok drop tests. */
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: "https://fake.provider.test/v1/realtime", provider: "openai" },
    });
    await h.append(micFrame(1));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    h.provider.responseCreated();
    h.provider.answerAudio(600, "item_burst");
    h.provider.answerTranscript("one two three four five");
    h.provider.answerAudio(11_400, "item_burst");
    h.provider.answerComplete();
    await playOutEverything(h, 600);
    const deliveredAtOnset = speakerMsDelivered(h);

    h.provider.speechStarted();
    await h.settle();
    /* The user keeps talking while the pacer holds; the schedule would keep
     * advancing, which is why heard-ms is frozen AT the onset — repaired at
     * the commit two seconds later, the number must still be the one from
     * the moment the room went silent. */
    await playOutEverything(h, 2_000);

    /* A real turn: stopped and committed arrive in the same server tick —
     * the retraction must not erase the frozen number the commit still
     * owes. */
    h.provider.speechStopped();
    h.provider.push({ type: "input_audio_buffer.committed" });
    await h.settle();

    const truncations = h.provider.sentOfType("conversation.item.truncate");
    expect(truncations).toHaveLength(1);
    expect(truncations[0]).toMatchObject({ item_id: "item_burst", content_index: 0 });
    /* Frozen: 600 ms had been heard when the clear fired. Recomputed at the
     * commit it would claim 4,600 — everything ever handed over, none of the
     * cleared buffer subtracted — which is exactly the lie the freeze
     * prevents. */
    expect(truncations[0]!.audio_end_ms).toBe(600);
    const notes = h.provider.sentOfType("conversation.item.create");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("heard only this much");
    expect(h.provider.sentOfType("response.cancel")).toHaveLength(0);

    /* The held tail is gone for good — the retraction restarted the pacer
     * one message before the commit landed, so the single in-flight frame
     * may slip, and no more; the confirm's own watermark re-clears the
     * device (the second clear), so the blurt is never heard. */
    await playOutEverything(h, 2_000);
    const deliveredAfterConfirm = speakerMsDelivered(h);
    expect(deliveredAfterConfirm - deliveredAtOnset).toBeLessThanOrEqual(SPEAKER_FRAME_MS);
    expect(speakerClears(h)).toHaveLength(2);

    /* And the reply to the interruption plays clean, with none of the dead
     * answer resuming underneath it. (1,500 fake-ms = 1,000 real at 24 kHz;
     * the resampler's half-kernel lookahead holds back ~1.3 ms of tail.) */
    h.provider.responseCreated();
    h.provider.answerAudio(1_500);
    h.provider.answerComplete();
    await playOutEverything(h, 3_000);
    expect(Math.abs(speakerMsDelivered(h) - (deliveredAfterConfirm + 1_000))).toBeLessThan(2);
  });
});

/* ========================================================================== */
/* ENDING                                                                     */
/* ========================================================================== */

describe("ending a call", () => {
  it("a device-appended obituary silences the speaker and frees the dial NOW", async () => {
    /* The hang-up button appends conversation-ended directly — no
     * end-requested ever exists, so the caught-up settlement never runs.
     * Measured on HAVPE: without this arm the zombie dial squatted until
     * the 60s idle tick and every press in between was deaf, while the
     * ring played out four more seconds of a call that was over. */
    const h = makeHarness();
    const conversationId = await callIsLive(h, GROK_LISTENS);
    h.provider.responseCreated();
    h.provider.answerAudio(8_000);
    await playOutEverything(h, 600);
    const clearsBefore = speakerClears(h).length;
    const socketsBefore = h.sockets.length;

    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId, reason: "button" },
    });
    await h.settle();
    /* The device is silenced immediately — the buffered lead dies with the
     * call — and the provider socket is gone. */
    expect(speakerClears(h).length).toBe(clearsBefore + 1);
    expect(h.provider.closed).toBe(true);

    /* The dying call's OWN last frames mint nothing: a device drains its
     * mic for ~100 ms after the far end hangs up, and the call those
     * frames used to mint was the zombie a person heard as a second
     * "call ended". */
    await h.append(micFrame(2));
    await h.settle();
    expect(h.sockets.length).toBe(socketsBefore);

    /* And the next press is NOT deaf: once the trailing-frame window has
     * passed, speech dials a fresh provider socket at once instead of
     * waiting out a zombie's idle deadline. */
    await h.advanceTime(2_000);
    await h.append(micFrame(3));
    await h.settle();
    expect(h.sockets.length).toBe(socketsBefore + 1);
  });

  it("a stale obituary for a dead call cannot touch the live one", async () => {
    const h = makeHarness();
    await callIsLive(h, GROK_LISTENS);
    h.provider.responseCreated();
    h.provider.answerAudio(2_000);
    await playOutEverything(h, 200);
    const socketsBefore = h.sockets.length;
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId: "conv_from_last_week", reason: "button" },
    });
    await h.settle();
    expect(h.provider.closed).toBe(false);
    expect(h.sockets.length).toBe(socketsBefore);
  });

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
    h.provider.answerAudio(180_000);
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
    h.provider.close();
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
    expect(h.provider.closed).toBe(true);
    expect(h.state().call).toBeNull();
  });

  it("the idle tick chain dies with its call", async () => {
    /* The dial-identity fence at the top of each tick is the ONLY thing
     * that kills the self-rescheduling chain when the call ends — #hangUp
     * nulls #dial but cannot reach the pending sleep. A fence-less chain
     * keeps running with its captured closure and, because the "goodbye"
     * path never used the `idle:` idempotency key, appends a SECOND
     * end-requested with reason "no input" for a call already buried. */
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "the person said goodbye" },
    });
    await h.settle();
    await h.advanceTime(IDLE_TIMEOUT_MS + 10_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(1);
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
  });

  it("writes the provider's error where somebody can read it", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.push({ type: "error", error: { message: "commit on an empty buffer" } });
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
    const dialsBefore = h.dialledUrls.length;

    h.crash();
    await h.append(micFrame(9));
    await h.settle();

    expect(h.dialledUrls.length).toBe(dialsBefore + 1);
  });

  it("does not re-dial a call that has been ended", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "done" },
    });
    await h.settle();
    const dialsBefore = h.dialledUrls.length;

    h.crash();
    await h.append(micFrame(9));
    await h.settle();
    /* A new call may be opened by that frame, but the ENDED one is not revived. */
    const revived = eventsOfType(h, "call-started").filter(
      (event) => (event.payload as { conversationId: string }).conversationId === conversationId,
    );
    expect(revived).toHaveLength(1);
    expect(h.dialledUrls.length).toBeGreaterThanOrEqual(dialsBefore);
  });
});

/* ========================================================================== */
/* THE DUMB CLIENT'S CONTRACT                                                 */
/* ========================================================================== */

describe("what the device is told", () => {
  /* (The clear-rides-a-numbered-frame claim is pinned by "flushes through
   * the highest frame minted at that moment" — a test here staged the same
   * construction and asserted a subset of it.) */
  it("clears once at the start of a session and never again unprompted", async () => {
    /* The first frame of a fresh socket empties whatever the board was holding
     * from a session that is gone. After that, an uninterrupted answer must not
     * clear at all — a clear mid-answer is the stutter. */
    const h = makeHarness();
    await callIsLive(h);
    h.provider.answerAudio(1_000);
    h.provider.answerComplete();
    await playOutEverything(h, 3_000);
    const frames = speakerFrames(h);
    expect(frames[0]!.clearSpeakerBufferBeforeFrame).toBe(true);
    expect(
      frames.slice(1).filter((frame) => frame.clearSpeakerBufferBeforeFrame === true),
    ).toHaveLength(0);
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
    h.provider.answerAudio(2_000);
    await playOutEverything(h, 600);
    const framesBefore = speakerFrames(h).length;
    expect(framesBefore).toBeGreaterThan(0);

    h.crash();
    await h.append(micFrame(9));
    await h.settle();
    h.provider.completeHandshake();
    h.provider.answerAudio(1_000);
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
    const abandoned = h.provider;
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
    h.provider.answerAudio(600);
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

    /* Past the trailing-frame mint cooldown: this frame is a person
     * speaking again, not the dead call's last drained audio. */
    await h.advanceTime(2_000);
    await h.append(micFrame(20));
    await h.settle();
    h.provider.completeHandshake();
    await h.settle();
    const live = h.state().call!.conversationId;
    expect(live).not.toBe(first);
    const sentBefore = h.provider.sentOfType("input_audio_buffer.append").length;

    /* At-least-once delivery means the first call's obituary can arrive
     * again — or a replay from offset 0 can. It named a call that is over. */
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId: first, reason: "done" },
    });
    await h.append(micFrame(21));
    await h.settle();

    expect(h.state().call!.conversationId).toBe(live);
    expect(h.provider.closed).toBe(false);
    expect(h.provider.sentOfType("input_audio_buffer.append").length).toBeGreaterThan(sentBefore);
  });

  it("lets a re-dial record its own handshake", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.crash();
    await h.append(micFrame(9));
    await h.settle();
    h.provider.completeHandshake();
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
    h.provider.answerAudio(250);
    h.provider.answerComplete();
    await playOutEverything(h, 1_000);
    /*
     * 250 ms is 8,000 bytes of PCM16, and the only thing that shapes it on the
     * way out is the identity path's 3,198-byte slice (the largest whole
     * number of base64 groups under the 3,200-byte ceiling): 3,198 + 3,198 +
     * 1,604, so three frames and a short tail of 50.125 ms.
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
    expect(atob(frames[2]!.pcm).length / PCM16_BYTES_PER_MS).toBe(50.125);
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
    h.provider.pushRaw("{not json");
    h.provider.pushRaw(new ArrayBuffer(8));
    await h.settle();
    h.provider.answerAudio(400);
    h.provider.answerComplete();
    await playOutEverything(h, 1_000);
    expect(speakerMsDelivered(h)).toBe(400);
  });

  it("sends each provider's credential to its host and to nobody else", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url: String(url), headers: init.headers });
      return { webSocket: new FakeProvider() } as unknown as Response;
    });
    await dialProviderSocket(
      "grok",
      "https://fake.provider.test/v1/realtime",
      "grok-voice-think-fast-2.0",
    );
    await dialProviderSocket("grok", null, "grok-voice-think-fast-2.0");
    await dialProviderSocket("openai", null, "gpt-realtime");
    /* A test seam gets no credential, whichever provider it fakes. */
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(seen[1]!.headers.Authorization).toContain("/secrets/xai");
    expect(seen[1]!.url).toContain("model=grok-voice-think-fast-2.0");
    expect(seen[2]!.headers.Authorization).toContain("/secrets/openai");
    expect(seen[2]!.url).toContain("api.openai.com");
    expect(seen[2]!.url).toContain("model=gpt-realtime");
  });
});
