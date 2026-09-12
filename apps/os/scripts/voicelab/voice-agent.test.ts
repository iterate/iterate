/**
 * The voice agent's third cut, against a pretend GPT-Live server.
 *
 * WHAT THE FAKE IS FOR. GPT-Live's output is a CONTINUOUS stream — one delta
 * per 100 ms whether or not anything is being said — and it has no response
 * lifecycle, no VAD onsets, no item ids. Every claim here is about how the
 * facet turns that stream into the device's three-sentence contract (numbered
 * frames, a clear that names a sequence number, an end-of-answer marker) and
 * how it hands a delegation to the standard Agent. `fetch` is mocked rather
 * than the dial injected, so `dialProviderSocket` itself is under test too.
 *
 * THE SEQUENCE NUMBERS ARE STILL THE POINT: contiguous, a flush names one,
 * nothing after a flush's watermark is ever lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import type { Project } from "iterate/sdk";
import VoiceAgentEntrypoint, {
  dialProviderSocket,
  IDLE_TIMEOUT_MS,
  MAX_SPEAKER_PAYLOAD_BYTES,
  VoiceAgentContract,
  VoiceAgentProcessor,
  SILENCE_FILL_MS,
} from "../../../../packages/voice-agent/src/voice-agent.ts";

/* ========================================================================== */
/* A PRETEND GPT-LIVE                                                         */
/* ========================================================================== */

/** 16 kHz mono PCM16: sixteen samples, thirty-two bytes, per millisecond. */
const PCM16_BYTES_PER_MS = 32;
/** One provider delta: 100 ms, which is also the device's frame ceiling. */
const DELTA_MS = 100;
const ACTIVATION = "test-activation-a";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** `ms` of audible speech: a ramp, so a test that loses audio can say WHICH. */
function speechDelta(ms: number, seed = 1): string {
  const pcm = new Uint8Array(ms * PCM16_BYTES_PER_MS);
  for (let index = 0; index + 1 < pcm.length; index += 2) {
    const sample = 4_000 + ((index / 2 + seed * 7) % 2_000);
    pcm[index] = sample & 0xff;
    pcm[index + 1] = (sample >> 8) & 0xff;
  }
  return base64(pcm);
}

/** `ms` of what the idle stream carries: digital zero. */
function silenceDelta(ms: number): string {
  return base64(new Uint8Array(ms * PCM16_BYTES_PER_MS));
}

/**
 * The pretend provider, and the pretend socket it speaks over. Deliberately
 * not a WebSocket subclass: the facet only ever calls `addEventListener`,
 * `send`, `close` and `accept`.
 */
class FakeLive {
  /** Everything the facet sent us, parsed, oldest first. */
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  notifyClose = true;
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
    if (!this.notifyClose) return;
    for (const listener of this.#listeners.get("close") ?? []) listener({});
  }

  sentOfType(type: string) {
    return this.sent.filter((message) => message.type === type);
  }

  /** The `session.start` the facet opened with, or throws. */
  get startedWith(): Record<string, unknown> {
    const start = this.sentOfType("session.start")[0];
    if (!start) throw new Error("no session.start was sent");
    return start.session as Record<string, unknown>;
  }

  /* ------------------------------------------------- the provider's voice */

  pushRaw(data: unknown): void {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data });
  }

  push(message: Record<string, unknown>): void {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }

  /** The one edge that makes a session usable. */
  start(): void {
    this.push({ type: "session.started", event_id: "e1", session: { id: "live_fake" } });
  }

  /** `ms` of speech, as 100 ms deltas. */
  speech(ms: number): void {
    for (let sent = 0; sent < ms; sent += DELTA_MS) {
      this.push({
        type: "session.output_audio.delta",
        delta: speechDelta(Math.min(DELTA_MS, ms - sent), sent / DELTA_MS),
      });
    }
  }

  /** `ms` of the idle stream. */
  silence(ms: number): void {
    for (let sent = 0; sent < ms; sent += DELTA_MS) {
      this.push({
        type: "session.output_audio.delta",
        delta: silenceDelta(Math.min(DELTA_MS, ms - sent)),
      });
    }
  }

  userSays(delta: string, startMs: number, endMs: number): void {
    this.push({ type: "session.input_transcript.delta", delta, start_ms: startMs, end_ms: endMs });
  }

  assistantSays(delta: string, startMs: number, endMs: number): void {
    this.push({ type: "session.output_transcript.delta", delta, start_ms: startMs, end_ms: endMs });
  }

  /** The voice handed the conversation so far to the backend. */
  delegationCreated(id = "item_b", offsetMs = 0): void {
    this.push({
      type: "session.delegation.created",
      offset_ms: offsetMs,
      delegation: { id, target: "client" },
    });
  }
}

/* ================================================================ harness */

function makeHarness(Processor: typeof VoiceAgentProcessor = VoiceAgentProcessor) {
  const sockets: FakeLive[] = [];
  const dialled: { url: string; headers: Record<string, string> }[] = [];
  /* `fetch` IS THE SEAM, because that is what `dialProviderSocket` uses. */
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
    dialled.push({ url: String(url), headers: init?.headers ?? {} });
    const socket = new FakeLive();
    sockets.push(socket);
    return { webSocket: socket } as unknown as Response;
  });

  const agentCreates: string[] = [];
  const agentAppends: { path: string; events: unknown[] }[] = [];
  const projectRoot: { current: unknown } = {
    current: {
      agents: {
        get: (path: string) => ({
          create: async () => {
            agentCreates.push(path);
          },
          append: async (...events: unknown[]) => {
            agentAppends.push({ path, events });
          },
        }),
      },
    },
  };

  const harness = makeProcessorHarness<VoiceAgentContract, VoiceAgentProcessor>({
    path: "/agents/voice/test",
    createProcessor: (deps) =>
      new Processor({
        ...deps,
        nowAtFacetMs: deps.now,
        buildCacheKey: "test-build",
        dialProvider: dialProviderSocket,
        withProject: (fn) => fn(projectRoot.current as Project),
      }),
  });
  return {
    ...harness,
    sockets,
    get provider() {
      return sockets[sockets.length - 1]!;
    },
    dialled,
    projectRoot,
    agentCreates,
    agentAppends,
  };
}

type Harness = ReturnType<typeof makeHarness>;

/* ------------------------------------------------------------ read helpers */

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

function speakerClears(h: Harness) {
  return speakerFrames(h).filter(
    (frame) => frame.clearSpeakerBufferBeforeFrame === true && frame.pcm === "",
  );
}

function eventsOfType(h: Harness, type: string) {
  return h.events().filter((event) => event.type === `events.iterate.com/voice-agent/${type}`);
}

function speakerMsDelivered(h: Harness): number {
  return speakerFrames(h).reduce(
    (total, frame) => total + atob(frame.pcm).length / PCM16_BYTES_PER_MS,
    0,
  );
}

/* ----------------------------------------------------------- write helpers */

function micFrame(deviceMicFrameSeq: number, activation = ACTIVATION) {
  return {
    type: "events.iterate.com/voice-agent/mic-frame" as const,
    payload: {
      activation,
      deviceMicFrameSeq,
      pcm: base64(new Uint8Array(20 * PCM16_BYTES_PER_MS)),
      capturedAtDeviceMs: deviceMicFrameSeq * 20,
    },
  };
}

/**
 * Get to "a live call with a started session", which almost every test needs
 * and none of them is about.
 */
async function callIsLive(h: Harness, configured: Record<string, unknown> = {}): Promise<string> {
  await h.append({
    type: "events.iterate.com/voice-agent/configured",
    payload: configured,
  });
  await h.append(micFrame(1));
  await h.settle();
  h.provider.start();
  await h.settle();
  const started = eventsOfType(h, "call-started");
  return (started[0]!.payload as { conversationId: string }).conversationId;
}

/** Let the timers and the tick chains run `ms` of the fake clock, in coarse steps. */
async function playOutEverything(h: Harness, ms: number): Promise<void> {
  await h.settle();
  for (let spent = 0; spent < ms; ) {
    const step = Math.min(1_000, ms - spent);
    await h.advanceTime(step);
    await h.settle();
    spent += step;
  }
}

/** Speech, then enough silence to end the answer, then the drain. */
async function answer(h: Harness, speechMs: number): Promise<void> {
  h.provider.speech(speechMs);
  h.provider.silence(1_000);
  await playOutEverything(h, speechMs + 2_000);
}

/** Eviction: abandon the incarnation; the next frame wakes the successor. */
async function evict(h: Harness): Promise<void> {
  h.crash();
  await h.append(micFrame(9));
  await h.settle();
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

  it("closes a dial whose call-started record was rejected", async () => {
    const h = makeHarness();
    h.stream.failAppendsOfType = "events.iterate.com/voice-agent/call-started";
    await expect(h.append(micFrame(1))).rejects.toThrow("injected append failure");
    expect(h.sockets).toHaveLength(1);
    expect(h.provider.closed).toBe(true);

    h.stream.failAppendsOfType = undefined;
    h.crash();
    await h.append(micFrame(2));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(1);
    expect(h.sockets).toHaveLength(2);
  });

  it("pads the kit firmware's unpadded base64 before the provider sees it", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* voicelab_stream.c encodes RFC 4648 unpadded: 640 bytes → 854 chars. */
    const unpadded = micFrame(7).payload.pcm.replace(/=+$/, "");
    expect(unpadded.length % 4).not.toBe(0);
    await h.append({ ...micFrame(7), payload: { ...micFrame(7).payload, pcm: unpadded } });
    await h.settle();
    const appends = h.provider.sentOfType("session.input_audio.append");
    expect(appends.at(-1)!.audio).toBe(micFrame(7).payload.pcm);
    expect(Buffer.from(String(appends.at(-1)!.audio), "base64")).toHaveLength(640);
  });

  it("keeps the provider's input stream continuous: silence fills every 100 ms the device is quiet", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const sentAtStart = h.provider.sentOfType("session.input_audio.append").length;
    /* A released button: nothing from the device for a second. The fill is
     * a tick chain, so the clock steps through it. */
    for (let step = 0; step < 10; step++) {
      await h.advanceTime(SILENCE_FILL_MS);
      await h.settle();
    }
    const fills = h.provider.sentOfType("session.input_audio.append").slice(sentAtStart);
    expect(fills.length).toBeGreaterThanOrEqual(9);
    const silence = Buffer.from(String(fills[0]!.audio), "base64");
    expect(silence).toHaveLength(SILENCE_FILL_MS * 32);
    expect(silence.every((byte) => byte === 0)).toBe(true);
    /* Device audio covers its own DURATION, not its arrival: a burst of 25
     * frames (500 ms) sent at once suppresses the fill for the next 500 ms —
     * filling inside a burst chops the person's words with silence. */
    const before = h.provider.sentOfType("session.input_audio.append").length;
    const burst = Array.from({ length: 25 }, (_, index) => micFrame(50 + index));
    await h.append(...burst);
    for (let step = 0; step < 4; step++) {
      await h.advanceTime(SILENCE_FILL_MS);
      await h.settle();
    }
    const since = h.provider.sentOfType("session.input_audio.append").slice(before);
    expect(since.map((append) => append.audio)).toEqual(burst.map((frame) => frame.payload.pcm));
    /* Past the burst's 500 ms the fill resumes. */
    await h.advanceTime(SILENCE_FILL_MS * 2);
    await h.settle();
    expect(h.provider.sentOfType("session.input_audio.append").length).toBeGreaterThan(
      before + burst.length,
    );
  });

  it("ends rather than truncating microphone audio beyond the opening budget", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {},
    });
    const held = Array.from({ length: 21 }, (_, index) => ({
      ...micFrame(index + 1),
      payload: { ...micFrame(index + 1).payload, pcm: speechDelta(1_000, index) },
    }));
    await h.append(...held);
    await h.settle();
    h.provider.start();
    await h.settle();
    const delivered = h.provider.sentOfType("session.input_audio.append");
    expect(delivered.map((append) => append.audio)).toEqual(held.map((frame) => frame.payload.pcm));

    const overflowing = makeHarness();
    await overflowing.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {},
    });
    await overflowing.append(...held, micFrame(99));
    await overflowing.settle();
    const endings = eventsOfType(overflowing, "conversation-ended");
    expect(endings).toHaveLength(1);
    expect((endings[0]!.payload as { reason: string }).reason).toContain("microphone audio");
    await overflowing.append(micFrame(100));
    expect(eventsOfType(overflowing, "conversation-ended")).toHaveLength(1);
  });

  it("ends a call whose silence clock cannot catch up without a burst", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const sentBefore = h.provider.sentOfType("session.input_audio.append").length;
    /* The test clock resumes after one missed second, not on every 100 ms tick. */
    await h.advanceTime(SILENCE_FILL_MS * 11);
    await h.settle();
    expect(h.provider.sentOfType("session.input_audio.append")).toHaveLength(sentBefore);
    const endings = eventsOfType(h, "conversation-ended");
    expect(endings).toHaveLength(1);
    expect((endings[0]!.payload as { reason: string }).reason).toContain("input clock");
  });

  it("drops an empty mic frame instead of forwarding it (the provider rejects empty audio)", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { instructions: "You are Iterate on a small speaker." },
    });
    const empty = { ...micFrame(1), payload: { ...micFrame(1).payload, pcm: "" } };
    await h.append(empty);
    await h.settle();
    /* An empty frame opens no call, either. */
    expect(eventsOfType(h, "call-started")).toHaveLength(0);
    await h.append(micFrame(2), empty, micFrame(3));
    h.provider.start();
    await h.settle();
    const appends = h.provider.sentOfType("session.input_audio.append");
    expect(appends.map((append) => append.audio)).toEqual([
      micFrame(2).payload.pcm,
      micFrame(3).payload.pcm,
    ]);
  });

  it("starts the session the moment the socket is adopted, and holds capture until it is started", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { instructions: "You are Iterate on a small speaker." },
    });
    await h.append(micFrame(1), micFrame(2), micFrame(3));
    await h.settle();
    /* session.start is the FIRST message — there is no session.created to wait for. */
    expect(h.provider.sent[0]!.type).toBe("session.start");
    expect(h.provider.sentOfType("session.input_audio.append")).toHaveLength(0);
    const session = h.provider.startedWith;
    expect(session.model).toBe("gpt-live-1");
    expect(session.audio).toEqual({
      format: { type: "audio/pcm", rate: 16_000 },
      output: { voice: "marin" },
    });
    expect(String(session.instructions)).toContain("You are Iterate on a small speaker.");
    expect(String(session.instructions)).toContain("Delegation policy:");
    expect(String(session.instructions)).toContain(
      "Always request a NEW client delegation when the user asks to end or hang up",
    );
    expect(String(session.instructions)).toContain("Saying goodbye does not close it: delegate");
    expect(String(session.instructions)).toContain("Delegate to the backend when:");
    expect(String(session.instructions)).toContain("When uncertain, delegate.");
    expect(session.delegation).toEqual({ type: "client" });

    h.provider.start();
    await h.settle();
    /* Every held frame, VERBATIM — the device's own base64, no transcode. */
    const appends = h.provider.sentOfType("session.input_audio.append");
    expect(appends).toHaveLength(3);
    expect(appends[0]!.audio).toBe(micFrame(1).payload.pcm);
    const accepted = eventsOfType(h, "conversation-accepted")[0]!.payload as {
      heldMicFrames: number;
    };
    expect(accepted.heldMicFrames).toBe(3);
    /* And the briefing is on the record. */
    const configured = eventsOfType(h, "session-configured")[0]!.payload as {
      delegation: string;
      provider: string;
    };
    expect(configured.provider).toBe("gpt-live");
    expect(configured.delegation).toBe("client");
  });

  it("sends later capture straight through, and nothing else", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const before = h.provider.sent.length;
    await h.append(micFrame(2), micFrame(3));
    await h.settle();
    const later = h.provider.sent.slice(before).map((message) => message.type);
    /* Two frames, and nothing else: no commit, no response.create, no mute. */
    expect(later).toEqual(["session.input_audio.append", "session.input_audio.append"]);
  });

  it("backend overrides do not change the client delegation", async () => {
    const h = makeHarness();
    await callIsLive(h, {
      backend: { model: "gpt-5.6-terra", reasoningEffort: "none", serviceTier: "default" },
    });
    const session = h.provider.startedWith;
    expect(session.model).toBe("gpt-live-1");
    expect((session.audio as { output: { voice: string } }).output.voice).toBe("marin");
    expect(session.delegation).toEqual({ type: "client" });
  });

  it("replays exact v23 configured and session-configured rows", async () => {
    const historicSessionConfigured = {
      type: "events.iterate.com/voice-agent/session-configured" as const,
      payload: {
        activation: "historic-activation",
        conversationId: "historic-conversation",
        provider: "gpt-live",
        instructions: "Historic voice instructions.",
        backendModel: "gpt-6-astra",
        tools: ["exec_typescript", "hang_up"],
      },
    };
    expect(VoiceAgentContract.parseEventInput(historicSessionConfigured)).toMatchObject(
      historicSessionConfigured,
    );
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {
        instructions: "Historic voice instructions.",
        visemes: true,
        backend: {
          model: "gpt-6-astra",
          reasoningEffort: "low",
          serviceTier: "priority",
        },
        tools: [{ name: "hang_up", description: "End the call." }],
      },
    });
    await h.stream.append(historicSessionConfigured);
    await h.append(
      {
        type: "events.iterate.com/voice-agent/utterance-transcript",
        payload: { conversationId: "historic-conversation", text: "Historic listener turn." },
      },
      {
        type: "events.iterate.com/voice-agent/answer-transcript",
        payload: { conversationId: "historic-conversation", text: "Historic assistant turn." },
      },
    );
    await h.settle();
    expect(h.agentAppends.flatMap((append) => append.events)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          content: "Historic listener turn.",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          role: "developer",
          content: "Voice agent (spoken transcript): Historic assistant turn.",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        }),
      }),
    ]);
    await h.append(micFrame(1));
    await h.settle();
    expect(h.state().call?.activation).toBe(ACTIVATION);
  });

  it("seeds the session with the fold's transcript as typed history", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {},
    });
    await h.append(
      {
        type: "events.iterate.com/voice-agent/utterance-transcript",
        payload: { conversationId: "conv_old", text: "Count to three." },
      },
      {
        type: "events.iterate.com/voice-agent/answer-transcript",
        payload: { conversationId: "conv_old", text: "One, two," },
      },
    );
    await h.append(micFrame(1));
    await h.settle();
    const input = h.provider.startedWith.input as { role: string; content: { text: string }[] }[];
    expect(input.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(input[0]!.content[0]!.text).toBe("Count to three.");
    expect(input[1]!.content[0]!.text).toContain("One, two,");
    /* Instructions carry the policy, not the history. */
    expect(String(h.provider.startedWith.instructions)).not.toContain("Count to three.");
  });

  it("ends the call when the handshake never completes", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: {},
    });
    await h.append(micFrame(1));
    await h.settle();
    await playOutEverything(h, 20_000);
    await h.settle();
    const ended = eventsOfType(h, "conversation-ended");
    expect(ended).toHaveLength(1);
    expect((ended[0]!.payload as { reason: string }).reason).toContain("did not become ready");
    expect(h.provider.closed).toBe(true);
  });
});

describe("the dial", () => {
  it("carries no model in the URL and the credential only to OpenAI", async () => {
    const h = makeHarness();
    await dialProviderSocket();
    expect(h.dialled[0]!.url).toBe("https://api.openai.com/v1/live/sessions");
    expect(h.dialled[0]!.url).not.toContain("model=");
    expect(h.dialled[0]!.headers.Authorization).toBe('Bearer getSecret("/secrets/openai")');
    expect(h.sockets[0]!.accepted).toBe(true);
    expect(h.sockets[0]!.binaryType).toBe("arraybuffer");
  });

  it("ends the call when the provider refuses the upgrade", async () => {
    const h = makeHarness();
    vi.stubGlobal("fetch", async () => ({}) as Response);
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append(micFrame(1));
    await h.settle();
    const ended = eventsOfType(h, "conversation-ended");
    expect(ended).toHaveLength(1);
    expect((ended[0]!.payload as { reason: string }).reason).toContain("refused");
  });
});

/* ========================================================================== */
/* THE SPEAKER LANE                                                           */
/* ========================================================================== */

describe("the speaker lane", () => {
  it("drops the idle stream's silence and sends nothing", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.silence(5_000);
    await playOutEverything(h, 6_000);
    expect(speakerFrames(h)).toHaveLength(0);
  });

  it("numbers every frame contiguously from one and delivers every millisecond of speech", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await answer(h, 1_000);
    const frames = speakerFrames(h);
    const seqs = frames.map((frame) => frame.deviceSpeakerFrameSeq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
    /* Ten deltas of 100 ms, each one frame — no two-byte tails — plus the
     * trailing silence the answer is allowed to carry, then the marker. */
    const audible = frames.filter((frame) => frame.pcm !== "");
    expect(audible.length).toBeGreaterThanOrEqual(10);
    expect(atob(audible[0]!.pcm).length).toBe(MAX_SPEAKER_PAYLOAD_BYTES);
    expect(speakerMsDelivered(h)).toBeGreaterThanOrEqual(1_000);
  });

  it("ends the call rather than silently losing a rejected speaker frame", async () => {
    const h = makeHarness();
    const append = h.stream.append.bind(h.stream);
    let rejected = false;
    vi.spyOn(h.stream, "append").mockImplementation(async (...inputs) => {
      if (
        !rejected &&
        inputs.some((input) => input.type === "events.iterate.com/voice-agent/spk-frame")
      ) {
        rejected = true;
        throw new Error("injected one-shot speaker append failure");
      }
      return append(...inputs);
    });

    await callIsLive(h);
    h.provider.speech(100);
    await h.settle();

    expect(rejected).toBe(true);
    const ended = eventsOfType(h, "conversation-ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toMatchObject({
      reason: "the device speaker frame could not be appended",
    });
    expect(h.provider.closed).toBe(true);
    expect(h.state().call).toBeNull();
    /* The failed audio is never replayed; only the existing empty cleanup
     * frame may follow before the durable terminal event reaches the device. */
    expect(speakerFrames(h).filter((frame) => frame.pcm !== "")).toEqual([]);
    expect(speakerFrames(h).filter((frame) => frame.lastFrameOfAnswer === true)).toEqual([]);

    h.provider.speech(100);
    await h.settle();
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    expect(speakerFrames(h).filter((frame) => frame.pcm !== "")).toEqual([]);
    expect(speakerFrames(h).filter((frame) => frame.lastFrameOfAnswer === true)).toEqual([]);
  });

  it("ends the answer after 700 ms of silence with a numbered marker, and keeps short pauses", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.speech(300);
    h.provider.silence(400); /* a pause inside the answer: sent */
    h.provider.speech(300);
    h.provider.silence(700); /* the end */
    h.provider.silence(3_000); /* idle: dropped */
    await playOutEverything(h, 6_000);
    const frames = speakerFrames(h);
    const markers = frames.filter((frame) => frame.lastFrameOfAnswer === true);
    expect(markers).toHaveLength(1);
    const last = frames.at(-1)!;
    expect(last.lastFrameOfAnswer).toBe(true);
    expect(last.pcm).toBe("");
    expect(last.deviceSpeakerFrameSeq).toBe(frames.length);
    /* 300 + 400 + 300 of the answer, up to 700 of trailing silence, and none
     * of the three idle seconds. */
    expect(speakerMsDelivered(h)).toBeGreaterThanOrEqual(1_000);
    expect(speakerMsDelivered(h)).toBeLessThanOrEqual(1_700);
  });

  it("cuts a delta larger than the device's frame ceiling into frames it will accept", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* 4,000 bytes: over the ceiling (no provider sends one today), with its
     * base64 padding trimmed for good measure. */
    const oversized = speechDelta(125).replace(/=+$/, "");
    h.provider.push({ type: "session.output_audio.delta", delta: oversized });
    h.provider.silence(1_000);
    await playOutEverything(h, 3_000);
    for (const frame of speakerFrames(h)) {
      expect(atob(frame.pcm).length).toBeLessThanOrEqual(MAX_SPEAKER_PAYLOAD_BYTES);
    }
    expect(speakerMsDelivered(h)).toBeGreaterThanOrEqual(124);
  });

  it("hands every delta to the device the moment it arrives — nothing is paced or held", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* Ten seconds of speech in one go: all of it is on the stream before the
     * clock moves at all. The device's own buffer is the only buffer. */
    h.provider.speech(10_000);
    await h.settle();
    expect(speakerMsDelivered(h)).toBe(10_000);
    expect(speakerFrames(h)).toHaveLength(100);
  });

  it("a burst of deltas starts ONE background sender, not one keepalive registration per frame", async () => {
    /* Every `runInBackground` rides the processor keepalive, which re-arms
     * its recovery record (a storage write) per registration. Ten of those a
     * second put a write ahead of every frame — measured on preview as one
     * frame reaching the device every ~1.5 s. */
    let registrations = 0;
    class CountingProcessor extends VoiceAgentProcessor {
      protected override runInBackground(work: () => Promise<unknown>): void {
        registrations += 1;
        super.runInBackground(work);
      }
    }
    const h = makeHarness(CountingProcessor);
    await callIsLive(h);
    registrations = 0;
    h.provider.speech(10_000);
    await h.settle();
    expect(speakerFrames(h)).toHaveLength(100);
    /* The sender, plus the mirror's own flush: nowhere near a hundred. */
    expect(registrations).toBeLessThan(5);
  });

  it("deltas a hundred milliseconds apart keep ONE sender registered, not one per delta", async () => {
    /* The burst above is the easy case. In steady state an append finishes
     * long before the next delta arrives, and a sender that let go each time
     * the outbox drained re-registered for nearly every frame: ten storage
     * writes a second, measured on preview-7 as facet sends gapping up to
     * 9.6 s while the provider delivered on time. */
    let registrations = 0;
    class CountingProcessor extends VoiceAgentProcessor {
      protected override runInBackground(work: () => Promise<unknown>): void {
        registrations += 1;
        super.runInBackground(work);
      }
    }
    const h = makeHarness(CountingProcessor);
    await callIsLive(h);
    registrations = 0;
    for (let delta = 0; delta < 30; delta++) {
      h.provider.speech(100);
      await h.settle();
      await h.advanceTime(100);
      await h.settle();
    }
    expect(speakerFrames(h)).toHaveLength(30);
    expect(registrations).toBeLessThan(5);
  });

  it("clears once at the start of a session and never again unprompted", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await answer(h, 500);
    await answer(h, 500);
    const frames = speakerFrames(h);
    expect(frames[0]!.clearSpeakerBufferBeforeFrame).toBe(true);
    expect(frames.slice(1).filter((frame) => frame.clearSpeakerBufferBeforeFrame)).toHaveLength(0);
  });
});

/* ========================================================================== */
/* THE BUTTON                                                                 */
/* ========================================================================== */

describe("a quiet listener", () => {
  it("a long answer with no mic frames at all keeps flowing and the call stays up", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* A half-duplex device sends NOTHING while it listens — no frames, no
     * keepalive — for longer than the idle deadline. The frames going out
     * are the activity. */
    for (let tick = 0; tick < 7; tick++) {
      h.provider.speech(10_000);
      h.provider.assistantSays(
        ` part ${String(tick)}`,
        tick * 10_000 + 3_000,
        tick * 10_000 + 3_400,
      );
      await playOutEverything(h, 10_000);
      await h.settle();
    }
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(0);
    expect(speakerMsDelivered(h)).toBe(70_000);
    /* The metronome kept running: the rows closed on the timeline. */
    expect(eventsOfType(h, "answer-transcript").length).toBeGreaterThan(0);
  });
});

/* ========================================================================== */
/* THE TRANSCRIPT                                                             */
/* ========================================================================== */

describe("the transcript", () => {
  it("groups fragments into turns closed by the metronome, both speakers, and folds the recap", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* The output stream is the clock: 1.6 s of idle silence puts the
     * timeline where the fragments say they are. */
    h.provider.silence(1_600);
    h.provider.userSays(" What", 1_000, 1_200);
    h.provider.userSays(" time", 1_200, 1_400);
    h.provider.userSays(" is it?", 1_400, 1_600);
    /* A backchannel overlapping the question: its own row. */
    h.provider.assistantSays(" Mm-hm.", 1_300, 1_500);
    /* 1.2 s later both rows are finished turns. */
    h.provider.silence(1_200);
    await h.settle();
    expect(eventsOfType(h, "utterance-transcript")).toHaveLength(1);
    expect(eventsOfType(h, "answer-transcript")).toHaveLength(1);
    h.provider.assistantSays(" It's", 3_000, 3_200);
    h.provider.assistantSays(" four.", 3_200, 3_400);
    h.provider.silence(600); /* not yet */
    await h.settle();
    expect(eventsOfType(h, "answer-transcript")).toHaveLength(1);
    h.provider.silence(1_000); /* now */
    await h.settle();

    const utterances = eventsOfType(h, "utterance-transcript").map(
      (event) => (event.payload as { text: string }).text,
    );
    const answers = eventsOfType(h, "answer-transcript").map(
      (event) => (event.payload as { text: string }).text,
    );
    expect(utterances).toEqual(["What time is it?"]);
    expect(answers).toEqual(["Mm-hm.", "It's four."]);
    /* Rows close in the order their LAST fragment ended: the backchannel
     * (1,500) before the question (1,600). */
    expect(h.state().transcript).toEqual([
      { role: "assistant", text: "Mm-hm." },
      { role: "listener", text: "What time is it?" },
      { role: "assistant", text: "It's four." },
    ]);
  });

  it("a fragment far behind its row's last opens a new row even before the metronome", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.userSays(" Hello.", 1_000, 1_400);
    h.provider.userSays(" Anyone there?", 4_000, 4_600);
    await h.settle();
    expect(
      eventsOfType(h, "utterance-transcript").map((e) => (e.payload as { text: string }).text),
    ).toEqual(["Hello."]);
  });

  it("closes the open rows when the call ends", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.userSays(" Bye for now.", 1_000, 1_600);
    await h.settle();
    expect(eventsOfType(h, "utterance-transcript")).toHaveLength(0);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "button" },
    });
    await h.settle();
    expect(eventsOfType(h, "utterance-transcript")).toHaveLength(1);
  });
});

/* ========================================================================== */
/* THINKING, FAST AND SLOW — the backend                                      */
/* ========================================================================== */

describe("the Agent bridge", () => {
  it("sets up the ordinary Agent once on the voice stream with its standing protocol", async () => {
    const agentCreates: string[] = [];
    const agentAppends: { path: string; events: unknown[] }[] = [];
    const project = {
      secrets: {
        get: () => ({
          __describe: async () => ({ created: true, hasMaterial: true }),
          [Symbol.dispose]: () => {},
        }),
      },
      agents: {
        get: (path: string) => ({
          create: async () => {
            agentCreates.push(path);
          },
          append: async (...events: unknown[]) => {
            agentAppends.push({ path, events });
          },
        }),
      },
      streams: {
        get: () => ({
          append: async () => [{ offset: 3 }],
          subscriptions: {
            get: () => ({
              waitUntilProcessed: async () => {},
              [Symbol.dispose]: () => {},
            }),
          },
          [Symbol.dispose]: () => {},
        }),
      },
    };
    /* setupVoiceAgent only needs this invocation's project capability. */
    const entrypoint = { itx: project } as unknown as VoiceAgentEntrypoint;
    await VoiceAgentEntrypoint.prototype.setupVoiceAgent.call(entrypoint, {
      streamPath: "/agents/voice/test",
      backend: { model: "gpt-6-astra" },
    });

    expect(agentCreates).toEqual(["/agents/voice/test"]);
    expect(agentAppends).toEqual([
      {
        path: "/agents/voice/test",
        events: [
          expect.objectContaining({
            type: "events.iterate.com/agent/configured",
            payload: { config: { llm: { model: "openai/gpt-6-astra" } } },
          }),
          expect.objectContaining({
            type: "events.iterate.com/agents/context-added",
            payload: expect.objectContaining({
              key: "voice-agent/protocol",
              content: expect.stringContaining(
                "Completing a task does not end a call: omit hangUp on ordinary results.",
              ),
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            }),
          }),
        ],
      },
    ]);
  });

  it("puts passive open-transcript snapshots before each queued delegation request", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.userSays("Create a note.", 1_000, 1_500);
    h.provider.delegationCreated("delegate-a");
    h.provider.delegationCreated("delegate-b");
    await h.settle();

    expect(h.agentAppends).toHaveLength(2);
    for (const [index, append] of h.agentAppends.entries()) {
      const [snapshot, metadata] = append.events as { payload: Record<string, unknown> }[];
      expect(snapshot!.payload).toMatchObject({
        role: "user",
        content: "Create a note.",
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      });
      expect(metadata!.payload).toMatchObject({
        role: "developer",
        llmRequestPolicy: { behaviour: "after-current-request" },
        content: expect.stringContaining(`"delegationId":"delegate-${index === 0 ? "a" : "b"}"`),
      });
    }
  });

  it("ends the matching call when an Agent handoff cannot be recorded", async () => {
    const h = makeHarness();
    h.projectRoot.current = {
      agents: {
        get: () => ({
          append: async () => {
            throw new Error("injected Agent append failure");
          },
        }),
      },
    };
    await callIsLive(h);
    h.provider.delegationCreated("delegate-a");
    await h.settle();

    const ended = eventsOfType(h, "conversation-ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toMatchObject({
      reason: "the Agent handoff could not be recorded: Error: injected Agent append failure",
    });
    expect(h.provider.sentOfType("session.thinking.append")).toEqual([]);
    expect(h.provider.closed).toBe(true);
  });

  it("keeps user speech distinct from observed GPT-Live speech under the same keys", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.userSays("Make", 1_000, 1_200);
    h.provider.assistantSays("Okay", 1_000, 1_200);
    h.provider.delegationCreated("delegate-a");
    await h.settle();
    const snapshots = h.agentAppends[0]!.events as { payload: Record<string, unknown> }[];
    expect(snapshots).toHaveLength(3);

    h.provider.userSays(" it private.", 1_200, 1_500);
    h.provider.assistantSays("; I will.", 1_200, 1_500);
    h.provider.silence(2_000);
    await h.settle();
    const finalized = h.agentAppends.slice(1).flatMap((append) => append.events) as {
      payload: Record<string, unknown>;
    }[];
    for (const [role, content] of [
      ["user", "Make it private."],
      ["developer", "Voice agent (spoken transcript): Okay; I will."],
    ] as const) {
      const snapshot = snapshots.find((event) => event.payload.role === role)!;
      const final = finalized.find((event) => event.payload.content === content)!;
      expect(final.payload).toMatchObject({
        role,
        key: snapshot.payload.key,
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      });
    }
  });

  it("cannot let a deferred prefix snapshot overwrite its keyed finalized transcript", async () => {
    const h = makeHarness();
    let releaseSnapshot: (() => void) | undefined;
    let snapshotKey = "";
    let markSnapshotStarted: (() => void) | undefined;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    const completedContents: string[] = [];
    h.projectRoot.current = {
      agents: {
        get: () => ({
          create: async () => {},
          append: async (...events: { payload?: { content?: unknown; key?: unknown } }[]) => {
            const context = events.find((event) => event.payload?.content === "prefix")?.payload;
            if (context) {
              snapshotKey = String(context.key);
              markSnapshotStarted!();
              await new Promise<void>((resolve) => {
                releaseSnapshot = resolve;
              });
            }
            completedContents.push(String(events[0]?.payload?.content));
          },
        }),
      },
    };
    await callIsLive(h);
    h.provider.userSays("prefix", 1_000, 1_200);
    h.provider.delegationCreated("delegate-a");
    await snapshotStarted;

    const finalProjection = h.append({
      type: "events.iterate.com/voice-agent/utterance-transcript",
      payload: { conversationId: "conv_test", text: "final", key: snapshotKey },
    });
    await Promise.resolve();
    releaseSnapshot!();
    await finalProjection;
    await h.settle();

    expect(
      completedContents.filter((content) => content === "prefix" || content === "final"),
    ).toEqual(["prefix", "final"]);
  });

  it("snapshots a just-closed turn before its durable projection arrives", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.userSays("Close then delegate.", 1_000, 1_400);
    h.provider.silence(2_000); /* queues closeTurn's durable append */
    h.provider.delegationCreated("delegate-a"); /* before that append is observed */
    await h.settle();

    const contexts = h.agentAppends.flatMap((append) => append.events) as {
      payload: Record<string, unknown>;
    }[];
    const snapshot = contexts.find(
      (event) => event.payload.content === "Close then delegate." && event.payload.role === "user",
    )!;
    const final = contexts.filter(
      (event) => event.payload.content === "Close then delegate." && event.payload.role === "user",
    )[1]!;
    expect(snapshot.payload).toMatchObject({
      key: expect.stringContaining("voice-agent/transcript:"),
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(final.payload).toMatchObject({ key: snapshot.payload.key });
  });

  it("keeps a delegation with no transcript alive and forwards later speech once it closes", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.delegationCreated("delegate-a");
    await h.settle();
    const beforeSpeech = h.agentAppends.length;

    h.provider.userSays("Make", 1_000, 1_200);
    h.provider.userSays(" a note.", 1_200, 1_500);
    await h.settle();
    /* Raw deltas do not wake the normal Agent one word at a time. */
    expect(h.agentAppends).toHaveLength(beforeSpeech);

    h.provider.silence(2_000);
    await h.settle();
    const laterContext = (
      h.agentAppends.flatMap((append) => append.events) as {
        type: string;
        payload: Record<string, unknown>;
      }[]
    ).find(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        (event.payload as { content?: unknown }).content === "Make a note.",
    ) as { payload: Record<string, unknown> } | undefined;
    expect(laterContext).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          role: "user",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        }),
      }),
    );
  });

  it("forwards each repeated completed transcript once without requesting Agent work", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await h.append(
      {
        type: "events.iterate.com/voice-agent/utterance-transcript",
        payload: { conversationId: "conv_test", text: "yes" },
      },
      {
        type: "events.iterate.com/voice-agent/utterance-transcript",
        payload: { conversationId: "conv_test", text: "yes" },
      },
      {
        type: "events.iterate.com/voice-agent/answer-transcript",
        payload: { conversationId: "conv_test", text: "I heard you." },
      },
    );
    await h.settle();
    const contexts = h.agentAppends.flatMap((append) => append.events) as {
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }[];
    expect(contexts).toHaveLength(3);
    expect(contexts.map((event) => event.payload.content)).toEqual([
      "yes",
      "yes",
      "Voice agent (spoken transcript): I heard you.",
    ]);
    expect(contexts.map((event) => event.payload.role)).toEqual(["user", "user", "developer"]);
    expect(
      contexts.every(
        (event) =>
          JSON.stringify(event.payload.llmRequestPolicy) ===
          JSON.stringify({ behaviour: "dont-trigger-request" }),
      ),
    ).toBe(true);
    expect(new Set(contexts.map((event) => event.idempotencyKey)).size).toBe(3);
  });

  it("maps all three Agent output channels, including concurrent and repeated commentary", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await h.append(
      {
        type: "events.iterate.com/voice-agent/instructions",
        payload: { activation: ACTIVATION, delegationId: "delegate-a", content: "Use Celsius." },
      },
      {
        type: "events.iterate.com/voice-agent/thinking",
        payload: { activation: ACTIVATION, delegationId: null, content: "The weather is clear." },
      },
      {
        type: "events.iterate.com/voice-agent/commentary",
        payload: { activation: ACTIVATION, delegationId: "delegate-a", content: "It is 18 C." },
      },
      {
        type: "events.iterate.com/voice-agent/commentary",
        payload: {
          activation: ACTIVATION,
          delegationId: "delegate-b",
          content: "I saved the note.",
        },
      },
      {
        type: "events.iterate.com/voice-agent/commentary",
        payload: { activation: ACTIVATION, delegationId: "delegate-a", content: "Anything else?" },
      },
    );
    await h.settle();
    const controls = h.provider.sent.filter((message) =>
      [
        "session.instructions.append",
        "session.thinking.append",
        "session.commentary.append",
      ].includes(String(message.type)),
    );
    expect(controls.map(({ event_id: _eventId, ...control }) => control)).toEqual([
      { type: "session.instructions.append", delegation_id: "delegate-a", content: "Use Celsius." },
      {
        type: "session.thinking.append",
        delegation_id: null,
        content: "The weather is clear.",
      },
      { type: "session.commentary.append", delegation_id: "delegate-a", content: "It is 18 C." },
      {
        type: "session.commentary.append",
        delegation_id: "delegate-b",
        content: "I saved the note.",
      },
      {
        type: "session.commentary.append",
        delegation_id: "delegate-a",
        content: "Anything else?",
      },
    ]);
  });

  it("never sends a late old-call commentary control into its successor", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "button" },
    });
    await h.append(micFrame(2, "activation-b"));
    await h.settle();
    h.provider.start();
    await h.settle();

    await h.append({
      type: "events.iterate.com/voice-agent/commentary",
      payload: {
        activation: ACTIVATION,
        delegationId: "delegate-a",
        content: "late old call",
      },
    });
    await h.settle();
    expect(h.provider.sentOfType("session.commentary.append")).toEqual([]);
  });

  it("keeps an in-progress acknowledgement alive, then ends after the later goodbye plays out", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.speech(100);
    await h.settle();
    await h.append({
      type: "events.iterate.com/voice-agent/commentary",
      payload: {
        activation: ACTIVATION,
        delegationId: "delegate-a",
        content: "Goodbye.",
        hangUp: true,
      },
    });
    h.provider.silence(700); /* ends the pre-existing acknowledgement */
    await h.settle();
    await playOutEverything(h, 500);
    expect(eventsOfType(h, "conversation-ended")).toEqual([]);

    h.provider.speech(200);
    h.provider.silence(700);
    await h.settle();
    expect(speakerFrames(h).some((frame) => frame.pcm !== "")).toBe(true);
    expect(speakerFrames(h).at(-1)?.lastFrameOfAnswer).toBe(true);
    await playOutEverything(h, 499);
    expect(eventsOfType(h, "conversation-ended")).toEqual([]);
    await playOutEverything(h, 1);
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
  });
});

/* ========================================================================== */
/* ENDING A CALL                                                              */
/* ========================================================================== */

describe("ending a call", () => {
  it("ends A and accepts B's opening capture before A's terminal delivery settles", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await h.append(
      {
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { activation: ACTIVATION, reason: "button" },
      },
      micFrame(2, "test-activation-b"),
      micFrame(3, "test-activation-b"),
    );
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
    h.provider.start();
    await h.settle();
    expect(h.provider.sentOfType("session.input_audio.append").map((event) => event.audio)).toEqual(
      [micFrame(2, "test-activation-b").payload.pcm, micFrame(3, "test-activation-b").payload.pcm],
    );
  });

  it("does not resurrect cancelled A when its delayed call-started record arrives", async () => {
    const h = makeHarness();
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "button" },
    });
    await h.settle();
    await h.append({
      type: "events.iterate.com/voice-agent/call-started",
      payload: { activation: ACTIVATION, conversationId: "conv_late_a" },
    });
    await h.settle();
    const calls = eventsOfType(h, "call-started").map(
      (event) => event.payload as { activation: string; conversationId: string },
    );
    expect(calls.map((call) => call.activation)).toEqual([ACTIVATION]);
    expect(h.state().call).toBeNull();
  });

  it("does not let A's late terminal erase B's cancellation fence", async () => {
    const h = makeHarness();
    const activationB = "test-activation-b";
    await callIsLive(h);
    await h.append(
      {
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { activation: ACTIVATION, reason: "button" },
      },
      micFrame(2, activationB),
    );
    await h.settle();
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: activationB, reason: "button" },
    });
    await h.settle();

    await h.append(
      {
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { activation: ACTIVATION, reason: "late" },
      },
      micFrame(3, activationB),
    );
    await h.settle();

    expect(h.state().recentEndedActivations).toEqual([activationB, ACTIVATION]);
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
  });

  it("fences B when B ends before its delayed opening microphone frame", async () => {
    const h = makeHarness();
    const activationB = "test-activation-b";
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append(
      {
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { activation: ACTIVATION, reason: "button" },
      },
      {
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { activation: activationB, reason: "button" },
      },
      micFrame(3, activationB),
    );
    await h.settle();

    expect(h.state().recentEndedActivations).toEqual([activationB, ACTIVATION]);
    expect(eventsOfType(h, "call-started")).toHaveLength(0);
  });

  it("does not append a late dial failure for A after B has replaced it", async () => {
    const h = makeHarness();
    let resolveFirstDial: ((response: Response) => void) | null = null;
    let dials = 0;
    vi.stubGlobal("fetch", () => {
      dials += 1;
      if (dials === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirstDial = resolve;
        });
      }
      return new Promise<Response>(() => {});
    });
    await h.append(micFrame(1));
    await h.settle();
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "button" },
    });
    await h.settle();
    await h.append(micFrame(2, "test-activation-b"));
    await h.settle();
    resolveFirstDial!({ webSocket: { close: () => {} } } as unknown as Response);
    await h.settle();
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    expect(h.state().call).toMatchObject({ activation: "test-activation-b" });
  });

  it("a device-appended obituary silences the speaker, closes the session and frees the dial NOW", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.speech(10_000);
    await h.settle();
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "button" },
    });
    await h.settle();
    expect(speakerClears(h)).toHaveLength(1);
    expect(h.provider.sentOfType("session.close")).toHaveLength(1);
    expect(h.provider.closed).toBe(true);
    /* The next frame, past the dying-breath guard, mints a fresh call on a
     * fresh socket. */
    await playOutEverything(h, 2_000);
    await h.append(micFrame(20, "test-activation-b"));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
    expect(h.sockets).toHaveLength(2);
  });

  it("a frame in the last call's dying breath mints no zombie; one after it opens the next call", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "button" },
    });
    await h.settle();
    /* The device drains its mic queue for ~100 ms after the far end hangs
     * up; those frames must not open a call to an empty room. */
    await h.append(micFrame(20), micFrame(21));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(1);
    await playOutEverything(h, 2_000);
    await h.append(micFrame(22, "test-activation-b"));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
  });

  it("a stale obituary for a dead call cannot touch the live one", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: "somebody-else", reason: "button" },
    });
    await h.settle();
    expect(h.provider.closed).toBe(false);
    expect(h.state().call).not.toBeNull();
  });

  it("ends after a minute with no input from the device", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await playOutEverything(h, IDLE_TIMEOUT_MS + 10_000);
    await h.settle();
    const ended = eventsOfType(h, "conversation-ended");
    expect(ended).toHaveLength(1);
    expect((ended[0]!.payload as { reason: string }).reason).toContain("no input");
    expect(h.state().call).toBeNull();
    expect(h.provider.sentOfType("session.close")).toHaveLength(1);
  });

  it("buries a call whose dial never resolves at the same idle deadline", async () => {
    const h = makeHarness();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append(micFrame(1));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(1);
    await playOutEverything(h, IDLE_TIMEOUT_MS + 10_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    await h.append(micFrame(2, "test-activation-b"));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
  });

  it("does not end a call while it is still speaking, nor one the device keeps feeding", async () => {
    const speaking = makeHarness();
    await callIsLive(speaking);
    /* A long answer arrives at play rate, ten seconds at a time, well past
     * the idle deadline: the frames going out ARE the activity. */
    for (let tick = 0; tick < 8; tick++) {
      speaking.provider.speech(10_000);
      await playOutEverything(speaking, 10_000);
      await speaking.settle();
    }
    expect(eventsOfType(speaking, "conversation-ended")).toHaveLength(0);

    const fed = makeHarness();
    await callIsLive(fed);
    for (let tick = 0; tick < 5; tick++) {
      await playOutEverything(fed, 20_000);
      await fed.append({ type: "events.iterate.com/voice-agent/keepalive", payload: {} });
      await fed.settle();
    }
    expect(eventsOfType(fed, "conversation-ended")).toHaveLength(0);
  });

  it("ends an interrupted provider session rather than replaying it", async () => {
    const closed = makeHarness();
    await callIsLive(closed);
    closed.provider.push({ type: "session.closed", reason: "expired", usage: { seconds: 9 } });
    await closed.settle();
    const recorded = eventsOfType(closed, "provider-disconnected");
    expect(recorded).toHaveLength(1);
    expect((recorded[0]!.payload as { reason: string }).reason).toContain("expired");
    expect(eventsOfType(closed, "conversation-ended")).toHaveLength(1);

    const dropped = makeHarness();
    await callIsLive(dropped);
    dropped.provider.close();
    await dropped.settle();
    expect(eventsOfType(dropped, "conversation-ended")).toHaveLength(1);
    expect(eventsOfType(dropped, "provider-disconnected")).toHaveLength(1);
  });

  it("retries a rejected terminal append through the processor recovery alarm", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.stream.failAppendsOfType = "events.iterate.com/voice-agent/conversation-ended";
    h.provider.close();
    await h.settle();
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(0);
    expect(h.state().call).not.toBeNull();
    expect(h.sockets).toHaveLength(1);

    h.stream.failAppendsOfType = undefined;
    await playOutEverything(h, 30_000);
    expect(h.events().map((event) => event.type)).toContain(
      "events.iterate.com/stream/processor-revived",
    );
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    expect(h.state().call).toBeNull();
    expect(h.sockets).toHaveLength(1);
  });

  it("recovers one terminal after speaker and terminal appends each reject once", async () => {
    const h = makeHarness();
    const append = h.stream.append.bind(h.stream);
    let rejectedSpeaker = false;
    let rejectedTerminal = false;
    vi.spyOn(h.stream, "append").mockImplementation(async (...inputs) => {
      const type = inputs[0]?.type;
      if (!rejectedSpeaker && type === "events.iterate.com/voice-agent/spk-frame") {
        rejectedSpeaker = true;
        throw new Error("injected one-shot speaker append failure");
      }
      if (!rejectedTerminal && type === "events.iterate.com/voice-agent/conversation-ended") {
        rejectedTerminal = true;
        h.crash();
        throw new Error("injected one-shot terminal append failure");
      }
      return append(...inputs);
    });

    await callIsLive(h);
    h.provider.notifyClose = false;
    h.provider.speech(100);
    await h.settle();
    await h.advanceTime(10_000);

    expect(rejectedSpeaker).toBe(true);
    expect(rejectedTerminal).toBe(true);
    expect(h.events().map((event) => event.type)).toContain(
      "events.iterate.com/stream/processor-revived",
    );
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    expect(h.state().call).toBeNull();
    expect(h.provider.closed).toBe(true);
  });

  it("does not revive an ended call when its abandoned provider closes or the facet restarts", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    const abandoned = h.provider;
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "button" },
    });
    abandoned.close();
    await h.settle();
    expect(h.sockets).toHaveLength(1);
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);

    h.crash();
    await h.append(micFrame(99, "test-activation-b"));
    await h.settle();
    const calls = eventsOfType(h, "call-started").map(
      (event) => (event.payload as { conversationId: string }).conversationId,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toBe(conversationId);
    expect(h.sockets).toHaveLength(2);
  });

  it("writes the provider's error where somebody can read it", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.push({
      type: "error",
      error: { type: "invalid_request_error", code: "unknown_parameter", message: "nope" },
    });
    await h.settle();
    const errors = eventsOfType(h, "provider-error");
    expect(errors).toHaveLength(1);
    expect((errors[0]!.payload as { message: string }).message).toContain("unknown_parameter");
  });
});

/* ========================================================================== */
/* EVICTION AND RECOVERY                                                      */
/* ========================================================================== */

describe("eviction", () => {
  it("ends an active call after eviction instead of reconnecting it", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await evict(h);
    expect(h.sockets).toHaveLength(1);
    const ended = eventsOfType(h, "conversation-ended");
    expect(ended).toHaveLength(1);
    expect((ended[0]!.payload as { reason: string }).reason).toContain("interrupted");

    await h.append(micFrame(10, "test-activation-b"));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
    expect(h.sockets).toHaveLength(2);
  });

  it("does not replay held opening audio after eviction", async () => {
    const h = makeHarness();
    await h.append({ type: "events.iterate.com/voice-agent/configured", payload: {} });
    await h.append(micFrame(1));
    await h.settle();
    const abandoned = h.provider;
    expect(abandoned.sentOfType("session.input_audio.append")).toHaveLength(0);

    await evict(h);
    expect(h.sockets).toHaveLength(1);
    expect(abandoned.sentOfType("session.input_audio.append")).toHaveLength(0);
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);

    await h.append(micFrame(10, "test-activation-b"));
    await h.settle();
    h.provider.start();
    await h.settle();
    expect(h.sockets).toHaveLength(2);
    expect(h.provider.sentOfType("session.input_audio.append")).toHaveLength(1);
  });

  it("does not re-dial a call that has been ended", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "test" },
    });
    await h.settle();
    await evict(h);
    /* The waking frame may open a NEW call; the ENDED one is not revived. */
    const revived = eventsOfType(h, "call-started").filter(
      (event) => (event.payload as { conversationId: string }).conversationId === conversationId,
    );
    expect(revived).toHaveLength(1);
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
  });

  it("ignores a superseded socket that is still talking", async () => {
    const h = makeHarness();
    await callIsLive(h);
    const abandoned = h.provider;
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: ACTIVATION, reason: "done" },
    });
    await h.settle();
    const micSentBefore = abandoned.sentOfType("session.input_audio.append").length;
    const framesBefore = speakerFrames(h).length;
    /* close() is not instant: messages already in flight arrive after it.
     * They must not revive the call, empty the microphone queue into a dead
     * connection, reach the device, or be recorded as the live call's. */
    abandoned.start();
    abandoned.speech(1_000);
    abandoned.push({ type: "error", error: { type: "x", code: "y", message: "from the grave" } });
    await playOutEverything(h, 2_000);
    expect(abandoned.sentOfType("session.input_audio.append")).toHaveLength(micSentBefore);
    expect(speakerFrames(h)).toHaveLength(framesBefore);
    expect(eventsOfType(h, "provider-error")).toHaveLength(0);
    expect(h.state().call).toBeNull();
  });

  it("survives a malformed provider message and keeps listening", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.pushRaw("{not json");
    h.provider.pushRaw(new ArrayBuffer(8));
    await h.settle();
    await answer(h, 200);
    expect(speakerMsDelivered(h)).toBeGreaterThan(0);
  });
});
