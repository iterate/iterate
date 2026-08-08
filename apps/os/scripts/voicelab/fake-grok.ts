// A Grok realtime provider that does whatever you tell it to, including the
// wrong thing.
//
// The real provider mostly behaves, which makes it useless for testing what
// happens when a provider does not. This speaks enough of the realtime
// protocol to hold a conversation — session.created/updated, binary mic in,
// binary speaker out, transcripts, response lifecycle, one function tool —
// and every deviation from that is selectable per call with `?script=`.
//
// It lives in THIS process rather than in a deployed worker on purpose:
//
//   * the loop is a restart, not a deploy-and-rebuild;
//   * everything the bridge sends is visible locally, so "the customer heard
//     nothing" becomes "the provider was handed 0 bytes" without instrumenting
//     the thing under test;
//   * a driver script can start the provider, start the call, and assert on
//     both halves in one process, so no scenario can silently not run.
//
// It is reachable from a Cloudflare worker because captun (the same gateway
// `pnpm dev` uses for webhooks) forwards public WebSockets to a local fetch
// handler: `https://<name>.tunnels.iterate.com`.
import { Buffer } from "node:buffer";
import {
  createCaptunTunnel,
  createWebSocketResponse,
  isWebSocketUpgradeRequest,
  WebSocketPair,
  type CaptunTunnel,
} from "captun";
import { z } from "zod";

/**
 * What this fake requires of anything the bridge sends it.
 *
 * Loose beyond `type` on purpose: the fake must accept every field a real
 * bridge sends without being taught each one, while still refusing a frame it
 * could not dispatch. Refusing loudly matters more here than anywhere — a
 * fake that silently accepts a malformed frame would make a bridge bug look
 * like a passing test.
 */
const BridgeMessage = z.looseObject({ type: z.string() });

/** 16kHz mono PCM16, so 20ms is 320 samples / 640 bytes. */
const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/**
 * What one fake session will do. Every field has a behaving default; a script
 * is just a named bundle of overrides, and any of them can also be set
 * individually on the query string so a scenario can be tuned without adding
 * a script name for it.
 */
export interface FakeGrokBehaviour {
  /** Never send session.created — the handshake simply never completes. */
  noSessionCreated: boolean;
  /**
   * Ms to wait after the socket opens before sending session.created.
   *
   * The default is deliberately not zero. A provider that greets instantly
   * loses its greeting (see the `handshake-race` scenario), which would
   * otherwise make every other script here fail for the same one reason.
   */
  sessionCreatedDelayMs: number;
  /** Re-send session.created every second until the bridge answers it. */
  repeatSessionCreated: boolean;
  /** Close the socket this many ms after it opens (0 = never). */
  closeAfterOpenMs: number;
  /** Close instead of answering session.update. */
  closeOnSessionUpdate: boolean;
  /** Close immediately after sending session.created. */
  closeAfterSessionCreated: boolean;
  /** Close the socket this many ms into an answer (0 = never). */
  closeDuringAnswerMs: number;
  /**
   * How many times, across the whole scenario, the mid-answer close applies.
   *
   * A redial dials the SAME url, so without this a "closes mid-answer"
   * provider closes every answer for ever and the call can never finish one
   * — which makes "did the redial recover the conversation?" unanswerable,
   * and the first version of the scenario reported a defect that was really
   * the script never letting go.
   */
  closeDuringAnswerMaxTimes: number;
  /** Close as soon as an answer completes. */
  closeAfterAnswer: boolean;
  /** Accept commits and never answer them. */
  ignoreCommits: boolean;
  /** Send response.created and then nothing at all. */
  createdThenNothing: boolean;
  /** Emit a frame of unparseable JSON before the first answer. */
  malformedJson: boolean;
  /** Emit event types the bridge has never heard of. */
  unknownEvents: boolean;
  /** Emit an `error` event before answering. */
  errorEvent: boolean;
  /** Emit speaker audio with no response.created in front of it. */
  audioWithoutCreated: boolean;
  /** Two response.created in a row, no response.done between them. */
  doubleCreated: boolean;
  /** Seconds of audio per answer. */
  answerSeconds: number;
  /** Ship the whole answer in one burst rather than in ~200ms chunks. */
  burst: boolean;
  /** Ms to wait after a commit before starting to answer. */
  answerDelayMs: number;
  /** Send audio as base64 response.output_audio.delta rather than binary. */
  base64Audio: boolean;
  /** Ask the colleague on every Nth turn (0 = never). */
  toolEveryTurn: number;
  /** How many ask_colleague calls to emit at once when a turn asks. */
  toolCallsPerTurn: number;
  /**
   * Stop asking after this many calls in a session (0 = no cap).
   *
   * Worth having: every colleague answer is injected as a fresh
   * response.create, so a model that asks on every turn asks again about the
   * answer, and the whole thing cascades. Measured: 22 questions in three
   * seconds from one turn.
   */
  toolMaxTotal: number;
  /** Bytes per binary speaker frame (real Grok ships 0.4–1s at a time). */
  audioChunkBytes: number;
}

const DEFAULTS: FakeGrokBehaviour = {
  answerDelayMs: 150,
  answerSeconds: 1.5,
  audioChunkBytes: 12_800, // 400ms
  audioWithoutCreated: false,
  base64Audio: false,
  burst: true,
  closeAfterAnswer: false,
  closeAfterOpenMs: 0,
  closeAfterSessionCreated: false,
  closeDuringAnswerMaxTimes: 1,
  closeDuringAnswerMs: 0,
  closeOnSessionUpdate: false,
  createdThenNothing: false,
  doubleCreated: false,
  errorEvent: false,
  ignoreCommits: false,
  malformedJson: false,
  noSessionCreated: false,
  repeatSessionCreated: false,
  sessionCreatedDelayMs: 400,
  toolCallsPerTurn: 1,
  toolEveryTurn: 0,
  toolMaxTotal: 0,
  unknownEvents: false,
};

/** Named bundles. `?script=<name>` picks one; query params override fields. */
const SCRIPTS: Record<string, Partial<FakeGrokBehaviour>> = {
  "audio-without-created": { audioWithoutCreated: true },
  "close-after-session-created": { closeAfterSessionCreated: true },
  "close-between-turns": { closeAfterAnswer: true },
  "close-handshake": { noSessionCreated: true, closeAfterOpenMs: 300 },
  /*
   * Paced, because a burst provider finishes its whole answer before the
   * close timer fires and the scenario then tests nothing. The first version
   * of this script reported a clean pass having delivered all 400 frames.
   */
  "close-mid-answer": {
    answerSeconds: 20,
    burst: false,
    closeDuringAnswerMaxTimes: 1,
    closeDuringAnswerMs: 1500,
  },
  "created-then-nothing": { createdThenNothing: true },
  "double-created": { doubleCreated: true },
  "error-event": { errorEvent: true },
  flood: { answerSeconds: 90, burst: true },
  /** Greet the instant the socket opens, the way a fast provider would. */
  "greet-instantly": { sessionCreatedDelayMs: 0 },
  /** Greet instantly, then keep greeting until someone answers. */
  "greet-instantly-then-retry": { sessionCreatedDelayMs: 0, repeatSessionCreated: true },
  "malformed-json": { malformedJson: true },
  "no-answer": { ignoreCommits: true },
  "no-session-created": { noSessionCreated: true },
  normal: {},
  "short-lifetime": { closeAfterOpenMs: 20_000 },
  tool: { toolEveryTurn: 1 },
  "tool-storm": { toolEveryTurn: 1, toolCallsPerTurn: 3 },
  "unknown-events": { unknownEvents: true },
};

/** Everything one fake session saw and did, for a driver to assert on. */
export interface FakeGrokSession {
  id: number;
  script: string;
  openedAt: number;
  closedAt: number | null;
  /** Why WE closed it, when we did. */
  closedBy: string | null;
  /** Total mic bytes the bridge handed us, and per committed turn. */
  micBytes: number;
  micBytesByTurn: number[];
  /** Every JSON event type the bridge sent us, in order. */
  received: string[];
  /** Text of every conversation.item.create the bridge injected. */
  injected: { role?: string; text: string; at: number }[];
  /** Function-call outputs the bridge sent back, in order. */
  toolOutputs: { callId: string; output: string; at: number }[];
  commits: number;
  responseCreates: number;
  cancels: number;
  /** Answers we actually started. */
  answers: number;
  /** ask_colleague calls we emitted, with the ids we used. */
  toolCallIds: string[];
}

export interface FakeGrok {
  url: string;
  sessions: FakeGrokSession[];
  /** Every line the fake logged, newest last. */
  log: string[];
  /** Push a message into the newest live session (scenario control). */
  poke(send: (session: FakeGrokSession, raw: (data: string | Uint8Array) => void) => void): boolean;
  close(): void;
}

function parseBehaviour(params: URLSearchParams): { behaviour: FakeGrokBehaviour; script: string } {
  const script = params.get("script") ?? "normal";
  const behaviour: FakeGrokBehaviour = { ...DEFAULTS, ...(SCRIPTS[script] ?? {}) };
  for (const key of Object.keys(DEFAULTS) as (keyof FakeGrokBehaviour)[]) {
    const raw = params.get(key);
    if (raw === null) continue;
    const current = DEFAULTS[key];
    if (typeof current === "boolean") {
      (behaviour[key] as boolean) = raw !== "0" && raw !== "false";
    } else {
      (behaviour[key] as number) = Number(raw);
    }
  }
  return { behaviour, script };
}

/** A 440Hz tone, because the bridge cannot tell speech from a sine wave. */
function tone(bytes: number, phase: number): { pcm: Buffer; phase: number } {
  const samples = Math.floor(bytes / 2);
  const pcm = Buffer.alloc(samples * 2);
  let next = phase;
  for (let index = 0; index < samples; index++) {
    pcm.writeInt16LE(Math.round(Math.sin(next) * 8000), index * 2);
    next += (2 * Math.PI * 440) / SAMPLE_RATE;
  }
  return { pcm, phase: next % (2 * Math.PI) };
}

/**
 * Start the fake and publish it. Returns the public https URL to hand to
 * `startCall({ grokBaseUrl })` — append `?script=…` to pick a misbehaviour.
 */
export async function startFakeGrok(options?: {
  name?: string;
  gateway?: string;
  token?: string;
  /** Mirror the log to stderr as it happens. */
  verbose?: boolean;
}): Promise<FakeGrok> {
  const sessions: FakeGrokSession[] = [];
  const log: string[] = [];
  const startedAt = Date.now();
  const say = (line: string) => {
    const stamped = `${((Date.now() - startedAt) / 1000).toFixed(1)}s ${line}`;
    log.push(stamped);
    if (options?.verbose) console.error(`  [fake] ${stamped}`);
  };

  /** Shared across redials: a "closes mid-answer" provider must let go. */
  const midAnswerCloses = { count: 0 };
  const live: {
    session: FakeGrokSession;
    send: (data: string | Uint8Array) => void;
  }[] = [];

  const handler = (request: Request): Response => {
    const url = new URL(request.url);
    if (!isWebSocketUpgradeRequest(request)) {
      return Response.json({ fakeGrok: true, sessions: sessions.length });
    }
    const { behaviour, script } = parseBehaviour(url.searchParams);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const session: FakeGrokSession = {
      answers: 0,
      cancels: 0,
      closedAt: null,
      closedBy: null,
      commits: 0,
      id: sessions.length + 1,
      injected: [],
      micBytes: 0,
      micBytesByTurn: [],
      openedAt: Date.now(),
      received: [],
      responseCreates: 0,
      script,
      toolCallIds: [],
      toolOutputs: [],
    };
    sessions.push(session);
    say(`session ${session.id} open (script=${script})`);

    let alive = true;
    const timers: NodeJS.Timeout[] = [];
    const raw = (data: string | Uint8Array) => {
      if (!alive) return;
      try {
        server.send(data as never);
      } catch (error) {
        say(`session ${session.id} send failed: ${String(error)}`);
      }
    };
    const emit = (event: Record<string, unknown>) => raw(JSON.stringify(event));
    const hangUp = (why: string) => {
      if (!alive) return;
      alive = false;
      session.closedAt = Date.now();
      session.closedBy = why;
      say(`session ${session.id} CLOSING: ${why}`);
      for (const timer of timers) clearTimeout(timer);
      try {
        server.close(1000, why.slice(0, 100));
      } catch {
        /* already gone */
      }
    };
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(() => {
        if (alive) run();
      }, ms);
      timers.push(timer);
      return timer;
    };

    live.push({ send: raw, session });

    let phase = 0;
    let micSinceCommit = 0;
    let turn = 0;
    let answering = false;
    /** Cancelled answers must stop emitting; this is the generation guard. */
    let answerGeneration = 0;

    const sendAudio = (chunkBytes: number) => {
      const made = tone(chunkBytes, phase);
      phase = made.phase;
      if (behaviour.base64Audio) {
        emit({ delta: made.pcm.toString("base64"), type: "response.output_audio.delta" });
      } else {
        raw(new Uint8Array(made.pcm));
      }
    };

    const answer = (transcript: string) => {
      if (!alive) return;
      const generation = ++answerGeneration;
      session.answers++;
      answering = true;
      if (behaviour.errorEvent) {
        emit({
          error: { code: "fake_error", message: "the provider is having a bad day" },
          type: "error",
        });
      }
      if (behaviour.malformedJson) raw('{"type":"response.created"'); // deliberately truncated
      if (behaviour.unknownEvents) {
        emit({ type: "response.telepathy.delta", delta: "???" });
        emit({ type: "conversation.item.retracted", item: { id: "x" } });
      }
      if (behaviour.audioWithoutCreated) sendAudio(behaviour.audioChunkBytes);
      emit({ response: { id: `resp_${generation}` }, type: "response.created" });
      session.responseCreates++;
      if (behaviour.doubleCreated) {
        emit({ response: { id: `resp_${generation}b` }, type: "response.created" });
        session.responseCreates++;
      }
      if (behaviour.createdThenNothing) {
        say(`session ${session.id} answer ${generation}: created, then nothing`);
        return;
      }
      const totalBytes = Math.floor(behaviour.answerSeconds * SAMPLE_RATE * 2);
      const chunk = behaviour.audioChunkBytes;
      const chunks = Math.max(1, Math.ceil(totalBytes / chunk));
      if (
        behaviour.closeDuringAnswerMs > 0 &&
        midAnswerCloses.count < behaviour.closeDuringAnswerMaxTimes
      ) {
        midAnswerCloses.count++;
        later(behaviour.closeDuringAnswerMs, () => hangUp("mid-answer close"));
      }
      const finish = () => {
        if (!alive || generation !== answerGeneration) return;
        answering = false;
        emit({ transcript, type: "response.output_audio_transcript.done" });
        emit({
          response: { id: `resp_${generation}`, output: [], status: "completed" },
          type: "response.done",
        });
        say(
          `session ${session.id} answer ${generation} done (${behaviour.answerSeconds}s audio, ${chunks} chunks)`,
        );
        if (behaviour.closeAfterAnswer) later(50, () => hangUp("between-turns close"));
      };
      emit({ delta: transcript, type: "response.output_audio_transcript.delta" });
      if (behaviour.burst) {
        for (let index = 0; index < chunks; index++) {
          if (generation !== answerGeneration) return;
          sendAudio(Math.min(chunk, totalBytes - index * chunk));
        }
        finish();
      } else {
        let index = 0;
        const step = () => {
          if (!alive || generation !== answerGeneration) return;
          if (index >= chunks) return finish();
          sendAudio(Math.min(chunk, totalBytes - index * chunk));
          index++;
          later((chunk / BYTES_PER_MS) * 0.9, step);
        };
        step();
      }
    };

    /*
     * Real questions with different answers, on purpose. Asking "fake
     * question 1/2/3" got three identical "that appears to be a placeholder"
     * replies, which makes it impossible to tell a correctly-correlated
     * answer from a mis-attributed one — the whole point of the test.
     */
    const QUESTIONS = [
      "What is the capital of Portugal?",
      "How many hearts does an octopus have?",
      "What is the boiling point of water in degrees Fahrenheit?",
      "Which planet in our solar system has the most moons?",
      "In what year did the Berlin Wall come down?",
    ];
    const askColleague = () => {
      for (let index = 0; index < behaviour.toolCallsPerTurn; index++) {
        const callId = `call_${session.id}_${turn}_${index}`;
        const question = QUESTIONS[session.toolCallIds.length % QUESTIONS.length]!;
        session.toolCallIds.push(callId);
        emit({
          arguments: JSON.stringify({ question }),
          call_id: callId,
          name: "ask_colleague",
          type: "response.function_call_arguments.done",
        });
      }
    };

    server.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        const bytes =
          event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : ((event.data as Uint8Array).byteLength ?? 0);
        session.micBytes += bytes;
        micSinceCommit += bytes;
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data);
      } catch {
        say(`session ${session.id} got unparseable text from the bridge`);
        return;
      }
      const parsed = BridgeMessage.safeParse(decoded);
      if (!parsed.success) {
        say(`session ${session.id} got a text frame with no usable type`);
        return;
      }
      const message = parsed.data;
      const type = message.type;
      session.received.push(type);
      switch (type) {
        case "session.update": {
          if (behaviour.closeOnSessionUpdate) return hangUp("close on session.update");
          emit({ session: { id: `sess_${session.id}` }, type: "session.updated" });
          break;
        }
        case "input_audio_buffer.commit": {
          session.commits++;
          session.micBytesByTurn.push(micSinceCommit);
          say(`session ${session.id} commit ${session.commits}: ${micSinceCommit} mic bytes`);
          micSinceCommit = 0;
          emit({ item_id: `item_${session.commits}`, type: "input_audio_buffer.committed" });
          break;
        }
        case "response.create": {
          if (behaviour.ignoreCommits) {
            say(`session ${session.id} ignoring response.create`);
            break;
          }
          turn++;
          const askThisTurn =
            behaviour.toolEveryTurn > 0 &&
            turn % behaviour.toolEveryTurn === 0 &&
            turn <= 20 &&
            (behaviour.toolMaxTotal === 0 || session.toolCallIds.length < behaviour.toolMaxTotal);
          later(behaviour.answerDelayMs, () => {
            if (askThisTurn) askColleague();
            answer(`fake answer ${turn}`);
          });
          break;
        }
        case "response.cancel": {
          session.cancels++;
          answerGeneration++;
          answering = false;
          say(`session ${session.id} cancel (${session.cancels})`);
          break;
        }
        case "conversation.item.create": {
          const item = (message.item ?? {}) as {
            content?: { text?: string }[];
            role?: string;
            type?: string;
            call_id?: string;
            output?: string;
          };
          if (item.type === "function_call_output") {
            session.toolOutputs.push({
              at: Date.now(),
              callId: item.call_id ?? "",
              output: item.output ?? "",
            });
          } else {
            const text = (item.content ?? []).map((part) => part.text ?? "").join("");
            session.injected.push({ at: Date.now(), role: item.role, text });
            say(`session ${session.id} injected (${item.role}): ${text.slice(0, 120)}`);
          }
          break;
        }
        default:
          break;
      }
    });

    server.addEventListener("close", () => {
      if (alive) {
        alive = false;
        session.closedAt = Date.now();
        session.closedBy = "bridge closed it";
        say(`session ${session.id} closed BY THE BRIDGE`);
      }
      for (const timer of timers) clearTimeout(timer);
      const index = live.findIndex((entry) => entry.session === session);
      if (index >= 0) live.splice(index, 1);
    });

    if (behaviour.closeAfterOpenMs > 0) {
      later(behaviour.closeAfterOpenMs, () => hangUp(`lifetime ${behaviour.closeAfterOpenMs}ms`));
    }
    if (!behaviour.noSessionCreated) {
      const greet = () => {
        emit({ session: { id: `sess_${session.id}` }, type: "session.created" });
        say(`session ${session.id} sent session.created`);
        if (behaviour.closeAfterSessionCreated) {
          later(10, () => hangUp("close after session.created"));
        }
      };
      if (behaviour.sessionCreatedDelayMs > 0) later(behaviour.sessionCreatedDelayMs, greet);
      else greet();
      if (behaviour.repeatSessionCreated) {
        const retry = (attempt: number) => {
          if (!alive || session.received.includes("session.update") || attempt > 10) return;
          say(`session ${session.id} re-sending session.created (attempt ${attempt})`);
          emit({ session: { id: `sess_${session.id}` }, type: "session.created" });
          later(1000, () => retry(attempt + 1));
        };
        later(1000, () => retry(2));
      }
    } else {
      say(`session ${session.id} will never send session.created`);
    }
    void answering;

    return createWebSocketResponse(client);
  };

  let tunnel: CaptunTunnel;
  try {
    tunnel = await createCaptunTunnel({
      fetch: handler,
      gateway:
        options?.gateway ?? process.env.CAPTUN_GATEWAY?.trim() ?? "https://tunnels.iterate.com",
      ...(options?.name ? { name: options.name } : {}),
      ...((options?.token ?? process.env.CAPTUN_TOKEN?.trim())
        ? { token: options?.token ?? process.env.CAPTUN_TOKEN!.trim() }
        : {}),
    });
  } catch (error) {
    throw new Error(
      `fake grok could not publish a tunnel (need CAPTUN_TOKEN from the Doppler config): ${String(error)}`,
    );
  }
  say(`fake grok published at ${tunnel.url}`);

  return {
    close: () => tunnel[Symbol.dispose](),
    log,
    poke: (send) => {
      const newest = live[live.length - 1];
      if (newest === undefined) return false;
      send(newest.session, newest.send);
      return true;
    },
    sessions,
    url: tunnel.url,
  };
}
