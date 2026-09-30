// voice-agent.test.ts — the relay between the live voice model and the agent on the call's context:
// what each delegation hands the agent, and what of the agent's answers the live model is sent.
// The relay runs bare, its provider a fake socket this file speaks for, the agent's side a log the
// hand-overs and answers are committed to. Audio, the provider's real protocol and the agent's own
// loop are out of scope: test/vitest/agents/voice-agent.e2e.test.ts runs the whole call on a worker.
import { consumesEvent } from "iterate/stream/processor";
import { expect, test } from "vitest";
import { HANG_UP_GOODBYE_GRACE_MS, VoiceAgentProcessor } from "./voice-agent.ts";

const HANDED_OVER = "The request was handed to the backend; the conversation may continue.";

type Step =
  /** The provider transcribed the person, on its session timeline. */
  | { heard: string; atMs: number }
  /** The provider transcribed its own speech. */
  | { said: string; atMs: number }
  /** The live model handed a request to the backend. */
  | { delegates: string }
  /** The agent opened a model request, over every item before it. */
  | { request: string }
  /** The agents app published a script's status. */
  | { status: string }
  /** The agents app published that request's message, written beside a script or not. */
  | { answer: string; text: string; besideScript?: true }
  | { agentPaused: string }
  /** Every wait of this many milliseconds ends. */
  | { elapseMs: number };

test.for<{
  name: string;
  steps: Step[];
  toAgent: string[];
  toLiveModel: { type: string; delegation_id: string | null; content: string }[];
  ended?: string;
}>([
  {
    name: "a delegation hands the person's words to the agent, and the agent's answer is spoken for it",
    steps: [
      { heard: "What time is it in London?", atMs: 0 },
      { delegates: "d1" },
      { request: "r1" },
      { answer: "r1", text: "It is noon in London." },
    ],
    toAgent: ["Person: What time is it in London?"],
    toLiveModel: [
      { type: "session.thinking.append", delegation_id: "d1", content: HANDED_OVER },
      { type: "session.commentary.append", delegation_id: "d1", content: "It is noon in London." },
    ],
  },
  {
    name: "a script's status reaches the live model quietly, and the prose beside the script is never spoken",
    steps: [
      { heard: "What time is it in London?", atMs: 0 },
      { delegates: "d1" },
      { request: "r1" },
      { status: "Checking London time" },
      { answer: "r1", text: "I could not verify the time.", besideScript: true },
      { request: "r2" },
      { answer: "r2", text: "It is noon in London." },
    ],
    toAgent: ["Person: What time is it in London?"],
    toLiveModel: [
      { type: "session.thinking.append", delegation_id: "d1", content: HANDED_OVER },
      { type: "session.thinking.append", delegation_id: null, content: "Checking London time" },
      { type: "session.commentary.append", delegation_id: "d1", content: "It is noon in London." },
    ],
  },
  {
    name: "a later hand-over carries only the words said since the one before, both speakers in order",
    steps: [
      { heard: "What is the weather like?", atMs: 0 },
      { delegates: "d1" },
      { said: "Which city?", atMs: 2_000 },
      { heard: "London.", atMs: 4_000 },
      { delegates: "d2" },
    ],
    toAgent: ["Person: What is the weather like?", "Voice: Which city?\nPerson: London."],
    toLiveModel: [
      { type: "session.thinking.append", delegation_id: "d1", content: HANDED_OVER },
      { type: "session.thinking.append", delegation_id: "d2", content: HANDED_OVER },
    ],
  },
  {
    name: "an answer speaks for the newest hand-over its request had read",
    steps: [
      { heard: "Show me an exercise.", atMs: 0 },
      { delegates: "d1" },
      { request: "r1" },
      { heard: "Make it division.", atMs: 3_000 },
      { delegates: "d2" },
      { answer: "r1", text: "Here is an exercise." },
      { request: "r2" },
      { answer: "r2", text: "Here is a division exercise." },
    ],
    toAgent: ["Person: Show me an exercise.", "Person: Make it division."],
    toLiveModel: [
      { type: "session.thinking.append", delegation_id: "d1", content: HANDED_OVER },
      { type: "session.thinking.append", delegation_id: "d2", content: HANDED_OVER },
      { type: "session.commentary.append", delegation_id: "d1", content: "Here is an exercise." },
      {
        type: "session.commentary.append",
        delegation_id: "d2",
        content: "Here is a division exercise.",
      },
    ],
  },
  {
    name: "a goodbye ending in HANG_UP is spoken without the token and ends the call after its grace",
    steps: [
      { heard: "Bye, hang up please.", atMs: 0 },
      { delegates: "d1" },
      { request: "r1" },
      { answer: "r1", text: "Bye for now. HANG_UP" },
      { elapseMs: HANG_UP_GOODBYE_GRACE_MS },
    ],
    toAgent: ["Person: Bye, hang up please."],
    toLiveModel: [
      { type: "session.thinking.append", delegation_id: "d1", content: HANDED_OVER },
      { type: "session.commentary.append", delegation_id: "d1", content: "Bye for now." },
    ],
    ended: "the Agent hung up",
  },
  {
    name: "an agent that pauses says so for the last hand-over, rather than leave the voice waiting",
    steps: [
      { heard: "Add a joke to the website.", atMs: 0 },
      { delegates: "d1" },
      { agentPaused: "the model failed 3 times in a row" },
    ],
    toAgent: ["Person: Add a joke to the website."],
    toLiveModel: [
      { type: "session.thinking.append", delegation_id: "d1", content: HANDED_OVER },
      {
        type: "session.commentary.append",
        delegation_id: "d1",
        content: "The agent stopped working on the request: the model failed 3 times in a row",
      },
    ],
  },
])("$name", async ({ steps, toAgent, toLiveModel, ended }) => {
  const call = await liveCall();
  for (const step of steps) await call.take(step);
  // Exact: anything else handed over or sent would be a hand-over or an utterance too many.
  expect(call.outcome()).toEqual({ toAgent, toLiveModel, endings: ended ? [ended] : [] });
});

test("a new incarnation replaying the call hands nothing over and speaks nothing: it ends the call", async () => {
  const call = await liveCall();
  for (const step of [
    { heard: "What time is it in London?", atMs: 0 },
    { delegates: "d1" },
    { request: "r1" },
  ] satisfies Step[])
    await call.take(step);
  // The incarnation that held the provider socket is gone; its successor folds the log, then the
  // agent's answer arrives.
  const successor = await call.restart();
  await successor.take({ answer: "r1", text: "It is noon in London." });
  expect(successor.outcome()).toEqual({
    toAgent: [],
    toLiveModel: [],
    endings: ["the voice session was interrupted"],
  });
});

type LoggedEvent = {
  type: string;
  payload: Record<string, unknown>;
  offset: number;
  createdAt: string;
  path: string;
  source: { origin: string };
};

/** A call on a bare relay, `call-started` delivered and the provider's session started. The log is
 *  the call's context: the relay's appends and the agent's events are committed to it in order and
 *  delivered back as the engine delivers them, only what the contract consumes, payloads parsed by
 *  its schemas. The clock stands still, so a wait ends only when a step lets its duration pass.
 *  `restart` is the next incarnation: the log folded, no socket. */
async function liveCall(log: LoggedEvent[] = [], requests = new Map<string, number>()) {
  const toAgent: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const onProviderMessage: ((message: { data: string }) => void)[] = [];
  const sleeps: { ms: number; resolve(): void }[] = [];
  const socket = {
    send: (message: string) => sent.push(JSON.parse(message)),
    close() {},
    addEventListener(type: string, listener: (message: { data: string }) => void) {
      if (type === "message") onProviderMessage.push(listener);
    },
  };
  const processor = new VoiceAgentProcessor({
    projectContext: async () => JSON.stringify({ projectId: "prj_test", path: PATH }),
    nowAtFacetMs: () => 0,
    sleep: (ms) => new Promise<void>((resolve) => sleeps.push({ ms, resolve })),
    // The relay only listens on, sends on and closes its provider's socket.
    dialProvider: async () => socket as unknown as WebSocket,
    messageAgent: async (words) => {
      toAgent.push(words);
      return commit({
        type: "events.iterate.com/agent/context-added",
        payload: { role: "user", content: words, actor: { type: "user" } },
      });
    },
  });
  type Consumed = Parameters<typeof processor.reduce>[0]["event"];
  /** The event as the engine hands it over, or null for a type the contract does not consume. The
   *  contract's own schema parsed its payload, so it is the consumed event its type names. */
  const consumed = (event: LoggedEvent): Consumed | null => {
    if (!consumesEvent(processor.contract.consumes, event)) return null;
    const payload = processor.contract.payloadSchemaFor(event.type)?.parse(event.payload);
    return { ...event, payload } as Consumed;
  };
  let state = log.reduce((folded, event) => {
    const delivered = consumed(event);
    return delivered ? (processor.reduce({ state: folded, event: delivered }) ?? folded) : folded;
  }, processor.contract.initialState());
  const background = (work: () => Promise<unknown>) => void work();
  function commit({ type, payload = {} }: { type: string; payload?: Record<string, unknown> }) {
    const offset = log.length + 1;
    const createdAt = new Date(offset * 1000).toISOString();
    const event: LoggedEvent = {
      type,
      payload,
      offset,
      createdAt,
      path: PATH,
      source: { origin: PATH },
    };
    log.push(event);
    const delivered = consumed(event);
    if (!delivered) return event;
    const previousState = state;
    state = processor.reduce({ state, event: delivered }) ?? state;
    processor.processEvent({
      event: delivered,
      state,
      previousState,
      delivery: { caughtUp: true },
      append: async (...inputs) => inputs.map(commit),
      runInBackground: background,
      blockProcessorWhile: background,
    });
    return event;
  }
  const provider = async (message: Record<string, unknown>) => {
    for (const listener of onProviderMessage) listener({ data: JSON.stringify(message) });
    await flush();
  };
  if (log.length === 0) {
    commit({
      type: "events.iterate.com/voice-agent/call-started",
      payload: { activation: "test", conversationId: "conv_test" },
    });
    await flush();
    await provider({ type: "session.started" });
  }
  return {
    /** What the agent was handed, what the live model was sent, and why the call ended. */
    outcome: () => ({
      toAgent,
      toLiveModel: sent
        .filter((message) => /^session\.(thinking|commentary)\.append$/.test(String(message.type)))
        .map(({ type, delegation_id, content }) => ({ type, delegation_id, content })),
      endings: log
        .filter((event) => event.type === "events.iterate.com/voice-agent/call-ended")
        .map((event) => event.payload.reason),
    }),
    restart: () => liveCall(log, requests),
    async take(step: Step) {
      if ("heard" in step || "said" in step) {
        const [type, delta] =
          "heard" in step
            ? ["session.input_transcript.delta", step.heard]
            : ["session.output_transcript.delta", step.said];
        await provider({ type, delta, start_ms: step.atMs, end_ms: step.atMs + 500 });
      } else if ("delegates" in step) {
        await provider({
          type: "session.delegation.created",
          delegation: { id: step.delegates, target: "client" },
        });
      } else if ("request" in step) {
        // The agent's intent, which the relay does not consume: its offset names the request.
        const intent = commit({
          type: "events.iterate.com/agent/llm-request-requested",
          payload: {},
        });
        requests.set(step.request, intent.offset);
      } else if ("status" in step) {
        commit({
          type: "events.iterate.com/agent/summary-updated",
          payload: { activity: step.status },
        });
      } else if ("answer" in step) {
        commit({
          type: "events.iterate.com/agent/web-message-sent",
          payload: {
            message: step.text,
            llmRequestOffset: requests.get(step.answer),
            ...(step.besideScript && { besideScript: true }),
          },
        });
      } else if ("agentPaused" in step) {
        commit({ type: "events.iterate.com/agent/paused", payload: { reason: step.agentPaused } });
      } else {
        for (const sleep of sleeps.filter(({ ms }) => ms === step.elapseMs)) sleep.resolve();
      }
      await flush();
    },
  };
}

const PATH = "/agents/voice/test";

/** Let every background continuation the last step started run to its next wait. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
