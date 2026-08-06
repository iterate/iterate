// Ten short calls instead of one long one.
//
// `soak` holds ONE call open for an hour. `stress` takes 120 turns on ONE call
// with minutes of unbroken audio in them. Both ask "does it last?", and both
// cross the boundaries that actually break — installing the server side,
// getting a call live, the FIRST answer on a playout that has never opened,
// hanging up, and coming back to a device whose last conversation is still
// warm — exactly ONCE each, at the top of the run.
//
// Frequency beats duration for those. This runs N independent sessions of about
// three minutes each, and every session does the whole arc:
//
//   SETUP → CALL → A HANDFUL OF TURNS → TEARDOWN → REMOUNT
//
// The turns are deliberately SHORT and MEDIUM. The point is not more speech,
// it is more TRANSITIONS: a turn asked the instant the call goes live, two
// turns with no gap between them, a blank turn, a one-word turn, a turn on top
// of an answer that is still playing, a turn after half a minute of silence,
// and a hang-up in the middle of a sentence.
//
// The bar is absolute and deliberately unkind: EVERY session must be flawless.
// Every clean turn must have `sent == played` — not "a low loss percentage",
// zero frames lost — and no counter in the never-moves tier may move anywhere,
// least of all `spkOverflow`, which is the known defect this device has (a
// 90-minute run once lost 30% of its audio to it). Two cases DO cancel an
// answer on purpose; each one declares exactly which counters that licenses and
// the report attributes their movement to the case by name. There is no
// tolerated bucket, and nothing is allowed through quietly.
//
//   doppler run --config preview_3 -- pnpm cli voicelab sessions \
//     --project prj_… --path /agents/voice/dev-… --sessions 10 \
//     --out /tmp/sessions.json
import fs from "node:fs";

import type { DynamicWorkerCapability } from "iterate/sdk";

import { bringCallUp, waitForQuietPlayout } from "./call.ts";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import {
  DAMAGE_MUST_NOT_MOVE,
  type DeviceStats,
  FRAME_MS,
  movedCounters,
  MUST_NOT_MOVE,
  spread,
  TOLERATED_COUNTERS,
} from "./device-stats.ts";
import { installVoiceAgent } from "./deploy.ts";
import { voiceAgentEntrypointRef } from "./voice-agent-ref.ts";
import { watchStream } from "./watch.ts";

/**
 * How many full-plan sessions constitute a proof.
 *
 * Ten, because the value is in the boundaries — setup, call, teardown, remount —
 * and one long session crosses each of them exactly once. Fewer than this is a
 * check on the harness, and `summary.proof` says so rather than letting a green
 * one-session run read as a passing device.
 */
const PROOF_SESSIONS = 10;

/** Options for `pnpm cli voicelab sessions`. */
export interface SessionsOptions extends VoicelabConnectOptions {
  /** Independent sessions to run. Ten is the proof; one or two is a smoke test. */
  sessions?: number;
  /**
   * Longest the call may take to go live, in ms.
   *
   * A device that answers perfectly but takes most a minute to pick up is not
   * the thing being asked for: the point of ten short sessions is that getting
   * INTO a call is fast and repeatable. 15s against a normal 7-10s, so an
   * ordinary bring-up has room and a cold-start does not pass unnoticed.
   */
  callLiveMs?: number;
  /** Stream the call rides on, and where the device is mounted. */
  path?: string;
  /** Capability the device mounts itself under (itx.kit.<name>). */
  name?: string;
  /** Write every session, turn and sample here as JSON. */
  out?: string;
  /**
   * What to remount between sessions: `server`, `device`, `both` or `none`.
   *
   * `server` kills the bridge and processor Durable Objects and removes the
   * stream's subscription, so the next session's setup has to install it again
   * and dials a bridge that has never run. `device` reboots the board, which is
   * the strongest boundary there is and costs ~30s of every session. `none`
   * measures the same sessions against a warm mount, which is how you tell a
   * remount bug from a session bug.
   */
  remount?: string;
  /** Seconds the `after-idle` case sits saying nothing before it speaks. */
  idle?: number;
  /** Seconds to let an answer play before a case that cuts it does so. */
  cutAfter?: number;
  /** Seconds of quiet between turns that are not asked back-to-back. */
  settle?: number;
  /** Seconds one answer's playout gets to drain before the turn is a miss. */
  drain?: number;
  /** Milliseconds a turn may take to produce its first speaker frame. */
  firstAudioMs?: number;
  /** Milliseconds a SHORT answer may take to finish generating. */
  doneShortMs?: number;
  /** Milliseconds a MEDIUM answer may take to finish generating. */
  doneMediumMs?: number;
  /**
   * Commit `config-repo/voice-agent.ts` from this checkout before the run.
   *
   * Off by default, unlike `talk`. This command measures session boundaries
   * against whatever server side the project is already running, and quietly
   * deploying a working copy that somebody is still editing would change the
   * thing under test halfway through a proof.
   */
  install?: boolean;
  /**
   * Run only these cases, by id, comma-separated — for shaking the harness out
   * in two minutes. A filtered run is a smoke test and never a proof; the
   * summary says so.
   */
  cases?: string;
}

/* ---- What a counter moving means -------------------------------------- */

/**
 * Where one device counter sits in this harness's ledger.
 *
 * This table is where the honesty lives. `device-stats.ts` groups counters by
 * what a healthy LONG call does; a repeat-session run is stricter, because it
 * asks for perfection over three minutes rather than an acceptable slope over
 * ninety. The regrouping is explicit — one row per counter, with the reason —
 * so nothing can drift into being tolerated by accident.
 */
interface CounterPolicy {
  key: string;
  /**
   * `never` — movement fails the run wherever it happens, including inside a
   * case that deliberately cancels an answer. These are damage no design
   * choice of ours can explain.
   *
   * `cut-only` — a clean turn must not move it, but the two cases that cancel
   * an answer mid-playout may: cancelling is what they count. Movement is
   * attributed to the case by name and reported separately, never summed away.
   *
   * `noted` — moves in every healthy call, so it cannot be used to fail one.
   * Reported anyway, because the SIZE is diagnostic even when the existence is
   * not.
   */
  tier: "never" | "cut-only" | "noted";
  /** Why it is in that tier. */
  why: string;
}

const COUNTER_POLICY: readonly CounterPolicy[] = [
  {
    key: "spkOverflow",
    tier: "never",
    why: "the known defect: sustained audio overflows the playout ring and the listener hears a truncated answer. A 90-minute run lost 30% of its audio here. Never allowed, not even inside a cut — raising this is how that run would have 'passed'.",
  },
  {
    key: "spkSeqGaps",
    tier: "never",
    why: "a hole in the frame sequence — audio that never arrived at all.",
  },
  { key: "spkWriteFailures", tier: "never", why: "frames the DAC would not take." },
  { key: "spkBadFrames", tier: "never", why: "frames the device could not parse." },
  { key: "spkDecodeFailures", tier: "never", why: "frames the device could not decode." },
  { key: "frameFailures", tier: "never", why: "microphone frames the device could not send." },
  { key: "sendFailures", tier: "never", why: "transport writes that failed." },
  { key: "recvFailures", tier: "never", why: "transport reads that failed." },
  { key: "protoFailures", tier: "never", why: "a message neither side could make sense of." },
  { key: "inboxDiscarded", tier: "never", why: "inbound work dropped for want of room." },
  { key: "outboxDiscarded", tier: "never", why: "outbound work dropped for want of room." },
  { key: "pingFailures", tier: "never", why: "a liveness probe that went unanswered." },
  {
    key: "livenessRestarts",
    tier: "never",
    why: "the device restarted its own transport — the session under test was replaced underneath it.",
  },
  {
    key: "bridgeLosses",
    tier: "never",
    why: "the device lost the bridge holding its call.",
  },
  { key: "micDropped", tier: "never", why: "captured speech the device threw away." },
  {
    key: "lowerReadFailures",
    tier: "never",
    why: "button reads the device could not complete (older firmware calls it talkReadFailures).",
  },
  { key: "talkReadFailures", tier: "never", why: "the pre-rename name of lowerReadFailures." },
  {
    key: "spkSoftDryRefills",
    tier: "noted",
    why:
      "audio arriving within a second of a dry software buffer — the same source-lateness signal " +
      "as spkConceal, one step later, and absorbed by the same hardware ring. A one-word answer " +
      "provokes it because the answer ends before response.done lands. Not a listener-visible " +
      "defect on its own; spkStarvedMs is",
  },

  {
    key: "spkSoftDryTicks",
    tier: "noted",
    why:
      "the playout clock covering a SOFTWARE buffer that went dry — which the 90ms hardware " +
      "ring then absorbs, so it is source lateness rather than an audible gap. The firmware's own " +
      "comment at the increment says it 'no longer costs the listener anything'. Measured on the " +
      "exact turns that moved it: spkStarvedMs 0 and sent == played, so the DAC never ran dry. " +
      "spkStarvedMs is the gate for what a listener hears",
  },

  {
    key: "spkStarvedMs",
    tier: "never",
    why:
      "milliseconds the DAC spent with an empty ring while the device was meant to be feeding " +
      "it — measured on the writing task against an absolute audio-empty deadline, so it does " +
      "not depend on the DMA driver issuing callbacks during a gap. This is THE starvation " +
      "gate: a listener heard silence where speech should have been.",
  },
  {
    key: "spkStarveEvents",
    tier: "never",
    why: "how many separate times the ring ran dry mid-answer. Same gate, counted rather than summed.",
  },
  {
    key: "dmaLedgerDeficit",
    tier: "noted",
    why:
      "an epoch-relative ledger deficit in the DMA ISR, NOT starvation. An intentional cut " +
      "discards the software buffer but not the hardware ring, so descriptors credited in the " +
      "previous feeding epoch arrive after the re-arm has zeroed the ledger. Measured across " +
      "one barge-in: written fell 380ms to 20ms and eleven such descriptors landed — charged to " +
      "dmaOpening that time and to this counter on an earlier run, differing only by timing. " +
      "spkStarvedMs is the gate; this is for diagnosis.",
  },

  {
    key: "dmaDraining",
    tier: "noted",
    why:
      "cleared descriptors the hardware sent after the source went dry — the normal end of " +
      "every answer. The ring is 90ms deep and the speaker task waits 60ms for a frame that is " +
      "not coming, so this moves 5-12 times per short turn on a turn where every frame sent " +
      "was played. It used to land in dmaUnderruns, which is what disqualified session 1.",
  },
  {
    key: "spkDiscarded",
    tier: "cut-only",
    why: "frames the playout threw away. On a cut that is the answer being abandoned; on a clean turn it is a truncated answer.",
  },
  {
    key: "spkAnswerStarts",
    tier: "noted",
    why:
      "one per answer, always: every answer begins by displacing the last, so the device's own " +
      "REPLACE path fires on a perfect turn. This was published as spkReplaced and tiered as a " +
      "fault, which made every clean turn look damaged. The subset that actually costs audio is " +
      "spkSupersededMidplay.",
  },
  {
    key: "spkSupersededMidplay",
    tier: "cut-only",
    why:
      "an answer displaced while it was STILL PLAYING — queued audio thrown away. This is what " +
      "a barge-in does deliberately and what nothing else may do.",
  },
  {
    key: "spkIgnoredStale",
    tier: "cut-only",
    why: "frames refused for belonging to an answer that has been superseded.",
  },
  {
    key: "spkIgnoredCall",
    tier: "cut-only",
    why: "frames refused for belonging to a call that has ended — the hang-up case in one number.",
  },
  {
    key: "spkIgnoredDup",
    tier: "cut-only",
    why: "frames refused as duplicates. Measured once eating a WHOLE first answer of a call started right after a previous one, which is precisely the boundary this command crosses ten times — so on a clean turn it fails the run.",
  },
  {
    key: "spkCatchup",
    tier: "cut-only",
    why: "the playout skipped ahead to pay off lag: heard as a stutter, so never acceptable on a clean turn.",
  },
  {
    key: "spkDebtPaid",
    tier: "cut-only",
    why: "the other half of catch-up accounting; same reasoning.",
  },
  {
    key: "spkAnswerDrains",
    tier: "noted",
    why:
      "one per answer, always: the source going dry IS how an answer ends. Published as " +
      "spkWaitDry and tiered as a fault on the belief it measured zero across a 26-minute " +
      "call; it measured 62 across 62 turns, which is once each.",
  },
  {
    key: "bargeIns",
    tier: "cut-only",
    why: "the device counting its own interruptions. Expected on the barge-in case and nowhere else.",
  },
  {
    key: "dmaOpening",
    tier: "noted",
    why: "the DAC opens once per answer; it moves on every healthy turn.",
  },
  {
    key: "spkWaitPriming",
    tier: "noted",
    why: "ticks while the playout waits to prime; already in the hundreds of thousands on an idle device.",
  },
  {
    key: "inboxDeferrals",
    tier: "noted",
    why: "work deferred to the next tick rather than dropped — back-pressure working as designed.",
  },
  {
    key: "downlinkRecycles",
    tier: "noted",
    why: "make-before-break replacement of the downlink connection. It loses nothing, and if it ever did, the sent-equals-played gate would say so.",
  },
];

/** Every counter this harness watches, in one list for the delta reader. */
const WATCHED = COUNTER_POLICY.map((policy) => policy.key);
/** Counters whose movement fails a session wherever it happens. */
const NEVER_MOVES = COUNTER_POLICY.filter((policy) => policy.tier === "never").map(
  (policy) => policy.key,
);
/** Counters only a deliberate cut may move. */
const CUT_ONLY = COUNTER_POLICY.filter((policy) => policy.tier === "cut-only").map(
  (policy) => policy.key,
);
/** Counters reported for their size and never used to fail anything. */
const NOTED = COUNTER_POLICY.filter((policy) => policy.tier === "noted").map(
  (policy) => policy.key,
);

/**
 * Fail at startup if `device-stats.ts` knows a counter this table does not.
 *
 * A counter added to the device and classified there but not here would be
 * silently unwatched: no tier, no failure, no mention in the report. That is
 * exactly the shape of a defect that gets shipped, so it is a crash rather
 * than a warning.
 */
function assertPolicyCoversEveryKnownCounter(): void {
  const missing = [...MUST_NOT_MOVE, ...DAMAGE_MUST_NOT_MOVE, ...TOLERATED_COUNTERS].filter(
    (key) => !WATCHED.includes(key),
  );
  if (missing.length > 0) {
    throw new Error(
      `sessions.ts has no policy for ${missing.join(", ")} — every counter device-stats.ts ` +
        `classifies must be given a tier here, or a run can pass while it moves.`,
    );
  }
}

/** One end of one call, as the stream reported it. */
export interface ObservedCallEnd {
  atMs: number;
  conversationId: string | null;
  reason: string;
}

/** One acceptance or one refusal of a call start, as the stream reported it. */
export interface ObservedCallStart {
  atMs: number;
  conversationId: string | null;
  /** Absent on an acceptance; the refusal's reason otherwise. */
  reason?: string;
}

/**
 * What is wrong with how this session's call got started.
 *
 * A session asks for ONE call and must get exactly one, started once. Anything
 * else means two bridges raced for it, and the loser says so on the stream:
 * `conversation-failed: superseded by a newer bridge`.
 *
 * This exists because a session passed with that exact event in it. The first
 * `conversation-requested` after a remount went unanswered for eight seconds while the
 * bridge worker built, the device re-asked — correctly, a request can be lost —
 * and both bridges then entered within a second of each other. The only symptom
 * the harness noticed was the 16.2s time to go live; the double-start itself was
 * invisible, so a faster machine would have hidden the defect entirely.
 */
export function callStartProblems(
  accepted: readonly ObservedCallStart[],
  failed: readonly ObservedCallStart[],
  requested: readonly ObservedCallStart[] = [],
): string[] {
  const problems: string[] = [];
  if (requested.length > 1) {
    problems.push(
      `starting one call took ${requested.length} requests, so the first one was not answered: ` +
        requested
          .map(
            (one) =>
              `${(one.atMs / 1000).toFixed(0)}s[${one.conversationId ?? "no conversationId"}]`,
          )
          .join(", "),
    );
  }
  if (accepted.length > 1) {
    problems.push(
      `the call was accepted ${accepted.length} times, so more than one bridge served one ` +
        `request: ` +
        accepted
          .map(
            (one) =>
              `${(one.atMs / 1000).toFixed(0)}s[${one.conversationId ?? "no conversationId"}]`,
          )
          .join(", "),
    );
  }
  for (const failure of failed) {
    problems.push(
      `starting the call failed once before it worked: ` +
        `${failure.reason ?? "unknown"}@${(failure.atMs / 1000).toFixed(0)}s` +
        `[${failure.conversationId ?? "no conversationId"}]`,
    );
  }
  return problems;
}

/** A hang-up this harness issued and the device accepted: which call, and when. */
export interface AskedCallEnd {
  conversationId: string;
  /** Session time the request went out. Nothing it caused can predate it. */
  issuedAtMs: number;
}

/**
 * How long after a hang-up the two expected reports of it may still arrive.
 *
 * ONE transition is reported TWICE by design: the device appends conversation-ended with
 * its own reason, and the worker bridge — watching the same stream, gated on the
 * conversationId — appends its own when it tears down. Measured on this hardware, the
 * bridge's echo lands about a second behind the device's.
 *
 * Ten seconds, so a busy bridge still reconciles while a call that dies a turn
 * later cannot borrow this hang-up as its excuse.
 */
const CALL_END_ECHO_WINDOW_MS = 10_000;

/** Which observer reported an end. The bridge names itself; the device does not. */
function callEndSource(reason: string): "bridge" | "device" {
  return reason.startsWith("worker bridge:") ? "bridge" : "device";
}

/** One observed end that no hang-up accounts for, and what is wrong with it. */
export interface UnreconciledCallEnd {
  end: ObservedCallEnd;
  why: string;
}

/**
 * Reconcile the ends observed on the stream against the hang-ups this harness
 * asked for — explicitly, by call, by observer, and inside a bounded window.
 *
 * Two earlier shapes of this were both wrong, in opposite directions. Counting
 * ends against a count of asks failed a healthy session on the bridge's echo of
 * the very hang-up that was requested. Excusing EVERY end naming an asked call
 * fixed that by being loose: it would equally excuse a third report, or a report
 * arriving a minute later from something else entirely.
 *
 * So each hang-up explains at most one report from each of the two known
 * observers, for exactly its call, within the window after it was issued.
 * Anything else — a third report, another call's end, a late one, an anonymous
 * one, or any end at all when no hang-up succeeded against a live call — is
 * returned for the session to fail on.
 */
export function reconcileCallEnds(
  ends: readonly ObservedCallEnd[],
  asked: readonly AskedCallEnd[],
): UnreconciledCallEnd[] {
  /** Per hang-up, which of the two observers has already been heard from. */
  const heard = new Map<string, Set<"bridge" | "device">>();
  const problems: UnreconciledCallEnd[] = [];
  for (const end of ends) {
    if (end.conversationId === null) {
      /* Every end this harness asks for names its call, so an anonymous one
       * came from somewhere this accounting cannot vouch for. */
      problems.push({ end, why: "the end did not name a call" });
      continue;
    }
    const forThisCall = asked.filter((ask) => ask.conversationId === end.conversationId);
    const ask = forThisCall.find(
      (candidate) =>
        end.atMs >= candidate.issuedAtMs &&
        end.atMs <= candidate.issuedAtMs + CALL_END_ECHO_WINDOW_MS,
    );
    if (ask === undefined) {
      problems.push({
        end,
        why:
          forThisCall.length === 0
            ? "no hang-up was asked for this call"
            : `it arrived outside the ${CALL_END_ECHO_WINDOW_MS / 1000}s window after the ` +
              `hang-up at ${(forThisCall[0]!.issuedAtMs / 1000).toFixed(0)}s`,
      });
      continue;
    }
    const key = `${ask.conversationId}@${String(ask.issuedAtMs)}`;
    const already = heard.get(key) ?? new Set<"bridge" | "device">();
    const source = callEndSource(end.reason);
    if (already.has(source)) {
      problems.push({ end, why: `the ${source} reported this same end twice` });
      continue;
    }
    already.add(source);
    heard.set(key, already);
  }
  return problems;
}

/* ---- The plan every session runs ------------------------------------- */

/** How much audio a prompt is meant to draw, and whether it is meant to draw any. */
type PromptClass = "short" | "medium" | "silent";

/**
 * One step of the fixed per-session plan.
 *
 * Fixed rather than random, and identical in every session, because the whole
 * value of ten sessions is that they are comparable: a failure that happens in
 * session 7 and not in session 1 is about the boundary, not about which
 * question got asked.
 */
interface SessionStep {
  /** Stable id. Printed on the progress line and used in every failure message. */
  id: string;
  /** What this step is FOR — the thing that would go unmeasured without it. */
  proves: string;
  promptClass: PromptClass;
  text: string;
  /**
   * How this turn opens relative to the previous one: `none` is the instant the
   * previous playout went quiet (queueing), `settle` leaves a gap, `idle` waits
   * out `--idle` seconds of silence first.
   */
  gap: "none" | "settle" | "idle";
  /**
   * Second prompt, appended while the first answer is still playing.
   *
   * The barge-in case in one step rather than two, because a 5s telemetry
   * cadence cannot split the two answers' frames apart: the pair shares one
   * counter window and one licence to lose audio.
   */
  interruptWith?: string;
  /**
   * How this step deliberately destroys an answer, if it does.
   *
   * The only thing that licenses lost audio and the cut-only counters, and it
   * is always named in the report next to the movement it explains.
   */
  cut?: "barge-in" | "hangup";
  /**
   * The device could not report at all: it answered, produced no telemetry, and
   * never started its speaker. Every later turn would repeat it, so the run
   * stops rather than restating it.
   */
  deviceWideBreakage?: boolean;
  /** Which answer-complete limit applies, if any. */
  doneLimit: "short" | "medium" | "none";
}

const PLAN: readonly SessionStep[] = [
  {
    doneLimit: "short",
    gap: "none",
    id: "cold-first-turn",
    proves:
      "the first answer of a fresh call, asked the instant the bridge says the call is live: " +
      "a playout that has never opened, a codec that has never been driven, and — from session " +
      "two on — a mount that was remounted seconds ago. This is where a device that refuses a " +
      "whole answer as duplicate audio refuses it.",
    promptClass: "short",
    text: "In one sentence: why is the sky blue?",
  },
  {
    doneLimit: "short",
    gap: "none",
    id: "back-to-back",
    proves:
      "queueing: the next question goes in the moment the previous answer finishes playing, " +
      "with no settle at all, so a device that needs a breath between turns has nowhere to take it.",
    promptClass: "short",
    text: "Name one bird that cannot fly. One sentence.",
  },
  {
    doneLimit: "short",
    gap: "settle",
    id: "one-word",
    proves:
      "a degenerate prompt still gets a real turn: one word in, an answer out, and no " +
      "difference in the audio path.",
    promptClass: "short",
    text: "Hi.",
  },
  {
    doneLimit: "none",
    gap: "settle",
    id: "whitespace-prompt",
    proves:
      "a blank turn disturbs nothing. The bridge drops a say whose text trims to empty, so the " +
      "right outcome is silence: no response, no frames, no counter movement — and the next " +
      "turn unaffected.",
    promptClass: "silent",
    text: "   ",
  },
  {
    cut: "barge-in",
    doneLimit: "short",
    gap: "settle",
    id: "barge-in",
    interruptWith: "Actually, stop — just tell me one word for the colour of the sea.",
    proves:
      "interrupting an answer that is still playing. The paragraph is cancelled on purpose, so " +
      "this case is licensed to lose the audio the listener was never going to hear — and the " +
      "answer that displaces it must still arrive, play, and leave the call healthy.",
    promptClass: "medium",
    text: "In about five sentences, and in your own words, explain how a microphone works.",
  },
  {
    doneLimit: "short",
    gap: "idle",
    id: "after-idle",
    proves:
      "a call that sat saying nothing for half a minute and then had to answer at once. Idle " +
      "is where a connection quietly dies and where a device parks buffers it will need back.",
    promptClass: "short",
    text: "In one sentence, what is thunder?",
  },
  {
    cut: "hangup",
    doneLimit: "none",
    gap: "settle",
    id: "hangup-mid-playout",
    proves:
      "tearing the call down mid-sentence, which is what a person does when they have heard " +
      "enough. Licensed to lose the rest of the answer; NOT licensed to leave a stuck call, a " +
      "wedged playout, or a counter in the never-moves tier moved.",
    promptClass: "medium",
    text: "Describe a rainy afternoon in a harbour town, in a paragraph of your own.",
  },
];

/**
 * How long an answer of each class gets to finish generating before the turn is
 * a miss. Not the latency limit — that is an option and much tighter; this is
 * only the point at which waiting stops.
 */
const ANSWER_TIMEOUT_MS: Record<PromptClass, number> = {
  medium: 120_000,
  short: 45_000,
  silent: 10_000,
};

/** How long to wait for the first speaker frame of an answer this run will cut. */
const CUT_FIRST_AUDIO_TIMEOUT_MS = 30_000;

/* ---- What gets recorded ---------------------------------------------- */

/** What to remount between sessions. */
type RemountMode = "server" | "device" | "both" | "none";
const REMOUNT_MODES: readonly RemountMode[] = ["server", "device", "both", "none"];

/** One measured turn. Every millisecond and every frame is per-turn on purpose. */
interface SessionTurn {
  index: number;
  /** The plan step's id — the name every failure about this turn uses. */
  id: string;
  proves: string;
  promptClass: PromptClass;
  prompt: string;
  /**
   * How this turn destroyed its own answer on purpose, if it did.
   *
   * Carried on the record rather than looked up from the plan, because it is
   * the flag that decides whether this turn's lost audio and counter movement
   * were licensed — and a reader of the JSON must be able to see that without
   * holding the plan in their head.
   */
  cut?: "barge-in" | "hangup";
  /** The prompt that interrupted this one, on the barge-in case. */
  interruptPrompt?: string;
  /** Milliseconds since this session began, when the prompt was appended. */
  atMs: number;
  /** Prompt to `response.created` — the provider accepting the turn. */
  thinkingMs?: number;
  /** Prompt to the first speaker frame on the stream. The real first audio. */
  firstAudioMs?: number;
  /** Interrupting prompt to ITS first speaker frame, on the barge-in case. */
  interruptFirstAudioMs?: number;
  /** Prompt (or interrupting prompt) to `response.done`. */
  answeredMs?: number;
  /** Prompt to the device's speaker going quiet. The end of the answer. */
  playedOutMs?: number;
  /** When this turn hung the call up, on the hangup case. */
  hangUpAtMs?: number;
  sentFrames?: number;
  playedFrames?: number;
  /**
   * Frames delivered and never heard: `sentFrames - playedFrames`.
   *
   * The only honest measure of a truncated answer, because the device counts
   * each way of losing a frame separately and a metric named after one cause
   * reads zero while the listener hears half an answer.
   */
  lostFrames?: number;
  sentAudioMs?: number;
  playedAudioMs?: number;
  /** The case that licensed this turn's lost audio, when one did. */
  lostAttributedTo?: string;
  playout?: "quiet" | "never started" | "still playing" | "not awaited";
  /** Every watched counter that moved during this turn's window. */
  counters?: Record<string, number>;
  /** The movement this turn's cut licensed, kept apart from the fatal ledger. */
  attributed?: Record<string, number>;
  heapFree?: number;
  psramFree?: number;
  ringMarginMaxMs?: number;
  transcript?: string;
  /** Everything wrong with this turn, each naming the counter or the threshold. */
  failures: string[];
  /**
   * The device could not report at all: it answered, produced no telemetry, and
   * never started its speaker. Every later turn would repeat it, so the run
   * stops rather than restating it seven times.
   */
  deviceWideBreakage?: boolean;
  /** The call ended during this turn, so the session stopped here. */
  callDiedHere?: boolean;
  /** A never-tier gate moved on this turn: the run stops at once. */
  neverTierBreach?: boolean;
}

/** A check with no audio in it: idempotency, teardown, the state afterwards. */
interface SessionProbe {
  id: string;
  proves: string;
  atMs: number;
  ok: boolean;
  detail: string;
}

/** What remounting did, and the evidence that it happened. */
interface RemountReport {
  mode: RemountMode;
  ms: number;
  /** Subscription and worker keys the server side reported removing. */
  removed?: string[];
  /** How long the device took to come back, when it was rebooted. */
  bootMs?: number;
  /** The reading that proves the mount is new rather than the old one warmed. */
  proof?: string;
  failures: string[];
}

/** One whole session: setup, call, turns, teardown, and its own verdict. */
interface SessionReport {
  index: number;
  /** Milliseconds since the run began. */
  atMs: number;
  durationMs: number;
  remount?: RemountReport;
  /** Milliseconds `setupVoiceAgent` took, what it created, and its warm proof. */
  setup?: {
    ms: number;
    created: string[];
    alreadyThere: number;
    /** The processor answered a warm-up token carrying the brief just installed. */
    warmOk: boolean;
    warmMs: number;
  };
  /** Press-call to the bridge saying it has the call. */
  callLiveMs?: number;
  turns: SessionTurn[];
  probes: SessionProbe[];
  /** Distinct `sessionGeneration` readings inside this session. Must be one. */
  sessionGenerations: number[];
  connGenerations: number[];
  /** Times the device's uptime went backwards: a reboot mid-session. */
  reboots: number;
  /**
   * Session-wide counter movement no turn's cut accounted for.
   *
   * The gaps between turns are inside this window too, so a counter that moves
   * while nothing is being asked has nowhere to hide.
   */
  unattributed: Record<string, number>;
  /** Movement in the noted tier, for size rather than for judgement. */
  noted: Record<string, number>;
  statsSamples: number;
  bridgeRedials: number;
  watchReopens: number;
  deviceQuietPeriods: number;
  failures: string[];
  verdict: "PASS" | "FAIL";
}

/** The device's control surface, as this command uses it. */
interface DeviceCapability {
  conversation: { start(): Promise<boolean>; hangUp(): Promise<boolean> };
  /** Reboots the board. The strongest remount boundary available from here. */
  restart(): Promise<boolean>;
  /**
   * ~70 live numbers, the same object dev-stats publishes.
   *
   * Asked directly rather than waited for, because telemetry stops exactly
   * when the device stops working and this does not.
   */
  health(): Promise<Record<string, unknown>>;
}

/** The guest worker's setup surface, as committed in `config-repo/voice-agent.ts`. */
interface VoiceAgentSurface {
  health(): Promise<{ ok: true; projectId: string; xaiSecretReady: boolean }>;
  setupVoiceAgent(options: { streamPath: string }): Promise<{
    streamPath: string;
    created: string[];
    alreadyThere: string[];
    /** The processor's own acknowledgement that it is awake and sees the brief. */
    warm: {
      ok: boolean;
      ms: number;
      acknowledged: boolean;
      briefMatched: boolean;
      protocolRevision?: string;
      error?: string;
    };
  }>;
  removeVoiceAgent(options: {
    streamPath: string;
  }): Promise<{ removed: string[]; alreadyAbsent: string[] }>;
}

/** One dev-stats sample plus when this process saw it, in session time. */
interface StatsSample extends DeviceStats {
  atMs: number;
}

/** The answer currently in flight, filled by the watcher and read by the turn. */
interface AnswerInFlight {
  createdAt: number;
  firstTranscriptAt: number;
  doneAt: number;
  text: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ProjectConnection = Awaited<ReturnType<typeof connectProject>>;

/** Dispose an itx connection without caring whether it is already gone. */
function closeConnection(itx: ProjectConnection): void {
  try {
    (itx as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  } catch {
    /* already gone; a dead session is what we wanted anyway */
  }
}

/**
 * Wait until the guest worker answers.
 *
 * A dynamic worker is built on the first call into it, so that first call is
 * both the slowest and the only one that can fail for reasons unrelated to what
 * was asked. Doing it deliberately means a compile error is reported as a
 * compile error rather than as "the session would not start".
 */
async function awaitVoiceAgentBuild(
  agent: DynamicWorkerCapability<VoiceAgentSurface>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      await agent.health();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await sleep(1000);
    }
  }
  throw new Error(
    `the voice-agent guest did not become healthy within ${timeoutMs / 1000}s. This is ` +
      `usually a compile error in the committed voice-agent.ts. The last error was:\n` +
      String(lastError),
  );
}

export async function sessions(options: SessionsOptions) {
  assertPolicyCoversEveryKnownCounter();

  const wanted = options.sessions ?? 10;
  const streamPath = options.path ?? "/agents/voice/device";
  const capabilityName = options.name ?? "waveshare";
  const remountOption = options.remount ?? "server";
  if (!REMOUNT_MODES.some((mode) => mode === remountOption)) {
    throw new Error(
      `--remount must be one of ${REMOUNT_MODES.join(", ")}; received ${JSON.stringify(remountOption)}`,
    );
  }
  const remount = remountOption as RemountMode;
  const limits = {
    doneMediumMs: options.doneMediumMs ?? 60_000,
    callLiveMs: options.callLiveMs ?? 15_000,
    doneShortMs: options.doneShortMs ?? 6000,
    firstAudioMs: options.firstAudioMs ?? 2000,
  };
  const timings = {
    cutAfterMs: Math.round((options.cutAfter ?? 2.5) * 1000),
    drainMs: (options.drain ?? 90) * 1000,
    idleMs: (options.idle ?? 30) * 1000,
    settleMs: (options.settle ?? 3) * 1000,
  };
  const only = options.cases
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const plan = only ? PLAN.filter((step) => only.includes(step.id)) : PLAN;
  if (plan.length === 0) {
    throw new Error(
      `--cases matched no step. The plan is: ${PLAN.map((step) => step.id).join(", ")}`,
    );
  }

  const runStartedAt = Date.now();
  const sinceRun = () => Date.now() - runStartedAt;
  const say = (what: string) => console.error(`[${(sinceRun() / 1000).toFixed(0)}s] ${what}`);

  if (options.install) {
    const itx = await connectProject(options);
    try {
      const install = await installVoiceAgent(itx);
      say(
        install.changed
          ? `installed voice-agent.ts (${install.commitOid.slice(0, 8)})`
          : `voice-agent.ts already current (${install.commitOid.slice(0, 8)})`,
      );
    } finally {
      closeConnection(itx);
    }
  }

  say(
    `${wanted} independent session(s) on ${streamPath}, remount=${remount}. ` +
      `Each one: setup, call, ${plan.length} turn(s), teardown.`,
  );
  for (const step of plan) say(`  · ${step.id} (${step.promptClass}${step.cut ? ", cuts" : ""})`);

  const reports: SessionReport[] = [];
  /** Every sample from every session, for the timeline in `--out`. */
  const allSamples: (StatsSample & { session: number })[] = [];

  for (let index = 1; index <= wanted; index++) {
    const report = await runSession({
      capabilityName,
      index,
      limits,
      options,
      plan,
      /*
       * EVERY session starts from a boundary this harness crossed on purpose,
       * including the first.
       *
       * Session one used to start from whatever state the device happened to be
       * in, which quietly made it the easiest session of the run: warm bridge,
       * warm processor, warm mount. Worse, it was warm for a reason nobody could
       * see — a warm-up probe run by hand minutes earlier is enough — so cycle
       * one measured the fix's own preparation rather than the fix.
       */
      remount,
      runStartedAt,
      samples: allSamples,
      streamPath,
      timings,
    });
    if (report.callLiveMs !== undefined && report.callLiveMs > limits.callLiveMs) {
      report.failures.push(
        `the call took ${(report.callLiveMs / 1000).toFixed(1)}s to go live, over the ` +
          `${(limits.callLiveMs / 1000).toFixed(0)}s limit — a session that is slow to pick ` +
          `up is not a fast repeatable session, however well the audio then behaves`,
      );
      report.verdict = "FAIL";
    }
    reports.push(report);
    /*
     * ANY failed session ends the run.
     *
     * Ten sessions is a proof of repeatability, and repeatability is already
     * disproved the moment one session fails — the remaining nine cost three
     * minutes each and cannot change the verdict. Measured: a failed session 1
     * was followed by a pointless session 2 before anybody noticed.
     */
    if (report.verdict === "FAIL") {
      say(
        `stopping the run after session ${report.index}: it failed, so this is already not a ` +
          `proof of ${PROOF_SESSIONS} clean sessions. Fix the failure and start again from one.`,
      );
      break;
    }
    if (report.turns.some((turn) => turn.neverTierBreach)) {
      say(
        `stopping the run after session ${report.index}: a never-tier gate moved. That is a ` +
          `release blocker; fix it and start the ten again from one.`,
      );
      break;
    }
    if (report.turns.some((turn) => turn.deviceWideBreakage)) {
      say(
        `stopping the run after session ${report.index}: the device is not reporting. ` +
          `Fix that before spending more sessions on it.`,
      );
      break;
    }
    say(
      `session ${index}/${wanted}: ${report.verdict}` +
        (report.failures.length > 0 ? ` — ${report.failures[0]}` : "") +
        ` (${(report.durationMs / 1000).toFixed(0)}s)`,
    );
  }

  /* ---- The verdict, which is 10/10 or nothing ------------------------ */

  const failures: string[] = [];
  for (const report of reports) {
    for (const failure of report.failures) failures.push(`session ${report.index}: ${failure}`);
  }
  const cleanTurns = reports.flatMap((report) =>
    report.turns.filter((turn) => turn.cut === undefined && turn.promptClass !== "silent"),
  );
  const everyTurn = reports.flatMap((report) => report.turns);
  const attributedByCase: Record<string, Record<string, number>> = {};
  for (const turn of everyTurn) {
    if (!turn.attributed) continue;
    const bucket = (attributedByCase[turn.id] ??= {});
    for (const [key, delta] of Object.entries(turn.attributed)) {
      bucket[key] = (bucket[key] ?? 0) + delta;
    }
    if ((turn.lostFrames ?? 0) > 0) {
      bucket.lostFrames = (bucket.lostFrames ?? 0) + (turn.lostFrames ?? 0);
    }
  }
  const notedTotals: Record<string, number> = {};
  for (const report of reports) {
    for (const [key, delta] of Object.entries(report.noted)) {
      notedTotals[key] = (notedTotals[key] ?? 0) + delta;
    }
  }

  const summary = {
    verdict:
      failures.length === 0 && reports.length === wanted ? ("PASS" as const) : ("FAIL" as const),
    /**
     * A filtered run is a harness check, not a proof, and says so where the
     * verdict is read rather than in a log line nobody scrolls back to.
     */
    proof:
      only !== undefined
        ? `NOT A PROOF: --cases ran only ${plan.map((step) => step.id).join(", ")}`
        : failures.length === 0 && reports.length >= PROOF_SESSIONS
          ? `PROOF: ${reports.length} full-plan sessions, all passed`
          : `NOT A PROOF: ${reports.length} full-plan session(s) run with ` +
            `${failures.length} failure(s); the bar is ${PROOF_SESSIONS} sessions and zero ` +
            `failures. One or two sessions is a smoke test of the harness, not of the device.`,
    failures,
    sessions: reports.length,
    passed: reports.filter((report) => report.verdict === "PASS").length,
    minutes: Number((sinceRun() / 60_000).toFixed(1)),
    remount,
    thresholds: { ...limits, ...timings },
    audio: {
      cleanTurns: cleanTurns.length,
      /* Zero, or the run failed. Printed anyway: a number is worth more than
       * the absence of a complaint. */
      cleanLostFrames: cleanTurns.reduce((total, turn) => total + (turn.lostFrames ?? 0), 0),
      sentSeconds: Number(
        (
          (everyTurn.reduce((total, turn) => total + (turn.sentFrames ?? 0), 0) * FRAME_MS) /
          1000
        ).toFixed(1),
      ),
      playedSeconds: Number(
        (
          (everyTurn.reduce((total, turn) => total + (turn.playedFrames ?? 0), 0) * FRAME_MS) /
          1000
        ).toFixed(1),
      ),
    },
    latencyMs: {
      firstAudio: spread(
        cleanTurns.flatMap((turn) => (turn.firstAudioMs === undefined ? [] : [turn.firstAudioMs])),
      ),
      answered: spread(
        cleanTurns.flatMap((turn) => (turn.answeredMs === undefined ? [] : [turn.answeredMs])),
      ),
    },
    /** What the deliberate cases cost, by case, so nothing is summed away. */
    attributedByCase,
    noted: notedTotals,
    perSession: reports.map((report) => ({
      index: report.index,
      verdict: report.verdict,
      durationSeconds: Number((report.durationMs / 1000).toFixed(0)),
      turns: report.turns.length,
      callLiveMs: report.callLiveMs ?? null,
      failures: report.failures,
    })),
    plan: plan.map((step) => ({ id: step.id, proves: step.proves })),
    counterPolicy: COUNTER_POLICY,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (options.out) {
    fs.writeFileSync(
      options.out,
      JSON.stringify({ samples: allSamples, sessions: reports, summary }, null, 2),
    );
    console.error(`timeline: ${options.out}`);
  }
  /*
   * THROW, don't just set process.exitCode.
   *
   * The exit code was being reported as 0 for a run whose own JSON said FAIL —
   * something after this returns exits cleanly and drops it. A thrown error is
   * the one signal that survives the CLI wrapper, and a proof harness whose
   * failure is invisible to a script is worse than no harness. The summary is
   * already printed and the JSON already written, so nothing is lost.
   */
  if (summary.verdict === "FAIL") {
    process.exitCode = 1;
    throw new Error(
      `sessions FAILED — ${summary.proof}. First failure: ${failures[0] ?? "(none recorded)"}`,
    );
  }
}

/** Everything one session needs to know, resolved once by the caller. */
interface RunSessionInput {
  index: number;
  options: SessionsOptions;
  streamPath: string;
  capabilityName: string;
  plan: readonly SessionStep[];
  remount: RemountMode;
  runStartedAt: number;
  limits: { callLiveMs: number; firstAudioMs: number; doneShortMs: number; doneMediumMs: number };
  timings: { settleMs: number; idleMs: number; cutAfterMs: number; drainMs: number };
  /** The run's whole sample series; this session appends its own to it. */
  samples: (StatsSample & { session: number })[];
}

/**
 * One session, start to finish, on its own itx connection.
 *
 * A FRESH connection per session is not tidiness: the device's capability and
 * every stub any session holds on it die when the board reboots, so a harness
 * that connects once spends the rest of the run reporting that a perfectly
 * healthy device is offline. A real client reconnects; pretending otherwise
 * tests the harness.
 */
async function runSession(input: RunSessionInput): Promise<SessionReport> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const report: SessionReport = {
    atMs: startedAt - input.runStartedAt,
    connGenerations: [],
    durationMs: 0,
    failures: [],
    index: input.index,
    noted: {},
    probes: [],
    reboots: 0,
    sessionGenerations: [],
    statsSamples: 0,
    bridgeRedials: 0,
    deviceQuietPeriods: 0,
    turns: [],
    unattributed: {},
    verdict: "FAIL",
    watchReopens: 0,
  };
  const fail = (what: string) => {
    report.failures.push(what);
    console.error(`  ✗ ${what}`);
  };
  const step = (what: string) => console.error(`  [${(elapsed() / 1000).toFixed(0)}s] ${what}`);
  console.error(`\nsession ${input.index} — setup, call, turns, teardown`);

  let itx = await connectProject(input.options);
  const device = () => {
    const kit = (itx as unknown as { kit: Record<string, DeviceCapability> }).kit;
    const capability = kit[input.capabilityName];
    if (!capability) throw new Error(`kit.${input.capabilityName} is offline`);
    return capability;
  };
  const withVoiceAgent = async <T>(
    run: (agent: DynamicWorkerCapability<VoiceAgentSurface>) => Promise<T>,
  ): Promise<T> => {
    using agent = itx.workers.get(
      voiceAgentEntrypointRef,
    ) as unknown as DynamicWorkerCapability<VoiceAgentSurface>;
    await awaitVoiceAgentBuild(agent, 20_000);
    return await run(agent);
  };

  try {
    /* ---- 1. Remount whatever the previous session left warm ---------- */
    if (input.remount !== "none") {
      const at = Date.now();
      const remountReport: RemountReport = { failures: [], mode: input.remount, ms: 0 };
      if (input.remount === "server" || input.remount === "both") {
        try {
          const removed = await withVoiceAgent(
            async (agent) => await agent.removeVoiceAgent({ streamPath: input.streamPath }),
          );
          remountReport.removed = removed.removed;
          step(
            `server remounted: killed the bridge and processor, removed ${removed.removed.length} subscription(s)`,
          );
        } catch (error) {
          /*
           * "kill requested" IS the terminal response of a self-removal.
           *
           * removeVoiceAgent's last two acts are processor.kill() and
           * bridge.kill(); killing the Durable Object that is serving the reply
           * means the reply never arrives, and the caller sees `Error: kill
           * requested`. That is the removal succeeding, not failing — but it is
           * indistinguishable from a genuine failure without checking, so it is
           * NOT swallowed. The postcondition is verified instead: the voice-agent
           * subscription must be gone from the stream, and no bridge may still be
           * answering on it. Only then is the remount called a success.
           */
          const message = String(error);
          const killExpected = message.includes("kill requested");
          const gone = killExpected
            ? await voiceAgentRemovalConfirmed(itx.streams.get(input.streamPath), step)
            : false;
          if (!gone) {
            remountReport.failures.push(
              killExpected
                ? `removeVoiceAgent reported "kill requested" but the subscription or an old ` +
                    `bridge is still present — the removal did not take`
                : `removeVoiceAgent threw: ${message.slice(0, 160)}`,
            );
          } else {
            remountReport.removed = ["(confirmed absent after kill-requested)"];
            step(
              "server remounted: removeVoiceAgent ended in kill-requested, and the subscription " +
                "is confirmed gone with no bridge answering",
            );
          }
        }
      }
      if (input.remount === "device" || input.remount === "both") {
        const before = await device()
          .health()
          .catch(() => ({}) as Record<string, unknown>);
        /* The reply can be lost to the reboot itself; that is not a failure. */
        await device()
          .restart()
          .catch(() => false);
        await sleep(3000);
        const bootAt = Date.now();
        let back = false;
        let lastSeen = "no answer yet";
        while (Date.now() - bootAt < 90_000 && !back) {
          closeConnection(itx);
          try {
            itx = await connectProject(input.options);
            const health = await device().health();
            const uptimeMs = Number(health.uptimeMs ?? 0);
            back = uptimeMs > 0 && uptimeMs < 60_000;
            lastSeen = `uptimeMs=${uptimeMs}`;
          } catch (error) {
            lastSeen = String(error).slice(0, 100);
          }
          if (!back) await sleep(2000);
        }
        remountReport.bootMs = Date.now() - bootAt;
        remountReport.proof = `uptime before ${String(before.uptimeMs ?? "?")}, after ${lastSeen}`;
        if (back)
          step(`device rebooted and came back in ${(remountReport.bootMs / 1000).toFixed(0)}s`);
        else remountReport.failures.push(`the device did not come back within 90s (${lastSeen})`);
      }
      remountReport.ms = Date.now() - at;
      report.remount = remountReport;
      for (const failure of remountReport.failures) fail(`remount: ${failure}`);
    }

    /* ---- 2. Setup, the same path a person's first call takes ---------- */
    {
      const at = Date.now();
      try {
        const setup = await withVoiceAgent(
          async (agent) => await agent.setupVoiceAgent({ streamPath: input.streamPath }),
        );
        report.setup = {
          alreadyThere: setup.alreadyThere.length,
          created: setup.created,
          ms: Date.now() - at,
          warmOk: setup.warm.ok,
          warmMs: setup.warm.ms,
        };
        step(
          `setup: ${setup.created.length} created, ${setup.alreadyThere.length} already there, ` +
            `processor acknowledged in ${setup.warm.ms}ms ` +
            `(${((Date.now() - at) / 1000).toFixed(1)}s)`,
        );
        /*
         * ASSERTED, NOT ASSUMED.
         *
         * setupVoiceAgent throws when the round trip fails, so reaching here
         * with warm.ok false would mean a deployed guest older than the
         * handshake. Calling the device anyway is how a cold first call gets
         * mistaken for a slow device.
         */
        if (!setup.warm.ok) {
          fail(
            `setup returned without a warm processor (acknowledged=${String(setup.warm.acknowledged)} ` +
              `briefMatched=${String(setup.warm.briefMatched)}) — the deployed guest predates the ` +
              `warm-up handshake, so a cold first call would be measured as device latency`,
          );
          report.durationMs = elapsed();
          return report;
        }
      } catch (error) {
        fail(`setup failed: ${String(error).slice(0, 200)}`);
        report.durationMs = elapsed();
        return report;
      }
    }

    /* ---- 3. The instrument, opened BEFORE the call ------------------- */
    const stream = itx.streams.get(input.streamPath);
    const samples: StatsSample[] = [];
    /** When the bridge last said it had this call. Zero means it does not. */
    let callLiveAt = 0;
    let answer: AnswerInFlight | null = null;
    let redials = 0;
    let providerErrors = 0;
    /*
     * ONE TRANSITION CAN BE REPORTED TWICE.
     *
     * The device ends a call and appends events.iterate.com/voice-agent/conversation-ended with its own
     * reason ("button"). The worker bridge is watching that same stream and
     * tears down when it sees the event — gated on `payload.conversationId === conversationId`
     * (voice-agent.ts) — and reports "worker bridge: conversation-ended event" a second
     * later. Both describe the SAME end of the SAME call, so counting events
     * made every hang-up case fail with `ended 2 time(s)`.
     *
     * The conversationId is therefore recorded and the accounting is done on DISTINCT
     * calls. Two ends carrying two different conversationIds is still a real
     * double-end, and still fails.
     */
    const callEnds: ObservedCallEnd[] = [];
    /* Before this, the harness has deliberately hung up whatever call it found,
     * and the device duly reports conversation-ended for it. Counting that would put
     * "the call ended" in the report of every healthy session. */
    let sessionLive = false;
    /*
     * HOW MANY ENDS THIS HARNESS ASKED FOR — counted where it asks, not
     * inferred from which plan cases were scheduled.
     *
     * The allowance used to be "turns that recorded a hangUpAtMs", on the
     * assumption stated in teardown: the plan's last case has already hung up
     * mid-sentence, so teardown's own hang-ups are no-ops. That assumption is
     * the plan's, not the harness's. Run a subset with --cases and the call is
     * still live at teardown, teardown's first hang-up legitimately ends it,
     * and the session fails with "1 call ended and only 0 were asked for" —
     * measured, on a startup cycle whose audio was perfect.
     *
     * Counting at the point of asking is true either way: with the full plan
     * the case hangs up while live and teardown finds nothing to end; with a
     * subset teardown does the ending. An end the harness did NOT ask for
     * still has no allowance, which is the property worth keeping.
     */
    const endsAskedFor: AskedCallEnd[] = [];
    /** Every acceptance and every refusal of THIS session's one call start. */
    const callAccepts: ObservedCallStart[] = [];
    const callFailures: ObservedCallStart[] = [];
    /**
     * Every request to start one, including the device's own re-asks.
     *
     * The device re-asks every 8s while a call is pending, and is right to — a
     * request can be lost. But a re-ask means the first request went unanswered,
     * which is the defect itself rather than a detail of the recovery: measured,
     * the first request after a remount waited out an 8s bridge build, the
     * device asked again, and two bridges raced for one call.
     */
    const callRequests: ObservedCallStart[] = [];
    /** Which call the stream currently says is up. Null when nothing is. */
    let liveConversationId: string | null = null;
    /**
     * Hang up, and record the ask — against the call it was aimed at, and only
     * once the device has accepted the request.
     *
     * Order matters in both directions. The target is read BEFORE the call,
     * because the end may be observed while the request is still in flight; the
     * allowance is granted AFTER it returns, because a hang-up that threw
     * asked for nothing and must not excuse a call that died on its own.
     */
    const hangUpAsked = async () => {
      const target = callLiveAt !== 0 ? liveConversationId : null;
      const issuedAtMs = elapsed();
      await device().conversation.hangUp();
      if (target !== null) endsAskedFor.push({ conversationId: target, issuedAtMs });
    };

    /*
     * Ephemeral events — dev-stats and every audio frame — only reach
     * connections that already existed when they were appended, so an
     * instrument opened after the call measures a suspiciously healthy device.
     * Speaker frames are NOT subscribed here: they are the bulk of the traffic
     * and this watcher plays none of them. First-audio timing gets its own
     * connection, opened per turn and closed on the first frame.
     */
    const watch = await watchStream({
      eventTypes: [
        "events.iterate.com/voice-agent/dev-stats",
        "events.iterate.com/voice-agent/grok-event",
        "events.iterate.com/voice-agent/conversation-accepted",
        "events.iterate.com/voice-agent/conversation-ended",
        /* A losing bridge announces itself here and nowhere else. */
        "events.iterate.com/voice-agent/conversation-failed",
        /* The device's own re-asks, which is how a lost request shows up. */
        "events.iterate.com/voice-agent/conversation-requested",
        "events.iterate.com/voice-agent/bridge-redialling",
      ],
      key: `sessions-${input.runStartedAt}-s${input.index}`,
      onNote: (what) => step(what),
      stream,
      onBatch: (batch) => {
        for (const event of batch.events) {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          if (event.type === "events.iterate.com/voice-agent/dev-stats") {
            const sample: StatsSample = { ...(payload as DeviceStats), atMs: elapsed() };
            samples.push(sample);
            input.samples.push({ ...sample, session: input.index });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/conversation-accepted") {
            callLiveAt = Date.now();
            if (sessionLive || callAccepts.length === 0) {
              callAccepts.push({
                atMs: elapsed(),
                conversationId:
                  typeof payload.conversationId === "string" ? payload.conversationId : null,
              });
            }
            /* Which call, so a hang-up can be correlated to the thing it ended. */
            liveConversationId =
              typeof payload.conversationId === "string" ? payload.conversationId : null;
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/conversation-ended") {
            callLiveAt = 0;
            liveConversationId = null;
            if (sessionLive) {
              callEnds.push({
                atMs: elapsed(),
                conversationId:
                  typeof payload.conversationId === "string" ? payload.conversationId : null,
                reason: String(payload.reason ?? "unknown"),
              });
            }
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/conversation-requested") {
            /*
             * ONLY THE BRING-UP WINDOW.
             *
             * Counted until the session's call is declared live, because that is
             * the window where a second request means the first was not answered.
             * Afterwards the harness asks again ON PURPOSE — the `start-twice`
             * probe exists to prove that starting a call twice is idempotent —
             * and counting those would fail every session for doing its job.
             */
            if (!sessionLive) {
              callRequests.push({
                atMs: elapsed(),
                conversationId:
                  typeof payload.conversationId === "string" ? payload.conversationId : null,
              });
            }
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/conversation-failed") {
            callFailures.push({
              atMs: elapsed(),
              conversationId:
                typeof payload.conversationId === "string" ? payload.conversationId : null,
              reason: String(payload.reason ?? "unknown"),
            });
            continue;
          }
          if (event.type === "events.iterate.com/voice-agent/bridge-redialling") {
            redials++;
            continue;
          }
          const inner = (payload as { event?: { type?: string; delta?: string } }).event;
          if (!inner) continue;
          if (inner.type === "error") {
            providerErrors++;
            continue;
          }
          if (!answer) continue;
          if (inner.type === "response.created" && answer.createdAt === 0) {
            answer.createdAt = Date.now();
          }
          if (inner.type === "response.output_audio_transcript.delta") {
            if (answer.firstTranscriptAt === 0) answer.firstTranscriptAt = Date.now();
            answer.text += inner.delta ?? "";
          }
          /*
           * Done means "done SAYING something". A cancelled response emits
           * `response.done` too, within a moment of the cancel — so on the
           * barge-in case the interrupted answer's own completion would
           * otherwise be read as the interrupting answer finishing instantly.
           * Requiring a transcript first makes the two impossible to confuse.
           */
          if (
            inner.type === "response.done" &&
            answer.doneAt === 0 &&
            answer.firstTranscriptAt > 0
          ) {
            answer.doneAt = Date.now();
          }
        }
      },
    });

    /**
     * One connection whose only job is to timestamp the FIRST speaker frame of
     * one answer, then get out of the way. Nothing else on the stream can say
     * when audio actually started: a transcript delta says the model began
     * talking, and the device's counters arrive 5s apart.
     */
    const openAudioProbe = async (label: string) => {
      let firstAt = 0;
      const handle = await stream.openConnection({
        connectionKey: `sessions-audio-${input.runStartedAt}-${label}`,
        eventTypes: ["events.iterate.com/voice-agent/spk-frame"],
        maxDeliveryBytes: 1400,
        maxDeliveryEvents: 1,
        processEventBatch: (batch) => {
          if (firstAt === 0 && batch.events.length > 0) firstAt = Date.now();
        },
        state: false,
      });
      return { at: () => firstAt, close: () => handle.close() };
    };

    /** Wait for `count` fresh dev-stats samples, so a counter window closes on real data. */
    const awaitSamples = async (count: number, timeoutMs: number) => {
      const target = samples.length + count;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && samples.length < target) await sleep(250);
      return samples.length >= target;
    };

    /* ---- 4. Get a call, the way a person does ------------------------ */
    try {
      const at = Date.now();
      await device()
        .conversation.hangUp()
        .catch(() => {});
      await sleep(3000);
      const live = await bringCallUp({
        deadline: Date.now() + 120_000,
        liveSince: () => callLiveAt,
        note: (what) => step(what),
        press: () => device().conversation.start(),
      });
      report.callLiveMs = Date.now() - at;
      if (!live) {
        fail(`the call never went live within ${((Date.now() - at) / 1000).toFixed(0)}s`);
        watch.close();
        report.durationMs = elapsed();
        return report;
      }
      sessionLive = true;
      step(`call live in ${(report.callLiveMs / 1000).toFixed(1)}s`);
    } catch (error) {
      fail(`bringing the call up threw: ${String(error).slice(0, 200)}`);
      watch.close();
      report.durationMs = elapsed();
      return report;
    }

    /* The sample every session-wide delta is measured from: the last one before
     * the first prompt. Not the first sample of the session — the ones before
     * the call belong to an idle device, and charging its idleness to the run
     * is how a total ends up disagreeing with the turns that make it up. */
    const baselineIndex = Math.max(0, samples.length - 1);

    /* ---- 5. The turns ------------------------------------------------ */
    let turnIndex = 0;
    for (const plannedStep of input.plan) {
      turnIndex++;
      if (plannedStep.gap === "settle") await sleep(input.timings.settleMs);
      if (plannedStep.gap === "idle") {
        step(`idle for ${input.timings.idleMs / 1000}s, saying nothing`);
        await sleep(input.timings.idleMs);
      }

      const turn = await takeTurn({
        awaitSamples,
        callEnds,
        device,
        hangUpAsked,
        limits: input.limits,
        openAudioProbe,
        plannedStep,
        readAnswer: () => answer,
        sessionStartedAt: startedAt,
        setAnswer: (next) => {
          answer = next;
        },
        samples,
        stream,
        timings: input.timings,
        turnIndex,
      });
      report.turns.push(turn);
      for (const failure of turn.failures) {
        fail(`turn ${turn.index} (${turn.id}): ${failure}`);
      }
      /*
       * A DEAD CALL ENDS THE PLAN.
       *
       * Every later case needs a live call, so running them against a call that
       * has already ended produces a column of identical failures and no
       * information. Measured: a provider stall ended the call on turn 2 and the
       * remaining five cases each restated it. Frequency means many short healthy
       * sessions, not many turns shouted at a corpse.
       */
      if (turn.failures.some((line) => line.includes("the call ended during this turn"))) {
        fail(
          `stopping this session at turn ${turn.index}: the call ended mid-turn, so the ` +
            `remaining cases have nothing live to run against`,
        );
        turn.callDiedHere = true;
        break;
      }
      /*
       * A NEVER-TIER BREACH STOPS EVERYTHING, IMMEDIATELY.
       *
       * These are the gates that describe what a listener hears. Once one has
       * moved, the run is already not a proof and the remaining turns and
       * sessions cost minutes to restate it. Measured: spkStarveEvents moved on
       * a barge-in in session 1 of a ten-run, and the harness carried on.
       */
      if (turn.failures.some((line) => line.includes("must never move"))) {
        fail(
          `stopping this session at turn ${turn.index}: a never-tier gate moved, which is a ` +
            `release blocker rather than a turn-level flake`,
        );
        turn.neverTierBreach = true;
        break;
      }
      if (turn.deviceWideBreakage) {
        /*
         * The device cannot report at all. Stop here and tear down cleanly:
         * the remaining turns would each restate it, which costs four minutes
         * and tells nobody anything new.
         */
        fail(
          `stopping this session at turn ${turn.index}: the device answered but produced no ` +
            `telemetry and never started its speaker — that is device-wide, not turn-specific`,
        );
        break;
      }

      /* The idempotency probes live between turns rather than at the edges,
       * because that is where they are dangerous: pressing call on a live call
       * used to end it, and only the next turn proves it did not. */
      if (turnIndex === 1) {
        const at = Date.now();
        const endsBefore = callEnds.length;
        let detail = "";
        let ok = false;
        try {
          await device().conversation.start();
          await sleep(3000);
          const health = await device().health();
          /*
           * Any new end at all is still fatal here: a second start must not end
           * the live call. Event count is the right measure for "did anything
           * end", because a duplicate report of an end still means an end.
           */
          ok = callEnds.length === endsBefore && health.callActive === true;
          detail =
            `callActive=${String(health.callActive)} sessionGeneration=` +
            `${String(health.sessionGeneration)} conversation-ended events=${callEnds.length - endsBefore}`;
        } catch (error) {
          detail = String(error).slice(0, 160);
        }
        report.probes.push({
          atMs: at - startedAt,
          detail,
          id: "start-twice",
          ok,
          proves:
            "pressing call on a call that is already live changes nothing: same conversation, " +
            "no teardown, no second bridge answering alongside the first.",
        });
        if (!ok) fail(`start-twice: the second press was not a no-op (${detail})`);
      }
    }

    /*
     * Where the session's counter ledger closes: the last sample the last turn
     * measured itself against.
     *
     * Deliberately NOT "the last sample of the session". Every turn's window
     * begins at the previous turn's closing sample, so ending the ledger here
     * makes it exactly the union of the turns — and a counter that moved has
     * exactly one turn to be charged to. Sampled later, the seconds spent
     * poking at health() after teardown would land in the ledger and in no
     * turn, and the report would invent movement "nothing accounts for" out of
     * a device quietly finishing what it was told to do.
     */
    const sessionAfterIndex = samples.length - 1;

    /* ---- 6. Teardown, and proof there is nothing left running -------- */
    {
      const at = Date.now();
      let detail = "";
      let ok = false;
      try {
        /* With the full plan the last case has already hung up mid-sentence and
         * both of these are no-ops; with a subset the first one is the end of a
         * live call. Either way the second must be as uneventful as the first. */
        await hangUpAsked();
        await sleep(2000);
        await hangUpAsked();
        await sleep(1000);
        ok = true;
        detail = "two hang-ups, no error";
      } catch (error) {
        detail = String(error).slice(0, 160);
      }
      report.probes.push({
        atMs: at - startedAt,
        detail,
        id: "hang-up-twice",
        ok,
        proves: "hanging up a call that is already down is a no-op, not an error.",
      });
      if (!ok) fail(`hang-up-twice: ${detail}`);
    }
    {
      const at = Date.now();
      let detail = "never answered";
      let ok = false;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !ok) {
        try {
          const health = await device().health();
          detail =
            `transport=${String(health.transport)} voicelab=${String(health.voicelab)} ` +
            `failure=${String(health.voicelabFailure)} gateOpen=${String(health.gateOpen)} ` +
            `callActive=${String(health.callActive)} callPending=${String(health.callPending)} ` +
            `wantsCall=${String(health.wantsCall)}`;
          ok =
            health.callActive === false &&
            health.callPending === false &&
            health.wantsCall === false &&
            health.gateOpen === true &&
            health.voicelabFailure === "none" &&
            health.transport === "ready";
        } catch (error) {
          detail = String(error).slice(0, 160);
        }
        if (!ok) await sleep(2000);
      }
      report.probes.push({
        atMs: at - startedAt,
        detail,
        id: "left-clean",
        ok,
        proves:
          "the session leaves no stuck call and no wedged capability: the device answers, its " +
          "gate is open, it reports no failure, and it wants no call.",
      });
      if (!ok) fail(`left-clean: the device did not settle after teardown (${detail})`);
    }

    /* ---- 7. Session-wide accounting --------------------------------- */
    const before = samples[baselineIndex];
    const after = samples[sessionAfterIndex];
    report.statsSamples = samples.length;
    report.bridgeRedials = redials;
    report.watchReopens = watch.reopens;
    report.deviceQuietPeriods = watch.deviceQuiet;
    watch.close();

    if (samples.length < 2 || !before || !after || before === after) {
      fail("the device published no usable dev-stats — nothing here was measured");
    } else {
      const moved = movedCounters(before, after, WATCHED);
      /* What the turns' cuts already accounted for. Anything left moved while
       * this harness was not looking at a turn, which is worse, not better. */
      const attributed: Record<string, number> = {};
      for (const turn of report.turns) {
        for (const [key, delta] of Object.entries(turn.attributed ?? {})) {
          attributed[key] = (attributed[key] ?? 0) + delta;
        }
      }
      for (const [key, delta] of Object.entries(moved)) {
        if (NOTED.includes(key)) {
          report.noted[key] = delta;
          continue;
        }
        const left = delta - (attributed[key] ?? 0);
        if (left <= 0) continue;
        report.unattributed[key] = left;
        const firstTurn = report.turns.find((turn) => (turn.counters?.[key] ?? 0) !== 0);
        fail(
          `${key} moved by ${left} with nothing to account for it` +
            (firstTurn ? ` (first seen on turn ${firstTurn.index}, ${firstTurn.id})` : "") +
            (NEVER_MOVES.includes(key)
              ? " — this counter must never move, cut or no cut"
              : " — only a case that cancels an answer may move this"),
        );
      }

      /* The same window the counters were read over: samples from before the
       * call belong to an idle device on somebody else's conversation. */
      const measured = samples.slice(baselineIndex, sessionAfterIndex + 1);
      /*
       * Generations are counted over the samples taken DURING THE CALL only.
       *
       * The baseline sample can be a whole telemetry period old — published
       * before the bridge accepted this call — so it carries the PREVIOUS
       * conversation's `sessionGeneration`, and a session that spans it would
       * report its own perfectly healthy call as a conversation that got
       * replaced. There is exactly one call per session, so every sample with
       * `callActive` set belongs to it and they must all agree.
       */
      const duringCall = measured.filter((sample) => sample.callActive === true);
      report.sessionGenerations = [
        ...new Set(
          duringCall.flatMap((sample) =>
            sample.sessionGeneration === undefined ? [] : [sample.sessionGeneration],
          ),
        ),
      ];
      report.connGenerations = [
        ...new Set(
          duringCall.flatMap((sample) =>
            sample.connGeneration === undefined ? [] : [sample.connGeneration],
          ),
        ),
      ];
      report.reboots = measured.filter(
        (sample, at) =>
          at > 0 && Number(sample.uptimeMs ?? 0) < Number(measured[at - 1]?.uptimeMs ?? 0),
      ).length;
      if (report.sessionGenerations.length > 1) {
        fail(
          `the conversation was replaced mid-session: sessionGeneration ` +
            `${report.sessionGenerations.join(" → ")}`,
        );
      }
      if (report.reboots > 0) fail(`the device rebooted ${report.reboots} time(s) mid-session`);
    }

    /* A call that ended by itself is a failure; one this harness asked for is
     * the point of the case that asked, and is required rather than tolerated. */
    /* Distinct CALLS ended, not events observed — see the note on callEnds. */
    const callsEnded = new Set(
      callEnds.map((end, index) => end.conversationId ?? `unidentified-${String(index)}`),
    );
    for (const problem of callStartProblems(callAccepts, callFailures, callRequests)) fail(problem);
    const unreconciled = reconcileCallEnds(callEnds, endsAskedFor);
    if (unreconciled.length > 0) {
      fail(
        `${unreconciled.length} call end(s) nothing accounts for, of ${callsEnded.size} distinct ` +
          `call(s) ended. Hang-ups asked: ` +
          `${endsAskedFor.map((ask) => `${ask.conversationId}@${(ask.issuedAtMs / 1000).toFixed(0)}s`).join(", ") || "none"}. ` +
          unreconciled
            .map(
              ({ end, why }) =>
                `${end.reason}@${(end.atMs / 1000).toFixed(0)}s` +
                `[${end.conversationId ?? "no conversationId"}] — ${why}`,
            )
            .join("; "),
      );
    }
    if (providerErrors > 0) fail(`the provider reported ${providerErrors} error event(s)`);
    if (redials > 0) {
      fail(
        `the bridge replaced its provider socket ${redials} time(s) — in a three-minute ` +
          `session that is not the provider's own schedule`,
      );
    }
  } catch (error) {
    fail(`the session threw: ${String(error).slice(0, 300)}`);
  } finally {
    closeConnection(itx);
  }

  report.durationMs = elapsed();
  report.verdict = report.failures.length === 0 ? "PASS" : "FAIL";
  return report;
}

/** Everything one turn needs. Assembled by the session; nothing global. */
/** The little of a stream event this check needs. */
interface StreamEventLike {
  type: string;
  createdAt: string;
}

/**
 * Did the removal actually take?
 *
 * Two facts, both required, because "kill requested" tells us nothing by itself:
 * the voice-agent subscription must be absent from the stream, and no bridge may
 * still be answering on it. Bounded: a removal that has not settled within a few
 * seconds is a failed removal, not a slow one.
 */
async function voiceAgentRemovalConfirmed(
  stream: {
    getEventPage: (args?: { limit?: number }) => Promise<{ streamMaxOffset?: number } | null>;
    getEvents: (args?: {
      afterOffset?: number;
      limit?: number;
    }) => Promise<StreamEventLike[] | null>;
  },
  step: (line: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    /*
     * READ FROM THE HEAD, not the start.
     *
     * getEvents() defaults to the beginning of the stream, and this stream is
     * 200k offsets long — so a plain read returns the ORIGINAL
     * subscription-configured and never the removal that just happened, and the
     * check concludes the removal failed when it succeeded. getEventPage's
     * streamMaxOffset is the field that names the head.
     */
    const page = await stream.getEventPage({ limit: 1 });
    const head = page?.streamMaxOffset ?? 0;
    const events =
      (await stream.getEvents({ afterOffset: Math.max(0, head - 300), limit: 500 })) ?? [];
    /* The newest configure/remove pair decides: removed must come last. */
    let subscribed = false;
    for (const event of events) {
      if (event.type === "events.iterate.com/stream/subscription-configured") subscribed = true;
      if (event.type === "events.iterate.com/stream/subscription-removed") subscribed = false;
    }
    /* An old bridge would still be accepting calls or ending them. */
    const recent = events.slice(-40);
    const bridgeAlive = recent.some(
      (event: StreamEventLike) =>
        event.type === "events.iterate.com/voice-agent/conversation-accepted" &&
        Date.parse(event.createdAt) > Date.now() - 10_000,
    );
    if (!subscribed && !bridgeAlive) {
      step("removal confirmed: no voice-agent subscription and no bridge answering");
      return true;
    }
    await sleep(1000);
  }
  return false;
}

interface TakeTurnInput {
  plannedStep: SessionStep;
  turnIndex: number;
  sessionStartedAt: number;
  stream: ReturnType<ProjectConnection["streams"]["get"]>;
  samples: readonly StatsSample[];
  device: () => DeviceCapability;
  callEnds: readonly ObservedCallEnd[];
  /**
   * Hang up the live call and record the ask against it.
   *
   * The cut cases end a call on purpose, so they must register that ask the
   * same way teardown does — the session's accounting correlates ends to asks
   * by conversationId and does not care which part of the harness asked.
   */
  hangUpAsked: () => Promise<void>;
  readAnswer: () => AnswerInFlight | null;
  setAnswer: (next: AnswerInFlight | null) => void;
  openAudioProbe: (label: string) => Promise<{ at: () => number; close: () => void }>;
  awaitSamples: (count: number, timeoutMs: number) => Promise<boolean>;
  limits: { callLiveMs: number; firstAudioMs: number; doneShortMs: number; doneMediumMs: number };
  timings: { settleMs: number; idleMs: number; cutAfterMs: number; drainMs: number };
}

/**
 * Take one turn and say everything that was wrong with it.
 *
 * The turn owns its own counter window: the last sample before the prompt to
 * the last sample once the speaker has gone quiet. Everything a listener would
 * notice is derived from those two samples plus the stream's own timestamps.
 */
async function takeTurn(input: TakeTurnInput): Promise<SessionTurn> {
  const { plannedStep: planned, timings, limits } = input;
  const sleepUntilFirstAudio = async (probe: { at: () => number }, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && probe.at() === 0) await sleep(100);
    return probe.at();
  };

  const baselineIndex = input.samples.length - 1;
  const before = baselineIndex >= 0 ? input.samples[baselineIndex] : undefined;
  const baselinePlayed = Number(before?.spkPlayed ?? 0);
  const callEndsBefore = input.callEnds.length;

  const probe = await input.openAudioProbe(`${input.turnIndex}-${planned.id}`);
  const askedAt = Date.now();
  input.setAnswer({ createdAt: 0, doneAt: 0, firstTranscriptAt: 0, text: "" });
  const turn: SessionTurn = {
    atMs: askedAt - input.sessionStartedAt,
    cut: planned.cut,
    failures: [],
    id: planned.id,
    index: input.turnIndex,
    prompt: planned.text,
    promptClass: planned.promptClass,
    proves: planned.proves,
  };
  await input.stream.append({
    payload: { text: planned.text },
    type: "events.iterate.com/voice-agent/say",
  });

  /** The answer this turn's latency is measured against, and when it was asked. */
  let measuredFrom = askedAt;

  if (planned.promptClass === "silent") {
    /* Nothing should happen. Wait a bounded window and prove it. */
    await sleep(ANSWER_TIMEOUT_MS.silent);
    await input.awaitSamples(2, 15_000);
    turn.playout = "not awaited";
  } else if (planned.cut === "barge-in") {
    const firstAt = await sleepUntilFirstAudio(probe, CUT_FIRST_AUDIO_TIMEOUT_MS);
    if (firstAt > 0) turn.firstAudioMs = firstAt - askedAt;
    probe.close();
    if (firstAt === 0) {
      turn.failures.push(
        `the answer this case exists to interrupt never produced audio within ` +
          `${CUT_FIRST_AUDIO_TIMEOUT_MS / 1000}s — there was nothing to barge in on`,
      );
    } else {
      /* Let the listener actually hear some of it, then talk over it. */
      await sleep(timings.cutAfterMs);
      const second = await input.openAudioProbe(`${input.turnIndex}-${planned.id}-interrupt`);
      measuredFrom = Date.now();
      input.setAnswer({ createdAt: 0, doneAt: 0, firstTranscriptAt: 0, text: "" });
      turn.interruptPrompt = planned.interruptWith;
      await input.stream.append({
        payload: { text: planned.interruptWith ?? "" },
        type: "events.iterate.com/voice-agent/say",
      });
      const deadline = measuredFrom + ANSWER_TIMEOUT_MS.short;
      while (Date.now() < deadline && (input.readAnswer()?.doneAt ?? 0) === 0) {
        if (turn.interruptFirstAudioMs === undefined && second.at() > 0) {
          turn.interruptFirstAudioMs = second.at() - measuredFrom;
        }
        await sleep(100);
      }
      if (turn.interruptFirstAudioMs === undefined && second.at() > 0) {
        turn.interruptFirstAudioMs = second.at() - measuredFrom;
      }
      second.close();
      turn.playout = await waitForQuietPlayout({
        baselinePlayed,
        samples: input.samples,
        timeoutMs: timings.drainMs,
      });
    }
  } else if (planned.cut === "hangup") {
    const firstAt = await sleepUntilFirstAudio(probe, CUT_FIRST_AUDIO_TIMEOUT_MS);
    if (firstAt > 0) turn.firstAudioMs = firstAt - askedAt;
    probe.close();
    if (firstAt === 0) {
      turn.failures.push(
        `the answer this case exists to cut off never produced audio within ` +
          `${CUT_FIRST_AUDIO_TIMEOUT_MS / 1000}s — the hang-up would not have been mid-playout`,
      );
    } else {
      await sleep(timings.cutAfterMs);
      turn.hangUpAtMs = Date.now() - input.sessionStartedAt;
      await input.hangUpAsked();
      /* Two samples so the window covers the teardown, not just the request. */
      await input.awaitSamples(2, 20_000);
      turn.playout = "not awaited";
    }
  } else {
    const timeoutMs = ANSWER_TIMEOUT_MS[planned.promptClass];
    const deadline = askedAt + timeoutMs;
    while (Date.now() < deadline && (input.readAnswer()?.doneAt ?? 0) === 0) {
      if (turn.firstAudioMs === undefined && probe.at() > 0) {
        turn.firstAudioMs = probe.at() - askedAt;
      }
      await sleep(100);
    }
    if (turn.firstAudioMs === undefined && probe.at() > 0) turn.firstAudioMs = probe.at() - askedAt;
    probe.close();
    turn.playout = await waitForQuietPlayout({
      baselinePlayed,
      samples: input.samples,
      timeoutMs: timings.drainMs,
    });
  }

  /*
   * A CUT'S CONSEQUENCES BELONG TO THE CUT.
   *
   * A barge-in or a hang-up abandons audio that is still draining when the turn
   * record would otherwise close. Telemetry arrives every 5s, so that drain —
   * the concealment and the underrun it legitimately causes — landed in a sample
   * AFTER the window and the session ledger then reported it as movement "with
   * nothing to account for it", while the turn that caused it had already been
   * licensed. That was a contradiction in the accounting, not a second defect:
   * the same movement was licensed at the turn and unexplained at the session.
   *
   * Waiting for the playout to go quiet before sampling puts it inside the
   * window of the turn that is licensed for it. Bounded, because a cut that
   * never settles is itself a failure and the drain timeout catches it.
   */
  if (turn.cut !== undefined) {
    await input.awaitSamples(2, 20_000);
  }

  const answer = input.readAnswer();
  if (answer) {
    if (answer.createdAt > 0) turn.thinkingMs = answer.createdAt - measuredFrom;
    if (answer.doneAt > 0) turn.answeredMs = answer.doneAt - measuredFrom;
    turn.transcript = answer.text.slice(0, 300);
  }
  input.setAnswer(null);
  turn.playedOutMs = Date.now() - input.sessionStartedAt - turn.atMs;

  /* ---- What the device says happened ------------------------------- */
  const after = input.samples[input.samples.length - 1];
  if (before && after && after !== before) {
    turn.sentFrames = Number(after.spkFrames ?? 0) - Number(before.spkFrames ?? 0);
    turn.playedFrames = Number(after.spkPlayed ?? 0) - Number(before.spkPlayed ?? 0);
    turn.lostFrames = Math.max(0, turn.sentFrames - turn.playedFrames);
    turn.sentAudioMs = turn.sentFrames * FRAME_MS;
    turn.playedAudioMs = turn.playedFrames * FRAME_MS;
    turn.counters = movedCounters(before, after, WATCHED);
    turn.heapFree = typeof after.heapFree === "number" ? after.heapFree : undefined;
    turn.psramFree = typeof after.psramFree === "number" ? after.psramFree : undefined;
    turn.ringMarginMaxMs =
      typeof after.spkMarginMaxMs === "number" ? after.spkMarginMaxMs : undefined;
  } else {
    turn.failures.push("no fresh dev-stats sample closed this turn's window — nothing measured");
  }

  /* ---- And whether that counts ------------------------------------- */
  const cut = planned.cut;
  const endedHere = input.callEnds.length - callEndsBefore;
  if (cut === "hangup") {
    if (endedHere === 0) {
      turn.failures.push(
        "hanging up mid-playout produced no conversation-ended on the stream — the teardown was not one",
      );
    }
  } else if (endedHere > 0) {
    turn.failures.push(
      `the call ended during this turn (${input.callEnds[callEndsBefore]?.reason ?? "unknown"})`,
    );
  }

  if (planned.promptClass === "silent") {
    /* A blank turn's only job is to change nothing. Audio would not be wrong in
     * itself — but audio that is delivered and not played is, and the
     * sent-equals-played gate below catches exactly that. */
    if (turn.answeredMs !== undefined) {
      turn.failures.push(
        `a blank prompt drew a full answer in ${turn.answeredMs}ms — the bridge is meant to ` +
          `drop a say that trims to nothing`,
      );
    }
  } else {
    if (turn.firstAudioMs === undefined) {
      turn.failures.push("no speaker frame ever reached the stream for this turn");
    } else if (turn.firstAudioMs > limits.firstAudioMs) {
      turn.failures.push(
        `first audio took ${turn.firstAudioMs}ms (limit ${limits.firstAudioMs}ms)`,
      );
    }
    if (planned.doneLimit !== "none") {
      const limit = planned.doneLimit === "short" ? limits.doneShortMs : limits.doneMediumMs;
      if (turn.answeredMs === undefined) {
        turn.failures.push(
          `the answer never finished: no response.done with speech in it within ` +
            `${ANSWER_TIMEOUT_MS[planned.promptClass] / 1000}s`,
        );
      } else if (turn.answeredMs > limit) {
        turn.failures.push(`the answer took ${turn.answeredMs}ms to finish (limit ${limit}ms)`);
      }
    }
    if (turn.playout === "never started") {
      turn.failures.push(
        "the model answered and the speaker never started" +
          ((turn.counters?.spkIgnoredDup ?? 0) > 0
            ? ` — the playout refused ${turn.counters?.spkIgnoredDup} frames as duplicates`
            : ""),
      );
    }
    if (turn.playout === "still playing") {
      turn.failures.push(`the speaker never went quiet within ${timings.drainMs / 1000}s`);
    }
    if ((turn.playedFrames ?? 0) <= 0) {
      turn.failures.push("nothing was played: the device wrote no audio to its speaker");
    }
  }

  /* THE GATE. Not a percentage: every frame delivered must be heard. */
  const lost = turn.lostFrames ?? 0;
  if (cut === undefined) {
    if (lost > 0) {
      turn.failures.push(
        `${lost} of ${turn.sentFrames} delivered frames never reached the speaker ` +
          `(${((lost * FRAME_MS) / 1000).toFixed(2)}s of the answer), where: ` +
          JSON.stringify(turn.counters ?? {}),
      );
    }
  } else if (lost > 0) {
    turn.lostAttributedTo = planned.id;
  }

  /* Counter movement, tier by tier. A cut licenses the cut-only tier and
   * nothing else; the never tier is never licensed. */
  const attributed: Record<string, number> = {};
  for (const [key, delta] of Object.entries(turn.counters ?? {})) {
    if (delta <= 0 || NOTED.includes(key)) continue;
    if (NEVER_MOVES.includes(key)) {
      turn.failures.push(`${key} moved by ${delta} — this counter must never move, cut or no cut`);
      continue;
    }
    if (!CUT_ONLY.includes(key)) {
      /* Unreachable while the policy table is the only source of watched keys,
       * and a failure rather than a shrug if that ever stops being true. */
      turn.failures.push(`${key} moved by ${delta} and this harness has no tier for it`);
      continue;
    }
    if (cut === undefined) {
      turn.failures.push(
        `${key} moved by ${delta} on a turn that cancels nothing (only the barge-in and ` +
          `hang-up cases may move it)`,
      );
      continue;
    }
    attributed[key] = delta;
  }
  if (Object.keys(attributed).length > 0) turn.attributed = attributed;

  /*
   * FAIL FAST ON A DEVICE-WIDE BREAKAGE.
   *
   * These three together — the model answered, no dev-stats sample closed the
   * window, and the speaker never started — are not a turn failing. They are the
   * device unable to report at all, and every remaining turn will say the same
   * thing. Measured: a stats buffer overflow took telemetry dark and a smoke
   * spent four minutes restating it seven times. Marked here so the caller can
   * tear down cleanly instead of grinding through the plan.
   */
  const answered = (turn.answeredMs ?? 0) > 0;
  const noStats = turn.failures.some((line) => line.includes("no fresh dev-stats"));
  const noSpeaker = turn.failures.some((line) => line.includes("speaker never started"));
  if (answered && noStats && noSpeaker) turn.deviceWideBreakage = true;

  /* ---- One line a person can watch go by -------------------------- */
  const seconds = (ms: number | undefined) =>
    ms === undefined ? "  --  " : `${(ms / 1000).toFixed(1)}s`;
  console.error(
    `  turn ${String(turn.index).padStart(2)} ${planned.id.padEnd(18)} ` +
      `audio@${seconds(turn.firstAudioMs)} done@${seconds(turn.answeredMs)} ` +
      `played ${seconds(turn.playedAudioMs)} of ${seconds(turn.sentAudioMs)} ` +
      (cut === undefined ? `lost ${lost}` : `cut, lost ${lost} (${planned.id})`) +
      ` heap ${Math.round((turn.heapFree ?? 0) / 1024)}k` +
      (turn.failures.length > 0 ? `  ✗ ${turn.failures.length} failure(s)` : ""),
  );
  if (turn.transcript) {
    console.error(`             "${turn.transcript.slice(0, 90).replaceAll("\n", " ")}"`);
  }
  return turn;
}
