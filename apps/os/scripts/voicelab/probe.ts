// A call with no device in it, and every provider event printed as it lands.
//
// The device is a wonderful thing to test with and a terrible thing to debug
// against: it has its own buffers, its own screen, its own opinions about
// when a turn ended. This opens a call on a stream nobody else is using,
// takes turns on it as TEXT, and prints the raw Grok event stream with
// timings — so "the second turn never answers" stops being a story about the
// device and becomes a question about the bridge.
//
//   doppler run --config preview_3 -- pnpm cli voicelab probe \
//     --project prj_… --turns 3 --every 45 --colleague
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab probe`. */
export interface ProbeOptions extends VoicelabConnectOptions {
  /** Stream to run the call on. Defaults to a fresh, unshared path. */
  path?: string;
  /** How many text turns to take. */
  turns?: number;
  /** Seconds between turns. */
  every?: number;
  /** Give the voice its genius colleague and ask it something worth asking. */
  colleague?: boolean;
  /** Say this instead of the built-in prompts (one turn). */
  say?: string;
  /** Print every provider event, not just the interesting ones. */
  verbose?: boolean;
  /**
   * Drip speaker frames at realtime, the way a device needs them. Worth
   * setting even with nobody listening: pacing changes the ORDER things
   * reach the stream, and transcript events ride the same queue.
   */
  pace?: boolean;
}

interface ProjectWorker {
  startCall(options: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export async function probe(options: ProbeOptions) {
  const turnCount = options.turns ?? 3;
  const everyMs = (options.every ?? 45) * 1000;
  /* A fresh path per run: a stream accumulates durable events forever, and a
   * shared one makes every run slower than the last. */
  const path = options.path ?? `/voicelab/probe-${Date.now().toString(36)}`;
  using itx = await connectProject(options);
  const stream = itx.streams.get(path);
  const worker = (itx as unknown as { worker: ProjectWorker }).worker;

  const startedAt = Date.now();
  const at = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  let responded = false;
  let spoken = "";
  let colleagueAsks = 0;
  let colleagueAnswers = 0;

  const connection = await stream.openConnection({
    connectionKey: `probe-${startedAt}`,
    eventTypes: [
      "events.iterate.com/voice-agent/grok-event",
      "events.iterate.com/voice-agent/conversation-accepted",
      "events.iterate.com/voice-agent/conversation-ended",
      "events.iterate.com/voice-agent/colleague-asked",
      "events.iterate.com/voice-agent/colleague-answered",
    ],
    processEventBatch: (batch: { events: { type: string; payload?: unknown }[] }) => {
      for (const event of batch.events) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === "events.iterate.com/voice-agent/colleague-asked") {
          colleagueAsks++;
          console.log(`${at()}  ASKED COLLEAGUE: ${String(payload.question)}`);
          continue;
        }
        if (event.type === "events.iterate.com/voice-agent/colleague-answered") {
          colleagueAnswers++;
          console.log(`${at()}  COLLEAGUE (${payload.ms}ms): ${String(payload.answer)}`);
          continue;
        }
        if (event.type !== "events.iterate.com/voice-agent/grok-event") {
          console.log(`${at()}  ${event.type}: ${JSON.stringify(payload).slice(0, 160)}`);
          continue;
        }
        const inner = (payload as { event?: Record<string, unknown> }).event ?? {};
        const type = String(inner.type);
        if (type === "response.output_audio_transcript.delta") continue;
        if (type === "response.output_audio_transcript.done") {
          spoken = String(inner.transcript ?? "");
          console.log(`${at()}  VOICE: ${spoken}`);
          continue;
        }
        if (type === "response.done") {
          responded = true;
          console.log(`${at()}  response.done`);
          continue;
        }
        if (type === "response.function_call_arguments.done") {
          console.log(`${at()}  TOOL CALL ${String(inner.name)}: ${String(inner.arguments)}`);
          continue;
        }
        if (options.verbose) console.log(`${at()}  ${type}`);
      }
    },
  });

  console.log(`${at()}  starting a call on ${path}`);
  const started = await worker.startCall({
    colleague: options.colleague === true,
    pace: options.pace === true,
    path,
    turns: "manual",
  });
  console.log(`${at()}  startCall: ${JSON.stringify(started)}`);
  if (started.ok !== true) {
    connection.close();
    throw new Error(`the call did not start: ${JSON.stringify(started)}`);
  }

  const prompts = options.say
    ? [options.say]
    : options.colleague
      ? [
          "What is the population of Lisbon?",
          "Ask your colleague what our project id is.",
          "Say something friendly about the weather.",
        ]
      : [
          "Say hello in one short sentence.",
          "In one sentence: why is the sky blue?",
          "Name one fact about octopuses.",
        ];

  for (let index = 0; index < turnCount; index++) {
    const prompt = prompts[index % prompts.length]!;
    console.log(`${at()}  --- turn ${index + 1}: ${prompt}`);
    responded = false;
    const turnAt = Date.now();
    await stream.append({ payload: { text: prompt }, type: "events.iterate.com/voice-agent/say" });
    while (!responded && Date.now() - turnAt < 45_000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!responded) console.log(`${at()}  *** NO ANSWER to turn ${index + 1}`);
    const wait = turnAt + everyMs - Date.now();
    if (wait > 0 && index < turnCount - 1) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /*
   * Do not hang up on a colleague who is still thinking. Their answer takes
   * as long as it takes — that is the whole premise — and ending the call
   * first proves nothing except that the probe is impatient.
   */
  if (colleagueAsks > colleagueAnswers) {
    console.log(`${at()}  waiting for ${colleagueAsks - colleagueAnswers} colleague answer(s)`);
    const deadline = Date.now() + 150_000;
    while (colleagueAnswers < colleagueAsks && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    /* Let the voice actually speak what it was handed. */
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }

  await stream.append({
    payload: { conversationId: started.conversationId, reason: "probe done" },
    type: "events.iterate.com/voice-agent/conversation-ended",
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  connection.close();
}
