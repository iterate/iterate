// Prove the device's whole capability surface through a REAL DEPLOYED AGENT.
//
// Every other device script in this directory calls `itx.kit.waveshare.*`
// itself. That proves the DEVICE works and proves nothing about the thing we
// actually ship: a model, running server-side, that has to DISCOVER the mount
// from its own description and then write code that calls it. Those are
// different claims, and only the second one is what a user gets. So every case
// here goes through `itx.agents.get(path).ask()` — a real turn on a real agent
// stream — and the evidence is the agent's own journal: the script it chose to
// run, what the device answered, and what it then said to the user.
//
// The harness never trusts the agent's prose. Everything the agent reports is
// checked again with a DIRECT capability call from this process, because a
// model narrating a success it did not have is the exact failure this is
// supposed to catch.
//
//   doppler run --config preview_3 -- pnpm cli voicelab prove \
//     --project prj_… --agent-path /agents/voice/dev-… --out /tmp/prove.json
//
// The agent path is the VOICE conversation's path: the voice agent and the
// back office are one agent at the device's own stream path, so the path
// changes every time a new conversation starts. That is why it is a required
// flag with no default — a hardcoded one would quietly prove something about
// an agent nobody is talking to.
//
// `restart` is disruptive and sits behind --include-restart (default false).
import fs from "node:fs";
import process from "node:process";
import type { DynamicWorkerCapability } from "iterate/sdk";

import { connectProject, resolveVoicelabBaseUrl, type VoicelabConnectOptions } from "./connect.ts";
import {
  baselineJpegProblems,
  DEVICE_IMAGE_LIMITS,
  startSlowImageFixture,
  type SlowImageFixture,
} from "./slow-image-fixture.ts";
import { voiceAgentEntrypointRef } from "./voice-agent-ref.ts";

/** Options for `pnpm cli voicelab prove`. */
export interface ProveOptions extends VoicelabConnectOptions {
  /**
   * The agent that must do the discovering and calling.
   *
   * A parameter and never a default, because the agent identity is per-voice
   * conversation: hardcoding one would make this harness quietly prove
   * something about an agent nobody is using any more.
   */
  agentPath: string;
  /** Capability the device mounts itself under (itx.kit.<name>). */
  name?: string;
  /** Where to write the evidence JSON. */
  out?: string;
  /** Run only these case ids (comma-separated). Everything else is skipped. */
  only?: string;
  /**
   * Reboot the device as the last case.
   *
   * Off by default: a reboot drops whatever call is live and costs ~20s, so it
   * is never something a coverage run should decide to do on its own.
   */
  includeRestart?: boolean;
  /**
   * The conversation stream to watch across a restart.
   *
   * The device remembers its conversation path in NVS and logs `resuming
   * remembered conversation` on boot — but serial is out of scope here, so the
   * host-visible form of that claim is telemetry reappearing on the SAME
   * stream path after the reboot. Without this, the restart case proves the
   * remount only and says so.
   */
  restartStreamPath?: string;
  /** How long to give one agent turn. */
  askTimeoutMs?: number;
  /** Speaker volume to leave behind. The firmware's own boot value is 85. */
  restoreVolume?: number;
  /**
   * Mic gain in dB to leave behind.
   *
   * The device has no getter for it, so the value in place before a run is
   * unknowable and "restore" can only mean "set to a value somebody chose".
   * 24 dB is that value; pass another if the board is mid-experiment.
   */
  restoreMicGain?: number;
  /** Background to leave behind. The firmware's own boot value is #101820. */
  restoreBackground?: string;
  /** A BASELINE JPEG small enough for the 368x448 panel. */
  baselineJpegUrl?: string;
  /** A second small baseline JPEG, for the two-at-once case. */
  otherBaselineJpegUrl?: string;
  /** A PNG — must be refused. */
  pngUrl?: string;
  /** A progressive JPEG — must be refused. */
  progressiveJpegUrl?: string;
  /** A baseline JPEG bigger than the panel — must be refused. */
  oversizeJpegUrl?: string;
  /** A URL whose body never finishes arriving — must time out. */
  stallingUrl?: string;
}

/**
 * The 15 methods the firmware's dispatch table registers.
 *
 * Written down so the run can report a DIFFERENCE, never as the source of
 * truth: the surface is read from the live mount and the live device, and this
 * list is only the thing those readings are compared against.
 */
const EXPECTED_METHODS = [
  "health",
  "restart",
  "setBackground",
  "conversation.start",
  "conversation.hangUp",
  "pushToTalk.start",
  "pushToTalk.stop",
  "takeScreenshot",
  "readScreenshotChunk",
  "setVolume",
  "setMicGain",
  "recording.status",
  "recording.size",
  "recording.read",
  "showImage",
] as const;

/**
 * Names that must NOT resolve.
 *
 * The shared capability layer other Iterate devices use registers
 * `interruptPlayback`; this device deliberately does not, and tells the model
 * to use `pushToTalk.start()` to cut an answer short instead. A run that finds
 * one of these working has found a bug, so the absence is asserted rather than
 * assumed.
 */
const MUST_NOT_EXIST = ["interruptPlayback", "interrupt", "conversation.interrupt"] as const;

/** The device's capability surface, as this harness calls it. */
interface DeviceCapability {
  health(): Promise<Record<string, unknown>>;
  restart(): Promise<unknown>;
  setBackground(colour: string): Promise<unknown>;
  setVolume(percent: number): Promise<unknown>;
  setMicGain(db: number): Promise<unknown>;
  showImage(url: string, seconds: number): Promise<unknown>;
  takeScreenshot(): Promise<{
    width: number;
    height: number;
    bytes: number;
    chunks: number;
    chunkSize?: number;
    format?: string;
  }>;
  readScreenshotChunk(index: number): Promise<ArrayBuffer>;
  conversation: { start(): Promise<unknown>; hangUp(): Promise<unknown> };
  pushToTalk: { start(): Promise<unknown>; stop(): Promise<unknown> };
  recording: {
    status(): Promise<Record<string, unknown>>;
    size(name?: string): Promise<number>;
    read(name?: string, offset?: number): Promise<ArrayBuffer>;
  };
  __describe(): Promise<{ instructions: string; types: string; children: Record<string, string> }>;
}

/**
 * One capability-host script the agent chose to run inside a turn.
 *
 * `code` is the load-bearing evidence: it is what the MODEL decided to call,
 * so a case only counts as proven through the agent when this text names the
 * method under test. Everything else in a turn is narration.
 */
interface AgentScriptRun {
  executionId: string;
  /** Offset of the `script-run-requested` row, so the journal can be reread. */
  requestedAtOffset: number;
  /** Offset of the matching `script-run-settled` row, when it arrived. */
  settledAtOffset: number | null;
  code: string;
  /** `{ status, result }` or `{ status, error }`, verbatim from the journal. */
  settlement: unknown;
}

/**
 * Everything one `ask()` produced, addressed by stream offset.
 *
 * Offsets rather than only copies, because the point of evidence is that
 * somebody else can read the same rows on the same stream; a payload pasted
 * into a report proves only that this harness said so.
 */
interface AgentTurn {
  prompt: string;
  /** Head offset captured BEFORE asking — the anchor every read starts from. */
  beforeOffset: number;
  afterOffset: number;
  ms: number;
  scriptRuns: AgentScriptRun[];
  finalMessage: string | null;
  finalMessageOffset: number | null;
  /** Set when `ask()` itself failed or timed out; the turn still has evidence. */
  error: string | null;
  /** How long this turn waited for settlements that trailed the answer. */
  settlementWaitMs: number;
  /** Runs whose settlement never arrived. Any entry here fails the case. */
  unsettled: string[];
}

/**
 * What the panel is showing, read back through the screenshot path.
 *
 * A dominant colour and not a hash: the device redraws status text constantly,
 * so two screenshots of one screen never match byte for byte, and only the
 * large flat areas are stable enough to assert on.
 */
interface PanelReading {
  width: number;
  height: number;
  bytes: number;
  chunks: number;
  /** Bytes actually reassembled from chunks; must equal `bytes`. */
  bytesRead: number;
  dominant: { rgb565: number; r: number; g: number; b: number; share: number };
  /** How many distinct colours are on screen — a flat fill has very few. */
  distinct: number;
}

/**
 * The verdict vocabulary.
 *
 * `refused-as-expected` is deliberately not a kind of success: a boundary case
 * that "passes" has produced an ERROR, and collapsing the two would let a tool
 * that only ever errors read as covered.
 */
type Verdict = "proven" | "refused-as-expected" | "failed" | "skipped";

/** One case's result: what the agent did, what the device independently said. */
interface ProofCaseResult {
  id: string;
  /** Which of the 15 methods this case is evidence for. */
  methods: string[];
  kind: "tool" | "boundary" | "bounded-error";
  verdict: Verdict;
  /** Why the verdict is what it is, in one line. */
  detail: string;
  agent: AgentTurn | null;
  /** The same claim, re-established with a direct call from this process. */
  independent: unknown;
}

/**
 * Absent methods that a text presents as CALLABLE.
 *
 * The distinction this draws is the whole point. A brief that says
 *
 *   "There is NO interrupt or interruptPlayback method here: to cut an answer
 *    short, call pushToTalk.start(), which cancels whatever is playing"
 *
 * is doing the model a service: given a device that plays audio and has no
 * interrupt, a model WILL guess `interrupt`, and naming it in order to refuse it
 * is the only thing that heads that off. A brief that says "call interrupt(0)"
 * is a bug that will produce a failed tool call on every barge-in.
 *
 * A bare substring check cannot tell those apart, and it also trips over
 * ordinary English — "the user can interrupt at any time" is prose about
 * interrupting, not a claim about a method. So what counts is INVOCATION FORM:
 * the name called with an argument list, or reached through a member access.
 * `interruptPlayback` is caught anywhere it appears, because a camelCase
 * identifier is never a word in a sentence.
 */
export function absentMethodCalls(text: string, absent: readonly string[]): string[] {
  return absent.filter((name) => {
    const escaped = name.replace(/\./g, "\\.");
    /* Called: `interrupt(`, `interruptPlayback ()`. */
    if (new RegExp(`\\b${escaped}\\s*\\(`).test(text)) return true;
    /*
     * A DOTTED name is already a member reference — `conversation.interrupt` in
     * a list of methods claims the method exists whether or not the parentheses
     * are shown. A BARE name needs the dot to be one: `.interrupt` is a
     * reference, while "no interrupt method" is a sentence.
     */
    if (name.includes(".")) return new RegExp(`\\b${escaped}\\b`).test(text);
    return new RegExp(`\\.${escaped}\\b`).test(text);
    /*
     * There is deliberately no "camelCase is always an identifier" rule. It
     * reads well and it is wrong: the deployed brief says "There is NO interrupt
     * or interruptPlayback method here", where the camelCase name is prose
     * inside a denial, and that rule failed the very sentence that stops a model
     * inventing the method.
     */
  });
}

/** A case the run is allowed to skip without failing (opt-in or unreachable). */
interface ProofCase {
  id: string;
  methods: string[];
  kind: "tool" | "boundary" | "bounded-error";
  optional?: boolean;
  run(): Promise<Omit<ProofCaseResult, "id" | "methods" | "kind">>;
}

export async function prove(options: ProveOptions) {
  const agentPath = options.agentPath?.trim();
  if (!agentPath) {
    throw new Error(
      "--agent-path is required. The agent identity is per-conversation, so " +
        "this harness will not guess one; pass the path of the agent that is " +
        "supposed to be able to drive the device.",
    );
  }
  const capabilityName = options.name ?? "waveshare";
  const mountPath = `kit.${capabilityName}`;
  const askTimeoutMs = options.askTimeoutMs ?? 150_000;
  const only = options.only
    ? new Set(
        options.only
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      )
    : null;
  const images = {
    baseline: options.baselineJpegUrl ?? "https://placehold.co/200x200.jpg",
    other: options.otherBaselineJpegUrl ?? "https://placehold.co/210x210.jpg",
    oversize: options.oversizeJpegUrl ?? "https://placehold.co/800x900.jpg",
    png: options.pngUrl ?? "https://httpbin.org/image/png",
    progressive: options.progressiveJpegUrl ?? "https://picsum.photos/200/200.jpg",
    /* Filled in from the local fixture below unless --stalling-url was given. */
    stalling: options.stallingUrl ?? "",
  };

  /*
   * ---- THE SLOW-IMAGE FIXTURE, VERIFIED BEFORE IT IS TRUSTED --------------
   *
   * The timeout case used to point at `httpbin.org/drip?...&numbytes=400000`
   * and failed because the device refused it in 849ms as "too-large": 400,000
   * bytes is past MAX_BODY_BYTES, so the size gate answered before anything
   * could be slow. The case was testing a gate it was not written for, and the
   * failure read like a device fault.
   *
   * So the endpoint is ours, and it is checked here rather than assumed: the
   * bytes must be a baseline JPEG under the device's cap, the fast path must
   * return them intact, and the slow path must still be unfinished after the
   * device's own deadline has passed. Only then can "timeout" mean what the case
   * says it means.
   */
  let fixture: SlowImageFixture | null = null;
  const fixtureChecks: string[] = [];
  if (options.stallingUrl === undefined) {
    const source = await fetch(options.baselineJpegUrl ?? "https://placehold.co/200x200.jpg");
    const bytes = new Uint8Array(await source.arrayBuffer());
    fixture = await startSlowImageFixture(bytes);
    const problems = baselineJpegProblems(bytes);
    if (problems.length > 0) fixtureChecks.push(...problems);

    /* The fast path must hand back exactly what it was given. */
    const fast = await fetch(fixture.fastUrl);
    const served = new Uint8Array(await fast.arrayBuffer());
    if (served.length !== bytes.length) {
      fixtureChecks.push(
        `the fixture served ${served.length} bytes where the image is ${bytes.length}`,
      );
    }

    /* And the slow path must NOT be finished by the time the device gives up. */
    const slowStartedAt = Date.now();
    const probeDeadline = DEVICE_IMAGE_LIMITS.deadlineMs + 3_000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), probeDeadline);
    let slowFinishedMs: number | null = null;
    try {
      const slow = await fetch(fixture.slowUrl, { signal: abort.signal });
      await slow.arrayBuffer();
      slowFinishedMs = Date.now() - slowStartedAt;
    } catch {
      /* Aborted, which is the point: it was still stalling. */
    } finally {
      clearTimeout(timer);
    }
    if (slowFinishedMs !== null) {
      fixtureChecks.push(
        `the fixture's slow path finished in ${slowFinishedMs}ms, inside the device's ` +
          `${DEVICE_IMAGE_LIMITS.deadlineMs}ms deadline — it would not time out`,
      );
    }
    /*
     * Every image case now points at bytes we serve. The internet cost this
     * proof two runs: `httpbin.org/drip` refused as "too-large" where the case
     * wanted "timeout", and `httpbin.org/image/png` answered "http-error" where
     * it wanted "unsupported-format". Both read as device faults and neither was.
     */
    images.stalling = fixture.slowUrl;
    images.baseline = fixture.fastUrl;
    images.other = fixture.otherUrl;
    images.png = fixture.pngUrl;
    images.progressive = fixture.progressiveUrl;
    images.oversize = fixture.oversizeUrl;
  }

  const baseUrl = resolveVoicelabBaseUrl(options);
  using itx = await connectProject(options);
  const kit = (itx as unknown as { kit: Record<string, DeviceCapability> }).kit;
  const device = kit[capabilityName];
  if (!device) throw new Error(`no device capability named ${capabilityName}`);

  const say = (line: string) => console.error(line);
  say(`prove: ${baseUrl} project=${options.project} agent=${agentPath} mount=${mountPath}`);

  /**
   * The brief this run installed, named by setup so it can be read back by
   * idempotencyKey — a point read, not a search through the stream's history.
   */
  let installedBriefKey = "";
  let installedSetupId = "";

  /*
   * ---- SETUP FIRST, AND PROVE IT WORKED ----------------------------------
   *
   * Two reasons this runs before anything touches the device.
   *
   * The prompt this whole harness is testing is installed HERE: setup derives
   * the capability brief from the project's live `__describe` and appends it to
   * this agent's stream. A proof that read the inventory without refreshing the
   * brief would be checking the device against whatever prompt a previous run
   * happened to leave behind.
   *
   * And setup returns only once the processor for this exact stream has
   * acknowledged a warm-up token carrying that exact brief, so `warm.ok` is the
   * one assertion that says "this agent can hold a call" rather than "this agent
   * exists". Asserted, not printed: the first call after a cold start took 16.2s
   * to go live, and every case after it would have been measuring that.
   */
  {
    using agent = itx.workers.get(voiceAgentEntrypointRef) as unknown as DynamicWorkerCapability<{
      setupVoiceAgent(input: { streamPath: string }): Promise<{
        created: string[];
        alreadyThere: string[];
        warm: {
          ok: boolean;
          ms: number;
          acknowledged: boolean;
          briefMatched: boolean;
          bridgeWarmed: boolean;
          bridgeWarmMs?: number;
          protocolRevision?: string;
          expectedBriefKey: string;
          expectedSetupId: string;
          seenBriefKey?: string;
          seenSetupId?: string;
          error?: string;
        };
      }>;
    }>;
    const setup = await agent.setupVoiceAgent({ streamPath: agentPath });
    const warm = setup.warm;
    installedBriefKey = warm.expectedBriefKey;
    installedSetupId = warm.expectedSetupId;
    say(
      `setup: ${setup.created.length} created, ${setup.alreadyThere.length} already there; ` +
        `warm ok=${String(warm.ok)} in ${warm.ms}ms ` +
        `(brief ${warm.seenBriefKey ?? "none"} vs ${warm.expectedBriefKey}, ` +
        `bridge ${warm.bridgeWarmed ? `${String(warm.bridgeWarmMs)}ms` : "NOT WARMED"}, ` +
        `protocol ${warm.protocolRevision ?? "none"})`,
    );
    if (!warm.ok) {
      throw new Error(
        `prove: setupVoiceAgent returned without a warm agent for ${agentPath} — ` +
          `acknowledged=${String(warm.acknowledged)} briefMatched=${String(warm.briefMatched)} ` +
          `bridgeWarmed=${String(warm.bridgeWarmed)}${warm.error ? ` lastError=${warm.error}` : ""}. ` +
          `Every case below would be measuring a cold start.`,
      );
    }
  }

  // ---------------------------------------------------------------- inventory
  const inventory = await readInventory(itx, device, mountPath, agentPath);
  say(
    `inventory: mount type=${inventory.mount?.type ?? "MISSING"} ` +
      `scope=${inventory.mount?.scope ?? "-"} providedAtOffset=${inventory.mount?.providedAtOffset ?? "-"}`,
  );
  say(
    `inventory: advertised ${inventory.advertised.length}/15, ` +
      `present ${inventory.present.length}, ` +
      `advertised-but-absent [${inventory.advertisedButAbsent.join(", ") || "none"}], ` +
      `present-but-unadvertised [${inventory.presentButUnadvertised.join(", ") || "none"}]`,
  );
  for (const surprise of inventory.shouldNotExistButDoes) {
    say(`inventory: BUG — ${surprise} resolves on this device and must not`);
  }
  const agentSeesMount = inventory.agentScopeCapabilities.some(
    (entry) => entry.path.join(".") === mountPath,
  );
  say(
    `inventory: agent scope ${agentPath} ${agentSeesMount ? "sees" : "DOES NOT SEE"} ${mountPath}`,
  );

  /*
   * THE AGENT'S RESULT HAS TO COME BACK, or there is nothing to compare.
   *
   * A script that calls the device and returns nothing succeeds, and its
   * settlement carries `{status: "succeeded"}` with no `result` — measured, on
   * four consecutive cases whose devices had done exactly what was asked while
   * the agent reported `null`. The device working is not evidence that the AGENT
   * drove it: side effects prove the wire, not the tool call.
   *
   * The health case passed only because its prompt happened to demand exact
   * values, which made the agent return them (settlement at offset 290477
   * carries the whole health payload). Saying so once, for every case, is what
   * makes that the rule instead of a happy accident.
   */
  const RETURN_RULE =
    "When you run code against the device, RETURN the exact value the device replied with — " +
    "the whole reply object, not a summary and not a sentence about it — so the run's own " +
    "result carries it. Do not guess or reconstruct any number.";
  const ask = (prompt: string) =>
    askAgent(itx, agentPath, `${prompt}\n\n${RETURN_RULE}`, askTimeoutMs);

  // The device answering at all decides whether the tool cases can mean
  // anything; an offline device turns every one of them into a test of the
  // error path, and pretending otherwise is how a red run reads green.
  const liveness = await attempt(() => device.health());
  const deviceOnline = liveness.ok;
  say(
    deviceOnline
      ? `device: online (uptime ${String((liveness.value as Record<string, unknown>).uptimeMs)}ms)`
      : `device: OFFLINE — ${liveness.error}`,
  );

  const cases: ProofCase[] = [];

  /*
   * ---- THE PROMPT IS THE DEVICE'S OWN INVENTORY, ON THIS AGENT'S STREAM ----
   *
   * Everything below tests whether the agent can DRIVE the device. This case
   * tests the thing that makes those possible: that `setupVoiceAgent` derived
   * the brief from the project's live `__describe` and appended it to the same
   * `/agents/voice/<id>` stream the calls ride on — not to a fixed colleague
   * agent, and not from a description written before the device last changed.
   *
   * Read by idempotencyKey, which is a point read: setup names the brief it
   * installed, so nothing here searches history. That matters because searching
   * for it is precisely what could not be done exactly — a filtered stream read
   * only pages FORWARD, so every attempt to find "the newest brief" was a guess
   * about how far back to look, and one of those guesses failed a ten-session
   * run in its third session.
   *
   * The assertion is two-directional. Every method the device advertises must
   * appear in the brief, or the model has not been told about a capability it
   * has; and no method the device does NOT have may appear, or the model will
   * call something that does not exist. The second half is not hypothetical: a
   * diagnostic-only tool was removed from the firmware and an earlier brief went
   * on advertising it.
   */
  cases.push({
    id: "setup-injects-the-advertised-inventory",
    kind: "boundary",
    methods: [...inventory.advertised],
    async run() {
      const brief = await attempt(() =>
        itx.streams.get(agentPath).getEvent({ idempotencyKey: installedBriefKey }),
      );
      if (!brief.ok || brief.value === undefined) {
        return {
          agent: null,
          detail: `the brief ${installedBriefKey} setup installed is not on ${agentPath}: ${brief.ok ? "no such event" : brief.error}`,
          independent: { briefKey: installedBriefKey, found: false },
          verdict: "fail" as Verdict,
        };
      }
      const event = brief.value as { payload?: { key?: string; content?: string } };
      const content = event.payload?.content ?? "";
      const slot = event.payload?.key ?? "";
      const missing = inventory.advertised.filter((method) => !content.includes(method));
      /* And the semantics a model needs, not only the method names. */
      const topicProblems = briefContentProblems(content);
      /* Invocation form only — see absentMethodCalls for why a denial passes. */
      const ghosts = absentMethodCalls(content, MUST_NOT_EXIST);
      const ok =
        missing.length === 0 &&
        ghosts.length === 0 &&
        topicProblems.length === 0 &&
        content.length > 0;
      return {
        agent: null,
        detail: ok
          ? `the brief on ${agentPath} names all ${inventory.advertised.length} advertised ` +
            `method(s), covers ${REQUIRED_BRIEF_TOPICS.length} required topics (call control, ` +
            `timed image display, metrics, recording, screenshot, device controls with ranges, ` +
            `push-to-talk as the barge-in, and an explicit denial of interrupt), and presents ` +
            `none of [${MUST_NOT_EXIST.join(", ")}] as callable (${content.length} chars, ` +
            `slot "${slot}", setup ${installedSetupId})`
          : `the brief on ${agentPath} is wrong: missing method(s) [${missing.join(", ") || "none"}], ` +
            `presents as callable [${ghosts.join(", ") || "none"}]` +
            `${topicProblems.length > 0 ? `; ${topicProblems.join("; ")}` : ""}, ` +
            `${content.length} chars`,
        independent: {
          advertised: inventory.advertised,
          briefKey: installedBriefKey,
          contentChars: content.length,
          ghosts,
          missing,
          setupId: installedSetupId,
          slot,
          streamPath: agentPath,
        },
        verdict: (ok ? "pass" : "fail") as Verdict,
      };
    },
  });

  // ------------------------------------------------------------------- health
  cases.push({
    id: "health",
    kind: "tool",
    methods: ["health"],
    async run() {
      const agent = await ask(
        `Use the ${mountPath} device capability. Call health() once and reply with the ` +
          `exact values of uptimeMs, connectionState and resetReason. Do not guess any number.`,
      );
      const direct = (await device.health()) as Record<string, number>;
      const reported = firstSucceededResult(agent, "health(");
      const reportedUptime = reportedNumber(agent, "uptimeMs");
      // uptimeMs only ever goes up while the device stays booted, so the
      // direct read must not be BEHIND what the agent was told. A smaller
      // number means the agent read a different (or invented) device.
      const monotonic = reportedUptime !== null && direct.uptimeMs! >= reportedUptime;
      return verdictFor({
        agent,
        detail: monotonic
          ? `agent read uptimeMs=${reportedUptime}, direct read ${direct.uptimeMs} (>=, same boot)`
          : `agent-reported uptimeMs (${reportedUptime}) is not consistent with the direct read (${direct.uptimeMs})`,
        independent: {
          uptimeMs: direct.uptimeMs,
          connectionState: direct.connectionState,
          resetReason: direct.resetReason,
        },
        ok: monotonic,
        want: "proven",
      });
    },
  });

  // ------------------------------------------- takeScreenshot + readChunk
  cases.push({
    id: "screenshot",
    kind: "tool",
    methods: ["takeScreenshot", "readScreenshotChunk"],
    async run() {
      const agent = await ask(
        `Use the ${mountPath} device capability. Call takeScreenshot(), then read EVERY chunk ` +
          `with readScreenshotChunk(i) and reply with width, height, bytes, chunks, and the ` +
          `total number of bytes you actually read back.`,
      );
      const reported = firstSucceededResult(agent, "readScreenshotChunk(");
      // Read the panel again ourselves. takeScreenshot is a latch the next
      // readScreenshotChunk reads from, so this must not interleave with the
      // agent's reads — hence after the turn has fully settled.
      const panel = await readPanel(device);
      const shapeMatches =
        reportedNumber(agent, "width") === panel.width &&
        reportedNumber(agent, "height") === panel.height &&
        reportedNumber(agent, "chunks") === panel.chunks;
      const reassembled = panel.bytesRead === panel.bytes;
      return verdictFor({
        agent,
        detail: shapeMatches
          ? `agent and direct read agree: ${panel.width}x${panel.height}, ${panel.chunks} chunks, ` +
            `${panel.bytesRead}/${panel.bytes} bytes reassembled`
          : `agent-reported geometry (${reportedNumber(agent, "width")}x${reportedNumber(agent, "height")}, ` +
            `${reportedNumber(agent, "chunks")} chunks) does not match the direct read ` +
            `(${panel.width}x${panel.height}, ${panel.chunks} chunks)`,
        independent: panel,
        ok: shapeMatches && reassembled,
        want: "proven",
      });
    },
  });

  // ------------------------------------------------------------ setBackground
  cases.push({
    id: "set-background",
    kind: "tool",
    methods: ["setBackground"],
    async run() {
      const target = "#7f0000";
      const targetRgb = { b: 0x00, g: 0x00, r: 0x7f };
      /*
       * A CONTRASTING BASELINE, ESTABLISHED AND VERIFIED.
       *
       * Navy is as far from the target as this panel gets without being black,
       * which the firmware also uses as its default — a baseline that could be
       * confused with "nothing happened" is no baseline. Set directly, because
       * this is the case's precondition and not its evidence: the agent's turn
       * below is still the only thing that writes the target, and its own
       * returned value is still required.
       */
      const baseline = "#00007f";
      const baselineRgb = { b: 0x7f, g: 0x00, r: 0x00 };
      await attempt(() => device.setBackground(baseline));
      await sleep(1500);
      const before = await readPanel(device);
      const baselineVerified = colourDistance(before.dominant, baselineRgb) <= 28;

      const agent = await ask(
        `Use the ${mountPath} device capability. The background is currently ${baseline}. Call ` +
          `setBackground("${target}") to change it, then confirm what the call returned.`,
      );
      await sleep(1500);
      const after = await readPanel(device);
      // The device draws its own status text over the fill, so assert on the
      // dominant colour and not on the whole frame.
      const near = colourDistance(after.dominant, targetRgb) <= 28;
      const problems = transitionProblems({
        agentReported: firstSucceededResult(agent, "setBackground("),
        baseline,
        baselineDiffersFromTarget:
          Math.max(
            Math.abs(baselineRgb.r - targetRgb.r),
            Math.abs(baselineRgb.g - targetRgb.g),
            Math.abs(baselineRgb.b - targetRgb.b),
          ) > 28,
        baselineVerified,
        endedAtTarget: near,
        target,
      });
      return verdictFor({
        agent,
        detail:
          problems.length === 0
            ? `panel dominant colour moved ${describeDominant(before)} -> ${describeDominant(after)}, ` +
              `from a verified ${baseline} baseline into tolerance of ${target}`
            : problems.join("; "),
        independent: { after, baseline, baselineVerified, before, target },
        ok: problems.length === 0,
        want: "proven",
      });
    },
  });

  // ----------------------------------------------------- setVolume, setMicGain
  cases.push({
    id: "set-volume",
    kind: "tool",
    methods: ["setVolume"],
    async run() {
      /*
       * A CONTRASTING BASELINE FIRST, for the same reason set-background needs
       * one: this device has no volume getter, so the echo is the only
       * read-back, and an echo of 42 from a device that was already at 42 says
       * nothing about whether the call did anything.
       */
      const baseline = await attempt(() => device.setVolume(20));
      const agent = await ask(
        `Use the ${mountPath} device capability. The volume is currently 20. Call setVolume(42) ` +
          `and tell me exactly what the call returned.`,
      );
      // setVolume echoes the value it applied, which is the only read-back
      // this device has: health() reports no volume field at all.
      const direct = await attempt(() => device.setVolume(42));
      const agentEcho = firstSucceededResult(agent, "setVolume(");
      const problems = transitionProblems({
        agentReported: agentEcho,
        baseline: "20",
        baselineDiffersFromTarget: true,
        baselineVerified: baseline.ok && baseline.value === 20,
        endedAtTarget: direct.ok && direct.value === 42,
        target: "42",
      });
      const echoed = scalarOrField(agentEcho, "volume") === 42;
      if (!echoed && problems.length === 0) {
        problems.push(`the agent's run returned ${JSON.stringify(agentEcho)}, not the echoed 42`);
      }
      const ok = problems.length === 0 && echoed;
      return verdictFor({
        agent,
        detail: ok
          ? "setVolume moved a verified 20 baseline to 42, echoed 42 to the agent and to a " +
            "direct call (no getter exists; the echo IS the read-back)"
          : problems.join("; "),
        independent: { baseline, direct },
        ok,
        want: "proven",
      });
    },
  });

  cases.push({
    id: "set-mic-gain",
    kind: "tool",
    methods: ["setMicGain"],
    async run() {
      /* Same contrasting-baseline rule; the echo is the only read-back here too. */
      const baseline = await attempt(() => device.setMicGain(12));
      const agent = await ask(
        `Use the ${mountPath} device capability. The microphone gain is currently 12 dB. Call ` +
          `setMicGain(30) to set it to 30 dB and tell me exactly what the call returned.`,
      );
      const direct = await attempt(() => device.setMicGain(30));
      const agentEcho = firstSucceededResult(agent, "setMicGain(");
      const problems = transitionProblems({
        agentReported: agentEcho,
        baseline: "12 dB",
        baselineDiffersFromTarget: true,
        baselineVerified: baseline.ok && baseline.value === 12,
        endedAtTarget: direct.ok && direct.value === 30,
        target: "30 dB",
      });
      const echoed = scalarOrField(agentEcho, "micGain") === 30;
      if (!echoed && problems.length === 0) {
        problems.push(`the agent's run returned ${JSON.stringify(agentEcho)}, not the echoed 30`);
      }
      const ok = problems.length === 0 && echoed;
      return verdictFor({
        agent,
        detail: ok
          ? "setMicGain moved a verified 12 dB baseline to 30 dB, echoed 30 to the agent and to " +
            "a direct call (no getter exists; the echo IS the read-back)"
          : problems.join("; "),
        independent: { baseline, direct },
        ok,
        want: "proven",
      });
    },
  });

  // ---------------------------------------------------------------- recording
  cases.push({
    id: "recording-discovery",
    kind: "tool",
    methods: ["recording.status", "recording.size", "recording.read"],
    // Optional on purpose: this asks whether the model can find a method the
    // mount's own description never mentions. A "no" is a documentation
    // finding about the deployed firmware, not a broken device.
    optional: true,
    async run() {
      const agent = await ask(
        `Using only the ${mountPath} device capability, find out whether the device has ` +
          `anything recorded on its SD card. If there is a way to ask it, use it and report ` +
          `what you found. If there is no such call, say so plainly.`,
      );
      const found = agent.scriptRuns.some((run) => run.code.includes("recording."));
      const direct = await attempt(() => device.recording.status());
      return {
        agent,
        detail: found
          ? "the agent discovered recording.* unprompted, from the mount description alone"
          : "the agent did NOT discover recording.* — the deployed mount's instructions never mention it (see inventory.presentButUnadvertised)",
        independent: direct,
        verdict: found ? "proven" : "skipped",
      };
    },
  });

  cases.push({
    id: "recording",
    kind: "tool",
    methods: ["recording.status", "recording.size", "recording.read"],
    async run() {
      const agent = await ask(
        `Use the ${mountPath} device capability. It has three recording calls: ` +
          `recording.status(), recording.size(name) and recording.read(name, byteOffset). ` +
          `Call recording.status(), then recording.size("mic.pcm"), then ` +
          `recording.read("call.log", 0) and report the status object, the size, and how many ` +
          `bytes the read returned.`,
      );
      const status = await attempt(() => device.recording.status());
      const size = await attempt(() => device.recording.size("mic.pcm"));
      const read = await attempt(
        async () => (await device.recording.read("call.log", 0)).byteLength,
      );
      /*
       * SAME FILE, or it is not an inconsistency.
       *
       * This case used to note that size reported 0 "while read still returns
       * 1040 bytes" — comparing size("mic.pcm") with read("call.log"). Two
       * different files disagreeing about their lengths is not a defect, and a
       * note that says otherwise costs someone a real investigation later. So
       * the comparison is made against the file that was actually read.
       */
      const sizeOfFileRead = await attempt(() => device.recording.size("call.log"));
      const sameFileDisagrees =
        sizeOfFileRead.ok &&
        read.ok &&
        Number(sizeOfFileRead.value) === 0 &&
        Number(read.value) > 0;
      const calledAll =
        agent.scriptRuns.some((run) => run.code.includes("recording.status(")) &&
        agent.scriptRuns.some((run) => run.code.includes("recording.size(")) &&
        agent.scriptRuns.some((run) => run.code.includes("recording.read("));
      const ok = calledAll && status.ok && size.ok && read.ok;
      return verdictFor({
        agent,
        detail: ok
          ? `all three recording calls answered (status.card=${String((status.value as Record<string, unknown>).card)}, ` +
            `size("mic.pcm")=${String(size.value)}, read("call.log",0)=${String(read.value)} bytes)` +
            ` and size("call.log")=${sizeOfFileRead.ok ? String(sizeOfFileRead.value) : "unavailable"}` +
            (sameFileDisagrees
              ? ` — NOTE: for the SAME file, size("call.log") reports 0 while read returns ` +
                `${String(read.value)} bytes, which is a real inconsistency`
              : "")
          : `not all three recording calls were made through the agent and answered ` +
            `(agent called them: ${calledAll})`,
        independent: { read, size, sizeOfFileRead, status },
        ok,
        want: "proven",
      });
    },
  });

  // ---------------------------------------------------------------- showImage
  cases.push({
    id: "show-image",
    kind: "tool",
    methods: ["showImage"],
    async run() {
      const seconds = 6;
      const before = await readPanel(device);
      const agent = await ask(
        `Use the ${mountPath} device capability. Call showImage("${images.baseline}", ${seconds}) ` +
          `to put that picture on the device screen for ${seconds} seconds, then tell me what the ` +
          `call returned.`,
      );
      // showImage resolves once the picture is UP, not after `seconds`, so the
      // window is still open when the turn ends — but a turn takes tens of
      // seconds, so re-show it ourselves to observe the display and restore.
      await device.showImage(images.baseline, seconds).catch(() => undefined);
      await sleep(2000);
      const during = await readPanel(device);
      await sleep(seconds * 1000 + 2500);
      const restored = await readPanel(device);
      const changed =
        during.dominant.rgb565 !== before.dominant.rgb565 ||
        during.distinct > before.distinct * 1.5;
      const cameBack = restored.dominant.rgb565 === before.dominant.rgb565;
      const ok = changed && cameBack;
      return verdictFor({
        agent,
        detail: ok
          ? `screen changed while the image was up (${describeDominant(before)} -> ${describeDominant(during)}) ` +
            `and returned to ${describeDominant(restored)} after ${seconds}s`
          : `display did not change-and-restore as expected: before ${describeDominant(before)}, ` +
            `during ${describeDominant(during)}, after ${describeDominant(restored)}`,
        independent: { before, during, restored, seconds, url: images.baseline },
        ok,
        want: "proven",
      });
    },
  });

  // --------------------------------------------------------------- boundaries
  //
  // Each of these is asked of the agent AND repeated as a direct call. The
  // direct call is what proves the DEVICE refused; the agent turn is what
  // proves a model driving the device gets the same refusal rather than a
  // silent clamp it then reports as success.
  const boundary = (
    id: string,
    methods: string[],
    prompt: string,
    expect: string,
    direct: () => Promise<unknown>,
    /*
     * The call the agent must be SEEN making, when that differs from the methods
     * this case reports coverage for.
     *
     * They are the same thing everywhere except the absence case, whose whole
     * point is a method the device does not have: `methods` there is the human
     * label "(none — asserts absence)", and searching the agent's scripts for
     * `absence)(` can never match — which failed the case on a harness artefact
     * while the device behaved perfectly.
     */
    mustCall: readonly string[] = methods,
  ): ProofCase => ({
    id,
    kind: "boundary",
    methods,
    async run() {
      /*
       * The shape is dictated, not hoped for: caught, returned as a value, and
       * reported. See boundaryEvidenceProblems for why each leg is required.
       */
      const agent = await ask(
        `${prompt}\n` +
          `Run the call inside a try/catch and RETURN ` +
          `{ ok: false, error: String(error?.message ?? error) } — the whole object, with the ` +
          `device's wording in \`error\`. Do not let the call throw out of your script, and do ` +
          `not summarise it. Then tell me that error message in your reply.`,
      );
      const attempted = await attempt(direct);
      const deviceSaw = !attempted.ok && attempted.error.includes(expect);
      const problems = boundaryEvidenceProblems(agent, expect, mustCall);
      const ok = deviceSaw && problems.length === 0;
      return {
        agent,
        detail: ok
          ? `refused with "${expect}": the agent caught it, returned it from its script and ` +
            `reported it, and a direct call agrees`
          : `expected "${expect}" — ${problems.join("; ") || "the agent's evidence was complete"}` +
            `; direct call ` +
            `${attempted.ok ? `SUCCEEDED (${JSON.stringify(attempted.value)}) instead of refusing` : `said "${attempted.error}"`}`,
        independent: { attempted, problems, runs: agent.scriptRuns.length },
        verdict: ok ? "refused-as-expected" : "failed",
      };
    },
  });

  cases.push(
    boundary(
      "show-image-seconds-zero",
      ["showImage"],
      `Use the ${mountPath} device capability. Call showImage("${images.baseline}", 0) and report ` +
        `the error message verbatim. Do not retry with a different number.`,
      "seconds must be 1-30",
      () => device.showImage(images.baseline, 0),
    ),
    boundary(
      "show-image-seconds-999",
      ["showImage"],
      `Use the ${mountPath} device capability. Call showImage("${images.baseline}", 999) and ` +
        `report the error message verbatim. Do not retry with a different number.`,
      "seconds must be 1-30",
      () => device.showImage(images.baseline, 999),
    ),
    boundary(
      "show-image-bad-scheme",
      ["showImage"],
      `Use the ${mountPath} device capability. Call showImage("ftp://example.com/photo.jpg", 3) ` +
        `and report the error message verbatim. Do not substitute a different URL.`,
      "bad-url",
      () => device.showImage("ftp://example.com/photo.jpg", 3),
    ),
    boundary(
      "show-image-png",
      ["showImage"],
      `Use the ${mountPath} device capability. Call showImage("${images.png}", 3) — that URL is ` +
        `a PNG — and report the error message verbatim. Do not convert it or pick another URL.`,
      "unsupported-format",
      () => device.showImage(images.png, 3),
    ),
    boundary(
      "show-image-progressive-jpeg",
      ["showImage"],
      `Use the ${mountPath} device capability. Call showImage("${images.progressive}", 3) — that ` +
        `URL serves a progressive JPEG — and report the error message verbatim. Do not pick ` +
        `another URL.`,
      "unsupported-format",
      () => device.showImage(images.progressive, 3),
    ),
    boundary(
      "show-image-too-large",
      ["showImage"],
      `Use the ${mountPath} device capability. Call showImage("${images.oversize}", 3) — that ` +
        `image is 800x900, larger than the panel — and report the error message verbatim. Do ` +
        `not resize it or pick another URL.`,
      "too-large",
      () => device.showImage(images.oversize, 3),
    ),
    boundary(
      "set-volume-over",
      ["setVolume"],
      `Use the ${mountPath} device capability. Call setVolume(101) and report the error message ` +
        `verbatim. Do not retry with a valid number.`,
      "expected 0-100",
      () => device.setVolume(101),
    ),
    boundary(
      "set-volume-under",
      ["setVolume"],
      `Use the ${mountPath} device capability. Call setVolume(-1) and report the error message ` +
        `verbatim. Do not retry with a valid number.`,
      "expected 0-100",
      () => device.setVolume(-1),
    ),
    boundary(
      "set-mic-gain-over",
      ["setMicGain"],
      `Use the ${mountPath} device capability. Call setMicGain(49) and report the error message ` +
        `verbatim. Do not retry with a valid number.`,
      "expected 0-48 dB",
      () => device.setMicGain(49),
    ),
    boundary(
      "set-mic-gain-under",
      ["setMicGain"],
      `Use the ${mountPath} device capability. Call setMicGain(-1) and report the error message ` +
        `verbatim. Do not retry with a valid number.`,
      "expected 0-48 dB",
      () => device.setMicGain(-1),
    ),
    boundary(
      "screenshot-chunk-out-of-range",
      ["readScreenshotChunk"],
      `Use the ${mountPath} device capability. Call takeScreenshot(), then call ` +
        `readScreenshotChunk(9999) and report the error message verbatim.`,
      "chunk index out of range",
      async () => {
        await device.takeScreenshot();
        return await device.readScreenshotChunk(9999);
      },
    ),
    /*
     * The negative control, and the only case whose PASS is a failure.
     *
     * The shared capability layer other Iterate devices use registers
     * `interruptPlayback`; this device deliberately does not, and its own
     * description now says so. So the required outcome is an explicit bounded
     * refusal — `unknown device capability`. If this ever resolves, the mount
     * has grown a method the firmware does not have, which is a bug to report
     * and never a capability to celebrate.
     */
    boundary(
      "no-interrupt-method",
      ["(none — asserts absence)"],
      `Use the ${mountPath} device capability. Its description says there is no interrupt or ` +
        `interruptPlayback method on this device. Try calling interruptPlayback() on it anyway ` +
        `and report exactly what happens. Do not substitute another method and do not call ` +
        `pushToTalk.`,
      "unknown device capability",
      () => (device as unknown as { interruptPlayback(): Promise<unknown> }).interruptPlayback(),
      /* The agent must be seen ATTEMPTING the absent call — that is the case. */
      ["interruptPlayback"],
    ),
  );

  // ------------------------------------------------------------ busy, timeout
  cases.push({
    id: "show-image-busy",
    kind: "bounded-error",
    methods: ["showImage"],
    async run() {
      const agent = await ask(
        `Use the ${mountPath} device capability to show that it accepts only ONE image ` +
          `request at a time. Run EXACTLY this, as a single script, and return what it ` +
          `returns — do not restructure it, do not add awaits between the two calls, and do ` +
          `not catch the errors yourself:\n` +
          `  const a = itx.${mountPath}.showImage("${images.baseline}", 5);\n` +
          `  const b = itx.${mountPath}.showImage("${images.other}", 5);\n` +
          `  return await Promise.allSettled([a, b]);\n` +
          `Both calls must be STARTED before either is awaited — that is the whole point; ` +
          `awaiting the first one before starting the second proves nothing. One will ` +
          `succeed and the other must be refused. Report both outcomes verbatim, including ` +
          `the exact refusal text.`,
      );
      /*
       * The agent's own result, not its prose: exactly one accepted and one
       * refused. See busyOutcomeProblems for why the refusal TEXT is asserted on
       * the direct call instead — it does not cross into the sandbox.
       */
      const agentOutcome = firstSucceededResult(agent, "showImage(");
      const outcomeProblems = busyOutcomeProblems(agentOutcome);
      /*
       * THE REFUSAL TEXT, IN THE AGENT'S OWN EVIDENCE — required, not waived.
       *
       * It was tempting to accept [fulfilled, rejected] and take the wording from
       * the direct call, because the message was being stripped at the sandbox
       * boundary. That would have written a platform defect into the harness as
       * an expectation: an agent told only `{remote:true,durableObjectId:...}`
       * cannot explain to anyone why its request was refused, and a failure that
       * carries no meaningful explanation is the thing this repo does not ship.
       */
      const agentSaw = turnMentions(agent, "already in flight");
      /*
       * What the agent RAN, not only what came back. Measured: the agent wrote a
       * perfectly concurrent script and the case still failed, because the
       * rejected entry of Promise.allSettled carries an Error and
       * JSON.stringify(new Error("x")) is {} — so neither the agent nor this
       * harness ever saw the refusal text. Checking the shape separates "the
       * agent did not overlap the calls" from "the overlap happened and the
       * evidence was lost in serialisation", which are different bugs with
       * different fixes.
       */
      const shapeProblems = agent.scriptRuns
        .filter((run) => run.code.includes("showImage"))
        .flatMap((run) => busyShapeProblems(run.code));
      const ranConcurrently =
        agent.scriptRuns.some((run) => run.code.includes("showImage")) &&
        shapeProblems.length === 0;
      await sleep(8000);
      const both = await Promise.allSettled([
        device.showImage(images.baseline, 5),
        device.showImage(images.other, 5),
      ]);
      const settled = both.map((entry) =>
        entry.status === "fulfilled"
          ? { ok: true, value: entry.value }
          : { error: errorText(entry.reason), ok: false },
      );
      const oneWon = settled.filter((entry) => entry.ok).length === 1;
      const oneRefused = settled.some(
        (entry) => !entry.ok && String(entry.error).includes("already in flight"),
      );
      const ok =
        agentSaw && outcomeProblems.length === 0 && ranConcurrently && oneWon && oneRefused;
      await sleep(6000);
      return {
        agent,
        detail: ok
          ? `two overlapping showImage calls: the agent's own script came back ` +
            `[fulfilled, rejected] with the refusal naming itself — "an image request is ` +
            `already in flight" — and a direct overlap agrees`
          : `overlap did not resolve to one acceptance plus one refusal the agent can explain ` +
            `(agent evidence contains the refusal text: ${agentSaw}; agent script ` +
            `overlapped: ${ranConcurrently}` +
            `${shapeProblems.length > 0 ? ` — ${shapeProblems.join("; ")}` : ""}` +
            `${outcomeProblems.length > 0 ? `; ${outcomeProblems.join("; ")}` : ""}; ` +
            `direct: ${JSON.stringify(settled)})`,
        independent: { agentOutcome, outcomeProblems, settled, shapeProblems },
        verdict: ok ? "refused-as-expected" : "failed",
      };
    },
  });

  cases.push({
    id: "show-image-timeout",
    kind: "bounded-error",
    methods: ["showImage"],
    async run() {
      /*
       * A FIXTURE THAT WAS NOT VERIFIED CANNOT PROVE A TIMEOUT.
       *
       * This is the guard that stops "too-large" masquerading as "timeout": if
       * the bytes are past the device's cap, or progressive, or the slow path
       * actually finishes, the case says so instead of reporting whatever the
       * device happened to answer.
       */
      if (fixtureChecks.length > 0) {
        return {
          agent: null,
          detail: `the stalling fixture is not usable: ${fixtureChecks.join("; ")}`,
          independent: { fixtureChecks },
          verdict: "failed" as Verdict,
        };
      }
      const agent = await ask(
        `Use the ${mountPath} device capability. Call showImage("${images.stalling}", 3). That URL ` +
          `never finishes sending its body. Report the error message verbatim and roughly how ` +
          `long the call took.`,
      );
      const started = Date.now();
      const attempted = await attempt(() => device.showImage(images.stalling, 3));
      const ms = Date.now() - started;
      const agentSaw = turnMentions(agent, "timeout");
      const driveProblems = agentDriveProblems(agent, ["showImage"]);
      // Bounded is the whole claim: the firmware's fetch gives up at ~15s and
      // the RPC deadline behind it at 40s, so anything past 45s means the
      // caller was left hanging on a device that stopped answering.
      const bounded = !attempted.ok && attempted.error.includes("timeout") && ms < 45_000;
      const ok = agentSaw && bounded && driveProblems.length === 0;
      return {
        agent,
        detail: ok
          ? `a stalling body failed with "timeout" after ${ms}ms — explicit and bounded, ` +
            `through the agent and on a direct call`
          : `expected a bounded "timeout" — agent evidence contains it: ${agentSaw} ` +
            `(${agent.scriptRuns.length} script run(s)` +
            `${driveProblems.length > 0 ? `; ${driveProblems.join("; ")}` : ""}); direct ` +
            `call took ${ms}ms and ${attempted.ok ? `SUCCEEDED` : `said "${attempted.error}"`}`,
        independent: { ...attempted, ms },
        verdict: ok ? "refused-as-expected" : "failed",
      };
    },
  });

  // -------------------------------------------- conversation and push-to-talk
  cases.push({
    id: "conversation-start",
    kind: "tool",
    methods: ["conversation.start"],
    async run() {
      const agent = await ask(
        `Use the ${mountPath} device capability. Call conversation.start() to start a ` +
          `conversation on the device, then tell me what it returned.`,
      );
      // wantsCall is the INTENT the call records; callActive follows only once
      // the provider session is up, which is why intent is what gets asserted.
      const direct = (await device.health()) as Record<string, unknown>;
      const ok = direct.wantsCall === true;
      return verdictFor({
        agent,
        detail: ok
          ? `health() now reports wantsCall=true (callActive=${String(direct.callActive)}, ` +
            `callPending=${String(direct.callPending)}) — the device took the intent`
          : `health() reports wantsCall=${String(direct.wantsCall)} after the agent started a conversation`,
        independent: {
          callActive: direct.callActive,
          callPending: direct.callPending,
          sessionGeneration: direct.sessionGeneration,
          wantsCall: direct.wantsCall,
        },
        ok,
        want: "proven",
      });
    },
  });

  cases.push({
    id: "push-to-talk-start",
    kind: "tool",
    methods: ["pushToTalk.start"],
    async run() {
      const agent = await ask(
        `Use the ${mountPath} device capability. Call pushToTalk.start() to hold the device's ` +
          `talk button down. Do NOT call pushToTalk.stop(). Tell me what start returned.`,
      );
      const direct = (await device.health()) as Record<string, unknown>;
      const ok = direct.talking === true;
      return verdictFor({
        agent,
        detail: ok
          ? "health() reports talking=true with the button still held — the agent's press stuck"
          : `health() reports talking=${String(direct.talking)} after the agent pressed talk`,
        independent: { micCaptured: direct.micCaptured, talking: direct.talking },
        ok,
        want: "proven",
      });
    },
  });

  cases.push({
    id: "push-to-talk-stop",
    kind: "tool",
    methods: ["pushToTalk.stop"],
    async run() {
      const agent = await ask(
        `Use the ${mountPath} device capability. Call pushToTalk.stop() to release the device's ` +
          `talk button and tell me what it returned.`,
      );
      const direct = (await device.health()) as Record<string, unknown>;
      const ok = direct.talking === false;
      return verdictFor({
        agent,
        detail: ok
          ? "health() reports talking=false — the agent's release landed"
          : `health() still reports talking=${String(direct.talking)} after the agent released talk`,
        independent: { micCaptured: direct.micCaptured, talking: direct.talking },
        ok,
        want: "proven",
      });
    },
  });

  cases.push({
    id: "conversation-hang-up",
    kind: "tool",
    methods: ["conversation.hangUp"],
    async run() {
      const agent = await ask(
        `Use the ${mountPath} device capability. Call conversation.hangUp() to end the ` +
          `conversation on the device and tell me what it returned.`,
      );
      await sleep(2000);
      const direct = (await device.health()) as Record<string, unknown>;
      const ok = direct.wantsCall === false;
      return verdictFor({
        agent,
        detail: ok
          ? `health() reports wantsCall=false (callActive=${String(direct.callActive)}) — the hang-up landed`
          : `health() still reports wantsCall=${String(direct.wantsCall)} after the agent hung up`,
        independent: { callActive: direct.callActive, wantsCall: direct.wantsCall },
        ok,
        want: "proven",
      });
    },
  });

  // ------------------------------------------------------------------ offline
  cases.push({
    id: "offline-is-explicit-and-fast",
    kind: "bounded-error",
    methods: ["(none — asserts the platform's error for a dead provider)"],
    optional: true,
    async run() {
      if (!deviceOnline) {
        // The real thing, for free: the device is not here, so call it.
        const started = Date.now();
        const attempted = await attempt(() => device.health());
        const ms = Date.now() - started;
        const ok =
          !attempted.ok &&
          attempted.error.includes(`capability "${mountPath}" is offline`) &&
          ms < 1000;
        return {
          agent: null,
          detail: ok
            ? `the real mount answered \`capability "${mountPath}" is offline\` in ${ms}ms`
            : `expected a sub-second offline error; got ${attempted.ok ? "success" : attempted.error} in ${ms}ms`,
          independent: { ...attempted, ms, synthetic: false },
          verdict: ok ? "refused-as-expected" : "failed",
        };
      }
      /*
       * The device is online, so this case has nothing honest to measure.
       *
       * It used to mount a stand-in provider of the same name on a scratch
       * scope and drop its connection — same code path, same message. That is
       * not evidence about THIS device, and when it finally ran it did not even
       * work: the host had not noticed the provider was gone and the call
       * returned success in 52ms. A case that fabricates its own subject is
       * worse than a case that admits it cannot run.
       *
       * The real outage is the reboot, so the assertion lives in the `restart`
       * case, where the device is genuinely gone for ~20s.
       */
      return {
        agent: null,
        detail:
          "not run: the device is online. A real offline window is created by the `restart` " +
          "case, which asserts the bounded error itself — pass --include-restart for it.",
        independent: { synthetic: false },
        verdict: "skipped",
      };
    },
  });

  cases.push({
    id: "restart",
    kind: "tool",
    methods: ["restart"],
    optional: true,
    async run() {
      if (options.includeRestart !== true) {
        return {
          agent: null,
          detail:
            "not run: restart reboots the device (~20s, drops any live call). Pass " +
            "--include-restart to include it, and --restart-stream-path to also prove the " +
            "remembered conversation path survived the reboot.",
          independent: null,
          verdict: "skipped",
        };
      }
      const beforeHealth = (await device.health()) as Record<string, number>;
      const watcher = options.restartStreamPath
        ? await watchStream(itx, options.restartStreamPath)
        : null;
      const agent = await ask(
        `Use the ${mountPath} device capability. Call restart() to reboot the device, then tell ` +
          `me what it returned. Do not wait for it to come back.`,
      );
      // A reboot is the one case where an ERROR from the device is expected on
      // the way out, so the proof is the return: uptimeMs must come back
      // SMALLER than it went in, which no living device can do.
      const deadline = Date.now() + 120_000;
      let afterHealth: Record<string, number> | null = null;
      let wentAway = false;
      /*
       * The reboot is the only REAL offline window this harness can create, so
       * the offline assertion lives here rather than against a fabricated
       * stand-in provider: while the device is away, the error must name the
       * mount and come back immediately instead of hanging.
       */
      let offlineError: string | null = null;
      let offlineMs: number | null = null;
      while (Date.now() < deadline) {
        await sleep(2000);
        const probeStarted = Date.now();
        const probe = await attempt(() => device.health());
        if (!probe.ok) {
          wentAway = true;
          if (offlineError === null) {
            offlineError = probe.error;
            offlineMs = Date.now() - probeStarted;
          }
          continue;
        }
        const reading = probe.value as Record<string, number>;
        if (reading.uptimeMs! < beforeHealth.uptimeMs!) {
          afterHealth = reading;
          break;
        }
      }
      const resumed = watcher ? await watcher.sawAfter(30_000) : null;
      watcher?.close();
      const remounted = afterHealth !== null;
      const offlineExplicit =
        offlineError !== null &&
        offlineError.includes(`capability "${mountPath}" is offline`) &&
        offlineMs !== null &&
        offlineMs < 1000;
      return {
        agent,
        detail: remounted
          ? `device rebooted and remounted: uptimeMs ${beforeHealth.uptimeMs} -> ${afterHealth!.uptimeMs}, ` +
            `resetReason ${afterHealth!.resetReason} (went unreachable in between: ${wentAway}` +
            (offlineError === null
              ? ", no offline error observed"
              : `, offline error ${offlineExplicit ? "explicit and bounded" : "UNEXPECTED"}: ` +
                `"${offlineError}" in ${offlineMs}ms`) +
            `)` +
            (watcher
              ? resumed
                ? `; telemetry reappeared on ${options.restartStreamPath}, so the remembered conversation path survived`
                : `; NO telemetry on ${options.restartStreamPath} within 30s — the remembered conversation path did NOT visibly survive`
              : "; conversation-path survival NOT checked (pass --restart-stream-path to check it; the boot log line itself needs serial, which is out of scope here)")
          : `device did not come back with a reset uptimeMs within 120s (went unreachable: ${wentAway})`,
        independent: { afterHealth, beforeHealth, resumedOnStream: resumed, wentAway },
        verdict: remounted && (watcher === null || resumed === true) ? "proven" : "failed",
      };
    },
  });

  // ------------------------------------------------------------------ run them
  const results: ProofCaseResult[] = [];
  for (const proofCase of cases) {
    if (only && !only.has(proofCase.id)) continue;
    if (!deviceOnline && proofCase.id !== "offline-is-explicit-and-fast") {
      results.push({
        agent: null,
        detail: `not run: the device is offline (${liveness.ok ? "" : liveness.error})`,
        id: proofCase.id,
        independent: null,
        kind: proofCase.kind,
        methods: proofCase.methods,
        verdict: "skipped",
      });
      continue;
    }
    say(`--- ${proofCase.id}`);
    const started = Date.now();
    let outcome: Omit<ProofCaseResult, "id" | "kind" | "methods">;
    try {
      outcome = await proofCase.run();
    } catch (error) {
      outcome = {
        agent: null,
        detail: `the case itself threw: ${errorText(error)}`,
        independent: null,
        verdict: "failed",
      };
    }
    results.push({
      ...outcome,
      id: proofCase.id,
      kind: proofCase.kind,
      methods: proofCase.methods,
    });
    say(
      `    ${outcome.verdict.toUpperCase()} (${((Date.now() - started) / 1000).toFixed(1)}s) — ${outcome.detail}`,
    );
  }

  /*
   * The fixture's listener would keep this process alive after the last case, so
   * it closes here — before the restore, so a failure in either is still
   * reported rather than hanging the run.
   */
  await fixture?.close();

  // Put the board back where a person would want to find it. The device has
  // no getters for volume or gain, so "restore" can only mean "set to a value
  // somebody chose"; the values and that caveat are both recorded.
  const restored = deviceOnline
    ? {
        background: await attempt(() =>
          device.setBackground(options.restoreBackground ?? "#101820"),
        ),
        micGain: await attempt(() => device.setMicGain(options.restoreMicGain ?? 24)),
        volume: await attempt(() => device.setVolume(options.restoreVolume ?? 85)),
      }
    : null;

  const optionalIds = new Set(cases.filter((entry) => entry.optional).map((entry) => entry.id));
  const summary = {
    failed: results.filter((entry) => entry.verdict === "failed").map((entry) => entry.id),
    proven: results.filter((entry) => entry.verdict === "proven").map((entry) => entry.id),
    refusedAsExpected: results
      .filter((entry) => entry.verdict === "refused-as-expected")
      .map((entry) => entry.id),
    skipped: results.filter((entry) => entry.verdict === "skipped").map((entry) => entry.id),
    /**
     * PASS is strict: nothing failed, and nothing was skipped except cases
     * that are opt-in by design. A skipped required case is not a pass — that
     * is exactly how a coverage run comes to mean nothing.
     */
    pass:
      results.length > 0 &&
      results.every(
        (entry) =>
          entry.verdict === "proven" ||
          entry.verdict === "refused-as-expected" ||
          (entry.verdict === "skipped" && optionalIds.has(entry.id)),
      ),
  };

  const report = {
    agentPath,
    baseUrl,
    capability: mountPath,
    cases: results,
    deviceOnline,
    finishedAt: new Date().toISOString(),
    inventory,
    project: options.project,
    restored,
    summary,
  };
  if (options.out) {
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    say(`wrote ${options.out}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  say(
    `${summary.pass ? "PASS" : "FAIL"} — proven ${summary.proven.length}, ` +
      `refused-as-expected ${summary.refusedAsExpected.length}, ` +
      `failed ${summary.failed.length} [${summary.failed.join(", ")}], ` +
      `skipped ${summary.skipped.length} [${summary.skipped.join(", ")}]`,
  );
  if (!summary.pass) process.exitCode = 1;
  return report;
}

/**
 * Read the surface from the server rather than from this file.
 *
 * Three readings, because they disagree and the disagreement is the finding:
 * what the project's capability table says is mounted, what the mount's own
 * description ADVERTISES to a model, and what the device actually DISPATCHES.
 */
async function readInventory(
  itx: Awaited<ReturnType<typeof connectProject>>,
  device: DeviceCapability,
  mountPath: string,
  agentPath: string,
) {
  const root = await itx.__describe();
  const mount = root.capabilities.find((entry) => entry.path.join(".") === mountPath) ?? null;
  const own = await device.__describe();
  const advertisedText = `${mount?.instructions ?? ""}\n${own.instructions}\n${own.types}`;
  const advertised = EXPECTED_METHODS.filter((method) => advertisedText.includes(method));

  /*
   * Existence, without breaking anything.
   *
   * A method that is not in the dispatch table answers "unknown device
   * capability"; a method that IS there answers its own validation error. So
   * calling each one with arguments it must refuse proves the method exists
   * and changes nothing on the device — which is the only way to enumerate a
   * FLATTENED mount, whose __describe() reports no children at all.
   *
   * `restart` is unprobeable by construction (the probe would be the reboot)
   * and conversation/pushToTalk have their own cases, so they are marked
   * as such rather than guessed at.
   */
  const probes: { method: string; run: () => Promise<unknown> }[] = [
    { method: "health", run: () => device.health() },
    { method: "setBackground", run: () => device.setBackground("") },
    { method: "takeScreenshot", run: () => device.takeScreenshot() },
    { method: "readScreenshotChunk", run: () => device.readScreenshotChunk(9999) },
    { method: "setVolume", run: () => device.setVolume(101) },
    { method: "setMicGain", run: () => device.setMicGain(49) },
    { method: "recording.status", run: () => device.recording.status() },
    { method: "recording.size", run: () => device.recording.size() },
    { method: "recording.read", run: () => device.recording.read() },
    { method: "showImage", run: () => device.showImage("ftp://example.invalid/x.jpg", 0) },
  ];
  const present: string[] = [];
  const absent: string[] = [];
  const probeResults: Record<string, { ok: boolean; answer: string }> = {};
  for (const probe of probes) {
    const attempted = await attempt(probe.run);
    const answer = attempted.ok
      ? `ok: ${JSON.stringify(attempted.value).slice(0, 120)}`
      : attempted.error;
    probeResults[probe.method] = { answer, ok: attempted.ok };
    if (attempted.ok || !answer.includes("unknown device capability")) present.push(probe.method);
    else absent.push(probe.method);
  }

  const shouldNotExistButDoes: string[] = [];
  const absenceProbes: Record<string, string> = {};
  for (const name of MUST_NOT_EXIST) {
    const steps = name.split(".");
    const attempted = await attempt(() =>
      itx.capabilityHosts
        .get("/")
        .invokeCapability({ args: [], path: [...mountPath.split("."), ...steps] }),
    );
    const answer = attempted.ok ? `RESOLVED: ${JSON.stringify(attempted.value)}` : attempted.error;
    absenceProbes[name] = answer;
    if (attempted.ok || !answer.includes("unknown device capability"))
      shouldNotExistButDoes.push(name);
  }

  /*
   * What the AGENT's scope can reach, not what the project root holds. The
   * mount lives at "/" and agent scopes inherit it through their fallback, so
   * this is the reading that says whether the agent under test can see the
   * device at all — and a run against an agent that cannot is a run whose
   * every case would fail for one boring reason.
   */
  const agentCapabilities = await itx.capabilityHosts
    .get(agentPath)
    .__describe()
    .then((description) => description.capabilities);

  return {
    /** The 15 from the firmware's dispatch table, for comparison only. */
    expected: [...EXPECTED_METHODS],
    /** Named in what a model is shown (`instructions` + `types`). */
    advertised,
    /** In the description but not dispatchable — nothing should be here. */
    advertisedButAbsent: advertised.filter((method) => absent.includes(method)),
    /** Dispatchable but never mentioned to a model. */
    presentButUnadvertised: present.filter(
      (method) => !advertised.includes(method as (typeof EXPECTED_METHODS)[number]),
    ),
    /** Expected by the firmware source but neither advertised nor reachable. */
    expectedButMissing: EXPECTED_METHODS.filter(
      (method) => !advertised.includes(method) && !present.includes(method),
    ),
    present,
    absent,
    probeResults,
    /** Methods no non-destructive probe can settle; see the comment above. */
    notProbeable: {
      "conversation.hangUp": "proven by its own case",
      "conversation.start": "proven by its own case",
      "pushToTalk.start": "proven by its own case",
      "pushToTalk.stop": "proven by its own case",
      restart: "probing it IS the reboot; behind --include-restart",
    },
    absenceProbes,
    shouldNotExistButDoes,
    mount,
    mountDescribe: own,
    agentScopeCapabilities: agentCapabilities.map((entry) => ({
      path: entry.path,
      scope: entry.scope,
      type: entry.type,
    })),
  };
}

/**
 * One real turn on a real agent, with its journal.
 *
 * The offset anchor is captured BEFORE the ask and every read goes forward
 * from it. `getEventPage({ limit: 1 })` does NOT hand back the head row — it
 * hands back the OLDEST matching one — and only its `streamMaxOffset` names
 * where the log currently ends, which is the single field worth reading here.
 */
/**
 * What the injected prompt has to say, beyond naming the methods.
 *
 * `setupVoiceAgent` derives this text from the project's live `__describe`, so
 * the acceptance point is not "a brief exists" but "the brief a real model reads
 * would let it drive this device correctly". Each row below is a capability the
 * device actually has, checked by the words the brief has to contain — so a
 * method that gains an argument, loses a range, or stops being described fails
 * here rather than in a conversation with a customer.
 *
 * Ranges and argument shapes are included deliberately. A model told
 * `setMicGain` exists but not that it takes 0-48 dB will guess, and guessing is
 * what produced the refusals these proofs spend their time on.
 */
const REQUIRED_BRIEF_TOPICS: readonly { topic: string; needles: readonly string[] }[] = [
  { needles: ["conversation.start(", "conversation.hangUp("], topic: "call initiate and hang-up" },
  { needles: ["showImage(url, seconds)", "1-30", "restored"], topic: "timed image URL display" },
  { needles: ["health()", "METRICS"], topic: "metrics access" },
  {
    needles: ["recording.status(", "recording.size(name)", "recording.read(name, byteOffset)"],
    topic: "recording",
  },
  { needles: ["takeScreenshot()", "readScreenshotChunk("], topic: "screenshot" },
  {
    needles: ["setBackground(", "setVolume(0-100)", "setMicGain(0-48 dB)", "restart()"],
    topic: "device controls with their ranges",
  },
  {
    needles: ["pushToTalk.start()", "pushToTalk.stop()", "cut an answer short"],
    topic: "push-to-talk as the barge-in mechanism",
  },
  { needles: ["NO interrupt"], topic: "an explicit denial that an interrupt method exists" },
];

/** Which required topics the injected prompt fails to cover, and how. */
export function briefContentProblems(content: string): string[] {
  const problems: string[] = [];
  for (const { needles, topic } of REQUIRED_BRIEF_TOPICS) {
    const missing = needles.filter((needle) => !content.includes(needle));
    if (missing.length > 0) {
      problems.push(`${topic}: the brief does not say ${missing.map((m) => `"${m}"`).join(", ")}`);
    }
  }
  return problems;
}

/**
 * Why an agent turn is not evidence that the AGENT exercised the method.
 *
 * A boundary case used to be satisfied by the refusal text appearing anywhere in
 * the turn. That is weaker than it looks in two directions.
 *
 * It can pass wrongly: the same wording appears in earlier cases of the same
 * conversation, so a model that answered from memory without calling anything
 * would satisfy it.
 *
 * And it fails opaquely, which is what happened. `set-mic-gain-over` failed with
 * "agent evidence contains it: false" while the stream showed the script at
 * offset 319998 settling at 320003 with exactly `expected 0-48 dB` — the text was
 * there, that turn simply never produced a final message, and the verdict said
 * nothing about whether the ask had errored or how many runs it saw. Recovering
 * that took a hand-written walk over stream offsets. A verdict should name its
 * own cause.
 */
export function agentDriveProblems(
  turn: Pick<AgentTurn, "error" | "scriptRuns" | "unsettled">,
  methods: readonly string[],
): string[] {
  const problems: string[] = [];
  if (turn.error !== null) problems.push(`the ask itself failed: ${turn.error}`);
  if (turn.scriptRuns.length === 0) {
    problems.push("the agent ran no capability script at all");
  } else {
    /* The last segment is what appears in code: `recording.size` -> `size(`. */
    const named = methods.some((method) => {
      const call = `${method.split(".").at(-1) ?? method}(`;
      return turn.scriptRuns.some((run) => run.code.includes(call));
    });
    if (!named) {
      problems.push(
        `none of the ${turn.scriptRuns.length} script(s) the agent ran call ` +
          `${methods.join(" or ")} — the refusal text could have come from anywhere`,
      );
    }
  }
  if (turn.unsettled.length > 0) {
    problems.push(`${turn.unsettled.length} run(s) never settled: ${turn.unsettled.join(", ")}`);
  }
  return problems;
}

/**
 * The three things a boundary case must show, and which of them is missing.
 *
 * A refusal is proven when the AGENT asked for it, the device said no in words,
 * and the agent came back and said so. Each leg is required because each can be
 * true while the claim is false:
 *
 *  - **A succeeded run returning the message.** The script has to CATCH the
 *    rejection and return `{ok: false, error: "..."}`. An uncaught rejection
 *    settles as `failed`, and that is a script that crashed — the model receives
 *    a tool error and may say anything about it. Requiring the caught, returned
 *    form is what makes the refusal a value the agent HANDLED.
 *  - **A completed final message naming it.** `set-mic-gain-over` failed with a
 *    settlement carrying exactly `expected 0-48 dB` and no final message at all:
 *    the turn ended without the agent telling anyone. A device that refuses and
 *    an agent that goes quiet is not a working pair, so the silence is the
 *    failure and not a diagnostic footnote.
 *  - **A direct call agreeing** — asserted by the caller, since only it can say
 *    the DEVICE refused rather than the model inventing a plausible sentence.
 */
export function boundaryEvidenceProblems(
  turn: Pick<AgentTurn, "error" | "finalMessage" | "scriptRuns" | "unsettled">,
  expect: string,
  methods: readonly string[],
): string[] {
  const problems = agentDriveProblems(turn, methods);
  const needle = expect.toLowerCase();
  const succeededWithMessage = turn.scriptRuns.some((run) => {
    const settlement = run.settlement as { result?: unknown; status?: string } | null;
    if (settlement?.status !== "succeeded") return false;
    return JSON.stringify(settlement.result ?? null)
      .toLowerCase()
      .includes(needle);
  });
  if (!succeededWithMessage) {
    const uncaught = turn.scriptRuns.some((run) => {
      const settlement = run.settlement as { error?: unknown; status?: string } | null;
      return (
        settlement?.status === "failed" &&
        String(settlement.error ?? "")
          .toLowerCase()
          .includes(needle)
      );
    });
    problems.push(
      uncaught
        ? `the agent let the rejection throw out of its script — the settlement is "failed" ` +
            `carrying "${expect}" instead of a succeeded run returning it`
        : `no script the agent ran returned "${expect}" as a value it caught`,
    );
  }
  if (turn.finalMessage === null) {
    problems.push("the agent's turn ended without a final message, so it never reported anything");
  } else if (!turn.finalMessage.toLowerCase().includes(needle)) {
    problems.push(`the agent's final message does not name "${expect}"`);
  }
  return problems;
}

/**
 * Why an agent's own overlap result does not show a refusal.
 *
 * WHAT THE AGENT CAN AND CANNOT SEE.
 *
 * Measured, from the settled run at offset 302256:
 *
 *   [{"status":"fulfilled","value":true},
 *    {"status":"rejected","reason":{"remote":true,"durableObjectId":"ff5ced4c..."}}]
 *
 * The device's refusal text — "an image request is already in flight" — does not
 * survive the hop into the script sandbox: the reason arrives as a remote-stub
 * descriptor with no message on it. The agent said so itself, accurately: "No
 * additional refusal text was included in the returned result."
 *
 * So asking the agent to report that text is asking for something the platform
 * does not deliver, and `String(reason?.message ?? reason)` yields
 * "[object Object]" no matter how the script is written. What the agent's own run
 * DOES prove is the behaviour: of two requests in flight together, exactly one
 * was accepted and exactly one was rejected. The wording of the refusal is
 * asserted on the direct call, where it is visible.
 *
 * That is a narrower claim honestly held, not a side effect standing in for the
 * agent: the rejection is in the agent's own result, from its own concurrent
 * calls.
 */
export function busyOutcomeProblems(result: unknown): string[] {
  if (!Array.isArray(result)) {
    return [`the agent's run returned ${JSON.stringify(result)}, not a pair of outcomes`];
  }
  const statuses = result.map((entry) =>
    typeof entry === "object" && entry !== null
      ? String((entry as { status?: unknown }).status ?? "unknown")
      : "unknown",
  );
  const fulfilled = statuses.filter((status) => status === "fulfilled").length;
  const rejected = statuses.filter((status) => status === "rejected").length;
  if (result.length !== 2) {
    return [`the agent's run returned ${result.length} outcome(s); an overlap has two`];
  }
  if (fulfilled !== 1 || rejected !== 1) {
    return [
      `the agent's two concurrent requests came back as [${statuses.join(", ")}] — exactly one ` +
        `had to be accepted and one refused`,
    ];
  }
  return [];
}

/**
 * Why an agent's script does not actually test concurrency.
 *
 * The busy case only means something if both requests are IN FLIGHT together.
 * Awaiting the first before starting the second tests nothing — the device would
 * accept them one after another, exactly as it should, and the case would report
 * a refusal that never happened.
 *
 * Syntactic on purpose, and honest about it: this reads the code the agent wrote
 * rather than inferring intent from results. A result-only check cannot tell a
 * genuine overlap from a device that happens to be busy for another reason.
 */
export function busyShapeProblems(code: string): string[] {
  const problems: string[] = [];
  const calls = code.match(/showImage\s*\(/g)?.length ?? 0;
  if (calls < 2) {
    problems.push(`the script makes ${calls} showImage call(s); an overlap needs two`);
  }
  if (/await\s+[\w.$]*showImage\s*\(/.test(code)) {
    problems.push(
      "the script awaits a showImage call directly, so the second request starts after the " +
        "first has finished and nothing overlaps",
    );
  }
  if (!/Promise\.(allSettled|all)\s*\(/.test(code)) {
    problems.push(
      "the script does not await both requests together (Promise.allSettled/Promise.all), so " +
        "there is no moment when both are in flight",
    );
  }
  return problems;
}

/**
 * Why a stateful case has not proved a transition.
 *
 * A case that says "the agent set X to V" only means something if the device was
 * NOT already at V. Measured: proof run 3 failed `set-background` with "panel
 * dominant colour moved rgb(123,0,0) -> rgb(123,0,0)", because run 2 had been
 * stopped mid-way with the panel already red. Nothing was wrong with the device
 * or the agent — the case simply had nothing to prove, and would equally have
 * "passed" a device that ignored the call.
 *
 * So each such case establishes a CONTRASTING baseline first and verifies the
 * device actually shows it. Establishing it directly is a precondition, not
 * evidence: the agent's turn stays the only thing that writes the target, and
 * the agent's own returned value is still required. A rerun is then
 * self-contained — it cannot pass or fail on what a previous run left behind.
 */
export function transitionProblems(input: {
  /** The contrasting state this case established before asking the agent. */
  baseline: string;
  /** Whether the device actually showed that baseline. */
  baselineVerified: boolean;
  /** Whether baseline and target differ enough for the move to mean anything. */
  baselineDiffersFromTarget: boolean;
  /** Whether the device shows the target after the agent's turn. */
  endedAtTarget: boolean;
  /** What the agent's own run returned, or null when it returned nothing. */
  agentReported: unknown;
  target: string;
}): string[] {
  const problems: string[] = [];
  if (!input.baselineDiffersFromTarget) {
    problems.push(
      `the baseline ${input.baseline} does not differ from the target ${input.target}, so ` +
        `nothing about this case would distinguish a device that applied the call from one ` +
        `that ignored it`,
    );
  }
  if (!input.baselineVerified) {
    problems.push(
      `the device did not show the contrasting baseline ${input.baseline} before the agent ran, ` +
        `so any later reading proves nothing about the agent's call`,
    );
  }
  if (!input.endedAtTarget) {
    problems.push(`the device does not show the target ${input.target} after the agent's turn`);
  }
  if (input.agentReported === null || input.agentReported === undefined) {
    problems.push(
      `the agent's own run returned nothing, so the device's state is the only witness — and a ` +
        `side effect is not proof that the agent made the call`,
    );
  }
  return problems;
}

/** The minimum of a stream this module needs to wait for a settlement. */
interface SettlementSource {
  waitForEvent(args: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: { payload?: unknown }) => boolean;
    timeoutMs: number;
  }): Promise<{ offset: number; payload?: unknown }>;
}

/**
 * Fill in the settlements that had not landed yet when the turn ended.
 *
 * MEASURED, on deployed preview_3: `script-run-settled` is appended 155-283ms
 * AFTER `agents/web-message-sent`, every single time —
 *
 *   291142  02:32:45.594  web-message-sent
 *   291170  02:32:45.749  script-run-settled  succeeded
 *
 * `ask()` resolves on the agent's message, so a harness that reads the stream
 * immediately afterwards lands inside that window: it sees `script-run-requested`
 * and never the settlement, and reports "no capability script the agent ran
 * settled as succeeded" about a script that succeeded. Four consecutive cases
 * failed that way while the device had in fact done what was asked — which is
 * the most dangerous shape of harness bug, because the next step is to go
 * looking for a device fault that does not exist.
 *
 * `waitForEvent` replays durable rows after `afterOffset`, so a settlement that
 * already landed returns immediately and one that has not is waited for with a
 * deadline. A run that never settles stays unsettled and fails its case.
 */
export async function awaitSettlements(
  stream: SettlementSource,
  runs: AgentScriptRun[],
  timeoutMs: number,
): Promise<{ waitedMs: number; stillPending: string[] }> {
  const startedAt = Date.now();
  const stillPending: string[] = [];
  for (const run of runs) {
    if (run.settlement !== null) continue;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      stillPending.push(run.executionId);
      continue;
    }
    try {
      const settled = await stream.waitForEvent({
        afterOffset: Math.max(0, run.requestedAtOffset - 1),
        eventTypes: ["events.iterate.com/capability-host/script-run-settled"],
        predicate: (event) =>
          (event.payload as { executionId?: string } | null)?.executionId === run.executionId,
        timeoutMs: remaining,
      });
      const payload = (settled.payload ?? {}) as { settlement?: unknown };
      run.settlement = payload.settlement ?? null;
      run.settledAtOffset = settled.offset;
      if (run.settlement === null) stillPending.push(run.executionId);
    } catch {
      stillPending.push(run.executionId);
    }
  }
  return { stillPending, waitedMs: Date.now() - startedAt };
}

/** A tag this harness stamps on one question so its answer is identifiable. */
export const ASK_TAG_PATTERN = /\[(q[0-9a-f]{8})\]/g;

/** One question's window on the stream, and why it cannot be trusted. */
export interface TaggedTurn {
  /** Offset of the event carrying the tagged question. */
  promptOffset: number | null;
  /** Offset of the completed reply that carried the tag back. */
  replyOffset: number | null;
  reply: string | null;
  /** Replies seen after this question that answered a DIFFERENT one. */
  lateOtherTags: string[];
  problems: string[];
}

/**
 * Find exactly this question's prompt and its answer, or say what is wrong.
 *
 * WHY CORRELATION HAS TO BE EXPLICIT HERE.
 *
 * The agent under test is a messaging colleague, not a request/response endpoint
 * — its own brief says so, and the platform labels messages "Message #n" because
 * replies do not arrive in lockstep. Measured on the stream at 03:59:27.996 it
 * sent "For the preceding setMicGain(49) test, the error message was..." AFTER
 * the next case's prompt had gone out. `ask()` resolved on that message, so the
 * harness judged one case using the previous case's evidence: run 7 reported a
 * device fault, and run 9 reported "the agent ran no script" about a turn that
 * had run one for a different question.
 *
 * The rules, and what each rules out:
 *  - the prompt must be on the stream (otherwise there is no window at all)
 *  - exactly ONE completed reply may carry this tag — none means unanswered,
 *    more than one means a replayed or duplicated message
 *  - a reply carrying somebody else's tag is recorded and never used, which is
 *    what stops the harness advancing one question behind forever
 */
export function correlateTaggedTurn(
  events: readonly { offset: number; type: string; payload?: unknown }[],
  tag: string,
): TaggedTurn {
  const problems: string[] = [];
  const stamp = `[${tag}]`;
  const promptOffset =
    events.find((event) => JSON.stringify(event.payload ?? {}).includes(stamp))?.offset ?? null;
  if (promptOffset === null) {
    return {
      lateOtherTags: [],
      problems: [`the question tagged ${stamp} never reached the stream`],
      promptOffset: null,
      reply: null,
      replyOffset: null,
    };
  }
  const messages = events.filter(
    (event) => event.offset >= promptOffset && event.type.endsWith("/agents/web-message-sent"),
  );
  const mine = messages.filter((event) =>
    String((event.payload as { message?: unknown } | null)?.message ?? "").includes(stamp),
  );
  const lateOtherTags = [
    ...new Set(
      messages
        .filter((event) => !mine.includes(event))
        .flatMap((event) => [
          ...String((event.payload as { message?: unknown } | null)?.message ?? "").matchAll(
            ASK_TAG_PATTERN,
          ),
        ])
        .map((match) => match[1] ?? "")
        .filter((other) => other !== tag && other.length > 0),
    ),
  ];
  if (mine.length === 0) {
    problems.push(
      `no completed reply carried ${stamp}` +
        (lateOtherTags.length > 0
          ? ` — the only replies after it answered [${lateOtherTags.join("], [")}], so this ` +
            `question was never answered`
          : ""),
    );
  }
  if (mine.length > 1) {
    problems.push(
      `${mine.length} replies carried ${stamp} at offsets ` +
        `${mine.map((event) => String(event.offset)).join(", ")} — a duplicated or replayed reply ` +
        `cannot be treated as one answer`,
    );
  }
  const reply = mine.length === 1 ? mine[0] : null;
  return {
    lateOtherTags,
    problems,
    promptOffset,
    reply:
      reply === null
        ? null
        : String((reply.payload as { message?: unknown } | null)?.message ?? ""),
    replyOffset: reply?.offset ?? null,
  };
}

export async function askAgent(
  itx: Awaited<ReturnType<typeof connectProject>>,
  agentPath: string,
  prompt: string,
  timeoutMs: number,
): Promise<AgentTurn> {
  const stream = itx.streams.get(agentPath);
  const beforeOffset = (await stream.getEventPage({ limit: 1 })).streamMaxOffset;
  /*
   * A TAG, BECAUSE THIS AGENT ANSWERS ONE QUESTION BEHIND.
   *
   * It is a messaging colleague, not a request/response endpoint: its own brief
   * says so, and the platform labels messages "Message #n" precisely because
   * replies do not arrive in lockstep. Measured on the stream, at 03:59:27.996 it
   * sent "For the preceding setMicGain(49) test, the error message was..." — the
   * right answer to the PREVIOUS case, while this case's prompt had already gone
   * out. `ask()` returned on that message, so the harness read one case's
   * evidence and judged another's, and the verdict blamed the device.
   *
   * So each question carries a token and the reply has to carry it back. That
   * makes the window unambiguous at both ends: the prompt event is findable, the
   * answering message is identifiable, and a lagging agent can no longer have its
   * evidence attributed to the wrong case.
   */
  const tag = `q${crypto.randomUUID().slice(0, 8)}`;
  const tagged =
    `[${tag}] ${prompt}\n` +
    `START your reply with the tag [${tag}] so I can tell which question it answers. ` +
    `Answer THIS question, now — do not answer it from an earlier turn's result and do not ` +
    `assume you already know the answer, even if you have been asked something similar.`;

  const started = Date.now();
  let error: string | null = null;
  try {
    await itx.agents.get(agentPath).ask({ message: tagged, timeoutMs });
  } catch (caught) {
    error = errorText(caught);
  }
  /*
   * `ask` resolving is not this question being answered — see above. Wait for the
   * reply that carries the tag, inside whatever budget is left.
   */
  let taggedReply: { offset: number; payload?: unknown } | null = null;
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining > 0) {
    try {
      taggedReply = await stream.waitForEvent({
        afterOffset: beforeOffset,
        eventTypes: ["events.iterate.com/agents/web-message-sent"],
        predicate: (event) =>
          String((event.payload as { message?: unknown } | null)?.message ?? "").includes(tag),
        timeoutMs: remaining,
      });
    } catch {
      /* No tagged reply. The case fails on a missing final message, which is
       * true: this question was never answered. */
    }
  }
  const ms = Date.now() - started;

  const events = [];
  let cursor = beforeOffset;
  for (let page = 0; page < 40; page++) {
    const batch = await stream.getEvents({ afterOffset: cursor, limit: 500 });
    if (batch.length === 0) break;
    events.push(...batch);
    cursor = batch[batch.length - 1]!.offset;
  }

  /*
   * The window starts at the PROMPT and ends at the reply that carries this
   * ask's tag — never at the head before the ask, because the previous case's
   * scripts can still be landing then, and never at some other question's reply.
   */
  const correlated = correlateTaggedTurn(events, tag);
  const promptOffset = correlated.promptOffset ?? beforeOffset;
  const replyOffset = correlated.replyOffset ?? Number.MAX_SAFE_INTEGER;

  const runs = new Map<string, AgentScriptRun>();
  let finalMessage: string | null = null;
  let finalMessageOffset: number | null = null;
  for (const event of events) {
    if (event.offset < promptOffset) continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type.endsWith("/capability-host/script-run-requested")) {
      /* Scripts this question caused: after its prompt, up to its answer. A
       * script requested after the reply belongs to whatever came next. */
      if (event.offset > replyOffset) continue;
      const executionId = String(payload.executionId ?? `offset-${event.offset}`);
      runs.set(executionId, {
        code: String(payload.code ?? ""),
        executionId,
        requestedAtOffset: event.offset,
        settledAtOffset: null,
        settlement: null,
      });
      continue;
    }
    if (event.type.endsWith("/capability-host/script-run-settled")) {
      const existing = runs.get(String(payload.executionId));
      if (existing) {
        existing.settlement = payload.settlement ?? null;
        existing.settledAtOffset = event.offset;
      }
      continue;
    }
  }
  /*
   * Only the tagged reply counts as this question's answer, and only if exactly
   * one carried the tag. `waitForEvent` above is the bounded wait; this is the
   * verdict on what actually landed.
   */
  if (correlated.problems.length === 0) {
    finalMessage = correlated.reply;
    finalMessageOffset = correlated.replyOffset;
  } else if (error === null) {
    error = correlated.problems.join("; ");
  }
  void taggedReply;

  const scriptRuns = [...runs.values()];
  /* The settlement is bookkeeping that trails the model's answer — wait for it
   * rather than concluding from its absence. */
  const settling = await awaitSettlements(stream, scriptRuns, 20_000);

  return {
    afterOffset: cursor,
    error,
    finalMessage,
    finalMessageOffset,
    ms,
    prompt: tagged,
    scriptRuns,
    settlementWaitMs: settling.waitedMs,
    unsettled: settling.stillPending,
    beforeOffset,
  };
}

/**
 * Turn one independent check into a verdict.
 *
 * A tool is proven only when the agent RAN CODE naming it, that code
 * succeeded, and a direct call agrees — three separate things, because any two
 * of them can be true while the claim is false.
 */
function verdictFor(input: {
  agent: AgentTurn;
  detail: string;
  independent: unknown;
  ok: boolean;
  want: "proven";
}): Omit<ProofCaseResult, "id" | "kind" | "methods"> {
  const succeeded = input.agent.scriptRuns.some(
    (run) => settlementStatus(run.settlement) === "succeeded",
  );
  const agentDrove = input.agent.scriptRuns.length > 0;
  const ok = input.ok && agentDrove && succeeded && input.agent.error === null;
  const reasons = [
    agentDrove ? null : "the agent ran no capability script at all",
    input.agent.unsettled.length === 0
      ? null
      : `${input.agent.unsettled.length} script run(s) never settled within the wait: ` +
        input.agent.unsettled.join(", "),
    succeeded ? null : "no capability script the agent ran settled as succeeded",
    input.agent.error === null ? null : `ask() failed: ${input.agent.error}`,
  ].filter((entry): entry is string => entry !== null);
  return {
    agent: input.agent,
    detail: reasons.length > 0 ? `${input.detail}; also: ${reasons.join("; ")}` : input.detail,
    independent: input.independent,
    verdict: ok ? input.want : "failed",
  };
}

/** Whether any part of a turn's evidence contains a string, case-insensitively. */
function turnMentions(turn: AgentTurn, needle: string): boolean {
  const haystack = [
    JSON.stringify(turn.scriptRuns.map((run) => run.settlement)),
    turn.finalMessage ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

/**
 * A number the agent was actually told, from ANY succeeded run's result.
 *
 * `firstSucceededResult` looks only at the first run whose code names a marker,
 * which silently returns null the moment the model splits its work across two
 * scripts (read the device in one, speak in the next) or reshapes what it
 * returns. That is a hole in the HARNESS, not evidence about the device: the
 * number was in the settled result all along. This scans every succeeded run,
 * and one level into its result, so the check is about what the device answered
 * rather than about how the model chose to structure its code.
 */
function reportedNumber(turn: AgentTurn, field: string): number | null {
  for (const run of turn.scriptRuns) {
    const settlement = run.settlement as { result?: unknown; status?: string } | null;
    if (settlement?.status !== "succeeded") continue;
    const direct = numberIn(settlement.result, field);
    if (direct !== null) return direct;
    const nested = settlement.result;
    if (nested !== null && typeof nested === "object") {
      for (const value of Object.values(nested as Record<string, unknown>)) {
        const inner = numberIn(value, field);
        if (inner !== null) return inner;
      }
    }
  }
  return null;
}

/** The result of the first succeeded script run whose code names `marker`. */
function firstSucceededResult(turn: AgentTurn, marker: string): unknown {
  for (const run of turn.scriptRuns) {
    if (!run.code.includes(marker)) continue;
    const settlement = run.settlement as { result?: unknown; status?: string } | null;
    if (settlement?.status === "succeeded") return settlement.result;
  }
  return null;
}

function settlementStatus(settlement: unknown): string | null {
  const typed = settlement as { status?: string } | null;
  return typed?.status ?? null;
}

/** A number the agent reported, whether it came back bare or in an object. */
function numberIn(value: unknown, field: string): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && field in value) {
    const inner = (value as Record<string, unknown>)[field];
    if (typeof inner === "number") return inner;
  }
  return null;
}

/** Some device calls echo a bare number; a model may wrap it in an object. */
function scalarOrField(value: unknown, field: string): number | null {
  return numberIn(value, field);
}

/**
 * Read the panel back and reduce it to something assertable.
 *
 * takeScreenshot latches a frame that readScreenshotChunk then walks, so the
 * two must stay adjacent: another caller taking a screenshot in between would
 * silently hand back somebody else's frame.
 */
async function readPanel(device: DeviceCapability): Promise<PanelReading> {
  const meta = await device.takeScreenshot();
  const counts = new Map<number, number>();
  let bytesRead = 0;
  for (let index = 0; index < meta.chunks; index++) {
    const bytes = new Uint8Array(await device.readScreenshotChunk(index));
    bytesRead += bytes.length;
    for (let at = 0; at + 1 < bytes.length; at += 2) {
      const value = bytes[at]! | (bytes[at + 1]! << 8);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = 0;
  let total = 0;
  for (const [value, count] of counts) {
    total += count;
    if (count > bestCount) {
      bestCount = count;
      best = value;
    }
  }
  return {
    bytes: meta.bytes,
    bytesRead,
    chunks: meta.chunks,
    distinct: counts.size,
    dominant: {
      b: Math.round(((best & 0x1f) * 255) / 31),
      g: Math.round((((best >> 5) & 0x3f) * 255) / 63),
      r: Math.round((((best >> 11) & 0x1f) * 255) / 31),
      rgb565: best,
      share: total === 0 ? 0 : bestCount / total,
    },
    height: meta.height,
    width: meta.width,
  };
}

function describeDominant(reading: PanelReading): string {
  const { b, g, r, share } = reading.dominant;
  return `rgb(${r},${g},${b}) @${(share * 100).toFixed(0)}%`;
}

/** Largest per-channel difference, in 8-bit terms. RGB565 quantises hard. */
function colourDistance(
  dominant: PanelReading["dominant"],
  target: { b: number; g: number; r: number },
): number {
  return Math.max(
    Math.abs(dominant.r - target.r),
    Math.abs(dominant.g - target.g),
    Math.abs(dominant.b - target.b),
  );
}

/**
 * Watch a stream for the device's own telemetry.
 *
 * Used across a reboot: `voicelab/dev-stats` reappearing on the SAME path is
 * the host-visible form of the boot log's `resuming remembered conversation`,
 * which is stored in NVS and can otherwise only be read over serial.
 */
async function watchStream(itx: Awaited<ReturnType<typeof connectProject>>, path: string) {
  let seen = 0;
  const connection = await itx.streams.get(path).openConnection({
    connectionKey: `prove-restart-${Date.now()}`,
    eventTypes: ["voice-agent/dev-stats"],
    processEventBatch: (batch: { events: unknown[] }) => {
      seen += batch.events.length;
    },
  });
  return {
    close: () => connection.close(),
    async sawAfter(windowMs: number) {
      const from = seen;
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        if (seen > from) return true;
        await sleep(1000);
      }
      return false;
    },
  };
}

/** Run something and keep both outcomes, because both are evidence. */
async function attempt<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { error: string; ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (caught) {
    return { error: errorText(caught), ok: false };
  }
}

function errorText(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  return String(caught);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
