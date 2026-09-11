import { afterEach, describe, expect, test, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  health: [] as Record<string, unknown>[],
  lastHealth: undefined as Record<string, unknown> | undefined,
  inputTranscript: "",
  answerTranscript: "",
  endError: undefined as Error | undefined,
  emit: undefined as ((events: Array<{ payload: unknown }>) => void) | undefined,
  greeting: false,
  historicalTranscript: "",
  bargeEvents: [] as Array<{ payload: unknown }>,
  speechCalls: 0,
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    callback: (error: null, stdout: string, stderr: string) => void,
  ) => {
    const words = _args.at(-1) ?? "";
    if (words.includes("two plus two") || words.includes("Tell a detailed story")) {
      fixtures.speechCalls += 1;
      fixtures.emit?.([
        {
          payload: {
            type: "conversation.item.input_audio_transcription.completed",
            transcript: fixtures.inputTranscript,
          },
        },
        { payload: { type: "response.created", response: { id: "first" } } },
        {
          payload: {
            type: "response.output_audio_transcript.delta",
            response_id: "first",
            delta: fixtures.answerTranscript,
          },
        },
      ]);
    }
    if (words.includes("Stop. Say the word pineapple instead.")) {
      fixtures.emit?.(fixtures.bargeEvents);
    }
    callback(null, "", "");
  },
}));

vi.mock("./connect.ts", () => ({
  connectProject: async () => ({
    streams: {
      get: () => ({
        openConnection: async (options: {
          processEventBatch(batch: { events: { type?: string; payload: unknown }[] }): void;
        }) => {
          fixtures.emit = (events) => options.processEventBatch({ events });
          if (fixtures.historicalTranscript) {
            fixtures.emit([
              {
                payload: {
                  type: "conversation.item.input_audio_transcription.completed",
                  transcript: fixtures.historicalTranscript,
                },
              },
            ]);
          }
          options.processEventBatch({
            events: [
              {
                payload: {
                  greeting: fixtures.greeting,
                },
                type: "events.iterate.com/voice-agent/session-configured",
              },
            ],
          });
          return { close: () => undefined };
        },
      }),
    },
    [Symbol.dispose]: () => undefined,
  }),
  deviceCapability: () => ({
    health: async () => {
      const health = fixtures.health.shift() ?? fixtures.lastHealth;
      if (!health) throw new Error("unexpected health read");
      fixtures.lastHealth = health;
      return health;
    },
    conversation: {
      start: async () => undefined,
      end: async () => {
        if (fixtures.endError) throw fixtures.endError;
      },
    },
    pushToTalk: { start: async () => undefined, stop: async () => undefined },
  }),
  deviceClientPath: (name: string) => `/clients/${name}`,
}));

import { boards } from "./boards.ts";

function health(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    callActive: false,
    pushToTalk: false,
    conversation: "/agents/voice/test",
    framesSent: 100,
    spkWrites: 0,
    spkPlayed: 0,
    spkSupersededMidplay: 0,
    spkAnswerStarts: 7,
    spkSpeakerGeneration: 7,
    spkLastPlayedGeneration: 7,
    speakerPlaying: 0,
    callPending: false,
    wantsCall: false,
    uptimeMs: 1_000,
    wakeWordModel: 0,
    ...overrides,
  };
}

describe("boards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fixtures.health = [];
    fixtures.lastHealth = undefined;
    fixtures.inputTranscript = "";
    fixtures.answerTranscript = "";
    fixtures.endError = undefined;
    fixtures.emit = undefined;
    fixtures.greeting = false;
    fixtures.historicalTranscript = "";
    fixtures.bargeEvents = [];
    fixtures.speechCalls = 0;
    process.exitCode = undefined;
  });

  async function runProof(
    inputTranscript: string,
    answerTranscript: string,
    finalHealth = health({ uptimeMs: 1_001 }),
    preEndHealth = finalHealth,
    beforeHealth = health({ spkWrites: 9 }),
    greetingPlayback = true,
  ) {
    fixtures.health = [
      beforeHealth,
      health({ callActive: true }),
      health({ callActive: true }),
      health({
        callActive: true,
        spkWrites: greetingPlayback ? 1 : 0,
        speakerPlaying: greetingPlayback ? 1 : 0,
      }),
      health({
        callActive: true,
        spkWrites: greetingPlayback ? 2 : 0,
        speakerPlaying: greetingPlayback ? 1 : 0,
      }),
      health({ callActive: true, spkWrites: greetingPlayback ? 2 : 0 }),
      health({ callActive: true, spkWrites: greetingPlayback ? 2 : 0 }),
      health({ callActive: true, spkWrites: greetingPlayback ? 2 : 0 }),
      health({ callActive: true, spkWrites: greetingPlayback ? 2 : 0 }),
      health({
        callActive: true,
        framesSent: 101,
        spkWrites: greetingPlayback ? 4 : 0,
        spkAnswerStarts: greetingPlayback ? 8 : 7,
        speakerPlaying: greetingPlayback ? 1 : 0,
      }),
      preEndHealth,
      ...Array.from({ length: 41 }, () => finalHealth),
    ];
    fixtures.inputTranscript = inputTranscript;
    fixtures.answerTranscript = answerTranscript;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    return await boards({
      project: "voice-test",
      only: "new-board",
      prompt: "What is two plus two?",
      expect: "four",
    });
  }

  async function runBargeProof(events: Array<{ payload: unknown }>, secondPlayback = true) {
    fixtures.inputTranscript =
      "Tell a detailed story for at least thirty seconds about a banana Keep speaking until asked to stop";
    fixtures.answerTranscript = "banana";
    fixtures.bargeEvents = events;
    fixtures.health = [
      health({ spkWrites: 9, spkPlayed: 100 }),
      health({ callActive: true, spkPlayed: 100 }),
      health({ callActive: true, spkPlayed: 100 }),
      health({ callActive: true, spkWrites: 1, speakerPlaying: 1, spkPlayed: 101 }),
      health({ callActive: true, spkWrites: 2, speakerPlaying: 1, spkPlayed: 102 }),
      health({ callActive: true, spkWrites: 2, spkPlayed: 102 }),
      health({ callActive: true, spkWrites: 2, spkPlayed: 102 }),
      health({ callActive: true, spkWrites: 2, spkPlayed: 102 }),
      health({ callActive: true, spkWrites: 2, spkPlayed: 102 }),
      health({
        callActive: true,
        framesSent: 101,
        spkWrites: 4,
        spkAnswerStarts: 8,
        speakerPlaying: 1,
        spkPlayed: 103,
      }),
      health({
        callActive: true,
        spkWrites: 5,
        spkAnswerStarts: 8,
        speakerPlaying: 1,
        spkPlayed: 104,
      }),
      health({
        callActive: true,
        spkWrites: 6,
        spkAnswerStarts: 8,
        speakerPlaying: 1,
        spkPlayed: 105,
      }),
      health({
        callActive: true,
        spkWrites: secondPlayback ? 7 : 6,
        spkAnswerStarts: secondPlayback ? 9 : 8,
        spkSpeakerGeneration: secondPlayback ? 9 : 8,
        spkLastPlayedGeneration: secondPlayback ? 9 : 7,
        speakerPlaying: 0,
        spkPlayed: secondPlayback ? 106 : 106,
      }),
      health({ uptimeMs: 1_001, spkPlayed: 106 }),
      ...Array.from({ length: 41 }, () => health({ uptimeMs: 1_001, spkPlayed: 106 })),
    ];
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    return boards({ project: "voice-test", only: "new-board", barge: true });
  }

  test("rejects proof inputs that cannot supply transcript evidence", async () => {
    await expect(
      boards({ project: "voice-test", only: "new-board", prompt: "...", expect: "banana" }),
    ).rejects.toThrow("prompt must contain at least one letter or number");
    await expect(
      boards({ project: "voice-test", only: "new-board", prompt: "hello", expect: " " }),
    ).rejects.toThrow("expect must contain at least one letter or number");
  });

  test("uses the post-call prompt baseline after a repeated call resets speaker writes", async () => {
    const result = await runProof("What is two plus two", "four");

    expect(result["new-board"]?.verdict).toBe("PASS");
    expect(result["new-board"]?.after).toMatchObject({ spkWritesDelta: 2 });
    expect(process.exitCode).toBeUndefined();
  });

  test("fails when the board transcribes unrelated words instead of the prompt", async () => {
    const result = await runProof("Please tell me about bananas", "four");

    expect(result["new-board"]?.verdict).toBe("FAIL: incomplete physical evidence");
    expect(process.exitCode).toBe(1);
  });

  test("fails when no prompt transcription arrives", async () => {
    const result = await runProof("", "four");

    expect(result["new-board"]?.verdict).toBe("FAIL: incomplete physical evidence");
    expect(process.exitCode).toBe(1);
  });

  test("does not let a setup transcript prove the later prompt", async () => {
    fixtures.historicalTranscript = "What is two plus two";
    const result = await runProof("", "four");

    expect(result["new-board"]?.verdict).toBe("FAIL: incomplete physical evidence");
  });

  test("fails when a configured greeting never plays", async () => {
    fixtures.greeting = true;
    const result = await runProof(
      "What is two plus two",
      "four",
      undefined,
      undefined,
      undefined,
      false,
    );

    expect(result["new-board"]?.verdict).toContain(
      "configured greeting playback was never observed",
    );
  });

  test("fails when playback is real but the answer transcript omits the expected word", async () => {
    const result = await runProof("What is two plus two", "five");

    expect(result["new-board"]?.verdict).toBe("FAIL: incomplete physical evidence");
    expect(process.exitCode).toBe(1);
  });

  test("fails a physical pass when hangup leaves the call active", async () => {
    const result = await runProof(
      "What is two plus two",
      "four",
      health({
        callActive: true,
        framesSent: 101,
        spkWrites: 4,
        spkAnswerStarts: 8,
        speakerPlaying: 0,
        uptimeMs: 1_001,
      }),
    );

    expect(result["new-board"]?.verdict).toContain("hangup failed: device did not become idle");
    expect(result["new-board"]?.finalHealth).toMatchObject({ callActive: true });
    expect(process.exitCode).toBe(1);
  });

  test("fails a physical pass when hangup observes a reset", async () => {
    const result = await runProof("What is two plus two", "four", health({ uptimeMs: 10 }));

    expect(result["new-board"]?.verdict).toContain("hangup failed: device restarted during hangup");
    expect(result["new-board"]?.finalHealth).toMatchObject({ uptimeMs: 10 });
    expect(process.exitCode).toBe(1);
  });

  test("requires wake processing to advance after the pre-end snapshot", async () => {
    const result = await runProof(
      "What is two plus two",
      "four",
      health({ uptimeMs: 1_001, wakeWordModel: 1, wakeWordFrames: 50 }),
      health({ callActive: true, uptimeMs: 1_001, wakeWordModel: 1, wakeWordFrames: 50 }),
      health({ spkWrites: 9, wakeWordModel: 1, wakeWordFrames: 1 }),
    );

    expect(result["new-board"]?.verdict).toContain("wake-word processing did not resume");
    expect(result["new-board"]?.preEndHealth).toMatchObject({ wakeWordFrames: 50 });
    expect(process.exitCode).toBe(1);
  });

  test("passes wake teardown only when frames advance after the pre-end snapshot", async () => {
    const result = await runProof(
      "What is two plus two",
      "four",
      health({ uptimeMs: 1_001, wakeWordModel: 1, wakeWordFrames: 51 }),
      health({ callActive: true, uptimeMs: 1_001, wakeWordModel: 1, wakeWordFrames: 50 }),
      health({ spkWrites: 9, wakeWordModel: 1, wakeWordFrames: 1 }),
    );

    expect(result["new-board"]?.verdict).toBe("PASS");
    expect(result["new-board"]?.finalHealth).toMatchObject({ wakeWordFrames: 51 });
  });

  test("attributes a short post-barge answer to its response id after playback has already ended", async () => {
    const result = await runBargeProof([
      {
        payload: {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "pineapple",
        },
      },
      { payload: { type: "response.created", response: { id: "fresh" } } },
      {
        payload: {
          type: "response.output_audio_transcript.delta",
          response_id: "fresh",
          delta: "pineapple",
        },
      },
    ]);

    expect(result["new-board"]?.barge).toMatchObject({
      newResponseStarted: true,
      postInterruptionResponseId: "fresh",
      answerMentionsPineapple: true,
      playbackRestarted: true,
      interruptionAnswered: true,
    });
  });

  test("rejects a stale answer transcript even when it says pineapple", async () => {
    const result = await runBargeProof([
      {
        payload: {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "pineapple",
        },
      },
      { payload: { type: "response.created", response: { id: "fresh" } } },
      {
        payload: {
          type: "response.output_audio_transcript.delta",
          response_id: "first",
          delta: "pineapple",
        },
      },
    ]);

    expect(result["new-board"]?.barge).toMatchObject({
      newResponseStarted: true,
      answerMentionsPineapple: false,
      interruptionAnswered: false,
    });
  });

  test("rejects a response that was cancelled before any second answer audio played", async () => {
    const result = await runBargeProof(
      [
        {
          payload: {
            type: "conversation.item.input_audio_transcription.completed",
            transcript: "pineapple",
          },
        },
        { payload: { type: "response.created", response: { id: "fresh" } } },
        {
          payload: {
            type: "response.output_audio_transcript.delta",
            response_id: "fresh",
            delta: "pineapple",
          },
        },
      ],
      false,
    );

    expect(result["new-board"]?.barge).toMatchObject({
      answerMentionsPineapple: true,
      playbackRestarted: false,
      interruptionAnswered: false,
    });
  });
});
