import { expect, test, vi } from "vitest";
import { VoiceSessionCore, type RealtimeEvent, type WorkerStream } from "./session-core.ts";

const USER_TURN = "events.iterate.com/voice/user-turn-transcribed";
const CLIENT_CONNECTED = "events.iterate.com/voice/client-connected";
const SAY_REQUESTED = "events.iterate.com/voice/say-requested";
const REPORT_SUPPRESSED = "events.iterate.com/voice/report-suppressed";
const WORKER_REPLY = "events.iterate.com/agents/web-message-sent";

test("starting a session configures the realtime leg and marks the stream", async () => {
  const world = createWorld();
  await world.session.start();

  expect(world.session.getSnapshot()).toMatchObject({ status: "live", micLive: true });
  expect(world.sent[0]).toMatchObject({
    type: "session.update",
    session: { tools: [{ name: "ask_assistant" }, { name: "no_comment" }] },
  });
  await vi.waitFor(() => {
    expect(world.appended).toMatchObject([{ type: CLIENT_CONNECTED, payload: { client: "ios" } }]);
  });
});

test("a transcribed spoken turn is forwarded to the worker stream exactly once", async () => {
  const world = createWorld();
  await world.session.start();

  world.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_1",
    transcript: "list my repos",
  });
  // VAD kicking off a response must not forward the same turn again.
  world.emit({ type: "response.created" });

  await vi.waitFor(() => {
    expect(world.appended.filter((event) => event.type === USER_TURN)).toMatchObject([
      { payload: { transcript: "list my repos", origin: "speech" } },
    ]);
  });
  expect(world.session.getSnapshot().entries).toMatchObject([
    { kind: "status" },
    { kind: "status" },
    { kind: "you", text: "list my repos" },
    { kind: "worker-request", text: "list my repos" },
  ]);
});

test("say-requests are relayed as worker reports, queued behind an active response", async () => {
  const world = createWorld();
  await world.session.start();
  await vi.waitFor(() => expect(world.appended.length).toBe(1)); // listen loop is live

  world.emit({ type: "response.created" }); // assistant mid-response
  world.push(SAY_REQUESTED, { message: "you have 3 repos" });

  // Queued: nothing injected while the response is active.
  await vi.waitFor(() => {
    expect(world.session.getSnapshot().workerBusy).toBe(false);
  });
  expect(world.sent.filter((event) => event.type === "conversation.item.create")).toMatchObject([]);

  world.emit({ type: "response.done" });
  await vi.waitFor(() => {
    expect(world.sent).toMatchObject([
      { type: "session.update" },
      {
        type: "conversation.item.create",
        item: { content: [{ text: "[worker report] you have 3 repos" }] },
      },
      { type: "response.create" },
    ]);
  });
});

test("idle worker replies are shown but never injected into the conversation", async () => {
  const world = createWorld();
  await world.session.start();
  await vi.waitFor(() => expect(world.appended.length).toBe(1));

  world.push(WORKER_REPLY, { message: "(idle)" });
  await vi.waitFor(() => {
    expect(world.session.getSnapshot().entries).toMatchObject([
      { kind: "status" },
      { kind: "status" },
      { kind: "worker-reply", text: "(idle — nothing to report)" },
    ]);
  });
  expect(world.sent.filter((event) => event.type === "response.create")).toMatchObject([]);
});

test("no_comment completes the call silently and journals the suppression", async () => {
  const world = createWorld();
  await world.session.start();

  world.emit({ type: "response.function_call_arguments.done", name: "no_comment", call_id: "c1" });

  expect(world.sent).toMatchObject([
    { type: "session.update" },
    { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1" } },
  ]);
  expect(world.sent.filter((event) => event.type === "response.create")).toMatchObject([]);
  await vi.waitFor(() => {
    expect(world.appended.filter((event) => event.type === REPORT_SUPPRESSED)).toHaveLength(1);
  });
});

test("typed text rides the same lanes as speech", async () => {
  const world = createWorld();
  await world.session.start();

  world.session.sendText("deploy the thing");

  expect(world.sent).toMatchObject([
    { type: "session.update" },
    {
      type: "conversation.item.create",
      item: { content: [{ text: "deploy the thing" }] },
    },
    { type: "response.create" },
  ]);
  await vi.waitFor(() => {
    expect(world.appended.filter((event) => event.type === USER_TURN)).toMatchObject([
      { payload: { transcript: "deploy the thing", origin: "text" } },
    ]);
  });
});

test("assistantSpeaking follows the output audio buffer and snaps off on barge-in", async () => {
  const world = createWorld();
  await world.session.start();

  world.emit({ type: "output_audio_buffer.started" });
  expect(world.session.getSnapshot().assistantSpeaking).toBe(true);
  world.emit({ type: "input_audio_buffer.speech_started" });
  expect(world.session.getSnapshot().assistantSpeaking).toBe(false);
});

test("workerBusy turns on when a turn is forwarded and off when the worker answers", async () => {
  const world = createWorld();
  await world.session.start();
  await vi.waitFor(() => expect(world.appended.length).toBe(1));

  world.session.sendText("do something slow");
  expect(world.session.getSnapshot().workerBusy).toBe(true);

  world.push(WORKER_REPLY, { message: "done" });
  await vi.waitFor(() => expect(world.session.getSnapshot().workerBusy).toBe(false));
});

test("reopening an existing stream does not replay say-requests from before the client connected", async () => {
  const world = createWorld();
  // History from a previous session, already in the stream before this client
  // connects.
  world.push(SAY_REQUESTED, { message: "stale report from yesterday" });

  await world.session.start();
  world.push(SAY_REQUESTED, { message: "fresh report" });

  await vi.waitFor(() => {
    expect(world.sent.filter((event) => event.type === "conversation.item.create")).toMatchObject([
      { item: { content: [{ text: "[worker report] fresh report" }] } },
    ]);
  });
});

test("a dead worker lane surfaces an error entry but the voice call keeps going", async () => {
  const world = createWorld({ appendFails: true });
  await world.session.start();

  world.session.sendText("hello");

  await vi.waitFor(() => {
    expect(world.session.getSnapshot().entries).toMatchObject(
      expect.arrayContaining([
        {
          id: expect.any(Number),
          kind: "error",
          text: expect.stringContaining("failed to reach the worker stream"),
        },
      ]),
    );
  });
  expect(world.session.getSnapshot()).toMatchObject({ status: "live" });
  // The realtime lane still got the text.
  expect(world.sent.filter((event) => event.type === "conversation.item.create")).toHaveLength(1);
});

test("the assistant transcript accumulates deltas and is journaled on response.done", async () => {
  const world = createWorld();
  await world.session.start();

  world.emit({ type: "response.output_audio_transcript.delta", delta: "Sure — " });
  world.emit({ type: "response.output_audio_transcript.delta", delta: "on it." });
  world.emit({ type: "response.done" });

  expect(world.session.getSnapshot().entries).toMatchObject(
    expect.arrayContaining([{ id: expect.any(Number), kind: "assistant", text: "Sure — on it." }]),
  );
  await vi.waitFor(() => {
    expect(
      world.appended.filter(
        (event) => event.type === "events.iterate.com/voice/assistant-utterance-completed",
      ),
    ).toMatchObject([{ payload: { text: "Sure — on it." } }]);
  });
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type AppendedEvent = { type: string; payload: Record<string, unknown> };

function createWorld(options: { appendFails?: boolean } = {}) {
  const sent: RealtimeEvent[] = [];
  const appended: AppendedEvent[] = [];
  let callbacks: {
    onEvent(event: RealtimeEvent): void;
    onClose(info: { code?: number; reason?: string }): void;
  } | null = null;

  let offset = 0;
  const backlog: { offset: number; type: string; payload: Record<string, unknown> }[] = [];
  const waiters: {
    afterOffset: number;
    eventTypes: readonly string[];
    resolve(event: { offset: number; type: string; payload: Record<string, unknown> }): void;
  }[] = [];

  const flush = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      const match = backlog.find(
        (event) => event.offset > waiter.afterOffset && waiter.eventTypes.includes(event.type),
      );
      if (match) {
        waiters.splice(i, 1);
        waiter.resolve(match);
      }
    }
  };

  const stream: WorkerStream = {
    append: (event) => {
      if (options.appendFails) return Promise.reject(new Error("stream unreachable"));
      offset++;
      appended.push(event as AppendedEvent);
      return Promise.resolve([{ offset }]);
    },
    waitForEvent: (input) =>
      new Promise((resolve) => {
        waiters.push({
          afterOffset: input.afterOffset,
          eventTypes: input.eventTypes,
          resolve,
        });
        flush();
      }),
  };

  const session = new VoiceSessionCore({
    connectRealtime: (cb) => {
      callbacks = cb;
      return Promise.resolve({
        send: (event: RealtimeEvent) => sent.push(event),
        close: () => cb.onClose({}),
        setMicEnabled: () => {},
        micLive: true,
        label: "fake fake-realtime",
      });
    },
    agentStream: () => Promise.resolve(stream),
    retryDelayMs: 1,
  });

  return {
    session,
    sent,
    appended,
    emit: (event: RealtimeEvent) => callbacks!.onEvent(event),
    /** A worker-side event lands in the stream (visible to waitForEvent, not append log). */
    push: (type: string, payload: Record<string, unknown>) => {
      offset++;
      backlog.push({ offset, type, payload });
      flush();
    },
  };
}
