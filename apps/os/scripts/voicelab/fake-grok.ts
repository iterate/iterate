// A Grok realtime provider that does whatever you tell it to, including the
// wrong thing.
//
// The real provider mostly behaves, which makes it useless for testing what
// happens when a provider does not. This speaks enough of the realtime
// protocol to hold a conversation — session.created/updated, mic in (binary or
// base64), speaker out, transcripts, response lifecycle, one function tool —
// and every deviation from that is selectable per call with `?script=`.
//
// SELECTION IS THE QUERY STRING AND NOTHING ELSE, which is what makes it
// usable against a DEPLOYED bridge: the URL rides the `voice-agent/created`
// event as `providerBaseUrl`, `dialGrokSocket` adds `model` and changes
// nothing else, and everything from "hold the upgrade for twelve seconds" to
// "take three seconds to say the first word" is a parameter on it. There is no
// second configuration channel and there must not be — one would only be
// reachable by whoever is running the fake, which is exactly not the case when
// the thing under test is a worker somewhere else.
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  /**
   * Ms to hold the UPGRADE itself before answering it (0 = answer at once).
   *
   * The layer under everything else here: until this existed, connecting was
   * instantaneous and "the provider is slow to answer the door" could not be
   * expressed at all — only "the provider answers and then misbehaves". The
   * bridge has a ten-second handshake deadline
   * (`GROK_HANDSHAKE_DEADLINE_MS`), and a dial that is merely SLOW must not be
   * treated like one that is broken, so both sides of that number need to be
   * reachable from a query string.
   *
   * THE SESSION IS RECORDED BEFORE THE WAIT, deliberately. A driver watching
   * `sessions` can then see that the provider was dialled at all, which is the
   * difference between "still connecting" and "never asked" — and it is what
   * lets a test assert what a slow preset WILL do without waiting out its
   * twelve seconds. {@link FakeGrokHandler.close} releases anything still
   * waiting, so nothing lingers past the driver that started it.
   */
  upgradeDelayMs: number;
  /**
   * Answer the upgrade with a plain HTTP response and no socket at all.
   *
   * `dialGrokSocket` returns null for that (`response.webSocket === null`) and
   * the facet writes `conversation-failed` — the door being answered and shut,
   * as against {@link upgradeDelayMs}'s door nobody comes to.
   */
  refuseUpgrade: boolean;
  /**
   * The HTTP status of that refusal: 429 is "come back later", 503 "not now",
   * 401 "never".
   *
   * INERT ON ITS OWN, and that is the trap: a status without
   * {@link refuseUpgrade} refuses nothing, because a WebSocket upgrade that
   * succeeds does not have a status the caller ever sees.
   */
  upgradeStatus: number;
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
  /**
   * Ms to wait after a commit before the answer STARTS — `response.created`
   * and everything after it.
   *
   * This is silence with no acknowledgement in it, which is not what a slow
   * model looks like: a real one takes the turn immediately and then thinks.
   * For that, see {@link firstDeltaDelayMs}.
   */
  answerDelayMs: number;
  /**
   * Ms between `response.created` and the first byte of speech — time to first
   * token, on its own.
   *
   * Distinct from {@link answerDelayMs} because the two break different
   * things. A late `response.created` delays the moment the client learns it
   * has been heard at all; a late first delta delays only the audio, with the
   * turn already visibly taken. Anything measuring "press to first word" needs
   * to be able to move one without the other.
   */
  firstDeltaDelayMs: number;
  /**
   * Ms between deltas in paced (non-burst) mode; 0 keeps the derived default.
   *
   * The default paces at 90% of each chunk's own playback time, so a paced
   * provider still finishes slightly AHEAD of realtime — which is why nothing
   * before this knob could simulate a provider slower than the listener.
   *
   * THE TRAP IS THAT SLOWER THAN REALTIME IS SUPPOSED TO STARVE. Set a gap
   * longer than `audioChunkBytes` is worth in playback time and the device
   * legitimately runs dry between chunks: an underrun in that run is the
   * scenario working, not the lane failing. Every "no underruns" assertion
   * elsewhere assumes a provider that is at least as fast as speech.
   */
  deltaGapMs: number;
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
  /**
   * Words to answer with, rendered by this Mac's `say` instead of a tone.
   *
   * A sine wave is the right answer audio for every test that only counts
   * bytes, and the wrong one for the only test that listens: an echo
   * canceller's whole job is speech, and a transcriber asked whether it can
   * still hear the assistant cannot be asked about 440 Hz. Empty keeps the
   * tone, so no existing scenario changes.
   *
   * The text is the WHOLE answer — {@link answerSeconds} is ignored when this
   * is set, because the length of a sentence is not a knob, it is a fact
   * about the sentence.
   */
  speech: string;
  /** Which `say` voice renders {@link speech}. */
  speechVoice: string;
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
  deltaGapMs: 0,
  doubleCreated: false,
  errorEvent: false,
  firstDeltaDelayMs: 0,
  ignoreCommits: false,
  malformedJson: false,
  noSessionCreated: false,
  refuseUpgrade: false,
  repeatSessionCreated: false,
  sessionCreatedDelayMs: 400,
  speech: "",
  speechVoice: "Samantha",
  toolCallsPerTurn: 1,
  toolEveryTurn: 0,
  toolMaxTotal: 0,
  unknownEvents: false,
  upgradeDelayMs: 0,
  upgradeStatus: 502,
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
  /**
   * Slow to answer the door, and then FAILS to: past the bridge's ten-second
   * handshake deadline, so the call is a corpse before the socket ever opens.
   *
   * The socket does eventually arrive, which is the interesting part — a
   * bridge that has already given up must not be surprised by it, and must not
   * end up holding two.
   */
  "dead-connect": { upgradeDelayMs: 12_000 },
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
  /** The door is answered and shut: an upgrade refused with a bad gateway. */
  refused: { refuseUpgrade: true },
  "short-lifetime": { closeAfterOpenMs: 20_000 },
  /**
   * Slow to answer the door, but inside the bridge's handshake deadline, so
   * the call that eventually opens is the SAME call that was dialled.
   *
   * Eight seconds is deliberately close to the ten-second deadline rather than
   * comfortably under it: the interesting question is what a press DURING the
   * wait does, and a two-second window is the honest one to ask it in.
   */
  "slow-connect": { upgradeDelayMs: 8_000 },
  /**
   * The turn is taken instantly and the first word takes three seconds.
   *
   * Not the same scenario as `answerDelayMs` and it is worth keeping them
   * apart: this one leaves `response.created` where it was, so anything that
   * reacts to the turn being taken — a listening indicator, a barge-in guard,
   * the facet's own turn timing — sees it on time and only the audio is late.
   */
  "slow-first-token": { firstDeltaDelayMs: 3_000 },
  /**
   * A provider slower than speech: 600 ms between 400 ms chunks.
   *
   * THE DEVICE IS MEANT TO STARVE HERE. Nothing can pace its way out of a
   * provider that produces six seconds of audio in nine, so this is the one
   * scenario in the table where an underrun is a pass — it is what a listener
   * hears when the model itself cannot keep up, and telling that apart from
   * the lane's own stutter is the whole reason to be able to select it.
   */
  "slow-speech": { answerSeconds: 6, burst: false, deltaGapMs: 600 },
  tool: { toolEveryTurn: 1 },
  "tool-storm": { toolEveryTurn: 1, toolCallsPerTurn: 3 },
  "unknown-events": { unknownEvents: true },
};

/** Everything one fake session saw and did, for a driver to assert on. */
export interface FakeGrokSession {
  id: number;
  script: string;
  /**
   * What this session resolved to be, script and query overrides applied.
   *
   * Recorded so a driver can assert what a session WILL do without waiting for
   * it to do it — `dead-connect` holds its upgrade for twelve seconds, and a
   * test that had to sit through that to find out which preset it got would
   * simply not be written.
   */
  behaviour: FakeGrokBehaviour;
  /** When the dial ARRIVED, which for a slow upgrade is before it opened. */
  openedAt: number;
  closedAt: number | null;
  /** Why WE closed it, when we did. */
  closedBy: string | null;
  /** Total mic bytes the bridge handed us, and per committed turn. */
  micBytes: number;
  micBytesByTurn: number[];
  /**
   * Speaker bytes we handed the bridge, as PCM16 — what the answer WAS.
   *
   * The provider's own record of what it sent, which is the only honest left
   * hand side of "did everything arrive?". Comparing against `answerSeconds`
   * instead compares the delivery to what the test ASKED for, and would call a
   * fake that shipped nothing a pass the day it stopped shipping.
   */
  speakerBytes: number;
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

/**
 * The same fake, before anybody publishes it: a request handler and the record
 * of what it did.
 *
 * THE HANDLER IS THE WHOLE PROVIDER, and the tunnel is only how a deployed
 * worker reaches it. Lifted out, a test in this process can call it directly
 * and hand `response.webSocket` to the facet's injected `dialGrok` — so the
 * real facet talks the real realtime protocol over a real socket with no
 * gateway, no deployment, no credentials and no network at all. Every
 * misbehaviour still selects the same way, because selection happens inside
 * the handler off the request's query string.
 */
export interface FakeGrokHandler {
  /**
   * Answer one request, Workers-style.
   *
   * A WebSocket upgrade returns a response whose `webSocket` is the CLIENT
   * end, exactly as a Worker's would; the caller accepts it. Anything else
   * gets a small JSON health body.
   *
   * ASYNCHRONOUS BECAUSE THE DOOR CAN BE SLOW: `upgradeDelayMs` is the wait
   * before this resolves at all, and `refuseUpgrade` resolves it with no
   * socket on it.
   */
  handler(request: Request): Promise<Response>;
  sessions: FakeGrokSession[];
  /** Every line the fake logged, newest last. */
  log: string[];
  /** Add a line of the caller's own to that log, stamped the same way. */
  note(line: string): void;
  /** Push a message into the newest live session (scenario control). */
  poke(send: (session: FakeGrokSession, raw: (data: string | Uint8Array) => void) => void): boolean;
  /** Hang up every live session — the provider going away, on purpose. */
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
    } else if (typeof current === "string") {
      (behaviour[key] as string) = raw;
    } else {
      (behaviour[key] as number) = Number(raw);
    }
  }
  return { behaviour, script };
}

/**
 * Render words to 16 kHz mono PCM16 with this Mac's own text-to-speech.
 *
 * DETERMINISTIC BECAUSE IT IS CACHED, not because `say` promises to be: the
 * same text and voice resolve to the same file for the life of the machine,
 * so a calibration run compared against yesterday's is comparing the same
 * waveform. Cached in tmp under a content hash rather than regenerated per
 * session, because a hardware sweep renders the same sentence dozens of times
 * and `say` takes about a second each.
 *
 * `sox` does the resampling rather than `say --data-format`, which accepts
 * the flag and then writes a header claiming a rate it did not produce.
 */
export function renderSpeech(text: string, voice: string): Buffer {
  const digest = createHash("sha256").update(`${voice}::${text}`).digest("hex").slice(0, 16);
  const cached = path.join(os.tmpdir(), `iterate-say-${digest}.raw`);
  if (!fs.existsSync(cached)) {
    const aiff = `${cached}.aiff`;
    execFileSync("say", ["-v", voice, "-o", aiff, text], { stdio: "ignore" });
    execFileSync(
      "sox",
      [aiff, "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer", cached],
      { stdio: "ignore" },
    );
    fs.rmSync(aiff, { force: true });
  }
  return fs.readFileSync(cached);
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
 * Build the fake without publishing it — see {@link FakeGrokHandler}.
 *
 * {@link startFakeGrok} is this plus a tunnel.
 */
export function createFakeGrokHandler(options?: {
  /** Mirror the log to stderr as it happens. */
  verbose?: boolean;
}): FakeGrokHandler {
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
    hangUp: (why: string) => void;
  }[] = [];
  /**
   * Upgrades being held open, and how to let them go.
   *
   * Tracked rather than fire-and-forget because `dead-connect` waits twelve
   * seconds: without this, a driver that has finished with the fake is held
   * hostage by a timer belonging to a dial nobody is waiting for any more.
   */
  const waitingUpgrades = new Set<{ timer: NodeJS.Timeout; release: (open: boolean) => void }>();

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!isWebSocketUpgradeRequest(request)) {
      return Response.json({ fakeGrok: true, sessions: sessions.length });
    }
    const { behaviour, script } = parseBehaviour(url.searchParams);
    /*
     * THE DIAL IS RECORDED BEFORE THE DOOR IS ANSWERED, so "still connecting"
     * and "never asked" are different states rather than the same empty list.
     */
    const dialledAt: FakeGrokSession = {
      answers: 0,
      behaviour,
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
      speakerBytes: 0,
      toolCallIds: [],
      toolOutputs: [],
    };
    sessions.push(dialledAt);
    if (behaviour.upgradeDelayMs > 0) {
      say(`session ${dialledAt.id} holding the upgrade for ${behaviour.upgradeDelayMs}ms`);
      const opened = await new Promise<boolean>((resolve) => {
        const waiting = {
          release: (open: boolean) => {
            clearTimeout(waiting.timer);
            waitingUpgrades.delete(waiting);
            resolve(open);
          },
          timer: setTimeout(() => waiting.release(true), behaviour.upgradeDelayMs),
        };
        waitingUpgrades.add(waiting);
      });
      if (!opened) {
        dialledAt.closedAt = Date.now();
        dialledAt.closedBy = "shut down mid-upgrade";
        say(`session ${dialledAt.id} upgrade abandoned: fake grok shut down`);
        return new Response("fake grok shut down while connecting", { status: 503 });
      }
    }
    if (behaviour.refuseUpgrade) {
      dialledAt.closedAt = Date.now();
      dialledAt.closedBy = `refused the upgrade (${behaviour.upgradeStatus})`;
      say(`session ${dialledAt.id} REFUSING the upgrade with ${behaviour.upgradeStatus}`);
      return new Response("fake grok is not taking calls", { status: behaviour.upgradeStatus });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const session = dialledAt;
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

    live.push({ hangUp, send: raw, session });

    let phase = 0;
    /*
     * Rendered ONCE PER SESSION, at the top, so a slow first render is paid
     * before the bridge is told anything — not in the middle of the first
     * answer, where a second of `say` would read as a second of provider
     * latency in every measurement taken through this fake.
     */
    const speechPcm =
      behaviour.speech === "" ? null : renderSpeech(behaviour.speech, behaviour.speechVoice);
    /** How far into {@link speechPcm} the current answer has spoken. */
    let speechOffset = 0;
    let micSinceCommit = 0;
    let turn = 0;
    let answering = false;
    /** Cancelled answers must stop emitting; this is the generation guard. */
    let answerGeneration = 0;

    const sendAudio = (chunkBytes: number) => {
      let pcm: Buffer;
      if (speechPcm === null) {
        const made = tone(chunkBytes, phase);
        phase = made.phase;
        pcm = made.pcm;
      } else {
        pcm = speechPcm.subarray(speechOffset, speechOffset + chunkBytes);
        speechOffset += pcm.length;
      }
      session.speakerBytes += pcm.length;
      if (behaviour.base64Audio) {
        emit({ delta: pcm.toString("base64"), type: "response.output_audio.delta" });
      } else {
        raw(new Uint8Array(pcm));
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
      /* Every answer says the whole sentence from the top — an answer that
       * resumed where the last one stopped would make turn two quieter than
       * turn one for no reason a calibration run could account for. */
      speechOffset = 0;
      const totalBytes =
        speechPcm === null
          ? Math.floor(behaviour.answerSeconds * SAMPLE_RATE * 2)
          : speechPcm.length;
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
      /*
       * The transcript travels WITH the audio, not ahead of it. A provider
       * that had not produced a syllable yet has not transcribed one either,
       * so holding both behind `firstDeltaDelayMs` is what makes that knob
       * "time to first token" rather than "time to first PCM".
       */
      const speak = () => {
        if (!alive || generation !== answerGeneration) return;
        emit({ delta: transcript, type: "response.output_audio_transcript.delta" });
        if (behaviour.burst) {
          for (let index = 0; index < chunks; index++) {
            if (generation !== answerGeneration) return;
            sendAudio(Math.min(chunk, totalBytes - index * chunk));
          }
          finish();
          return;
        }
        /* 90% of a chunk's own playback time by default, so a paced provider
         * still finishes a shade ahead of the listener; `deltaGapMs` is how a
         * scenario asks for one that does not. */
        const gapMs =
          behaviour.deltaGapMs > 0 ? behaviour.deltaGapMs : (chunk / BYTES_PER_MS) * 0.9;
        let index = 0;
        const step = () => {
          if (!alive || generation !== answerGeneration) return;
          if (index >= chunks) return finish();
          sendAudio(Math.min(chunk, totalBytes - index * chunk));
          index++;
          later(gapMs, step);
        };
        step();
      };
      if (behaviour.firstDeltaDelayMs > 0) later(behaviour.firstDeltaDelayMs, speak);
      else speak();
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
        case "input_audio_buffer.append": {
          /*
           * THE MICROPHONE ARRIVES AS BASE64 ON THIS TRANSPORT, and counting
           * only the binary one made the fake's headline instrument lie.
           *
           * The realtime session picks a transport: "binary" puts mic PCM in
           * raw WebSocket frames, "json" puts it in `input_audio_buffer.append`
           * as base64 (see grok.ts, which speaks both). The retired bridge
           * asked for binary; the facet does not ask at all and therefore
           * speaks json — so against today's bridge every `micBytes` this fake
           * reported was ZERO. "The customer heard nothing" becomes "the
           * provider was handed 0 bytes" is the whole reason this double
           * exists, and it was saying that about a bridge that had handed over
           * every frame. Decoded length, so both transports count the same
           * thing: PCM bytes.
           */
          const bytes =
            typeof message.audio === "string" ? Buffer.from(message.audio, "base64").length : 0;
          session.micBytes += bytes;
          micSinceCommit += bytes;
          break;
        }
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

  return {
    close: () => {
      /* A copy, because hanging up splices the entry out of `live`. */
      for (const entry of [...live]) entry.hangUp("fake grok shut down");
      /* And let go of every door nobody is standing at any more. */
      for (const waiting of [...waitingUpgrades]) waiting.release(false);
    },
    handler,
    log,
    note: say,
    poke: (send) => {
      const newest = live[live.length - 1];
      if (newest === undefined) return false;
      send(newest.session, newest.send);
      return true;
    },
    sessions,
  };
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
  const fake = createFakeGrokHandler(
    options?.verbose === undefined ? {} : { verbose: options.verbose },
  );

  let tunnel: CaptunTunnel;
  try {
    tunnel = await createCaptunTunnel({
      fetch: fake.handler,
      gateway:
        options?.gateway ?? process.env.CAPTUN_GATEWAY?.trim() ?? "https://tunnels.iterate.com",
      ...(options?.name && { name: options.name }),
      ...((options?.token ?? process.env.CAPTUN_TOKEN?.trim()) && {
        token: options?.token ?? process.env.CAPTUN_TOKEN!.trim(),
      }),
    });
  } catch (error) {
    throw new Error(
      `fake grok could not publish a tunnel (need CAPTUN_TOKEN from the Doppler config): ${String(error)}`,
    );
  }
  fake.note(`fake grok published at ${tunnel.url}`);

  return {
    close: () => tunnel[Symbol.dispose](),
    log: fake.log,
    poke: fake.poke,
    sessions: fake.sessions,
    url: tunnel.url,
  };
}
