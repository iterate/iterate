/**
 * The voice agent's third cut, against a pretend GPT-Live server.
 *
 * WHAT THE FAKE IS FOR. GPT-Live's output is a CONTINUOUS stream — one delta
 * per 100 ms whether or not anything is being said — and it has no response
 * lifecycle, no VAD onsets, no item ids. Every claim here is about how the
 * facet turns that stream into the device's three-sentence contract (numbered
 * frames, a clear that names a sequence number, an end-of-answer marker) and
 * how it answers the backend model's function calls. `fetch` is mocked rather
 * than the dial injected, so `dialProviderSocket` itself is under test too.
 *
 * THE SEQUENCE NUMBERS ARE STILL THE POINT: contiguous, a flush names one,
 * nothing after a flush's watermark is ever lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import {
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

  sentOfType(type: string) {
    return this.sent.filter((message) => message.type === type);
  }

  /** The `session.start` the facet opened with, or throws. */
  get startedWith(): Record<string, unknown> {
    const start = this.sentOfType("session.start")[0];
    if (start === undefined) throw new Error("no session.start was sent");
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

  /** The backend asked for a function, nested the way the wire nests it. */
  backendFunctionCall(callId: string, name: string, args: string): void {
    this.push({
      type: "response.event",
      event_id: "e_fn",
      delegation_id: "item_b",
      event: {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: callId, name, arguments: args },
      },
    });
  }

  /** The voice handed the conversation so far to the backend. */
  delegationCreated(id = "item_b", offsetMs = 0): void {
    this.push({
      type: "session.delegation.created",
      offset_ms: offsetMs,
      delegation: { id, target: "responses" },
    });
  }

  /** The backend's final words. */
  backendMessage(itemId: string, text: string): void {
    this.push({
      type: "response.event",
      event_id: "e_msg",
      delegation_id: "item_b",
      event: {
        type: "response.output_item.done",
        item: { type: "message", id: itemId, content: [{ type: "output_text", text }] },
      },
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

  /* What a backend function walks: a stand-in for the guest's itx that
   * records the scripts it was asked to run — and, like a real voice
   * stream, has no capability host until somebody creates it. */
  const scripts: string[] = [];
  let hostCreates = 0;
  const projectRoot: { current: unknown } = {
    current: {
      capabilityHost: {
        create: async () => {
          hostCreates += 1;
        },
        runScript: async (code: string) => {
          if (hostCreates === 0) {
            throw new Error("capability host at /agents/voice/test has not been created");
          }
          scripts.push(code);
          return { result: { files: 3 } };
        },
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
        dialProvider: (baseUrl) => dialProviderSocket(baseUrl),
        withProject: (fn) => fn(projectRoot.current),
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
    scripts,
    hostCreates: () => hostCreates,
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

/** The mirror lane's payloads, oldest first. */
function mirrored(h: Harness) {
  return eventsOfType(h, "grok-event").map((event) => event.payload as Record<string, unknown>);
}

/* ----------------------------------------------------------- write helpers */

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

const SEAM = "https://fake.provider.test/v1/live/sessions";

/**
 * Get to "a live call with a started session", which almost every test needs
 * and none of them is about.
 */
async function callIsLive(h: Harness, configured: Record<string, unknown> = {}): Promise<string> {
  await h.append({
    type: "events.iterate.com/voice-agent/configured",
    payload: { providerBaseUrl: SEAM, ...configured },
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

  it("drops an empty mic frame instead of forwarding it (the provider rejects empty audio)", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: SEAM, instructions: "You are Iterate on a small speaker." },
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
      payload: { providerBaseUrl: SEAM, instructions: "You are Iterate on a small speaker." },
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
    /* ONE backend, the fast Astra, with exec_typescript. */
    const delegation = session.delegation as {
      type: string;
      responses: {
        model: string;
        reasoning: { effort: string };
        service_tier: string;
        tools: { name: string }[];
        parallel_tool_calls: boolean;
        instructions: string;
      };
    };
    expect(delegation.type).toBe("responses");
    expect(delegation.responses.model).toBe("gpt-6-astra");
    expect(delegation.responses.reasoning).toEqual({ effort: "low" });
    expect(delegation.responses.service_tier).toBe("priority");
    expect(delegation.responses.tools.map((tool) => tool.name)).toEqual(["exec_typescript"]);
    expect(delegation.responses.parallel_tool_calls).toBe(false);
    expect(delegation.responses.instructions).toContain("exec_typescript runs one TypeScript");

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
      provider: string;
      backendModel: string;
      tools: string[];
    };
    expect(configured.provider).toBe("gpt-live");
    expect(configured.backendModel).toBe("gpt-6-astra");
    expect(configured.tools).toEqual(["exec_typescript"]);
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

  it("certificate overrides ride session.start: model, voice, backend, tools", async () => {
    const h = makeHarness();
    await callIsLive(h, {
      providerModel: "gpt-live-2",
      providerVoice: "vesper",
      backend: { model: "gpt-5.6-terra", reasoningEffort: "none", serviceTier: "default" },
      tools: [{ name: "hang_up", description: "End the call." }],
    });
    const session = h.provider.startedWith;
    expect(session.model).toBe("gpt-live-2");
    expect((session.audio as { output: { voice: string } }).output.voice).toBe("vesper");
    const responses = (session.delegation as { responses: Record<string, unknown> }).responses;
    expect(responses.model).toBe("gpt-5.6-terra");
    expect(responses.reasoning).toEqual({ effort: "none" });
    expect(responses.service_tier).toBe("default");
    const tools = responses.tools as { name: string; parameters?: unknown }[];
    expect(tools.map((tool) => tool.name)).toEqual(["exec_typescript", "hang_up"]);
    /* A tool with no parameters of its own gets an empty schema. */
    expect(tools[1]!.parameters).toEqual({ type: "object", properties: {} });
    expect(String(responses.instructions)).toContain("hang_up: End the call.");
  });

  it("seeds the session with the fold's transcript as typed history", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: SEAM },
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

  it("greets on pickup with an instructions append, and only when the certificate asked", async () => {
    const greeted = makeHarness();
    await greeted.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: SEAM, greeting: true },
    });
    await greeted.append(micFrame(1));
    await greeted.settle();
    greeted.provider.start();
    await greeted.settle();
    const appended = greeted.provider.sentOfType("session.instructions.append");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.delegation_id).toBeNull();
    expect(String(appended[0]!.content)).toContain("greet them now");

    /* No greeting on the certificate, nothing appended — the open-mic rooms
     * did not ask to be welcomed. */
    const quiet = makeHarness();
    await quiet.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: SEAM },
    });
    await quiet.append(micFrame(1));
    await quiet.settle();
    quiet.provider.start();
    await quiet.settle();
    expect(quiet.provider.sentOfType("session.instructions.append")).toHaveLength(0);
  });

  it("ends the call when the handshake never completes", async () => {
    const h = makeHarness();
    await h.append({
      type: "events.iterate.com/voice-agent/configured",
      payload: { providerBaseUrl: SEAM },
    });
    await h.append(micFrame(1));
    await h.settle();
    await h.advanceTime(20_000);
    await h.settle();
    const requested = eventsOfType(h, "conversation-end-requested");
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { reason: string }).reason).toContain("handshake");
    expect(h.provider.closed).toBe(true);
  });
});

describe("the dial", () => {
  it("carries no model in the URL and the credential only to OpenAI", async () => {
    const h = makeHarness();
    await dialProviderSocket(null);
    await dialProviderSocket(SEAM);
    expect(h.dialled[0]!.url).toBe("https://api.openai.com/v1/live/sessions");
    expect(h.dialled[0]!.url).not.toContain("model=");
    expect(h.dialled[0]!.headers.Authorization).toBe('Bearer getSecret("/secrets/openai")');
    expect(h.dialled[1]!.headers.Authorization).toBeUndefined();
    expect(h.sockets[0]!.accepted).toBe(true);
    expect(h.sockets[0]!.binaryType).toBe("arraybuffer");
  });

  it("ends the call when the provider refuses the upgrade", async () => {
    const h = makeHarness();
    vi.stubGlobal("fetch", async () => ({}) as Response);
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append(micFrame(1));
    await h.settle();
    const requested = eventsOfType(h, "conversation-end-requested");
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { reason: string }).reason).toContain("refused");
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
      await h.advanceTime(10_000);
      await h.settle();
    }
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(0);
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
    const conversationId = await callIsLive(h);
    h.provider.userSays(" Bye for now.", 1_000, 1_600);
    await h.settle();
    expect(eventsOfType(h, "utterance-transcript")).toHaveLength(0);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId, reason: "button" },
    });
    await h.settle();
    expect(eventsOfType(h, "utterance-transcript")).toHaveLength(1);
  });
});

/* ========================================================================== */
/* THINKING, FAST AND SLOW — the backend                                      */
/* ========================================================================== */

describe("the backend", () => {
  it("runs exec_typescript on the stream's own capability host, created once per dial, and continues the response", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.backendFunctionCall(
      "call_1",
      "exec_typescript",
      JSON.stringify({ code: "async (itx) => itx.repo.listFiles()" }),
    );
    await h.settle();
    expect(h.scripts).toEqual(["async (itx) => itx.repo.listFiles()"]);
    expect(h.hostCreates()).toBe(1);
    /* The second call finds the host already there: one script, no create. */
    h.provider.backendFunctionCall(
      "call_2",
      "exec_typescript",
      JSON.stringify({ code: "async (itx) => 2" }),
    );
    await h.settle();
    expect(h.scripts).toEqual(["async (itx) => itx.repo.listFiles()", "async (itx) => 2"]);
    expect(h.hostCreates()).toBe(1);
    const results = h.provider.sentOfType("response.item.create");
    expect(results).toHaveLength(2);
    expect(results[0]!.item).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ files: 3 }),
    });
    /* The output, THEN the continuation — appending a result does not
     * continue the response on its own. */
    const order = h.provider.sent.map((message) => message.type);
    expect(order.indexOf("response.item.create")).toBeLessThan(order.indexOf("response.create"));
  });

  it("tells the voice what the backend did: a progress note per step, at most one every few seconds", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.backendFunctionCall(
      "call_1",
      "exec_typescript",
      JSON.stringify({ code: "async (itx) => itx.repo.listFiles()" }),
    );
    await h.settle();
    /* A step right behind the first is folded: no second note yet. */
    h.provider.backendFunctionCall("call_1b", "exec_typescript", '{"code":"async (itx) => 1"}');
    await h.settle();
    expect(h.provider.sentOfType("session.thinking.append")).toHaveLength(1);
    await h.advanceTime(5_000);
    h.provider.backendFunctionCall("call_2", "exec_typescript", '{"code":"async (itx) => 2"}');
    await h.settle();
    const notes = h.provider.sentOfType("session.thinking.append");
    expect(notes).toHaveLength(2);
    /* General context, not the delegation's own: the Responses delegation
     * refuses its id here (measured 2026-09-10). */
    expect(notes[0]!.delegation_id).toBeNull();
    expect(String(notes[0]!.content)).toContain("Step 1: ran exec_typescript");
    expect(String(notes[0]!.content)).toContain("do not read it out");
    /* Status only: the script's output never rides in a note. */
    expect(String(notes[0]!.content)).toContain("→ ok");
    expect(String(notes[0]!.content)).not.toContain(JSON.stringify({ files: 3 }));
    expect(String(notes[1]!.content)).toContain("Step 3");
    /* The note lands before the result that continues the response. */
    const order = h.provider.sent.map((message) => message.type);
    expect(order.indexOf("session.thinking.append")).toBeLessThan(
      order.indexOf("response.item.create"),
    );
  });

  it("holds a delegation's tool result while the person is still talking, then hands the backend the rest of the request", async () => {
    const h = makeHarness();
    await callIsLive(h);
    /* The voice delegates at the first pause, mid-request. */
    h.provider.userSays(" Open a workspace called scratch.", 1_000, 2_400);
    h.provider.delegationCreated();
    h.provider.backendFunctionCall("call_1", "exec_typescript", '{"code":"async (itx) => 1"}');
    await h.settle();
    /* The script has run, but the person is mid-sentence: no result yet. */
    expect(h.scripts).toEqual(["async (itx) => 1"]);
    expect(h.provider.sentOfType("response.item.create")).toHaveLength(0);
    h.provider.userSays(" In it, write a file called", 2_600, 3_600);
    await h.advanceTime(1_000);
    await h.settle();
    expect(h.provider.sentOfType("response.item.create")).toHaveLength(0);
    h.provider.userSays(" note dot md.", 3_600, 4_200);
    await h.advanceTime(2_000);
    await h.settle();
    /* The rest of the request, then the result, then the continuation. */
    const items = h.provider.sentOfType("response.item.create");
    expect(items.map((message) => (message.item as { type: string }).type)).toEqual([
      "message",
      "function_call_output",
    ]);
    expect(JSON.stringify(items[0]!.item)).toContain(
      'said more since this delegation was raised: \\"In it, write a file called note dot md.\\"',
    );
    const order = h.provider.sent.map((message) => message.type);
    expect(order.lastIndexOf("response.item.create")).toBeLessThan(
      order.lastIndexOf("response.create"),
    );
    /* Nothing new to hand over on the next call, and no hold for a person
     * who has finished: straight through. */
    h.provider.backendFunctionCall("call_2", "exec_typescript", '{"code":"async (itx) => 2"}');
    await h.settle();
    expect(h.provider.sentOfType("response.item.create")).toHaveLength(3);
    expect((h.provider.sentOfType("response.item.create")[2]!.item as { type: string }).type).toBe(
      "function_call_output",
    );
  });

  it("never holds hang_up: the goodbye must land inside the grace, whatever the person is saying", async () => {
    const h = makeHarness();
    await callIsLive(h, { tools: [{ name: "hang_up", description: "End the call." }] });
    h.provider.userSays(" Okay bye, thanks for", 1_000, 2_000);
    h.provider.delegationCreated();
    h.provider.backendFunctionCall("call_bye", "hang_up", "{}");
    await h.settle();
    /* Straight through, no developer message, while the person is mid-word. */
    const items = h.provider.sentOfType("response.item.create");
    expect(items.map((message) => (message.item as { type: string }).type)).toEqual([
      "function_call_output",
    ]);
  });

  it("a failing script answers the backend with the error, and an unknown function too", async () => {
    const h = makeHarness();
    h.projectRoot.current = {
      capabilityHost: {
        create: async () => {},
        runScript: async () => {
          throw new Error("Repo has no commits yet");
        },
      },
    };
    await callIsLive(h);
    h.provider.backendFunctionCall("call_x", "exec_typescript", '{"code":"async (itx) => 1"}');
    h.provider.backendFunctionCall("call_y", "teleport", "{}");
    await h.settle();
    const outputs = h.provider
      .sentOfType("response.item.create")
      .map((message) => message.item as { call_id: string; output: string });
    expect(outputs.find((item) => item.call_id === "call_x")!.output).toContain("no commits yet");
    expect(outputs.find((item) => item.call_id === "call_y")!.output).toContain("no such function");
    expect(h.provider.sentOfType("response.create")).toHaveLength(2);
  });

  it("hang_up ends the call only after the goodbye — spoken AFTER the call — finishes playing", async () => {
    const h = makeHarness();
    await callIsLive(h, { tools: [{ name: "hang_up", description: "End the call." }] });
    /* The backend hangs up first; the voice's goodbye follows a moment later. */
    h.provider.backendFunctionCall("call_bye", "hang_up", "{}");
    await h.settle();
    await h.advanceTime(1_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(0);
    h.provider.speech(1_500);
    h.provider.assistantSays(" Bye for now.", 1_000, 2_400);
    await playOutEverything(h, 1_000);
    /* Mid-goodbye: still not over. */
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(0);
    h.provider.silence(1_000);
    await playOutEverything(h, 4_000);
    const requested = eventsOfType(h, "conversation-end-requested");
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { reason: string }).reason).toContain("hung up");
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    /* And the goodbye is on the record: the end path closed the open row
     * before the dial went. */
    expect(
      eventsOfType(h, "answer-transcript").map((event) => (event.payload as { text: string }).text),
    ).toEqual(["Bye for now."]);
  });

  it("hang_up with nothing playing ends the call once the goodbye grace runs out", async () => {
    const h = makeHarness();
    await callIsLive(h, { tools: [{ name: "hang_up", description: "End the call." }] });
    h.provider.backendFunctionCall("call_bye", "hang_up", "{}");
    await h.settle();
    await h.advanceTime(5_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(0);
    await h.advanceTime(4_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(1);
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
  });

  it("an end decided in the fold still lands the open answer row durably", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    h.provider.speech(500);
    h.provider.assistantSays(" Goodbye then.", 1_000, 1_500);
    await h.settle();
    expect(eventsOfType(h, "answer-transcript")).toHaveLength(0);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "test" },
    });
    await h.settle();
    const answers = eventsOfType(h, "answer-transcript");
    expect(answers).toHaveLength(1);
    expect((answers[0]!.payload as { text: string }).text).toBe("Goodbye then.");
  });

  it("records the backend's final words durably", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    h.provider.backendMessage("msg_1", "The repo holds eight files.");
    await h.settle();
    const replies = eventsOfType(h, "backend-reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload).toEqual({ conversationId, text: "The repo holds eight files." });
  });
});

/* ========================================================================== */
/* ENDING A CALL                                                              */
/* ========================================================================== */

describe("ending a call", () => {
  it("a device-appended obituary silences the speaker, closes the session and frees the dial NOW", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    h.provider.speech(10_000);
    await h.settle();
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId, reason: "button" },
    });
    await h.settle();
    expect(speakerClears(h)).toHaveLength(1);
    expect(h.provider.sentOfType("session.close")).toHaveLength(1);
    expect(h.provider.closed).toBe(true);
    /* The next frame, past the dying-breath guard, mints a fresh call on a
     * fresh socket. */
    await h.advanceTime(2_000);
    await h.append(micFrame(20));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
    expect(h.sockets).toHaveLength(2);
  });

  it("a frame in the last call's dying breath mints no zombie; one after it opens the next call", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId, reason: "button" },
    });
    await h.settle();
    /* The device drains its mic queue for ~100 ms after the far end hangs
     * up; those frames must not open a call to an empty room. */
    await h.append(micFrame(20), micFrame(21));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(1);
    await h.advanceTime(2_000);
    await h.append(micFrame(22));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
  });

  it("a stale obituary for a dead call cannot touch the live one", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId: "conv_somebody_else", reason: "button" },
    });
    await h.settle();
    expect(h.provider.closed).toBe(false);
    expect(h.state().call).not.toBeNull();
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
    expect(h.provider.sentOfType("session.close")).toHaveLength(1);
  });

  it("buries a call whose dial never resolves at the same idle deadline", async () => {
    const h = makeHarness();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    await h.append({ type: "events.iterate.com/voice-agent/created", payload: {} });
    await h.append(micFrame(1));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(1);
    await h.advanceTime(IDLE_TIMEOUT_MS + 10_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
    await h.append(micFrame(2));
    await h.settle();
    expect(eventsOfType(h, "call-started")).toHaveLength(2);
  });

  it("does not end a call while the backend is still running a function for it", async () => {
    const h = makeHarness();
    let finish: (() => void) | null = null;
    h.projectRoot.current = {
      capabilityHost: {
        create: async () => {},
        runScript: () =>
          new Promise<{ result: unknown }>((resolve) => {
            finish = () => resolve({ result: { slow: true } });
          }),
      },
    };
    await callIsLive(h);
    h.provider.backendFunctionCall("call_slow", "exec_typescript", '{"code":"async (itx) => 1"}');
    await h.settle();
    /* The person waits in silence past the deadline; the script is the activity. */
    await h.advanceTime(IDLE_TIMEOUT_MS - 5_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(0);
    finish!();
    await h.settle();
    expect(h.provider.sentOfType("response.item.create")).toHaveLength(1);
    /* And once the backend is done and nothing else happens, the deadline bites. */
    await h.advanceTime(IDLE_TIMEOUT_MS + 10_000);
    await h.settle();
    expect(eventsOfType(h, "conversation-end-requested")).toHaveLength(1);
  });

  it("does not end a call while it is still speaking, nor one the device keeps feeding", async () => {
    const speaking = makeHarness();
    await callIsLive(speaking);
    /* A long answer arrives at play rate, ten seconds at a time, well past
     * the idle deadline: the frames going out ARE the activity. */
    for (let tick = 0; tick < 8; tick++) {
      speaking.provider.speech(10_000);
      await speaking.advanceTime(10_000);
      await speaking.settle();
    }
    expect(eventsOfType(speaking, "conversation-end-requested")).toHaveLength(0);

    const fed = makeHarness();
    await callIsLive(fed);
    for (let tick = 0; tick < 8; tick++) {
      await fed.advanceTime(10_000);
      await fed.append({ type: "events.iterate.com/voice-agent/keepalive", payload: {} });
      await fed.settle();
    }
    expect(eventsOfType(fed, "conversation-end-requested")).toHaveLength(0);
  });

  it("re-dials when the provider closes the session or the socket under a live call", async () => {
    /* OpenAI's socket dropped 2:51 into a live call with no session.closed
     * first (2026-09-11); ending the conversation for it cut a sentence in
     * half. The drop is recorded and the next device frame re-dials. */
    const closed = makeHarness();
    await callIsLive(closed);
    const firstSocket = closed.provider;
    closed.provider.push({ type: "session.closed", reason: "expired", usage: { seconds: 9 } });
    await closed.settle();
    expect(eventsOfType(closed, "conversation-end-requested")).toHaveLength(0);
    const recorded = eventsOfType(closed, "provider-disconnected");
    expect(recorded).toHaveLength(1);
    expect((recorded[0]!.payload as { reason: string }).reason).toContain("expired");
    await closed.append(micFrame(1));
    await closed.settle();
    expect(closed.provider).not.toBe(firstSocket);
    expect(closed.provider.sentOfType("session.start")).toHaveLength(1);
    expect(eventsOfType(closed, "conversation-ended")).toHaveLength(0);

    const dropped = makeHarness();
    await callIsLive(dropped);
    dropped.provider.close();
    await dropped.settle();
    expect(eventsOfType(dropped, "conversation-end-requested")).toHaveLength(0);
    expect(eventsOfType(dropped, "provider-disconnected")).toHaveLength(1);
    await dropped.append(micFrame(1));
    await dropped.settle();
    expect(dropped.provider.sentOfType("session.start")).toHaveLength(1);
  });

  it("gives up on a provider that closes three times in two minutes", async () => {
    const h = makeHarness();
    await callIsLive(h);
    for (let drop = 0; drop < 3; drop++) {
      h.provider.close();
      await h.settle();
      if (drop < 2) {
        await h.append(micFrame(10 + drop));
        await h.settle();
        expect(h.provider.sentOfType("session.start")).toHaveLength(1);
      }
    }
    const requested = eventsOfType(h, "conversation-end-requested");
    expect(requested).toHaveLength(1);
    expect((requested[0]!.payload as { reason: string }).reason).toContain("3 times");
    await h.settle();
    expect(eventsOfType(h, "conversation-ended")).toHaveLength(1);
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
  it("re-dials a call the log still says is open, and clears the device before playing anything", async () => {
    const h = makeHarness();
    await callIsLive(h);
    await answer(h, 300);
    const framesBefore = speakerFrames(h).length;
    await evict(h);
    expect(h.sockets).toHaveLength(2);
    h.provider.start();
    await h.settle();
    await answer(h, 300);
    const fresh = speakerFrames(h).slice(framesBefore);
    /* The first frame of the new session says clear: the device may hold the
     * dead incarnation's tail. And the numbering restarts at one. */
    expect(fresh[0]!.clearSpeakerBufferBeforeFrame).toBe(true);
    expect(fresh[0]!.deviceSpeakerFrameSeq).toBe(1);
    /* Two dials, two handshakes, both on the record. */
    expect(eventsOfType(h, "conversation-accepted")).toHaveLength(2);
  });

  it("does not re-dial a call that has been ended", async () => {
    const h = makeHarness();
    const conversationId = await callIsLive(h);
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "test" },
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
    const conversationId = await callIsLive(h);
    const abandoned = h.provider;
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-end-requested",
      payload: { conversationId, reason: "done" },
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

/* ========================================================================== */
/* THE MIRROR                                                                 */
/* ========================================================================== */

describe("the mirror lane", () => {
  it("replaces an audio delta's bytes with their length and records client commands", async () => {
    const h = makeHarness();
    await callIsLive(h);
    h.provider.speech(100);
    h.provider.push({ type: "session.usage.updated", usage: { seconds: 3 } });
    h.provider.backendFunctionCall("call_m", "exec_typescript", '{"code":"async (itx) => 1"}');
    await h.settle();
    const lane = mirrored(h);
    const delta = lane.find((payload) => payload.type === "session.output_audio.delta")!;
    expect(delta.delta).toBeUndefined();
    expect(delta.deltaBytes).toBe(MAX_SPEAKER_PAYLOAD_BYTES);
    expect(lane.some((payload) => payload.type === "session.usage.updated")).toBe(true);
    expect(lane.some((payload) => payload.type === "client.response.item.create")).toBe(true);
    expect(lane.some((payload) => payload.type === "client.response.create")).toBe(true);
  });
});
