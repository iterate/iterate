// Drive the bridge into the failures a real provider will eventually cause.
//
// One process holds both ends: a fake Grok (fake-grok.ts, published through
// captun so a Cloudflare worker can dial it) and a stream watcher, so every
// scenario can assert on what the PROVIDER was handed as well as on what the
// LISTENER received. A scenario that silently does nothing is the worst
// possible outcome here, so every one of them records its own evidence and
// says out loud when it could not run.
//
//   doppler run --config preview_3 -- pnpm cli voicelab pressure \
//     --project prj_… --scenario all
import fs from "node:fs";
import process from "node:process";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { startFakeGrok, type FakeGrok, type FakeGrokSession } from "./fake-grok.ts";

/** Options for `pnpm cli voicelab pressure`. */
export interface PressureOptions extends VoicelabConnectOptions {
  /** Scenario name, comma-separated list, or "all". */
  scenario?: string;
  /** Stable captun tunnel name for the fake provider. */
  tunnelName?: string;
  /** Print every fake-provider log line as it happens. */
  verbose?: boolean;
  /** Write the full report here as JSON. */
  out?: string;
  /** List the scenarios and exit. */
  list?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 20ms of silence, the shape a device's mic frame has on the wire. */
const SILENT_FRAME = Buffer.alloc(640).toString("base64");

interface StreamEventSeen {
  at: number;
  type: string;
  payload: Record<string, unknown>;
}

/** One call under test, plus everything both ends observed. */
interface Call {
  callId: string;
  path: string;
  started: Record<string, unknown>;
  startMs: number;
  /** True when startCall did not answer inside the scenario's patience. */
  startTimedOut: boolean;
  seen: StreamEventSeen[];
  /** Grok events, unwrapped, in arrival order. */
  grok: { at: number; type: string; event: Record<string, unknown> }[];
  spk: { answer: number; frame: number; seq: number; at: number }[];
  say(text: string): Promise<void>;
  /** Push-to-talk: start, frames, commit. `mangle` reorders/drops/duplicates. */
  speak(options: {
    frames?: number;
    mangle?: (seqs: number[]) => number[];
    commit?: boolean;
    start?: boolean;
    seqBase?: number;
    gapAfter?: number;
  }): Promise<void>;
  /** Append any event to this call's stream verbatim — including a foreign callId. */
  strayer(type: string, payload: Record<string, unknown>): Promise<void>;
  /**
   * Make the colleague appear to send a chat message it was never asked for.
   * `agent.ask()` waits for exactly this event type, so appending one is the
   * only way to drive "the agent replied twice" without a cooperative model.
   */
  strayColleague(message: string): Promise<void>;
  /** Wait until `check` is true or the deadline passes; returns whether it was. */
  until(what: string, check: () => boolean, ms?: number): Promise<boolean>;
  hangUp(): Promise<void>;
  close(): void;
}

interface Harness {
  fake: FakeGrok;
  /**
   * Provider sessions opened since THIS scenario started. One fake serves the
   * whole run, so the raw list is cumulative and quoting it puts 40 sessions
   * belonging to other scenarios into every piece of evidence.
   */
  newSessions(): FakeGrokSession[];
  /** The newest provider session, which is the one under test. */
  lastSession(): FakeGrokSession;
  open(options: {
    script?: string;
    query?: Record<string, string | number>;
    colleague?: boolean;
    /** How long to wait for startCall before calling it hung. */
    startPatienceMs?: number;
    path?: string;
    callId?: string;
    instructions?: string;
  }): Promise<Call>;
  note(line: string): void;
}

/** What a scenario reports back. */
interface ScenarioResult {
  name: string;
  what: string;
  expected: string;
  observed: string;
  verdict: "pass" | "DEFECT" | "inconclusive";
  evidence: string[];
  ms: number;
}

type Scenario = {
  name: string;
  what: string;
  expected: string;
  run(harness: Harness): Promise<{
    verdict: ScenarioResult["verdict"];
    observed: string;
    evidence: string[];
  }>;
};

// ---------------------------------------------------------------------------

export async function pressure(options: PressureOptions) {
  const scenarios = buildScenarios();
  if (options.list === true) {
    for (const scenario of scenarios) console.log(`${scenario.name.padEnd(28)} ${scenario.what}`);
    return;
  }
  const wanted =
    options.scenario === undefined || options.scenario === "all"
      ? scenarios
      : scenarios.filter((scenario) =>
          options.scenario!.split(",").some((name) => name.trim() === scenario.name),
        );
  if (wanted.length === 0) {
    throw new Error(
      `no scenario matched "${options.scenario}". Known: ${scenarios.map((s) => s.name).join(", ")}`,
    );
  }

  const fake = await startFakeGrok({
    ...(options.tunnelName ? { name: options.tunnelName } : {}),
    verbose: options.verbose === true,
  });
  console.error(`fake grok: ${fake.url}`);

  const itx = await connectProject(options);
  const notes: string[] = [];
  const results: ScenarioResult[] = [];

  let sessionsAtStart = 0;
  const harness: Harness = {
    fake,
    lastSession: () =>
      fake.sessions[fake.sessions.length - 1] ?? {
        answers: 0,
        cancels: 0,
        closedAt: null,
        closedBy: "no session was ever opened",
        commits: 0,
        id: 0,
        injected: [],
        micBytes: 0,
        micBytesByTurn: [],
        openedAt: 0,
        received: [],
        responseCreates: 0,
        script: "none",
        toolCallIds: [],
        toolOutputs: [],
      },
    newSessions: () => fake.sessions.slice(sessionsAtStart),
    note: (line) => {
      notes.push(line);
      console.error(`    · ${line}`);
    },
    open: async (openOptions) => openCall(itx, fake, openOptions),
  };

  for (const scenario of wanted) {
    console.error(`\n=== ${scenario.name}: ${scenario.what}`);
    const at = Date.now();
    const before = fake.log.length;
    sessionsAtStart = fake.sessions.length;
    let result: ScenarioResult;
    try {
      const outcome = await scenario.run(harness);
      result = {
        evidence: outcome.evidence,
        expected: scenario.expected,
        ms: Date.now() - at,
        name: scenario.name,
        observed: outcome.observed,
        verdict: outcome.verdict,
        what: scenario.what,
      };
    } catch (error) {
      result = {
        evidence: fake.log.slice(before),
        expected: scenario.expected,
        ms: Date.now() - at,
        name: scenario.name,
        observed: `the scenario itself threw: ${String(error).slice(0, 300)}`,
        verdict: "inconclusive",
        what: scenario.what,
      };
    }
    console.error(
      `--- ${scenario.name}: ${result.verdict.toUpperCase()} (${(result.ms / 1000).toFixed(1)}s)\n    ${result.observed}`,
    );
    results.push(result);
  }

  fake.close();
  try {
    (itx as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  } catch {
    /* already gone */
  }

  const defects = results.filter((result) => result.verdict === "DEFECT");
  const report = {
    notes,
    results,
    summary: {
      defects: defects.map((result) => result.name),
      inconclusive: results.filter((r) => r.verdict === "inconclusive").map((r) => r.name),
      passed: results.filter((r) => r.verdict === "pass").length,
      ran: results.length,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.out) fs.writeFileSync(options.out, JSON.stringify(report, null, 2));
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------

async function openCall(
  itx: Awaited<ReturnType<typeof connectProject>>,
  fake: FakeGrok,
  options: {
    script?: string;
    query?: Record<string, string | number>;
    colleague?: boolean;
    startPatienceMs?: number;
    path?: string;
    callId?: string;
    instructions?: string;
  },
): Promise<Call> {
  /*
   * Under /agents/voice/ because a voice conversation's stream IS its agent —
   * the same reason the device's default moved there. A path outside /agents/
   * gives the conversation no agent identity to be the back office of.
   */
  const path = options.path ?? `/agents/voice/pressure-${Date.now().toString(36)}`;
  const callId = options.callId ?? `p${Date.now().toString(36).slice(-6)}`;
  const stream = itx.streams.get(path);
  const seen: StreamEventSeen[] = [];
  const grok: Call["grok"] = [];
  const spk: Call["spk"] = [];

  const connection = await stream.openConnection({
    connectionKey: `pressure-${callId}`,
    eventTypes: [
      "voice-agent/spk-frame",
      "voice-agent/grok-event",
      "voice-agent/call-accepted",
      "voice-agent/call-ended",
      "voice-agent/turn-committed",
      "voice-agent/bridge-redialling",
      "voice-agent/colleague-asked",
      "voice-agent/colleague-answered",
      "voice-agent/pong",
    ],
    processEventBatch: (batch: { events: { type: string; payload?: unknown }[] }) => {
      const at = Date.now();
      for (const event of batch.events) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        seen.push({ at, payload, type: event.type });
        if (event.type === "voice-agent/spk-frame") {
          spk.push({
            answer: Number(payload.answer),
            at,
            frame: Number(payload.frame),
            seq: Number(payload.seq),
          });
        }
        if (event.type === "voice-agent/grok-event") {
          const inner = (payload.event ?? {}) as Record<string, unknown>;
          grok.push({ at, event: inner, type: String(inner.type) });
        }
      }
    },
  });

  const url = new URL(fake.url);
  url.pathname = "/realtime";
  if (options.script) url.searchParams.set("script", options.script);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const worker = (
    itx as unknown as {
      worker: { startCall(input: Record<string, unknown>): Promise<Record<string, unknown>> };
    }
  ).worker;

  const at = Date.now();
  let startTimedOut = false;
  const started = await Promise.race([
    worker.startCall({
      callId,
      colleague: options.colleague === true,
      grokBaseUrl: url.toString(),
      path,
      turns: "manual",
      ...(options.instructions ? { instructions: options.instructions } : {}),
    }),
    sleep(options.startPatienceMs ?? 30_000).then(() => {
      startTimedOut = true;
      return { hung: true } as Record<string, unknown>;
    }),
  ]);
  const startMs = Date.now() - at;

  let micSeq = 0;
  const call: Call = {
    callId,
    close: () => connection.close(),
    grok,
    hangUp: async () => {
      await stream
        .append({ payload: { callId, reason: "pressure done" }, type: "voice-agent/call-ended" })
        .catch(() => {});
      await sleep(700);
    },
    path,
    say: async (text) => {
      await stream.append({ payload: { callId, text }, type: "voice-agent/say" });
    },
    seen,
    speak: async (speakOptions) => {
      const frames = speakOptions.frames ?? 10;
      if (speakOptions.start !== false) {
        micSeq = 0;
        await stream.append({ payload: { action: "start", callId }, type: "voice-agent/turn" });
      }
      const base = speakOptions.seqBase ?? micSeq;
      let order = Array.from({ length: frames }, (_, index) => base + index);
      if (speakOptions.gapAfter !== undefined) {
        order = order.filter((seq) => seq - base !== speakOptions.gapAfter);
      }
      if (speakOptions.mangle) order = speakOptions.mangle(order);
      for (const seq of order) {
        await stream.append({
          ephemeral: true,
          payload: { callId, pcm: SILENT_FRAME, seq, t: Date.now() },
          type: "voice-agent/mic-frame",
        });
      }
      micSeq = base + frames;
      if (speakOptions.commit !== false) {
        await stream.append({ payload: { action: "commit", callId }, type: "voice-agent/turn" });
      }
    },
    spk,
    startMs,
    startTimedOut,
    started,
    strayColleague: async (message) => {
      /*
       * The voice agent's own stream, not a fixed colleague path: the thinking
       * half of a conversation lives at the conversation's path, so a stray
       * message has to arrive where a real one would.
       */
      await itx.streams.get(path).append({
        payload: { message },
        type: "events.iterate.com/agents/web-message-sent",
      });
    },
    strayer: async (type, payload) => {
      await stream.append({
        ...(type === "voice-agent/mic-frame" ? { ephemeral: true as const } : {}),
        payload,
        type,
      });
    },
    until: async (_what, check, ms = 15_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (check()) return true;
        await sleep(200);
      }
      return check();
    },
  };
  return call;
}

/** Compact one-liner about a fake session, for evidence. */
function describeSession(session: FakeGrokSession): string {
  return [
    `session ${session.id}`,
    `script=${session.script}`,
    `mic=${session.micBytes}B`,
    `commits=${session.commits}`,
    `responses=${session.responseCreates}`,
    `cancels=${session.cancels}`,
    `closedBy=${session.closedBy ?? "still open"}`,
    `received=[${session.received.join(",")}]`,
  ].join(" ");
}

/** Speaker frames grouped by answer, as "answer N: F frames, seqs a..b". */
function describeSpeaker(call: Call): string[] {
  const byAnswer = new Map<number, { frame: number; seq: number }[]>();
  for (const frame of call.spk) {
    const list = byAnswer.get(frame.answer) ?? [];
    list.push(frame);
    byAnswer.set(frame.answer, list);
  }
  return [...byAnswer.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([answer, frames]) => {
      const gaps = frames
        .map((frame, index) => (index > 0 ? frame.frame - frames[index - 1]!.frame : 1))
        .filter((step) => step !== 1).length;
      return `answer ${answer}: ${frames.length} frames, frame ${frames[0]!.frame}..${frames[frames.length - 1]!.frame}, ${gaps} discontinuities`;
    });
}

// ---------------------------------------------------------------------------

function buildScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  const add = (scenario: Scenario) => scenarios.push(scenario);

  add({
    expected:
      "the call comes up, both turns are answered, speaker frames are contiguous per answer",
    name: "baseline",
    run: async (harness) => {
      const call = await harness.open({ script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("hello");
      const first = await call.until("first answer", () => call.spk.length > 0, 20_000);
      await call.speak({ frames: 25 });
      const second = await call.until(
        "second answer",
        () => call.grok.filter((event) => event.type === "response.done").length >= 2,
        20_000,
      );
      const committed = call.seen.filter((event) => event.type === "voice-agent/turn-committed");
      evidence.push(...describeSpeaker(call));
      evidence.push(`turn-committed: ${JSON.stringify(committed.map((event) => event.payload))}`);
      evidence.push(describeSession(harness.lastSession()));
      await call.hangUp();
      call.close();
      const session = harness.lastSession();
      const ok =
        call.started.ok === true &&
        first &&
        second &&
        session.micBytes >= 25 * 640 &&
        session.commits >= 1;
      return {
        evidence,
        observed: ok
          ? `call live in ${call.startMs}ms, ${call.spk.length} speaker frames, provider got ${session.micBytes} mic bytes across ${session.commits} commit(s)`
          : `baseline did not hold: started=${JSON.stringify(call.started)} firstAnswer=${first} secondAnswer=${second} micBytes=${session.micBytes}`,
        verdict: ok ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "a behaving fake provider holds a conversation exactly like the real one",
  });

  add({
    expected:
      "a provider that greets the instant the socket opens is heard, exactly like one that waits 400ms",
    name: "handshake-race",
    run: async (harness) => {
      const evidence: string[] = [];
      const instant = await harness.open({ script: "greet-instantly", startPatienceMs: 25_000 });
      evidence.push(
        `greeting at 0ms:   startCall ${JSON.stringify(instant.started)} after ${instant.startMs}ms`,
      );
      const instantSession = harness.lastSession();
      evidence.push(`  provider saw from the bridge: [${instantSession.received.join(",")}]`);
      await instant.hangUp();
      instant.close();

      const patient = await harness.open({
        query: { sessionCreatedDelayMs: 400 },
        script: "normal",
        startPatienceMs: 25_000,
      });
      evidence.push(
        `greeting at 400ms: startCall ${JSON.stringify(patient.started)} after ${patient.startMs}ms`,
      );
      const patientSession = harness.lastSession();
      evidence.push(`  provider saw from the bridge: [${patientSession.received.join(",")}]`);
      await patient.hangUp();
      patient.close();

      const lost = instant.started.ok !== true && patient.started.ok === true;
      return {
        evidence,
        observed: lost
          ? `session.created sent at 0ms was never answered (the bridge sent nothing back); the same greeting sent at 400ms was answered and the call came up in ${patient.startMs}ms`
          : `instant=${JSON.stringify(instant.started)} patient=${JSON.stringify(patient.started)}`,
        verdict: lost ? ("DEFECT" as const) : ("pass" as const),
      };
    },
    what: "provider greets the instant the socket opens (before the bridge is listening)",
  });

  add({
    expected:
      "startCall answers promptly with ok:false — a provider that never completes the handshake is a failed call, not a hung one",
    name: "no-session-created",
    run: async (harness) => {
      const call = await harness.open({ script: "no-session-created", startPatienceMs: 75_000 });
      const evidence = [
        `startCall returned ${JSON.stringify(call.started)} after ${call.startMs}ms (timedOut=${call.startTimedOut})`,
        ...harness.newSessions().map(describeSession),
      ];
      await call.hangUp();
      call.close();
      const hung = call.startTimedOut || call.startMs > 20_000;
      return {
        evidence,
        observed: hung
          ? `startCall did not answer within ${call.startMs}ms — the caller is blocked with no timeout of its own`
          : `startCall answered in ${call.startMs}ms: ${JSON.stringify(call.started)}`,
        verdict: hung ? ("DEFECT" as const) : ("pass" as const),
      };
    },
    what: "provider accepts the socket and never sends session.created",
  });

  add({
    expected: "the bridge redials, and startCall gives up in seconds rather than minutes",
    name: "close-handshake",
    run: async (harness) => {
      const call = await harness.open({ script: "close-handshake", startPatienceMs: 75_000 });
      const redials = call.seen.filter((event) => event.type === "voice-agent/bridge-redialling");
      const evidence = [
        `startCall returned ${JSON.stringify(call.started)} after ${call.startMs}ms (timedOut=${call.startTimedOut})`,
        `redial announcements on the stream: ${redials.length}`,
        `fake saw ${harness.newSessions().length} dial attempts`,
      ];
      await call.hangUp();
      call.close();
      const hung = call.startTimedOut || call.startMs > 20_000;
      return {
        evidence,
        observed: hung
          ? `startCall blocked for ${call.startMs}ms while the bridge redialled ${harness.newSessions().length} times`
          : `startCall answered in ${call.startMs}ms`,
        verdict: hung ? ("DEFECT" as const) : ("pass" as const),
      };
    },
    what: "provider closes during the handshake, every time",
  });

  add({
    expected:
      "the call comes up, then the redial replaces the socket underneath and the conversation continues",
    name: "close-after-session-created",
    run: async (harness) => {
      const call = await harness.open({
        script: "close-after-session-created",
        startPatienceMs: 60_000,
      });
      const evidence = [
        `startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms (timedOut=${call.startTimedOut})`,
      ];
      await sleep(6000);
      evidence.push(`fake dial attempts: ${harness.newSessions().length}`);
      evidence.push(
        `redial announcements: ${call.seen.filter((e) => e.type === "voice-agent/bridge-redialling").length}`,
      );
      await call.hangUp();
      call.close();
      const hung = call.startTimedOut;
      return {
        evidence,
        observed: hung
          ? `startCall never answered; the bridge redialled ${harness.newSessions().length} times`
          : `startCall answered ${JSON.stringify(call.started)} in ${call.startMs}ms after ${harness.newSessions().length} dials`,
        verdict: hung ? ("DEFECT" as const) : ("pass" as const),
      };
    },
    what: "provider sends session.created then hangs up immediately",
  });

  add({
    expected:
      "the redial brings a new socket up under the conversation and the next turn is answered",
    name: "close-mid-answer",
    run: async (harness) => {
      const call = await harness.open({ script: "close-mid-answer" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("count to fifty");
      await call.until("some audio", () => call.spk.length > 0, 20_000);
      const framesBeforeClose = call.spk.length;
      await sleep(8000);
      evidence.push(`speaker frames before the provider hung up: ${framesBeforeClose}`);
      evidence.push(...describeSpeaker(call));
      evidence.push(`fake sessions: ${harness.newSessions().length}`);
      // Can the conversation carry on?
      const answersBefore = call.grok.filter((event) => event.type === "response.done").length;
      await call.speak({ frames: 15 });
      const recovered = await call.until(
        "an answer after the redial",
        () => call.grok.filter((event) => event.type === "response.done").length > answersBefore,
        25_000,
      );
      evidence.push(`answered after redial: ${recovered}`);
      evidence.push(...harness.newSessions().map(describeSession));
      const ended = call.seen.filter((event) => event.type === "voice-agent/call-ended");
      evidence.push(`call-ended seen: ${JSON.stringify(ended.map((event) => event.payload))}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: recovered
          ? `the provider hung up mid-answer after ${framesBeforeClose} frames and the next turn was still answered (${harness.newSessions().length} provider sessions)`
          : `the provider hung up mid-answer after ${framesBeforeClose} frames and the call never answered again`,
        verdict: recovered ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "provider closes the socket in the middle of an answer",
  });

  add({
    expected: "the redial is invisible; the next turn is answered on the replacement socket",
    name: "close-between-turns",
    run: async (harness) => {
      const call = await harness.open({ script: "close-between-turns" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("first");
      await call.until("first answer", () => call.spk.length > 0, 20_000);
      await sleep(6000);
      const answersBefore = call.grok.filter((event) => event.type === "response.done").length;
      // A turn that arrives WHILE the provider socket is gone: this is the
      // exact moment a customer presses the button after an idle pause.
      await call.speak({ frames: 15 });
      const answered = await call.until(
        "second answer",
        () => call.grok.filter((event) => event.type === "response.done").length > answersBefore,
        25_000,
      );
      evidence.push(`provider sessions: ${harness.newSessions().length}`);
      evidence.push(...harness.newSessions().map(describeSession));
      evidence.push(`second turn answered: ${answered}`);
      const committed = call.seen.filter((event) => event.type === "voice-agent/turn-committed");
      evidence.push(`turn-committed: ${JSON.stringify(committed.map((event) => event.payload))}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: answered
          ? `the customer's turn after the provider hung up was still answered`
          : `the customer spoke into a call whose provider socket had gone, and got nothing back`,
        verdict: answered ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "provider closes between turns, and the customer then speaks",
  });

  add({
    expected:
      "the bridge survives nonsense: the malformed frame is ignored and the answer around it still arrives",
    name: "malformed-json",
    run: async (harness) => {
      const call = await harness.open({ script: "malformed-json" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("hello");
      const answered = await call.until(
        "an answer",
        () => call.grok.some((event) => event.type === "response.done"),
        20_000,
      );
      evidence.push(`speaker frames: ${call.spk.length}`);
      evidence.push(`response.done seen: ${answered}`);
      // Is the call still usable at all afterwards?
      const before = call.grok.filter((event) => event.type === "response.done").length;
      await call.speak({ frames: 12 });
      const stillAlive = await call.until(
        "a second answer",
        () => call.grok.filter((event) => event.type === "response.done").length > before,
        20_000,
      );
      evidence.push(`second turn answered: ${stillAlive}`);
      evidence.push(`provider sessions: ${harness.newSessions().length}`);
      evidence.push(...harness.newSessions().map(describeSession));
      evidence.push(
        `call-ended: ${JSON.stringify(call.seen.filter((e) => e.type === "voice-agent/call-ended").map((e) => e.payload))}`,
      );
      await call.hangUp();
      call.close();
      const ok = answered && stillAlive;
      return {
        evidence,
        observed: ok
          ? "the malformed frame was absorbed and both turns answered"
          : `one bad frame from the provider cost the call: firstAnswer=${answered} secondAnswer=${stillAlive}, ${harness.newSessions().length} provider sessions`,
        verdict: ok ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "provider sends a frame of unparseable JSON",
  });

  add({
    expected:
      "unknown event types and an error event are ignored/forwarded; the answer still lands",
    name: "junk-events",
    run: async (harness) => {
      const call = await harness.open({
        query: { errorEvent: 1, unknownEvents: 1 },
        script: "normal",
      });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("hello");
      const answered = await call.until(
        "an answer",
        () => call.grok.some((event) => event.type === "response.done"),
        20_000,
      );
      const errors = call.grok.filter((event) => event.type === "error");
      evidence.push(`error events forwarded to the listener: ${errors.length}`);
      evidence.push(`speaker frames: ${call.spk.length}`);
      evidence.push(
        `grok event types seen: ${[...new Set(call.grok.map((e) => e.type))].join(",")}`,
      );
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: answered
          ? `unknown types and an error event were absorbed; the answer arrived (${call.spk.length} frames), error forwarded ${errors.length}x`
          : "the answer never arrived after junk events",
        verdict: answered ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "provider sends unknown event types and an error event",
  });

  add({
    expected:
      "audio with no response.created in front of it is still labelled with an answer a listener can act on",
    name: "audio-without-created",
    run: async (harness) => {
      const call = await harness.open({ script: "audio-without-created" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("hello");
      await call.until("frames", () => call.spk.length > 2, 20_000);
      await sleep(1500);
      evidence.push(...describeSpeaker(call));
      const orphans = call.spk.filter((frame) => frame.answer === 0);
      evidence.push(`frames labelled answer 0 (before any response.created): ${orphans.length}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: `${orphans.length} of ${call.spk.length} speaker frames arrived labelled with the previous answer number, and their frame counter continued from that answer rather than restarting`,
        verdict: orphans.length > 0 ? ("DEFECT" as const) : ("pass" as const),
      };
    },
    what: "provider sends audio with no preceding response.created",
  });

  add({
    expected:
      "two response.created in a row make two answers; the second's frames restart at frame 0",
    name: "double-created",
    run: async (harness) => {
      const call = await harness.open({ script: "double-created" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("hello");
      await call.until("frames", () => call.spk.length > 2, 20_000);
      await sleep(2000);
      evidence.push(...describeSpeaker(call));
      const answers = new Set(call.spk.map((frame) => frame.answer));
      evidence.push(`distinct answer numbers on speaker frames: ${[...answers].join(",")}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: `speaker audio for one spoken answer carried answer number(s) ${[...answers].join(",")}; the listener drops everything older than the newest number it has seen`,
        verdict: answers.size === 1 ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "two response.created with no response.done between them",
  });

  add({
    expected: "a huge answer is delivered without the bridge falling over or the stream losing it",
    name: "flood",
    run: async (harness) => {
      const call = await harness.open({ script: "flood" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      const at = Date.now();
      await call.say("count to a thousand");
      const done = await call.until(
        "the whole answer",
        () => {
          const last = call.spk[call.spk.length - 1];
          return last !== undefined && Date.now() - (call.spk[call.spk.length - 1]?.at ?? 0) > 4000;
        },
        120_000,
      );
      const drainMs = (call.spk[call.spk.length - 1]?.at ?? at) - at;
      const floodFrames = call.spk.length;
      evidence.push(`90s of audio = ${Math.round((90 * 16000 * 2) / 640)} expected 20ms frames`);
      evidence.push(...describeSpeaker(call));
      evidence.push(`speaker frames received: ${floodFrames}, drained over ${drainMs}ms`);
      const ended = call.seen.filter((event) => event.type === "voice-agent/call-ended");
      evidence.push(`call-ended: ${JSON.stringify(ended.map((event) => event.payload))}`);
      // Is the call still usable?
      const before = call.grok.filter((event) => event.type === "response.done").length;
      await call.speak({ frames: 10 });
      const alive = await call.until(
        "another answer",
        () => call.grok.filter((event) => event.type === "response.done").length > before,
        25_000,
      );
      evidence.push(`call still answering after the flood: ${alive}`);
      await call.hangUp();
      call.close();
      const expected = Math.round((90 * 16000 * 2) / 640);
      return {
        evidence,
        observed: `${floodFrames}/${expected} frames of the 90s answer reached the listener in ${drainMs}ms; call alive afterwards=${alive}; drained=${done}`,
        verdict: alive && floodFrames >= expected ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "provider emits 90 seconds of audio in one burst",
  });

  add({
    expected: "out-of-order mic frames are reassembled; the provider gets every byte, in order",
    name: "mic-reorder",
    run: async (harness) => {
      const call = await harness.open({ script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.speak({
        frames: 40,
        mangle: (seqs) => {
          // Swap neighbouring pairs, the shape two racing DO appends produce.
          const out = [...seqs];
          for (let index = 0; index + 1 < out.length; index += 2) {
            [out[index], out[index + 1]] = [out[index + 1]!, out[index]!];
          }
          return out;
        },
      });
      await call.until(
        "commit",
        () => call.seen.some((e) => e.type === "voice-agent/turn-committed"),
        20_000,
      );
      const committed = call.seen.find((event) => event.type === "voice-agent/turn-committed");
      evidence.push(`turn-committed: ${JSON.stringify(committed?.payload)}`);
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      evidence.push(`provider mic bytes this turn: ${session.micBytesByTurn.join(",")}`);
      await call.hangUp();
      call.close();
      const got = session.micBytesByTurn[0] ?? 0;
      return {
        evidence,
        observed: `40 frames sent in swapped pairs; the provider received ${got} bytes (${got / 640} frames), reported lost=${(committed?.payload as Record<string, unknown>)?.lost}`,
        verdict: got === 40 * 640 ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "mic frames appended out of order",
  });

  add({
    expected: "a permanent hole drains past after the window fills; the rest of the turn survives",
    name: "mic-gap",
    run: async (harness) => {
      const call = await harness.open({ script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.speak({ frames: 40, gapAfter: 5 });
      await call.until(
        "commit",
        () => call.seen.some((e) => e.type === "voice-agent/turn-committed"),
        20_000,
      );
      const committed = call.seen.find((event) => event.type === "voice-agent/turn-committed");
      evidence.push(`turn-committed: ${JSON.stringify(committed?.payload)}`);
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      await call.hangUp();
      call.close();
      const got = session.micBytesByTurn[0] ?? 0;
      return {
        evidence,
        observed: `39 of 40 frames sent (seq 5 never appended); the provider received ${got} bytes (${got / 640} frames)`,
        verdict: got === 39 * 640 ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "one mic frame never arrives (a permanent hole)",
  });

  add({
    expected: "duplicates are recognised as already-used and not fed to the provider twice",
    name: "mic-duplicates",
    run: async (harness) => {
      const call = await harness.open({ script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.speak({
        frames: 20,
        mangle: (seqs) => [...seqs, ...seqs.slice(0, 10)],
      });
      await call.until(
        "commit",
        () => call.seen.some((e) => e.type === "voice-agent/turn-committed"),
        20_000,
      );
      const committed = call.seen.find((event) => event.type === "voice-agent/turn-committed");
      evidence.push(`turn-committed: ${JSON.stringify(committed?.payload)}`);
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      await call.hangUp();
      call.close();
      const got = session.micBytesByTurn[0] ?? 0;
      return {
        evidence,
        observed: `20 frames plus 10 duplicates appended; the provider received ${got} bytes (${got / 640} frames)`,
        verdict: got === 20 * 640 ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "mic frames duplicated",
  });

  add({
    expected:
      "the next turn is heard in full: stragglers from the previous turn must not poison it",
    name: "mic-straggler-poison",
    run: async (harness) => {
      const call = await harness.open({ script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      // Turn 1: a normal turn, committed.
      await call.speak({ frames: 20 });
      await call.until(
        "commit 1",
        () => call.seen.some((e) => e.type === "voice-agent/turn-committed"),
        20_000,
      );
      // Now the shape of a barge-in: the customer starts talking again while
      // the tail of the previous turn is still in flight. The device numbers
      // the new turn from zero; the stragglers carry the OLD high numbers.
      await call.speak({ commit: false, frames: 0, start: true });
      const stream = call;
      await stream.speak({
        commit: false,
        frames: 20,
        seqBase: 200,
        start: false,
      });
      // …and only then does the real speech of turn 2 arrive.
      await stream.speak({ commit: true, frames: 30, seqBase: 0, start: false });
      await call.until(
        "commit 2",
        () => call.seen.filter((e) => e.type === "voice-agent/turn-committed").length >= 2,
        20_000,
      );
      const committed = call.seen.filter((event) => event.type === "voice-agent/turn-committed");
      evidence.push(`turn-committed: ${JSON.stringify(committed.map((event) => event.payload))}`);
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      evidence.push(`provider mic bytes per turn: ${session.micBytesByTurn.join(",")}`);
      await call.hangUp();
      call.close();
      const secondTurn = session.micBytesByTurn[1] ?? 0;
      const wanted = 30 * 640;
      return {
        evidence,
        observed: `turn 2 spoke 30 frames (${wanted} bytes) after 20 stragglers numbered 200+; the provider was handed ${secondTurn} bytes of it (${(secondTurn / 640).toFixed(0)} frames)`,
        verdict: secondTurn >= wanted ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "stragglers from the previous turn arrive numbered above the new turn's frames",
  });

  add({
    expected: "a commit with no frames is harmless — the provider is asked to answer nothing",
    name: "empty-commit",
    run: async (harness) => {
      const call = await harness.open({ script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.speak({ frames: 0 });
      await sleep(4000);
      const committed = call.seen.filter((event) => event.type === "voice-agent/turn-committed");
      evidence.push(`turn-committed: ${JSON.stringify(committed.map((event) => event.payload))}`);
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      // Then a real turn, to prove the call is still usable.
      await call.speak({ frames: 15 });
      const answered = await call.until(
        "an answer",
        () => call.grok.some((event) => event.type === "response.done"),
        20_000,
      );
      evidence.push(`a real turn afterwards was answered: ${answered}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: answered
          ? "an empty commit produced an empty turn and the call carried on"
          : "an empty commit left the call unable to answer the next real turn",
        verdict: answered ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "a turn committed with no mic frames at all",
  });

  add({
    expected: "a turn start with no commit leaves the call able to take the next turn",
    name: "turn-never-committed",
    run: async (harness) => {
      const call = await harness.open({ script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.speak({ commit: false, frames: 20 });
      await sleep(3000);
      // The customer gives up and starts again.
      await call.speak({ frames: 20 });
      const answered = await call.until(
        "an answer",
        () => call.grok.some((event) => event.type === "response.done"),
        20_000,
      );
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      evidence.push(`provider mic bytes per turn: ${session.micBytesByTurn.join(",")}`);
      evidence.push(`answered: ${answered}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: answered
          ? `the abandoned turn's ${session.micBytesByTurn[0] ?? 0} bytes were folded into the next commit and the call answered`
          : "an abandoned turn left the call unable to answer",
        verdict: answered ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "a turn is started and never committed",
  });

  add({
    expected: "each barge-in raises the answer number so the listener drops the old speech",
    name: "rapid-barge-in",
    run: async (harness) => {
      /*
       * Paced, NOT burst. A provider that ships the whole answer in 100ms is
       * finished before the barge-in lands, and the scenario then proves
       * nothing at all — the first version of this test reported a pass with
       * zero cancels reaching the provider, which is a test that did not run.
       */
      const call = await harness.open({
        query: { answerSeconds: 20, burst: 0 },
        script: "normal",
      });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("count to a hundred");
      await call.until("audio", () => call.spk.length > 0, 20_000);
      for (let index = 0; index < 6; index++) {
        await call.speak({ commit: false, frames: 3 });
        await sleep(400);
      }
      await call.speak({ frames: 10 });
      await sleep(8000);
      evidence.push(...describeSpeaker(call));
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      evidence.push(`provider cancels: ${session.cancels}`);
      const answers = [...new Set(call.spk.map((frame) => frame.answer))].sort((a, b) => a - b);
      // Every answer's frames must be monotonic within that answer.
      const broken: string[] = [];
      for (const answer of answers) {
        const frames = call.spk.filter((frame) => frame.answer === answer).map((f) => f.frame);
        for (let index = 1; index < frames.length; index++) {
          if (frames[index]! <= frames[index - 1]!) {
            broken.push(`answer ${answer}: frame ${frames[index - 1]} then ${frames[index]}`);
            break;
          }
        }
      }
      evidence.push(
        `non-monotonic frame runs: ${broken.length === 0 ? "none" : broken.join("; ")}`,
      );
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: `${answers.length} answer numbers seen (${answers.join(",")}), ${session.cancels} cancels reached the provider, ${broken.length} answers had non-monotonic frame numbering`,
        verdict: broken.length === 0 ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "six barge-ins in four seconds, mid-answer",
  });

  add({
    expected:
      "one ask is outstanding at a time, and each answer is announced against the question it belongs to",
    name: "colleague-two-questions",
    run: async (harness) => {
      const call = await harness.open({
        colleague: true,
        query: { toolCallsPerTurn: 2, toolEveryTurn: 1 },
        script: "tool",
        startPatienceMs: 60_000,
      });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("ask your colleague two things");
      const asked = await call.until(
        "two asks",
        () => call.seen.filter((event) => event.type === "voice-agent/colleague-asked").length >= 2,
        60_000,
      );
      const answered = await call.until(
        "two answers",
        () =>
          call.seen.filter((event) => event.type === "voice-agent/colleague-answered").length >= 2,
        180_000,
      );
      const asks = call.seen
        .filter((event) => event.type === "voice-agent/colleague-asked")
        .map((event) => event.payload);
      const answers = call.seen
        .filter((event) => event.type === "voice-agent/colleague-answered")
        .map((event) => event.payload);
      evidence.push(`asked: ${JSON.stringify(asks)}`);
      evidence.push(`answered: ${JSON.stringify(answers).slice(0, 1200)}`);
      const session = harness.lastSession();
      evidence.push(`tool outputs the bridge returned: ${JSON.stringify(session.toolOutputs)}`);
      evidence.push(
        `conversation items injected into the provider: ${JSON.stringify(session.injected)}`,
      );
      await call.hangUp();
      call.close();
      const texts = session.injected.map((item) => item.text);
      const distinct = new Set(texts.filter((text) => text.startsWith("Your colleague says")));
      const duplicated =
        texts.filter((t) => t.startsWith("Your colleague says")).length > distinct.size;
      return {
        evidence,
        observed: `asks=${asks.length} answers=${answers.length} injected=${texts.length}; identical answers injected for different questions: ${duplicated}`,
        verdict: !asked
          ? ("inconclusive" as const)
          : duplicated || !answered
            ? ("DEFECT" as const)
            : ("pass" as const),
      };
    },
    what: "two ask_colleague calls in flight at once",
  });

  add({
    expected:
      "the call outlives the provider's socket: turns keep being answered, and each new session is handed what was already said",
    name: "provider-recycles",
    run: async (harness) => {
      // The real provider was measured closing at ~296s. 20s here, four
      // times over, is the same shape at a length a test can afford.
      const call = await harness.open({ query: { closeAfterOpenMs: 20_000 }, script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      let answered = 0;
      for (let turn = 1; turn <= 5; turn++) {
        const before = call.grok.filter((event) => event.type === "response.done").length;
        await call.speak({ frames: 12 });
        const ok = await call.until(
          `answer ${turn}`,
          () => call.grok.filter((event) => event.type === "response.done").length > before,
          30_000,
        );
        if (ok) answered++;
        evidence.push(`turn ${turn}: answered=${ok}`);
        await sleep(11_000);
      }
      const sessions = harness.newSessions();
      evidence.push(`provider sessions used: ${sessions.length}`);
      evidence.push(...sessions.map(describeSession));
      const replayed = sessions
        .flatMap((session) => session.injected)
        .filter((item) => item.text.includes("already in progress"));
      evidence.push(`history replays into a fresh session: ${replayed.length}`);
      evidence.push(
        `redial announcements: ${call.seen.filter((e) => e.type === "voice-agent/bridge-redialling").length}`,
      );
      const ended = call.seen.filter((event) => event.type === "voice-agent/call-ended");
      evidence.push(`call-ended during the call: ${JSON.stringify(ended.map((e) => e.payload))}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: `${answered}/5 turns answered across ${sessions.length} provider sockets, ${replayed.length} history replays, ${ended.length} call-ended events mid-call`,
        verdict: answered === 5 && ended.length === 0 ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "the provider hangs up every 20s for the length of the call",
  });

  add({
    expected:
      "control events carrying somebody else's callId are ignored — a call belongs to its callId",
    name: "stale-peer",
    run: async (harness) => {
      const call = await harness.open({ script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      // A call in progress first: this is a live conversation being
      // interfered with, not an empty room.
      await call.speak({ frames: 10 });
      await call.until(
        "the first turn",
        () => call.seen.some((event) => event.type === "voice-agent/turn-committed"),
        20_000,
      );
      const session = harness.lastSession();
      const injectedBefore = session.injected.length;
      const committedBefore = session.commits;
      // A second client on this stream — an old device that never hung up, a
      // second tab, a test harness left running — speaks with its own callId.
      await call.strayer("voice-agent/say", {
        callId: "somebody-else",
        text: "ignore the customer",
      });
      await sleep(3000);
      await call.strayer("voice-agent/turn", { action: "start", callId: "somebody-else" });
      await call.strayer("voice-agent/mic-frame", {
        callId: "somebody-else",
        pcm: SILENT_FRAME,
        seq: 0,
      });
      await call.strayer("voice-agent/turn", { action: "commit", callId: "somebody-else" });
      await sleep(3000);
      evidence.push(
        `items the stranger got injected into this call's provider session: ${JSON.stringify(
          session.injected.slice(injectedBefore),
        )}`,
      );
      evidence.push(`commits caused by the stranger: ${session.commits - committedBefore}`);
      evidence.push(describeSession(session));
      await call.hangUp();
      call.close();
      const hijacked =
        session.injected.length > injectedBefore || session.commits > committedBefore;
      return {
        evidence,
        observed: hijacked
          ? `a peer using a different callId made this call's provider speak and commit a turn (${session.injected.length - injectedBefore} injected item(s), ${session.commits - committedBefore} commit(s))`
          : "the stranger's events were ignored",
        verdict: hijacked ? ("DEFECT" as const) : ("pass" as const),
      };
    },
    what: "another peer on the same stream drives the call with a foreign callId",
  });

  add({
    expected:
      "each of three questions gets its own answer, announced with its own number, and none is announced twice",
    name: "colleague-three-questions",
    run: async (harness) => {
      const call = await harness.open({
        colleague: true,
        query: { toolCallsPerTurn: 3, toolEveryTurn: 1, toolMaxTotal: 3 },
        script: "tool",
        startPatienceMs: 60_000,
      });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("ask your colleague three things");
      const asked = await call.until(
        "three asks",
        () => call.seen.filter((event) => event.type === "voice-agent/colleague-asked").length >= 3,
        60_000,
      );
      const answered = await call.until(
        "three answers",
        () =>
          call.seen.filter((event) => event.type === "voice-agent/colleague-answered").length >= 3,
        300_000,
      );
      const asks = call.seen
        .filter((event) => event.type === "voice-agent/colleague-asked")
        .map((event) => event.payload);
      const answers = call.seen
        .filter((event) => event.type === "voice-agent/colleague-answered")
        .map((event) => event.payload);
      evidence.push(`asked (${asks.length}): ${JSON.stringify(asks)}`);
      evidence.push(`answered (${answers.length}): ${JSON.stringify(answers).slice(0, 2000)}`);
      const session = harness.lastSession();
      evidence.push(
        `tool outputs handed back to the model: ${JSON.stringify(session.toolOutputs.map((output) => output.output))}`,
      );
      const spoken = session.injected.filter((item) => item.text.startsWith("Your colleague"));
      evidence.push(`answers injected into the conversation: ${JSON.stringify(spoken)}`);
      await call.hangUp();
      call.close();
      const bodies = spoken.map((item) =>
        item.text.replace(/^Your colleague says, on question #\d+: /, ""),
      );
      const duplicatedBody = new Set(bodies).size < bodies.length;
      const numbers = spoken
        .map((item) => /question #(\d+)/.exec(item.text)?.[1])
        .filter((number): number is string => number !== undefined);
      const numbered = numbers.length === spoken.length && new Set(numbers).size === numbers.length;
      /*
       * THE PROOF THAT THE CORRELATION IS REAL, not that the strings differ.
       *
       * Serialisation is what makes the platform's order-matching correct, so
       * the observable is that the asks resolved ONE AT A TIME: three asks
       * that all resolve within a few milliseconds of each other are three
       * asks that resolved on the same reply, which is the original defect.
       */
      const spokenAt = spoken.map((item) => item.at);
      const spread = spokenAt.length < 2 ? 0 : Math.max(...spokenAt) - Math.min(...spokenAt);
      const serialised = spoken.length < 2 || spread > 1000;
      /* The colleague's own #n label agreeing is belt and braces. */
      const mislabelled = answers.filter((payload) => payload.mislabelled === true).length;
      const outputsNumbered = session.toolOutputs.filter((output) =>
        /question #\d+/.test(output.output),
      ).length;
      return {
        evidence,
        observed: `asks=${asks.length} answers=${answers.length} injected=${spoken.length} numbered=${numbers.join(",")}; delivered over ${spread}ms (serialised=${serialised}); tool outputs carrying a number: ${outputsNumbered}/${session.toolOutputs.length}; distinct answer bodies: ${!duplicatedBody}; colleague mislabelled its own reply: ${mislabelled}`,
        verdict: !asked
          ? ("inconclusive" as const)
          : answered &&
              serialised &&
              !duplicatedBody &&
              numbered &&
              mislabelled === 0 &&
              outputsNumbered === session.toolOutputs.length
            ? ("pass" as const)
            : ("DEFECT" as const),
      };
    },
    what: "three ask_colleague calls at once — numbering and attribution",
  });

  add({
    expected: "the answer survives a barge-in: it is spoken once the customer stops talking",
    name: "colleague-barge-in",
    run: async (harness) => {
      const call = await harness.open({
        colleague: true,
        query: { answerSeconds: 8, burst: 0, toolEveryTurn: 1, toolMaxTotal: 1 },
        script: "tool",
        startPatienceMs: 60_000,
      });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("ask your colleague something");
      await call.until(
        "the ask",
        () => call.seen.some((event) => event.type === "voice-agent/colleague-asked"),
        60_000,
      );
      // Talk over everything while the colleague thinks, and keep the mic
      // open across the moment the answer lands.
      const answeredAt = call.until(
        "the answer",
        () => call.seen.some((event) => event.type === "voice-agent/colleague-answered"),
        180_000,
      );
      for (let index = 0; index < 20; index++) {
        await call.speak({ commit: false, frames: 3 });
        await sleep(1500);
        if (call.seen.some((event) => event.type === "voice-agent/colleague-answered")) break;
      }
      const gotAnswer = await answeredAt;
      // Now stop talking: the gap the delivery has been waiting for.
      await call.speak({ frames: 5 });
      const session = harness.lastSession();
      const spokenBefore = session.injected.length;
      const delivered = await call.until(
        "the answer spoken",
        () => session.injected.some((item) => item.text.startsWith("Your colleague")),
        90_000,
      );
      evidence.push(`colleague answered: ${gotAnswer}`);
      evidence.push(`answer reached the conversation: ${delivered}`);
      evidence.push(
        `injected since barge-in: ${JSON.stringify(session.injected.slice(spokenBefore))}`,
      );
      evidence.push(describeSession(session));
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: gotAnswer
          ? `the colleague answered during a barge-in storm and the answer ${delivered ? "was" : "was NOT"} delivered to the conversation once the mic closed`
          : "the colleague never answered inside the scenario's patience",
        verdict: !gotAnswer
          ? ("inconclusive" as const)
          : delivered
            ? ("pass" as const)
            : ("DEFECT" as const),
      };
    },
    what: "barge-in repeatedly while the colleague's answer arrives",
  });

  add({
    expected:
      "a long call stays healthy: every turn answered, no unbounded growth, no silent death",
    name: "long-run",
    run: async (harness) => {
      const call = await harness.open({ query: { answerSeconds: 2 }, script: "normal" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      const turns = 60;
      let answered = 0;
      const lateness: number[] = [];
      for (let turn = 1; turn <= turns; turn++) {
        const before = call.grok.filter((event) => event.type === "response.done").length;
        const at = Date.now();
        await call.speak({ frames: 25 });
        const ok = await call.until(
          `answer ${turn}`,
          () => call.grok.filter((event) => event.type === "response.done").length > before,
          25_000,
        );
        if (ok) {
          answered++;
          lateness.push(Date.now() - at);
        } else {
          evidence.push(`turn ${turn} was NOT answered`);
        }
        await sleep(1500);
      }
      const committed = call.seen
        .filter((event) => event.type === "voice-agent/turn-committed")
        .map((event) => event.payload as Record<string, number>);
      const lost = committed.reduce((total, payload) => total + Number(payload.lost ?? 0), 0);
      const late = committed.reduce((total, payload) => total + Number(payload.late ?? 0), 0);
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      evidence.push(`turns answered: ${answered}/${turns}`);
      evidence.push(
        `answer latency ms: first10=${lateness.slice(0, 10).join(",")} last10=${lateness.slice(-10).join(",")}`,
      );
      evidence.push(`accumulated lost=${lost} late=${late} across ${committed.length} commits`);
      evidence.push(`speaker frames total: ${call.spk.length}`);
      evidence.push(
        `provider mic bytes per turn (first 5 / last 5): ${session.micBytesByTurn.slice(0, 5).join(",")} … ${session.micBytesByTurn.slice(-5).join(",")}`,
      );
      const ended = call.seen.filter((event) => event.type === "voice-agent/call-ended");
      evidence.push(`call-ended mid-run: ${JSON.stringify(ended.map((event) => event.payload))}`);
      await call.hangUp();
      call.close();
      const firstHalf = lateness.slice(0, Math.floor(lateness.length / 2));
      const lastHalf = lateness.slice(Math.floor(lateness.length / 2));
      const mean = (values: number[]) =>
        values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      return {
        evidence,
        observed: `${answered}/${turns} turns answered; mean answer latency ${mean(firstHalf)}ms early vs ${mean(lastHalf)}ms late; ${lost} mic frames lost, ${late} late; ${ended.length} call-ended mid-run`,
        verdict: answered === turns && ended.length === 0 ? ("pass" as const) : ("DEFECT" as const),
      };
    },
    what: "sixty turns back to back on one call",
  });

  add({
    expected:
      "the customer is told something. Silence with no timeout is indistinguishable from a dead call",
    name: "no-answer-to-commit",
    run: async (harness) => {
      const call = await harness.open({ script: "no-answer" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.speak({ frames: 25 });
      /*
       * NOT `call.grok.length > 0`: the commit acknowledgement is a forwarded
       * provider event, so that condition is true the moment the turn is
       * committed and the scenario reported "the provider did answer" for a
       * provider that had answered nothing.
       */
      const answered = await call.until(
        "an actual answer",
        () =>
          call.spk.length > 0 ||
          call.grok.some(
            (event) => event.type === "response.created" || event.type === "response.done",
          ),
        30_000,
      );
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      evidence.push(
        `turn-committed: ${JSON.stringify(call.seen.filter((e) => e.type === "voice-agent/turn-committed").map((e) => e.payload))}`,
      );
      evidence.push(`anything from the provider in 30s: ${answered}`);
      evidence.push(
        `call-ended: ${JSON.stringify(call.seen.filter((e) => e.type === "voice-agent/call-ended").map((e) => e.payload))}`,
      );
      // Is the call still usable if the provider starts behaving again?
      const pongs = call.seen.filter((event) => event.type === "voice-agent/pong").length;
      evidence.push(`pongs (the bridge's proof of life): ${pongs}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: answered
          ? "the provider did answer, so the scenario did not test what it claims"
          : `the provider swallowed a 25-frame turn (${session.micBytesByTurn[0] ?? 0} bytes committed) and said nothing for 30s; the bridge has no per-turn deadline, so nothing is ever appended to say so`,
        verdict: answered ? ("inconclusive" as const) : ("DEFECT" as const),
      };
    },
    what: "provider accepts the commit and never answers it",
  });

  add({
    expected:
      "an answer that starts and never finishes is noticed; a listener stuck mid-answer is told",
    name: "created-then-nothing",
    run: async (harness) => {
      const call = await harness.open({ script: "created-then-nothing" });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.speak({ frames: 20 });
      const created = await call.until(
        "response.created",
        () => call.grok.some((event) => event.type === "response.created"),
        25_000,
      );
      await sleep(12_000);
      const done = call.grok.some((event) => event.type === "response.done");
      evidence.push(`response.created seen: ${created}, response.done seen: ${done}`);
      evidence.push(`speaker frames: ${call.spk.length}`);
      // Can the customer get out of it by talking again?
      const before = call.grok.filter((event) => event.type === "response.created").length;
      await call.speak({ frames: 20 });
      const recovered = await call.until(
        "a second response.created",
        () => call.grok.filter((event) => event.type === "response.created").length > before,
        25_000,
      );
      evidence.push(`a new turn started a new answer: ${recovered}`);
      const session = harness.lastSession();
      evidence.push(describeSession(session));
      evidence.push(`provider cancels: ${session.cancels}`);
      await call.hangUp();
      call.close();
      return {
        evidence,
        observed: created
          ? `the answer started and never finished (0 audio, no response.done); the customer's next turn ${recovered ? "did" : "did NOT"} start a fresh answer${session.cancels > 0 ? ` and cancelled the wedged one` : ""}`
          : "the provider never even started an answer",
        verdict: !created
          ? ("inconclusive" as const)
          : recovered
            ? ("pass" as const)
            : ("DEFECT" as const),
      };
    },
    what: "provider sends response.created and then nothing",
  });

  add({
    expected:
      "a stray second message from the colleague is not read out as the answer to the next question",
    name: "colleague-answers-twice",
    run: async (harness) => {
      /*
       * The residual hazard of serialising asks, driven directly: serialising
       * makes "the agent's NEXT message" the right answer, so an agent that
       * sends a SECOND message for a question it has already answered can
       * still be picked up by the following ask. The stray is appended to the
       * colleague's own stream as the very event `ask()` waits for, so this
       * tests the mechanism rather than hoping a model misbehaves.
       */
      const call = await harness.open({
        colleague: true,
        query: { toolCallsPerTurn: 2, toolEveryTurn: 1, toolMaxTotal: 2 },
        script: "tool",
        startPatienceMs: 60_000,
      });
      const evidence = [`startCall: ${JSON.stringify(call.started)} in ${call.startMs}ms`];
      await call.say("ask your colleague two things");
      const asked = await call.until(
        "two asks",
        () => call.seen.filter((event) => event.type === "voice-agent/colleague-asked").length >= 2,
        60_000,
      );
      const first = await call.until(
        "the first answer",
        () => call.seen.some((event) => event.type === "voice-agent/colleague-answered"),
        180_000,
      );
      // Question 2's ask is now in flight. Have the colleague "say something
      // else" — a second message for question 1, arriving too late.
      await sleep(1500);
      const stray = "IGNORE ME — a stray second message about question one.";
      await call.strayColleague(stray);
      const second = await call.until(
        "the second answer",
        () =>
          call.seen.filter((event) => event.type === "voice-agent/colleague-answered").length >= 2,
        180_000,
      );
      const answers = call.seen
        .filter((event) => event.type === "voice-agent/colleague-answered")
        .map((event) => event.payload);
      evidence.push(`answered: ${JSON.stringify(answers)}`);
      const session = harness.lastSession();
      const spoken = session.injected.filter((item) => item.text.startsWith("Your colleague"));
      evidence.push(`injected: ${JSON.stringify(spoken)}`);
      await call.hangUp();
      call.close();
      const misdelivered = answers.some(
        (payload) => typeof payload.answer === "string" && payload.answer.includes("IGNORE ME"),
      );
      /*
       * The defect is not that the stray was picked up — serialisation cannot
       * prevent that, and no correlation the platform offers can either. The
       * defect is the bridge ASSERTING a question number for it. So the test
       * is on what the voice was told: a stray must arrive with no "on
       * question #n" clause at all.
       */
      const falselyNumbered = spoken.some(
        (item) => item.text.includes("IGNORE ME") && /on question #\d+/.test(item.text),
      );
      const flagged = answers.some(
        (payload) => payload.mislabelled === true || payload.unlabelled === true,
      );
      return {
        evidence,
        observed:
          !asked || !first
            ? "the colleague never got as far as answering"
            : !misdelivered
              ? `the stray was never attributed to a question at all (second answer arrived: ${second})`
              : falselyNumbered
                ? `a stray second message was read out AS "on question #${answers.find((p) => String(p.answer).includes("IGNORE ME"))?.question}" — a number the bridge could not vouch for`
                : `the stray was picked up (serialisation cannot prevent that) but delivered with NO question number, and flagged on the stream (${flagged ? "unlabelled/mislabelled set" : "NOT flagged"})`,
        verdict:
          !asked || !first
            ? ("inconclusive" as const)
            : falselyNumbered || (misdelivered && !flagged)
              ? ("DEFECT" as const)
              : ("pass" as const),
      };
    },
    what: "the colleague sends a second message for a question it already answered",
  });

  return scenarios;
}
