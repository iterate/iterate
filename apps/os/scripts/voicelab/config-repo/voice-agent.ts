import {
  IterateWorkerEntrypoint,
  type Agent,
  type StatefulDynamicWorkerRef,
  type Stream,
  StreamProcessorFacet,
  type ProcessorHostDeps,
} from "iterate/sdk";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "iterate/processors";
import { z } from "zod";
import { createVisemeTracker, type VisemeChangeEvent } from "./viseme.ts";
import {
  DEFAULT_SPEAKER_LIMITS,
  speakerComplete,
  speakerPush,
  speakerRelease,
  speakerReplace,
  speakerStart,
  speakerSummary,
  type SpeakerChunk,
  type SpeakerLimits,
  type SpeakerRelease,
  type SpeakerState,
} from "./speaker.ts";

// This file is copied into and built from a user's config repo, so it cannot
// import the CLI-local rpc-ownership.ts module. Keep these three deployment-
// boundary equivalents aligned with that module's explicit ownership rules.
/** Release one Cap'n Web/Workers RPC capability without hiding a failed release. */
function disposeRpcStub(value: unknown, label: string): void {
  try {
    disposeIgnoredRpcResult(value);
  } catch (error) {
    console.error("voice-agent RPC stub disposal failed", { error, label });
  }
}

/** Await an RPC result whose payload is intentionally ignored, then release its wrapper. */
async function discardRpcResult(result: Promise<unknown>, label: string): Promise<void> {
  disposeRpcStub(await result, label);
}

// Voice-agent guest worker: the "server side" of the voice pipe, in userspace.
//
// Three modes, one Durable Object, reached via wss to the `voice` app host
// (voice--<slug>.<base>/?mode=...):
//
//   mode=proxy    client WS <-> Grok WS, frames pumped verbatim. The client
//                 speaks the Grok realtime protocol itself. This is the
//                 "simple websocket proxy" baseline.
//
//   mode=bridge   audio rides the STREAM: mic-frame ephemeral events in,
//                 spk-frame/grok-event ephemeral events out, exactly the
//                 voicelab node-bridge protocol. The client's WebSocket to
//                 this DO carries no audio — it is the lifetime anchor that
//                 keeps this invocation's context (and with it the outbound
//                 Grok socket + the live openConnection callback) alive.
//
//   mode=detached same bridge, no anchor socket: the call holds ITSELF open
//                 with ctx.waitUntil for as long as it is doing work, and
//                 ends on the stream's conversation-ended event, on Grok hanging up,
//                 on silence, or at the hard deadline. This is what a device
//                 uses — an `events.iterate.com/voice-agent/conversation-requested` stream event returns the moment the
//                 Grok session is live and nothing outside the platform has
//                 to stay running for the call to continue.
//
// The Grok key never enters this isolate: the upgrade fetch carries a
// getSecret placeholder that the platform substitutes en route to the
// pinned origin.

const XAI_SECRET = "/secrets/xai";
/* The provider the facet dials. Fixed here rather than per-request: the key
 * goes to x.ai and nowhere else, and a caller-chosen URL would carry it. */
const GROK_REALTIME_URL = "https://api.x.ai/v1/realtime";
const GROK_MODEL = "grok-voice-think-fast-2.0";
const GROK_VOICE = "eve";
/**
 * How long a dial may go without becoming usable before it counts as dead.
 *
 * Exported so a scenario that means "slower than the bridge will wait" can be
 * written against the number the bridge actually enforces, rather than a copy
 * of it that goes stale the day this moves (see `fake-grok.ts`'s
 * `slow-connect` and `dead-connect`).
 */
export const GROK_HANDSHAKE_DEADLINE_MS = 10_000;
/**
 * A CALL WITH NO UTTERANCE FROM EITHER SIDE FOR THIS LONG IS OVER.
 *
 * A conversation is one call across many presses, so this is the only clock
 * that ends an idle one. Both directions count: what goes to the provider and
 * what comes back from it, so a long answer cannot age a call out and neither
 * can somebody who pauses to think and then speaks again. Anything either way
 * restarts the minute.
 *
 * What deliberately does NOT count is liveness. The retiring bridge made the
 * same distinction for the same reason — a device pinging into an empty room
 * is exactly the case this exists to end — and it still holds now that those
 * pings are gone: presence, warm-ups and brief markers are traffic about the
 * stream, not somebody talking on it.
 */
const IDLE_TIMEOUT_MS = 60_000;
/**
 * THE ONE SENTENCE AN IDLE END IS ASKED FOR IN, and it has to be one sentence.
 *
 * Two things can notice the minute has passed — the countdown on a live call
 * and the at-head pass on a revived one (see {@link idleDeadlinePassed}) — and
 * both append the SAME `conversation-end-requested` under the SAME idempotency
 * key, so whichever gets there first wins and the other collapses into it.
 * That only works while the payload is byte-identical: the stream REJECTS a
 * same-key append with a different body rather than deduplicating it. Hence a
 * constant, not two sentences that happen to agree today.
 */
const IDLE_END_REASON = `no utterance from either side for ${IDLE_TIMEOUT_MS / 1000}s`;

/**
 * Has this call gone a whole minute with nothing said, as far as the FOLD
 * knows?
 *
 * THE SECOND OF TWO CLOCKS, and the only one that survives an eviction.
 *
 * The first is the countdown in `#holdUntilIdle`: a keepalive-backed loop
 * reading `GrokCall.lastSpokeAtMs`, which everything either side says moves,
 * and the one that ends a call on a Durable Object that is still up. It cannot
 * survive the object dying, and the object dying is exactly the case an
 * abandoned call is in.
 *
 * So the deadline is also derivable from reduced state. `lastHeardAtMs` is
 * folded from the events a client speaks with — the press verbs, every
 * microphone frame, a typed turn — using each event's own commit stamp, which
 * costs NOTHING: reduced state is already committed once per delivered batch,
 * so this rides a write that happens anyway. It is deliberately not a
 * heartbeat event; that is the thing deleted this morning for pinning four
 * Durable Objects awake around the clock.
 *
 * WHY THE TWO CANNOT DISAGREE, which is the whole argument. The fold's clock
 * is BLIND TO THE PROVIDER: a ninety-second answer is the model talking, and
 * none of it reaches the fold (`grok-event` is not consumed, and consuming it
 * would put the provider's whole firehose back on the delivery lane). So the
 * fold's clock can only be BEHIND the truth, never ahead — it can only call a
 * call dead early, never keep a dead one alive. That would be a real hazard,
 * except for where it is read: ONLY on an at-head pass for a call this
 * incarnation does not hold. A provider can only speak through a socket, a
 * socket belongs to the incarnation that opened it, and an incarnation that
 * holds no socket therefore has nothing left that could be speaking. The most
 * this can cost is ending a call whose answer died with its socket — an answer
 * nobody can hear any more.
 *
 * A live incarnation reads its own countdown and never this.
 */
export function idleDeadlinePassed(lastHeardAtMs: number, nowMs: number): boolean {
  return nowMs - lastHeardAtMs >= IDLE_TIMEOUT_MS;
}

/**
 * When the stream committed this event, in epoch milliseconds.
 *
 * `reduce` is pure and cannot ask a clock — and does not need to: every event
 * carries the stamp the Stream Durable Object gave it at commit. That is the
 * SAME Durable Object the facet runs inside, so a deadline folded from this
 * and compared against `deps.now()` is one clock read twice, not two clocks.
 * (Two clock bases quietly disagreeing is what left every board mute for a
 * day; it is worth saying out loud which one this is.)
 */
function eventTimeMs(event: { createdAt: string }): number {
  return Date.parse(event.createdAt);
}

/**
 * Does an event naming `named` speak about the call this stream is on?
 *
 * Worker-minted ids are eight hex chars, so a matching 8-hex id names its own
 * call, a MISMATCHED 8-hex id is a stale message about a predecessor and must
 * not touch the successor, and an id that is not 8-hex at all cannot possibly
 * name a predecessor: it is the device speaking about the one call it is on,
 * under its own name ("scdev", "havpedev" — the firmware does not yet echo the
 * real id). An exact-match-only rule made those self-named hang-ups fold to
 * nothing, which left the call IMMORTAL: every fresh incarnation's at-head
 * pass re-dialled the corpse, and every press folded into it in silence. Both
 * open-mic boards were wedged exactly this way.
 */
export function namesThisCall(liveId: string, named: string): boolean {
  return liveId === named || !/^[0-9a-f]{8}$/.test(named);
}
/**
 * The agent that does the actual thinking. Grok is a mouth and a pair of
 * ears with a ~200ms budget; anything that needs reading a repo, calling a
 * tool, or being RIGHT belongs to a text model with no clock on it.
 */
/*
 * THERE IS NO SEPARATE BACK-OFFICE AGENT.
 *
 * This used to be a fixed `/agents/colleague`, which made the thinking half of
 * every conversation on the deployment ONE GLOBAL SINGLETON: two devices, or
 * one device on two conversations, shared a single agent, a single stream and a
 * single memory. Starting a "new conversation" on the device changed the voice
 * path and left the agent behind, still holding the last conversation.
 *
 * The voice agent and the back office are the same agent, living at the voice
 * path itself. Change the voice path and the identity changes with it, which is
 * what "new conversation" is supposed to mean.
 */
const VOICE_AGENT_PROCESSOR_SLUG = "voice-agent";
/*
 * The warm-up handshake's own revision.
 *
 * Separate from the processor contract's version, which is 1.0.0 and does not
 * move when this handshake changes — so it cannot tell a caller whether the
 * running processor speaks the protocol the caller expects. Bump this whenever
 * the warm-up request or acknowledgement changes shape.
 */
const WARMUP_PROTOCOL_REVISION = "warmup/4-marked-brief";
/**
 * How long setup will wait for its own warm-up to be acknowledged.
 *
 * Deliberately generous, and deliberately NOT the 15s a call has to go live in.
 * Those are opposite bounds: the call gate is a promise to the person holding
 * the device, while this is setup volunteering to pay a cost so the call does
 * not. A run that times out here pushes that cost back into the first call,
 * which is the defect this whole handshake exists to remove.
 *
 * NINETY SECONDS BECAUSE 45 WAS MEASURABLY TOO SHORT, and not for the reason
 * it looks like. The build artifact is a KV HIT on a new stream — the build
 * key (build-key.ts) is content-addressed and carries no path, and setup is
 * itself running inside a dynamic worker built from the byte-identical
 * source, so the bundler cannot be in this window. What IS in it is loader
 * isolate instantiation, which is genuinely per-incarnation: `loaderIdentity`
 * (worker-loader.ts) includes `scopePath` because the isolate bakes `env.ITX`
 * from it, so two stream paths sharing one isolate would be privilege
 * confusion rather than a saving.
 *
 * Measured: a brand-new stream path with byte-identical source took 52s and
 * failed here; the immediate retry warmed in ~350ms. So the cost is real,
 * paid once per incarnation, and the only thing 45s bought was a first setup
 * that always failed and always worked on the second run.
 */
const WARMUP_DEADLINE_MS = 90_000;
/**
 * The subscription's name, which at CORE_STATE_VERSION 30 must EQUAL the
 * processor slug.
 *
 * There used to be two identities here: a `subscriptionKey`
 * (`app-voice-agent#voice-agent`) naming the subscription and a
 * `receiver.processorSlug` naming the contract to run. Version 30 collapsed
 * them — "the subscription NAME alone selects which registered contract a
 * processor-wake runs" — and made the payload strict, so the old pair is now
 * rejected outright. That rejection is what stopped every device: setup threw
 * a ZodError before it ever reached the warm-up, and the firmware, having no
 * way to report a rejected call, simply prepared a conversation again every
 * thirty seconds.
 *
 * Nothing checks this equality at configure time. A name matching no
 * registered processor commits happily and fails at the FIRST WAKE with the
 * registry's unknown-name error — which is a delivery failure on a live
 * conversation, not a setup failure anyone is watching.
 */
const VOICE_AGENT_SUBSCRIPTION_NAME = VOICE_AGENT_PROCESSOR_SLUG;
/**
 * What the voice model is told it is.
 *
 * Three paragraphs are load-bearing. Without an explicit instruction to keep
 * talking, a voice model handed an asynchronous tool goes silent waiting for
 * it, which sounds exactly like a dropped call. Without being told that
 * the back office is a colleague rather than a function — free to reply out
 * of order, several times, or not at all — it treats the first message that
 * arrives as the answer to whatever it asked last, and says so out loud.
 *
 * And without being told it is not the judge of its own limits, it declines.
 * A voice model knows what a voice model can usually do, which is nothing, so
 * it refuses on its own authority — and the half that could actually have done
 * the thing is never asked. The refusal paragraph exists because the honest
 * default is not "no", it is "let me see": only a RESULT line settles what
 * cannot be done, and only the careful half writes those.
 */

/* ===========================================================================
 * DIRECT TOOLS — what the voice half does ITSELF.
 *
 * The voice model is a mouth, a pair of ears and about 200ms of judgement.
 * Nearly everything asked of it belongs to the slower half through
 * `note_to_self`, and this table is the exception: the things that are INSTANT
 * AND LOCAL, where a round trip through a thinking model would be the only slow
 * part of them. Hanging up. Turning the head. Changing the face.
 *
 * ADDING ONE IS ONE ENTRY HERE, and nothing else in this file learns its name.
 * The entry carries the lot: what the model is told the tool is, what arguments
 * it may pass, which device methods it needs, and what happens when it is
 * called.
 *
 * WHAT IS OFFERED IS DERIVED, NEVER LISTED. `needs` names device methods, and a
 * tool reaches a call only if that call's device ADVERTISES them in its own
 * mount `instructions` — the same string the prompt quotes, written in the
 * firmware next to the dispatch table it describes. So a board with no servos
 * is never handed a nod tool, a board that grows one is handed it on the next
 * call, and no list of board names appears anywhere in this file.
 * ======================================================================== */

/**
 * One frame of a head gesture.
 *
 * `speed` is the device's name for the fourth argument of
 * `iterate_kit_stackchan_body_move_head`, and that argument is `duration_ms` —
 * the on-servo move time. So a step is not finished until `speed` milliseconds
 * have passed, and issuing the next one early overrides a move in progress
 * instead of following it.
 */
const BACK_OFFICE_BRIEF = [
  "You are the careful, thinking half of ONE assistant. The other half is a",
  "voice talking to a customer out loud, and it is the only way anything you",
  "say reaches them. Everything the customer says and everything the voice",
  "says arrives here as context, so you always know the conversation without",
  "being asked about it.",
  "",
  "YOU ARE NOT A SEPARATE PERSON, AND THE CUSTOMER MUST NEVER LEARN",
  "OTHERWISE. The voice presents your work as its own, because it is: you",
  "are the same assistant thinking properly. So write in the assistant's own",
  "first person — 'I checked the billing records and the March invoice was",
  "never sent' — never 'tell them that…', never 'the back office found',",
  "never anything that implies a second party. If a sentence you are about",
  "to send would sound odd coming straight out of the assistant's mouth,",
  "rewrite it until it does not.",
  "",
  "This is messaging, not question-and-answer. Send whenever you have",
  "something worth saying: an answer, a partial answer while you keep",
  "working, a question back, a correction, or something nobody asked for",
  "that they plainly need to know. Send as many as you like, in any order,",
  "at any time. Nothing is waiting on you, so silence is always an option",
  "and a slow careful reply is better than a fast wrong one.",
  "",
  "TO PUT SOMETHING IN FRONT OF THE VOICE DIRECTLY, append an",
  "`events.iterate.com/voice-agent/context-added` event to your own stream.",
  "It mirrors the `agents/context-added` you already use on yourself, one",
  "layer along:",
  "  content       what the voice should know, in plain spoken language",
  '  speechPolicy  { behaviour: "dont-trigger-speech" } — it learns this',
  '                but says nothing now; { behaviour: "after-current-speech" }',
  "                — it says this as soon as it stops talking, the normal",
  '                choice for an answer; { behaviour: "interrupt-current-speech" }',
  "                — it stops mid-sentence and says this, for when the customer",
  "                is about to act on something wrong. Rare.",
  "Nothing you append this way is attributed to the customer, so never write",
  "it as though you were them.",
  "",
  "YOUR `activity` IS NARRATED OUT LOUD, so write it as NEWS, not as a",
  "label. Every time you update it the customer hears a version of it, so",
  "it should say what just happened and what you are doing about it:",
  "'found a live weather source, fetching Bath now', 'that source returned",
  "an error, trying a different one', 'got the data, working out the",
  "forecast'. Not 'checking the weather' twice in a row with different",
  "words — that is the assistant sounding stuck, and it is worse than",
  "silence. If nothing material has changed, DO NOT UPDATE IT. Plain",
  "language a listener would understand: never 'invoking egress fetch'.",
  "",
  "Your `title` and `description` are different: they are the standing",
  "summary of the whole job and nobody reads them out. Set them once and",
  "leave them unless the job itself changes.",
  "",
  "What you SEND is the answer, and reaches the voice as a RESULT line.",
  "",
  "Messages arrive labelled 'Message #n'. When yours is about a particular",
  "one, START with that label — '#3: an octopus has three hearts…' — so the",
  "voice can tell the customer which thread it is picking up. When it is",
  "about nothing in particular, just say it. Labels go after 'NOW:' when you",
  "use both.",
  "",
  "SEND A CHAT MESSAGE. That is the only channel that reaches the customer",
  "— work in scripts all you like, but the words themselves have to be a",
  "message. Everything you send will be read out loud, so write to be",
  "spoken: two or three sentences of plain language, no lists, no URLs, no",
  "code. Lead with the point.",
].join("\n");
/** One key for every brief, so the head brief can be found and compared. */
const BRIEF_KEY = "voice-agent/voice-agent-brief";

/** The brief as the context event that carries it. */
const briefContext = (content: string) =>
  ({
    content,
    key: BRIEF_KEY,
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
    role: "system",
  }) as const;
/**
 * The brief's identity follows its CONTENT, so a changed brief installs and an
 * unchanged one deduplicates. That is what makes setup safe to re-run and what
 * makes a device gaining a capability reach the prompt without a second path
 * for "refresh".
 */
const briefKey = (context: ReturnType<typeof briefContext>) =>
  `voice-agent/brief:${contentHash(context)}`;

export interface HeadGestureStep {
  /** -128..128; 0 is forward (servo raw 460). */
  yawDegrees: number;
  /** 0..90; 0 is level (servo raw 620). */
  pitchDegrees: number;
  /** Milliseconds the servos are given for this move; the device caps it at 1000. */
  speed: number;
}

/**
 * Nod and shake, as the servo moves they are actually made of.
 *
 * DELIBERATELY NOT FIRMWARE. There is no `servos.nod()` and there should not
 * be: the device exposes one primitive — `servos.move({yawDegrees, pitchDegrees,
 * speed})` — and a gesture is a sequence of those with the timing that makes it
 * read as a gesture. That timing is a thing to tune by watching a robot, which
 * is a thing to do here rather than behind a reflash.
 *
 * Every gesture starts and ends at home (yaw 0, pitch 0) because nothing else
 * in the firmware ever moves the head: this capability is the only caller of
 * `move_head`, so home is where the head is unless a gesture left it elsewhere.
 * Which way pitch leans is the board's own convention and both readings of it
 * are a nod.
 */
export const HEAD_GESTURES = {
  nod: [
    { yawDegrees: 0, pitchDegrees: 24, speed: 260 },
    { yawDegrees: 0, pitchDegrees: 0, speed: 260 },
    { yawDegrees: 0, pitchDegrees: 24, speed: 260 },
    { yawDegrees: 0, pitchDegrees: 0, speed: 260 },
  ],
  shake: [
    { yawDegrees: -26, pitchDegrees: 0, speed: 240 },
    { yawDegrees: 26, pitchDegrees: 0, speed: 240 },
    { yawDegrees: -26, pitchDegrees: 0, speed: 240 },
    { yawDegrees: 0, pitchDegrees: 0, speed: 240 },
  ],
} as const satisfies Record<string, readonly HeadGestureStep[]>;

/**
 * Does a device's own mount `instructions` advertise this method?
 *
 * THE DEVICE'S WORD, NOT OURS. `instructions` is the one description of a board
 * that ever leaves it (`options.instructions` at the bottom of each
 * `*_device.c`, straight into `provideCapability`), it is what the prompt
 * already quotes, and it is written beside the dispatch table it describes. So
 * "does this board have servos" is asked of the board rather than answered from
 * a table of board names here, which would be wrong the first time somebody
 * added a servo to a board.
 *
 * Matches the method NAME followed by an open bracket, which is how every one
 * of them is written — `servos.move({yawDegrees,…})`, `health()`. The leading
 * guard stops `speaker.volume(` from satisfying a need for `volume(`.
 */
export function advertisesMethod(instructions: string, method: string): boolean {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w.])${escaped}\\s*\\(`).test(instructions);
}

/**
 * What a direct tool may do when the model calls it.
 *
 * EVERY VERB HERE RETURNS IMMEDIATELY. This is the realtime lane: a tool that
 * waits on a device call is a voice model saying nothing, and thirty seconds of
 * nothing is a dropped call as far as anyone listening can tell. The work is
 * handed to the call's own background lane and the tool answers the model in
 * the same tick.
 */
export interface DirectToolCall {
  /** Whatever the model sent, already parsed. Untrusted: a tool checks its own. */
  args: Record<string, unknown>;
  /** One method on the device this tool was derived from. Fire and forget. */
  device(method: string, argument?: unknown): void;
  /** A sequence of head moves, paced so each one finishes before the next. */
  gesture(steps: readonly HeadGestureStep[]): void;
  /** End the call once whatever is being said has finished PLAYING — see settleHangUp. */
  hangUp(reason: string): void;
}

/** One direct tool, as the table declares it. */
export interface DirectTool {
  /** The name the model calls, and part of the prompt: read it out in your head. */
  name: string;
  /** What the model is told this is for. The only place that explains it. */
  description: string;
  /** JSON Schema for the arguments, as the provider's `tools` entry carries it. */
  parameters: { properties: Record<string, unknown>; required?: string[]; type: "object" };
  /**
   * Device methods this tool cannot work without, exactly as the firmware
   * advertises them. Empty means it needs no device at all.
   */
  needs: readonly string[];
  /** Do it, and return the line handed back to the model as the tool's output. */
  run(call: DirectToolCall): string;
}

/** The 11 held expressions `face_stage_apply_held_expression` takes, lowercased. */
const FACE_EXPRESSIONS = [
  "neutral",
  "warm",
  "joy",
  "concern",
  "surprise",
  "thoughtful",
  "skeptical",
  "determined",
  "sleepy",
  "excited",
  "embarrassed",
] as const;

/** THE TABLE. Everything a direct tool is, in one entry each. */
export const DIRECT_TOOLS: readonly DirectTool[] = [
  {
    /*
     * ONE WAY TO END A CALL, and this is not a second one. The bridge's own
     * teardown appends `events.iterate.com/voice-agent/conversation-ended`, which
     * is the same event the device appends when somebody touches the screen and
     * the same one `endCall` appends — so hanging up here joins the existing
     * lifecycle path rather than inventing a parallel one.
     *
     * `needs` is empty on purpose. Ending a call is a property of the CALL, not
     * of the hardware: a bridge with no device mounted at all can still be hung
     * up, and every board can be.
     */
    name: "hang_up",
    description:
      "End the call. Say your goodbye FIRST, in the same breath — this hangs up as soon as " +
      "you stop speaking, and the person hears everything you said before it. Use it when " +
      "they say goodbye, when the conversation is plainly finished, or when they ask you to " +
      "hang up. Not to escape a question you would rather not answer.",
    needs: [],
    parameters: { properties: {}, type: "object" },
    run: (call) => {
      call.hangUp("the assistant hung up");
      return "hanging up as soon as you stop talking — finish your goodbye, then say nothing more";
    },
  },
  {
    name: "nod",
    description:
      "Nod your head, physically. A real robot head moves. Use it the way a person nods: " +
      "agreeing, saying yes, or showing you are listening while they talk. It makes no sound " +
      "and does not interrupt you, so you can nod in the middle of a sentence.",
    needs: ["servos.move"],
    parameters: { properties: {}, type: "object" },
    run: (call) => {
      call.gesture(HEAD_GESTURES.nod);
      return "nodding";
    },
  },
  {
    name: "shake_head",
    description:
      "Shake your head, physically. Use it the way a person does: disagreeing, saying no, or " +
      "showing something is not right. It makes no sound and does not interrupt you.",
    needs: ["servos.move"],
    parameters: { properties: {}, type: "object" },
    run: (call) => {
      call.gesture(HEAD_GESTURES.shake);
      return "shaking your head";
    },
  },
  {
    /*
     * NO BOARD ADVERTISES `face.set(` TODAY, so nothing is offered this tool and
     * that is the correct answer rather than a gap.
     *
     * The mechanism is all there in firmware and none of it is reachable:
     * `face_stage_apply_held_expression` takes the eleven expressions below and
     * its only caller is the doze animation, hardcoded to SLEEPY, so ten of them
     * have never been seen. Its own header says the shape is "suitable for AI
     * tool calls". What is missing is the RPC: a `face.set` method in the
     * dispatch table, and the method named in that board's `instructions[]`.
     * The day both exist, this entry lights up on every board that has them and
     * on no board that does not, with no edit here.
     */
    name: "set_face",
    description:
      "Change the expression on your face. You have a face and people watch it, so let it " +
      "follow what you are saying — warm when you greet someone, thoughtful while you work " +
      "something out, concern when the news is bad. It makes no sound and does not interrupt " +
      "you.",
    needs: ["face.set"],
    parameters: {
      properties: {
        expression: { enum: [...FACE_EXPRESSIONS], type: "string" },
      },
      required: ["expression"],
      type: "object",
    },
    run: (call) => {
      const expression = String(call.args.expression ?? "");
      if (!FACE_EXPRESSIONS.includes(expression as (typeof FACE_EXPRESSIONS)[number])) {
        return `there is no expression called "${expression}"; the ones you have are ${FACE_EXPRESSIONS.join(", ")}`;
      }
      call.device("face.set", { expression });
      return `your face is now ${expression}`;
    },
  },
];

/** One live capability mount, as both the prompt and the tool table read it. */
export interface LiveCapability {
  /**
   * The CLIENT this mount belongs to — an absolute stream path, e.g.
   * `"/clients/stackchan"`.
   *
   * Devices connect with `projects.connect`, which makes each board its own
   * capability-host scope rather than a name on the project root. Reaching one
   * therefore takes the path, not just a dotted name: the invocation goes to
   * `clients.get(clientPath)`, and `path` addresses the mount within it.
   */
  clientPath: string;
  /** Mount path within that client's host — `["capabilities"]` for a connect. */
  path: string[];
  /** The device's own description of itself — see advertisesMethod. */
  instructions: string;
}

/** Everything the project's live mounts add up to, or why they could not be read. */
export interface ProvidedCapabilities {
  live: LiveCapability[];
  /** Set when `__describe` failed; `live` is then empty and nothing is claimed. */
  error?: string;
}

/**
 * A direct tool, bound to the mount that earned it.
 *
 * `mountPath` is null exactly when the tool needs no device (`needs: []`). When
 * two mounted devices both advertise what a tool needs, the FIRST wins: a call
 * runs on one stream with one device on it, and there is nothing in a
 * capability inventory that says which. A second board with servos would get a
 * nod tool aimed at the first, which is a reason to look here — not a reason to
 * offer the model two tools called `nod`.
 */
export interface DerivedTool {
  tool: DirectTool;
  mountPath: string[] | null;
  /** The client scope `mountPath` lives in; null exactly when `mountPath` is. */
  clientPath: string | null;
}

/**
 * Which direct tools this project's live mounts earn, and what each acts on.
 *
 * Pure, exported and separate from the call path, because "a board with no
 * servos must never be offered a nod" is the whole design and is exactly the
 * kind of claim that is true until somebody edits the table.
 */
export function directToolsFor(provided: ProvidedCapabilities): DerivedTool[] {
  const derived: DerivedTool[] = [];
  for (const tool of DIRECT_TOOLS) {
    if (tool.needs.length === 0) {
      derived.push({ tool, mountPath: null, clientPath: null });
      continue;
    }
    const mount = provided.live.find((entry) =>
      tool.needs.every((method) => advertisesMethod(entry.instructions, method)),
    );
    if (mount !== undefined) {
      derived.push({ tool, mountPath: mount.path, clientPath: mount.clientPath });
    }
  }
  return derived;
}

/** The derived tools as the provider's `session.update` carries them. */
export function directToolDefinitions(derived: readonly DerivedTool[]) {
  return derived.map(({ tool }) => ({
    description: tool.description,
    name: tool.name,
    parameters: tool.parameters,
    type: "function" as const,
  }));
}

/** One speaker frame is 640 bytes of PCM16 at 16 kHz. */
const SPK_FRAME_MS = 20;
/**
 * The most a hang-up will ever wait for audio to finish.
 *
 * The device's playout ring holds thirty seconds, so nothing it is still
 * holding can be older than that — and a wait computed longer than this is
 * arithmetic that has gone wrong, not a very long goodbye.
 */
const MAX_PLAYOUT_WAIT_MS = 30_000;
/**
 * How long a hang-up waits for the floor before it happens anyway.
 *
 * A hang-up that waits forever is the failure this bound exists to stop. The
 * settle is a POLL rather than a callback for the same reason: four separate
 * places set `responseActive = false` — response.done, an interrupting line
 * taking the floor, a barge-in cancel, a turn commit — and only one of them
 * ever called the settle, so a hang-up that came free on any of the other
 * three sat pending for the rest of the call. Measured on the StackChan: the
 * tool fired, the model said "Goodbye!", the call stayed up.
 */
const HANG_UP_DEADLINE_MS = 15_000;

/**
 * Whether a hang-up the model asked for should be acted on now.
 *
 * Two ways to become due, and the second is what makes this safe: the floor is
 * free (the goodbye has been generated, so all that is left is playing it), or
 * the deadline has passed and the call ends regardless of what any flag says.
 * "The assistant said it was hanging up and the call stayed open" is worse than
 * a goodbye clipped by a second.
 */
export function hangUpIsDue(
  pending: { askedAtMs: number } | null,
  floorBusy: boolean,
  nowMs: number,
): boolean {
  if (pending === null) return false;
  if (nowMs - pending.askedAtMs >= HANG_UP_DEADLINE_MS) return true;
  return !floorBusy;
}

/**
 * How much of the answer the device has still to play, in milliseconds.
 *
 * HANGING UP IS DESTRUCTIVE, and this is what stops it cutting a goodbye in
 * half. `conversation-ended` reaching a device calls `abandon_speaker_audio()`
 * — its own comment: "a call that ends mid-answer would otherwise play the dead
 * conversation out" — so everything still in the ring is thrown away. And the
 * ring is usually full: frames leave this bridge as fast as the wire takes them
 * while the device plays them at realtime (see THE SERVER DOES NOT PACE), so at
 * the moment `response.done` arrives the device may be holding almost the whole
 * answer.
 *
 * The bound is computable rather than guessed: an answer is `frames` × 20ms of
 * speech, it started playing no earlier than its first frame went out, so what
 * is left is the difference. Never negative, never past the size of the ring.
 */
export function playoutRemainingMs(
  answer: { frames: number; firstFrameAtMs: number },
  nowMs: number,
): number {
  if (answer.frames <= 0 || answer.firstFrameAtMs <= 0) return 0;
  const spoken = nowMs - answer.firstFrameAtMs;
  const total = answer.frames * SPK_FRAME_MS;
  return Math.max(0, Math.min(MAX_PLAYOUT_WAIT_MS, total - spoken));
}

/**
 * Every live capability this project provides, as the model should be told
 * about it — read from the capabilities themselves.
 *
 * ONE SOURCE, DELIBERATELY. The alternative is a description of the device
 * written here in TypeScript beside the real one written in the firmware, and
 * two copies of a list of methods drift the first time somebody adds one. The
 * device already advertises what it can do (its mount `instructions`), so the
 * prompt quotes that rather than restating it. A method that does not exist
 * therefore cannot be mentioned, and one that is added arrives on the next
 * setup without anybody editing this file.
 */
export function capabilityBrief(provided: ProvidedCapabilities): string {
  if (provided.error !== undefined) {
    return `The device description could not be read (${provided.error}). Do not guess at what hardware can do.`;
  }
  /*
   * WHAT THE VOICE CAN ALREADY DO WITHOUT YOU.
   *
   * The thinking half is the one that decides whether something is possible, so
   * it has to know the short list of things the voice does NOT need it for —
   * otherwise it plans a way to hang up a call the voice can simply hang up.
   * Names only: the full descriptions are written at the voice, in the second
   * person, and read as nonsense addressed to anybody else. Derived from the
   * same table as the tools themselves, so the two halves cannot come to
   * disagree about which is which.
   */
  const itself = [
    "",
    "## What the voice half can already do on its own",
    "",
    `It does these itself, this instant, without asking you: ${directToolsFor(provided)
      .map(({ tool }) => tool.name)
      .join(", ")}. Never plan a way to do one of them for it, and never say`,
    "one of them cannot be done.",
  ].join("\n");
  if (provided.live.length === 0) {
    return [
      "No device is mounted on this project right now. Do not claim to have",
      "read anything from one; say it is not connected.",
      itself,
    ].join("\n");
  }
  return [
    provided.live
      .map((entry) =>
        [
          `Capability \`itx.clients.get("${entry.clientPath}").${entry.path.join(".")}\` — call it with dotted paths.`,
          entry.instructions,
        ].join("\n"),
      )
      .join("\n\n"),
    itself,
  ].join("\n");
}

/**
 * Read the project's live device mounts. Never throws: an honest gap beats a
 * wrong claim.
 *
 * DEVICES ARE CLIENTS, so this walks `clients.list()` and describes each
 * connected scope rather than reading the project root. A board used to mount
 * itself at a root name (`kit.stackchan`) and appear in the root's own
 * `__describe`; it now connects with `projects.connect`, which gives it a
 * capability-host scope of its own. The root describes nothing about it, so a
 * root read here would silently report a project with no devices — every tool
 * withdrawn, the model quietly unable to move a servo, and no error anywhere.
 *
 * Disconnected clients are skipped: presence is last-known but honest, and
 * offering a tool for a board that is not on the network buys a timeout
 * instead of a gesture.
 */
async function readProvidedCapabilities(
  project: Awaited<IterateWorkerEntrypoint["itx"]>,
): Promise<ProvidedCapabilities> {
  try {
    const clients = await project.clients.list();
    const connected = clients.filter((client) => client.connected);
    const described = await Promise.all(
      connected.map(async (client) => {
        let description:
          | Awaited<ReturnType<ReturnType<typeof project.clients.get>["__describe"]>>
          | undefined;
        try {
          description = await project.clients.get(client.path).__describe();
          return (description.capabilities ?? [])
            .filter(
              (entry) => entry.type === "live" && (entry.instructions ?? "").trim().length > 0,
            )
            .map((entry) => ({
              clientPath: client.path,
              path: entry.path ?? [],
              instructions: entry.instructions ?? "",
            }));
        } catch {
          /* One unreachable board must not blind the agent to the others. */
          return [];
        } finally {
          disposeRpcStub(description, `client ${client.path} description result`);
        }
      }),
    );
    return { live: described.flat() };
  } catch (error) {
    return { live: [], error: String(error) };
  }
}

/**
 * The back office exists, and knows what it is for.
 *
 * Called from setup AND from the call path, because a call can perfectly well
 * start without setup ever having run: a direct `startCall`, a `mode=bridge`
 * host, a project somebody configured by hand. Appending to an agent that is
 * not there fails quietly down in the call path while `handleToolCall` goes on
 * telling the model "the back office will reply when it has something" — so
 * the assistant keeps promising a colleague that never answers.
 */
/**
 * Which brief is current, as a fact the processor is TOLD rather than one it
 * goes looking for.
 *
 * Every readable design failed on the same rock: filtered stream reads only go
 * forward (`StreamEventReadInput` has `afterOffset`, `beforeOffset`, `limit` —
 * no reverse order), so "the newest matching event" is the LAST page, and every
 * attempt to find it cheaply was a guess about how far back to look.
 *
 *  1. `getEvents({eventTypes, limit: 500})` reads from offset ZERO and returned
 *     the first brief ever installed, while its comment claimed to compare the
 *     head.
 *  2. A bounded tail (`head - 10_000`) worked until the brief fell out of the
 *     window: two full sessions of audio frames move the head about that far,
 *     and session 3 of a ten-session run failed with "no brief is at the head"
 *     seconds after refreshing one.
 *  3. Paging the filter to the end is exact, but it still scans history that is
 *     overwhelmingly audio, and its page cap is one more arbitrary number.
 *
 * So setup states the answer instead. Each setup appends the brief under a
 * per-setup identity and then a marker naming it; the marker is a type the
 * processor's subscription carries, so the processor learns which brief is
 * current through the same filtered delivery a `conversation-requested` arrives on, and
 * folds it into state. No history is read by anyone.
 */
const BRIEF_MARKER_TYPE = "events.iterate.com/voice-agent/brief-current";

/** The brief setup installed, and the setup that installed it. */
export interface BriefMarker {
  /** Unique per setup: what makes "the current brief" a checkable identity. */
  setupId: string;
  /** The idempotencyKey of the context event carrying the brief text. */
  briefKey: string;
  /** Of the brief text, so a changed prompt is visible without reading it. */
  contentHash: string;
}

/**
 * The marker an event carries, or null.
 *
 * Pure, exported and separate from `reduce` so the folding rule can be tested
 * against a history with tens of thousands of audio events between markers —
 * the shape that broke all three reading designs.
 */
export function briefMarkerFromEvent(event: {
  type: string;
  payload?: unknown;
}): BriefMarker | null {
  if (event.type !== BRIEF_MARKER_TYPE) return null;
  const payload = event.payload as Partial<BriefMarker> | null;
  if (
    typeof payload?.setupId !== "string" ||
    typeof payload.briefKey !== "string" ||
    typeof payload.contentHash !== "string" ||
    payload.setupId.length === 0 ||
    payload.briefKey.length === 0
  ) {
    return null;
  }
  return {
    setupId: payload.setupId,
    briefKey: payload.briefKey,
    contentHash: payload.contentHash,
  };
}

/** One `events.iterate.com/voice-agent/viseme` outbound event, ready for the append lane. */
export interface VisemeAppendEvent {
  type: "events.iterate.com/voice-agent/viseme";
  ephemeral: true;
  payload: {
    /** The call whose mouth this drives. */
    conversationId: string;
    /** Which answer the offset is relative to — the spk-frame `answer`. */
    answer: number;
    /** 16 kHz samples from the answer's first sample. */
    playoutSamples: number;
    /** Firmware viseme id 0-14; 14 (SIL) closes the mouth. */
    viseme: number;
    /** Classification confidence 0-255; 0 for SIL. */
    confidence: number;
  };
}

/**
 * The per-call seam between speaker audio and the device's mouth: the same
 * whole 20 ms frames `appendSpkPcm` ships (their PCM16, before the mu-law
 * encode) go in, and the sparse `events.iterate.com/voice-agent/viseme` events to append come
 * out, already shaped for the outbound lane. Exported, and separate from the
 * lane itself, so the emission rule can be tested with literal expectations.
 *
 * `end` closes the current answer's track — the mouth always closes with SIL
 * — and `reset` starts the next one, offsets back at zero. Audio arriving
 * after `end` for the same answer is dropped rather than reopening a closed
 * mouth; the next `reset` starts a fresh track.
 */
export function createVisemeEmitter(conversationId: string) {
  const tracker = createVisemeTracker();
  let ended = false;
  const shape = (event: VisemeChangeEvent, answer: number): VisemeAppendEvent => ({
    type: "events.iterate.com/voice-agent/viseme",
    ephemeral: true,
    payload: {
      conversationId,
      answer,
      playoutSamples: event.playoutSamples,
      viseme: event.viseme,
      confidence: event.confidence,
    },
  });
  return {
    /** Consumes an answer PCM16 chunk; returns the events to append after it. */
    push(pcm: Int16Array, answer: number): VisemeAppendEvent[] {
      if (ended) return [];
      return tracker.push(pcm).map((event) => shape(event, answer));
    },
    /** Ends the answer; returns the closing SIL to append when one is due. */
    end(answer: number): VisemeAppendEvent[] {
      if (ended) return [];
      ended = true;
      const closing = tracker.end();
      return closing === undefined ? [] : [shape(closing, answer)];
    },
    /** Starts the next answer: track and playout clock back to zero. */
    reset(): void {
      tracker.reset();
      ended = false;
    },
  };
}

async function ensureVoiceAgent(
  agent: Agent,
  capabilityBrief: string,
  /** This setup's identity, which becomes part of the brief's own identity. */
  setupId: string,
) {
  const context = briefContext(
    [
      BACK_OFFICE_BRIEF,
      "",
      "## The hardware you are speaking through",
      "",
      /*
       * This stream is append-only, so an earlier description of the hardware is
       * still sitting in the context above. Saying which one wins is cheaper and
       * more reliable than hoping the model prefers the later text — and a
       * device that GAINS or LOSES a method between setups is the ordinary case,
       * not an exception.
       */
      "This section replaces any earlier description of this device in this",
      "conversation. If an earlier one lists a method that is not named here,",
      "that method no longer exists — do not call it.",
      "",
      capabilityBrief,
    ].join("\n"),
  );
  try {
    // Nothing may be appended to the agent's stream before the agent exists.
    await discardRpcResult(agent.create({}), "agent create result");
  } catch {
    /* Already born: create over an existing agent is loud, not fatal. */
  }
  /*
   * A FRESH OCCURRENCE EVERY SETUP, AND NOTHING READ TO DECIDE IT.
   *
   * The key used to be a hash of the content alone, which deduplicates against
   * ANY brief already on the stream — so a prompt that changed and then changed
   * BACK did not reinstall, and the newest system context the model saw stayed
   * the intermediate one. Measured: a diagnostic-only tool was removed from the
   * device, setup reported "already there", and the newest brief still told the
   * model the tool existed. Suffixing the key with the previous brief's offset
   * fixed that but required FINDING the previous brief, which is the read that
   * cannot be done cheaply or exactly (see BRIEF_MARKER_TYPE).
   *
   * So each setup writes its own occurrence, unconditionally. The platform's
   * agent reducer is built for exactly this: a keyed system item is replaced in
   * place by an update with the same `key`, and compaction keeps the latest
   * occurrence per key. `payload.key` stays BRIEF_KEY — the slot — while the
   * idempotencyKey carries this setup's identity, so the newest brief is always
   * the one this setup just installed and never a survivor of an older one.
   */
  const installed = await agent.append({
    type: "events.iterate.com/agents/context-added",
    idempotencyKey: `${briefKey(context)}:setup:${setupId}`,
    payload: context,
  });
  return installed;
}

/*
 * LOOSE, DELIBERATELY — the same doctrine the conversationId filter is built on: the
 * peers are not all in this repository.
 *
 * A strict object rejects the whole event for one field nobody here has heard
 * of, and the failure is total and silent: the event is skipped, no call
 * happens, and nothing says why. Firmware stamping a build id, a script
 * carrying its own correlation field, a future field added on the device
 * before it is added here — every one of those is a dropped call. The fields
 * this bridge acts on are still validated; the rest ride along untouched.
 */

/**
 * G.711 mu-law to little-endian PCM16. The inverse of what the device does to
 * fit its microphone through a link that could not carry PCM16.
 */
function mulawToPcm16(mulaw: ArrayBuffer): ArrayBuffer {
  const input = new Uint8Array(mulaw);
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index++) {
    const value = ~input[index]!;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    output[index] = sign !== 0 ? -sample : sample;
  }
  return output.buffer;
}

/**
 * PCM16 to G.711 mu-law. Shared, because the facet and the retiring bridge both
 * encode the downlink and two copies of this would be two subtly different
 * voices.
 *
 * Halving the bytes is what lets a microcontroller RECEIVE speech at all: the
 * device was measured taking 9-31 frames a second against the 50 realtime
 * needs, and concealing the shortfall. ~950 bytes per 20 ms becomes ~520.
 */
function encodeMulawFromPcm16(pcm: Uint8Array): Uint8Array {
  const BIAS = 0x84;
  const CLIP = 32635;
  const samples = pcm.length >> 1;
  const out = new Uint8Array(samples);
  for (let index = 0; index < samples; index++) {
    let sample = ((pcm[index * 2]! | (pcm[index * 2 + 1]! << 8)) << 16) >> 16;
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--) {
      mask >>= 1;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[index] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * A short stable fingerprint of a payload, for deriving idempotency keys FROM
 * WHAT IS BEING APPENDED rather than from a number somebody has to remember to
 * bump.
 *
 * An append whose key matches an existing event but whose payload does not
 * THROWS, naming an offset rather than a cause. So a hand-versioned key turns
 * every future edit to a payload into a setup that fails for every stream
 * already configured — and for the project-global back-office brief, one
 * unbumped edit would brick setup for every stream in the project at once.
 * Content-derived, an unchanged payload keeps its key and deduplicates, and a
 * changed one gets a new key and commits.
 *
 * FNV-1a over the serialised payload. Deterministic and dependency-free is the
 * whole requirement: this is not a security boundary, it is a way of noticing
 * that two payloads differ.
 */
function contentHash(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/**
 * The idempotency key the birth certificate is appended under.
 *
 * ONE OCCURRENCE PER SETUP, and it has to be, for exactly the reason
 * {@link ensureVoiceAgent} gives about the brief: an append keyed on its own
 * CONTENT deduplicates against any identical event already on the stream, so a
 * decision that changed and then changed BACK is silently not applied. Here
 * the decision is which provider to dial, and a morning of hardware runs
 * alternates it — mock, real, another mock, real — so by the second `real` the
 * content key was already taken, nothing was appended, and the newest `created`
 * the fold could see still named a captun tunnel that had closed an hour
 * before. Silent, and it fails as "the call just does not answer".
 *
 * `contentHash` is deliberately NOT used. The stream stays in the key so two
 * streams cannot collide; the setup's own id is what makes it an occurrence.
 */
export function birthCertificateKey(
  streamPath: string,
  payload: { providerBaseUrl?: string },
  setupId: string,
): string {
  /* The payload is in the key only so a reader can see what an occurrence
   * decided; the setup's id is what makes it one. */
  return `voice-agent/created:${streamPath}:${contentHash(payload)}:setup:${setupId}`;
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Where the loader finds the facet class: this file, in the project's config repo. */
function voiceAgentFacetRef(streamPath: string) {
  return {
    className: "VoiceAgentFacet",
    durableWorkerKey: "voice-agent-facet",
    path: streamPath,
    source: {
      createWorker: {
        entryPoint: "voice-agent.ts",
        files: { repoPath: "/repos/config", type: "repo" },
      },
    },
    type: "stateful",
  } satisfies StatefulDynamicWorkerRef;
}

/** What setup needs to know to install the agent on a stream. */
export interface SetupVoiceAgentOptions {
  /** The conversation stream. A fresh /agents/voice/* path is generated when omitted. */
  streamPath?: string;
  /**
   * Install the subscription under a fresh key.
   *
   * A MANUAL OVERRIDE, no longer a requirement: setup appends its subscription
   * under a key derived from the stream path and the payload's own content, so
   * re-running it is a no-op — which is the point, but it also means a
   * subscription somebody removed would stay removed, the re-install being
   * deduplicated against the original. Setup now checks whether the
   * subscription is really active afterwards and heals it under a fresh key if
   * it is not, so a plain re-run after `removeVoiceAgent` works. This says "do
   * it again anyway" without asking.
   */
  reinstall?: boolean;
  /**
   * Dial THIS instead of x.ai, for a deterministic test.
   *
   * A real provider is a bad oracle: its answers vary in length, its deltas
   * land wherever they land, and "count to one hundred" is ninety seconds of
   * wall clock per run. A mock speaking exactly N milliseconds on demand turns
   * every audio question — did anything stutter, overrun, underrun, or speed
   * up — into arithmetic, against the REAL facet on a REAL deployment rather
   * than an in-process double.
   *
   * NO CREDENTIAL FOLLOWS IT. The URL used to be pinned precisely because a
   * caller-chosen one is a bearer token waiting to be exfiltrated. It still is,
   * so the rule is not "trust the caller" but "a host that is not x.ai gets no
   * Authorization header at all" — see {@link dialGrokSocket}. A mock has no
   * use for the key, and the only way to receive it remains being x.ai.
   */
  providerBaseUrl?: string;
}

export interface SetupVoiceAgentResult {
  streamPath: string;
  created: string[];
  alreadyThere: string[];
  /**
   * Proof that setup left this stream ready, not merely configured.
   *
   * `acknowledged` is the processor for this stream having consumed a token and
   * answered it — the only proof that is not structural. `briefMatched` is that
   * answer carrying the brief setup just installed, so the running processor is
   * known to see the current prompt. Setup throws rather than returning with
   * either false, or with a protocol revision it does not recognise.
   */
  warm: {
    ok: boolean;
    ms: number;
    token: string;
    acknowledged: boolean;
    briefMatched: boolean;
    /** The bridge worker calls go through was built and instantiated. */
    bridgeWarmed: boolean;
    bridgeWarmMs?: number;
    protocolRevision?: string;
    expectedBriefKey: string;
    expectedSetupId: string;
    seenBriefKey?: string;
    seenSetupId?: string;
    error?: string;
  };
}

/*
 * Both lifecycle events carry the subscription's `name`. It is optional only
 * on configuration (an omitted name derives `subscription:<offset>`), and this
 * setup always sends one, so an event without a name is somebody else's.
 */
const SubscriptionLifecyclePayload = z.object({ name: z.string() });

async function voiceAgentSubscriptionStatus(stream: Stream): Promise<{
  active: boolean;
  installation: number;
}> {
  let active = false;
  let installation = 0;
  using pager = stream.readEvents({
    eventTypes: [
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-removed",
    ],
  });
  for (;;) {
    const events = await pager.next();
    if (events.length === 0) break;
    for (const event of events) {
      const payload = SubscriptionLifecyclePayload.safeParse(event.payload);
      if (!payload.success || payload.data.name !== VOICE_AGENT_SUBSCRIPTION_NAME) {
        continue;
      }
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        installation++;
        active = true;
      }
      if (event.type === "events.iterate.com/stream/subscription-removed") active = false;
    }
  }
  return { active, installation };
}

export default class VoiceAgentEntrypoint extends IterateWorkerEntrypoint {
  /**
   * Prove this guest is BUILT, RUNNING, and able to reach its own project.
   *
   * A dynamic worker is built lazily on the first call into it, so that first
   * call carries a cold build — and if the build fails, it fails there, in
   * whatever the caller happened to be doing. Committing the file says
   * nothing about whether it compiles.
   *
   * Having a call whose only job is to be the first one means a caller can
   * wait for the worker deliberately, retry a cold start without retrying
   * anything that has side effects, and report a build failure as a build
   * failure rather than as "the conversation would not start".
   *
   * It touches `this.itx` on purpose: a worker that loads but cannot reach
   * its project is not healthy, and answering from a field would prove only
   * that the isolate booted.
   */
  async health(): Promise<{ ok: true; projectId: string; xaiSecretReady: boolean }> {
    const project = await this.itx;
    const projectId = await project.projectId;
    const xaiSecret = project.secrets.get(XAI_SECRET);
    try {
      const secret = await xaiSecret.__describe();
      try {
        /*
         * Reported rather than thrown. Whether a credential exists is the
         * caller's decision to act on, and a health check that fails on policy
         * cannot distinguish "this worker is broken" from "you have not finished
         * setting up" — which are different problems with different fixes.
         */
        return {
          ok: true,
          projectId,
          xaiSecretReady: secret.created === true && secret.hasMaterial === true,
        };
      } finally {
        disposeRpcStub(secret, "health secret description result");
      }
    } finally {
      disposeRpcStub(xaiSecret, "health secret");
    }
  }

  async setupVoiceAgent(options: SetupVoiceAgentOptions = {}): Promise<SetupVoiceAgentResult> {
    const streamPath = options.streamPath ?? `/agents/voice/${crypto.randomUUID()}`;
    if (!streamPath.startsWith("/")) {
      throw new Error(
        `voice-agent streamPath must be absolute; received ${JSON.stringify(streamPath)}`,
      );
    }

    const project = await this.itx;
    const xaiSecret = project.secrets.get(XAI_SECRET);
    let xaiDescription: { created: boolean; hasMaterial: boolean };
    try {
      const description = await xaiSecret.__describe();
      try {
        xaiDescription = {
          created: description.created,
          hasMaterial: description.hasMaterial,
        };
      } finally {
        disposeRpcStub(description, "setup secret description result");
      }
    } finally {
      disposeRpcStub(xaiSecret, "setup secret");
    }
    if (!xaiDescription.created || !xaiDescription.hasMaterial) {
      throw new Error(
        'Voice agent setup requires secret "/secrets/xai" with material. Create it explicitly with ' +
          'await itx.secrets.get("/secrets/xai").create({ egress: { urls: ["https://api.x.ai"] }, material: "<xAI API key>" }); then rerun setupVoiceAgent. The voice agent never creates or copies credentials.',
      );
    }

    /*
     * Setting up is APPENDING, and an append carrying an idempotencyKey is
     * already idempotent — the platform deduplicates on it. So nothing below
     * is read before it is written: every event is appended unconditionally
     * under a key derived from what it is, and a second run appends the same
     * keys and changes nothing.
     *
     * The earlier shape asked "does this exist?" before each append purely to
     * print a nicer report. That cost four extra round trips, raced with
     * itself (two concurrent setups would both read "absent" and both claim
     * to have created), and still could not be trusted. What is reported
     * instead is derived from what came back: a deduplicated append returns
     * the event that was already on the stream, so an event older than this
     * call is one this call did not create.
     *
     * There is ONE read, at the end, and it is a different question: not "did
     * I create this?" but "is this stream actually listening?" — see below.
     */
    const stream = project.streams.get(streamPath);
    /* The voice agent for THIS conversation is also its back office. */
    const backOffice = project.agents.get(streamPath);
    let voiceEvents: Awaited<ReturnType<Stream["append"]>> | undefined;
    let agentEvents: Awaited<ReturnType<typeof ensureVoiceAgent>> | undefined;
    try {
      /* The birth certificate is where per-stream provider configuration
       * belongs: it is appended once, folded into state, and survives the
       * eviction that a per-call option would not. */
      const birthPayload =
        options.providerBaseUrl === undefined ? {} : { providerBaseUrl: options.providerBaseUrl };
      /*
       * THE SUBSCRIPTION, as one value, because its KEY is derived from it.
       *
       * `name` inside the payload is the platform's own handle on the
       * subscription and must stay the stable VOICE_AGENT_SUBSCRIPTION_NAME:
       * that is what makes a re-install REPLACE this subscription rather than
       * run a second one alongside it, AND — since version 30 — what selects
       * which registered processor contract the wake runs. The idempotency key
       * underneath is a different thing entirely and follows the content — see
       * contentHash.
       */
      const subscriptionPayload = {
        name: VOICE_AGENT_SUBSCRIPTION_NAME,
        description: "Wake the separately deployed voice-agent guest for call requests.",
        /*
         * THE FILTER IS THE CONTRACT'S OWN `consumes`, and it must be.
         *
         * Delivery is this filter INTERSECTED with `consumes`, so a type in
         * one and not the other is silently never delivered. Maintaining two
         * hand-written lists of the same thing cost three separate debugging
         * sessions in one day: first the audio types, then the warm-up
         * handshake, then the press verbs — each time the symptom was total
         * silence with nothing in any log, because a filtered-out event leaves
         * no trace anywhere.
         *
         * Deriving it means the two cannot drift. Adding a type to `consumes`
         * is now the whole change.
         */
        filter: { eventTypes: [...VoiceAgentFacetContract.consumes] },
        /*
         * A FACET, IN THIS STREAM'S OWN DURABLE OBJECT.
         *
         * This could not be done until #2455: a facet used to be dialled by
         * name out of the composition in processor-facet-durable-object.ts,
         * whose arms are chosen purely from the stream path, so a facet
         * contract had to be one the OS worker itself registers. This contract
         * is defined here, in the project's config repo, so it could not be in
         * that composition. `source: userspace` LOADS the class from the repo
         * instead, which removes that restriction entirely.
         *
         * What it buys is a hop per frame. The old expression lane woke a
         * SECOND Durable Object that held the provider socket, so every 20 ms
         * of microphone crossed a DO boundary on the way out and every 20 ms
         * of answer crossed it coming back. In-facet, delivery is a function
         * call and the socket is the only network boundary left.
         */
        receiver: {
          action: "facet-processor",
          source: { kind: "userspace", worker: voiceAgentFacetRef(streamPath) },
        },
      };
      const subscriptionKeyPrefix = `voice-agent/subscription-configured:${streamPath}`;
      const subscriptionKey = options.reinstall
        ? `${subscriptionKeyPrefix}:reinstall:${crypto.randomUUID()}`
        : `${subscriptionKeyPrefix}:${contentHash(subscriptionPayload)}`;
      /*
       * ONE IDENTITY FOR THIS SETUP, carried by the brief it installs and by the
       * marker that names it, so the acknowledgement can be checked against THIS
       * setup rather than against whatever the stream last happened to hold.
       */
      const setupId = crypto.randomUUID();
      const birthKey = birthCertificateKey(streamPath, birthPayload, setupId);
      const startedAt = Date.now();
      /*
       * Keep RPC ownership sequential: if the agent branch rejects after the
       * stream branch fulfills, the outer finally still owns and releases the
       * first wrapper. Promise.all cannot expose that fulfilled sibling on its
       * rejection path.
       */
      voiceEvents = await stream.append(
        {
          type: "events.iterate.com/voice-agent/created",
          idempotencyKey: birthKey,
          payload: birthPayload,
        },
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: subscriptionKey,
          payload: subscriptionPayload,
        },
      );
      /* Born and briefed — the same helper the call path uses, so a call that
       * never went through setup gets the same colleague. The brief text comes
       * from the project's live __describe every time, which is the whole point:
       * a device that gained or lost a method must not be described by a prompt
       * written before it did. */
      agentEvents = await ensureVoiceAgent(
        backOffice,
        capabilityBrief(await readProvidedCapabilities(project)),
        setupId,
      );

      /*
       * THE MARKER, appended after the brief it names.
       *
       * Delivery is ordered, so a processor that receives the warm-up token has
       * already folded this. Its type is in the subscription filter below, which
       * is how the processor learns which brief is current without reading any
       * history — the thing three successive read designs could not do exactly.
       */
      const installedBrief = agentEvents?.at(-1);
      if (!installedBrief?.idempotencyKey) {
        throw new Error(
          `setupVoiceAgent: the brief append for ${streamPath} returned no event, so there is ` +
            `nothing to mark current`,
        );
      }
      const installedBriefContent = z
        .object({ content: z.string() })
        .parse(installedBrief.payload).content;
      const briefMarker = {
        setupId,
        briefKey: installedBrief.idempotencyKey,
        contentHash: contentHash({
          content: installedBriefContent,
        }),
      } satisfies BriefMarker;
      await discardRpcResult(
        stream.append({
          type: BRIEF_MARKER_TYPE,
          idempotencyKey: `voice-agent/brief-current:${setupId}`,
          payload: { ...briefMarker },
        }),
        "brief marker append result",
      );

      const created: string[] = [];
      const alreadyThere: string[] = [];
      for (const event of [...(voiceEvents ?? []), ...(agentEvents ?? [])]) {
        const key = event.idempotencyKey ?? `${event.path}@${String(event.offset)}`;
        (Date.parse(event.createdAt) < startedAt ? alreadyThere : created).push(key);
      }
      /*
       * AND IS IT ACTUALLY LISTENING?
       *
       * Setup's contract is "this stream is ready to hold a conversation", so it
       * must not report success having left it deaf. The append above
       * deduplicates against the original install, which is the point — but
       * after `removeVoiceAgent` the original is REMOVED, and a deduplicated
       * re-append changes nothing while reporting that it did. Nobody discovers
       * that until a conversation fails to start.
       */
      if (!(await voiceAgentSubscriptionStatus(stream)).active) {
        const healKey = `${subscriptionKeyPrefix}:reinstall:${crypto.randomUUID()}`;
        await discardRpcResult(
          stream.append({
            type: "events.iterate.com/stream/subscription-configured",
            idempotencyKey: healKey,
            payload: subscriptionPayload,
          }),
          "subscription heal append result",
        );
        created.push(healKey);
      }

      /*
       * AND IS IT WARM?
       *
       * Setup used to return with the subscription configured and the worker
       * never instantiated, so the FIRST call paid for building it. Measured: the
       * bridge's own share of a call start is ~1.4s (dial 0.5s, session.created
       * 0.6-1.2s, accepted 0.8-1.4s), yet the first call after a remount took 8-16s
       * to go live. All of that difference is pre-bridge — the dynamic worker being
       * built and its processor woken — and a remount left it cold every time,
       * which is why removing the harness's duplicate-press retry did not help.
       *
       * So setup warms the processor it just configured and does not return until
       * it has answered. Bounded, and reported rather than swallowed: a setup that
       * could not warm its own worker says so, because the alternative is a caller
       * that thinks it is ready and then waits 16 seconds.
       */
      /*
       * WARM-UP: A TOKEN THROUGH THE REAL PROCESSOR, AND THE BRIEF IT SEES.
       *
       * Nothing structural can prove readiness. A registered subscription is a
       * fact about the STREAM; a health reply from a ref proves a wrapper answered;
       * reading `this.processor` only fetches a function. Each of those was tried
       * and each was vacuous. What is left is an end-to-end round trip: append a
       * benign token, have the processor that owns this stream consume it and
       * answer with that token plus the brief it can actually resolve, and refuse
       * to return until the answer matches.
       *
       * The cost this exists to remove: the first call after a remount paid for
       * compiling this file out of the config repo — 8 to 16 seconds to go live
       * against a bridge whose own share is 1.4.
       *
       * The warm-up event starts no call and reaches neither the provider nor the
       * device's downlink, which subscribe to different types.
       */
      /*
       * WHAT THE ACKNOWLEDGEMENT MUST NAME: the brief this setup installed, by the
       * identity this setup gave it.
       *
       * Nothing is read to establish this. The brief was appended under
       * `...:setup:<setupId>` and the marker naming it was appended straight after,
       * so the expectation is a fact this function created rather than an
       * observation it went looking for. That closes the last hole: an earlier
       * version derived the expectation from its own append result, which was null
       * whenever the refresh deduplicated, and the check degraded to "the
       * processor resolved SOME brief".
       */
      const expectedBriefKey = briefMarker.briefKey;
      const token = crypto.randomUUID();
      const warm: {
        ok: boolean;
        ms: number;
        token: string;
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
      } = {
        ok: false,
        ms: 0,
        token,
        acknowledged: false,
        briefMatched: false,
        bridgeWarmed: false,
        expectedBriefKey,
        expectedSetupId: setupId,
      };
      const warmStartedAt = Date.now();
      /*
       * THE WAIT STARTS BEHIND THE QUESTION, and that is the whole repair.
       *
       * `waitForEvent` with no `afterOffset` watches from the head it finds
       * when it opens — which is AFTER this append has returned, and by then a
       * warm facet has already answered. MEASURED on preview-3: `warmup` at
       * 16:04:11.970 and `warmup-ready` at 16:04:12.166, 196ms apart and both
       * on the stream, while this call sat out its full 90-second deadline and
       * reported `acknowledged=false`. A readiness probe that fails BECAUSE
       * the processor was ready is worse than no probe: it cost most of a
       * day's debugging, and the facet it condemned went on to hold a call for
       * fifteen minutes.
       *
       * Anchoring the wait one offset behind the token's own commit makes the
       * answer impossible to miss — it is replayed if it already landed — and
       * costs nothing when the facet really is cold.
       */
      const warmupAppend = await stream.append({
        type: "events.iterate.com/voice-agent/warmup",
        payload: { token },
      });
      let waitAfterOffset = 0;
      try {
        const committed = warmupAppend.at(0);
        waitAfterOffset = committed === undefined ? 0 : committed.offset - 1;
      } finally {
        disposeRpcStub(warmupAppend, "warm-up append result");
      }
      try {
        /*
         * BOTH ANSWERS, so a failure is classified in milliseconds rather than
         * being indistinguishable from a processor that never woke. The token
         * correlates either one to THIS attempt: a stale answer from a previous
         * setup on this long-lived stream must not satisfy or fail this one.
         */
        const answer = await stream.waitForEvent({
          afterOffset: waitAfterOffset,
          eventTypes: [
            "events.iterate.com/voice-agent/warmup-ready",
            "events.iterate.com/voice-agent/warmup-unresolved",
          ],
          predicate: (event) => (event.payload as { token?: string } | null)?.token === token,
          timeoutMs: WARMUP_DEADLINE_MS,
        });
        try {
          const payload = (answer.payload ?? {}) as {
            briefKey?: string;
            briefSetupId?: string;
            protocolRevision?: string;
            reason?: string;
            stage?: string;
            bridgeWarmMs?: number;
          };
          if (answer.type === "events.iterate.com/voice-agent/warmup-unresolved") {
            /* Woke and failed. Never a success, whatever else matches. */
            warm.error =
              `the processor woke and got as far as the ${payload.stage ?? "unknown"} stage: ` +
              `${payload.reason ?? "(no reason given)"}`;
          } else {
            warm.acknowledged = true;
            warm.protocolRevision = payload.protocolRevision;
            warm.seenBriefKey = payload.briefKey;
            /*
             * EXACTLY the brief at the head. Not "a brief", not "non-empty" — the
             * same idempotencyKey, which is what makes this a proof that the prompt
             * derived from the current __describe is the prompt the running processor
             * will use.
             */
            warm.seenSetupId = payload.briefSetupId;
            /*
             * THIS setup's brief, by both halves of its identity.
             *
             * The key alone would be satisfied by an identical brief installed by
             * some other setup; the setupId alone would not prove which context
             * event it named. Requiring both makes the acknowledgement a statement
             * about the prompt this call to setupVoiceAgent just derived from
             * __describe and appended.
             */
            warm.briefMatched =
              payload.briefKey === expectedBriefKey && payload.briefSetupId === setupId;
            warm.bridgeWarmMs = payload.bridgeWarmMs;
            /*
             * The bridge leg is part of readiness, not a detail: an acknowledgement
             * carrying no bridge timing came from a processor that never reached it,
             * which is exactly the state that cost 8 seconds on the first call.
             */
            warm.bridgeWarmed = typeof payload.bridgeWarmMs === "number";
            warm.ok =
              warm.briefMatched &&
              warm.bridgeWarmed &&
              payload.protocolRevision === WARMUP_PROTOCOL_REVISION;
          }
        } finally {
          disposeRpcStub(answer, "warm-up wait result");
        }
      } catch (error) {
        warm.error = String(error).slice(0, 160);
      }
      warm.ms = Date.now() - warmStartedAt;
      /* ENFORCED, not reported: setup's contract is "ready to hold a conversation". */
      if (!warm.ok) {
        throw new Error(
          `setupVoiceAgent: the processor for ${streamPath} did not acknowledge warm-up within ` +
            `${warm.ms}ms — acknowledged=${String(warm.acknowledged)} ` +
            `briefMatched=${String(warm.briefMatched)} ` +
            `bridgeWarmed=${String(warm.bridgeWarmed)} ` +
            `protocol=${warm.protocolRevision ?? "(none)"} expected=${WARMUP_PROTOCOL_REVISION} ` +
            `expectedBrief=${expectedBriefKey} ` +
            `seenBrief=${warm.seenBriefKey ?? "(none)"} ` +
            `expectedSetup=${setupId} seenSetup=${warm.seenSetupId ?? "(none)"}` +
            (warm.error ? ` lastError=${warm.error}` : ""),
        );
      }
      return { streamPath, created, alreadyThere, warm };
    } finally {
      disposeRpcStub(agentEvents, "setup agent append result");
      disposeRpcStub(voiceEvents, "setup stream append result");
      disposeRpcStub(backOffice, "setup back-office agent");
      disposeRpcStub(stream, "setup stream");
    }
  }

  async removeVoiceAgent(options: { streamPath: string }): Promise<{
    streamPath: string;
    removed: string[];
    alreadyAbsent: string[];
    /**
     * What to call to get this stream talking again.
     *
     * Named here because setup's subscription key is derived from the stream
     * path and the payload's content, so a plain re-run after a removal
     * deduplicates against the original install. Setup heals that itself now —
     * it checks the subscription really is active and re-installs it under a
     * fresh key if not — but saying so still beats making the caller work it
     * out by watching a conversation fail to start.
     */
    reinstallWith: string;
  }> {
    if (!options.streamPath?.startsWith("/")) {
      throw new Error(
        `removeVoiceAgent requires an absolute streamPath; received ${JSON.stringify(options.streamPath)}`,
      );
    }
    const project = await this.itx;
    const stream = project.streams.get(options.streamPath);
    try {
      const subscription = await voiceAgentSubscriptionStatus(stream);

      const removed: string[] = [];
      const alreadyAbsent: string[] = [];
      if (subscription.active) {
        const removalKey = `voice-agent/subscription-removed:v1:${options.streamPath}:install:${subscription.installation}`;
        await discardRpcResult(
          stream.append({
            type: "events.iterate.com/stream/subscription-removed",
            idempotencyKey: removalKey,
            payload: { name: VOICE_AGENT_SUBSCRIPTION_NAME, reason: "requested" },
          }),
          "subscription removal append result",
        );
        removed.push(removalKey);
      } else {
        alreadyAbsent.push(VOICE_AGENT_SUBSCRIPTION_NAME);
      }

      return {
        streamPath: options.streamPath,
        removed,
        alreadyAbsent,
        reinstallWith: `setupVoiceAgent({ streamPath: ${JSON.stringify(options.streamPath)}, reinstall: true })`,
      };
    } finally {
      disposeRpcStub(stream, "remove stream");
    }
  }

  /** Spike diagnostic: dial Grok realtime through the egress lane, report timings. */
  async probeGrok(): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    const response = await fetch("https://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0", {
      headers: { Upgrade: "websocket", Authorization: 'Bearer getSecret("/secrets/xai")' },
    });
    const socket = response.webSocket;
    if (socket === null) {
      return { ok: false, status: response.status, body: (await response.text()).slice(0, 300) };
    }
    socket.accept();
    const upgradeMs = Date.now() - t0;
    const seen: string[] = [];
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: "timeout", seen }), 10_000);
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        const event = JSON.parse(message.data) as { type?: string };
        seen.push(event.type ?? "?");
        if (event.type === "session.created") {
          socket.send(JSON.stringify({ type: "session.update", session: { voice: "eve" } }));
        }
        if (event.type === "session.updated") {
          clearTimeout(timer);
          resolve({ ok: true, upgradeMs, sessionReadyMs: Date.now() - t0, seen });
        }
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `closed ${event.code}`, seen });
      });
    });
    socket.close();
    return result;
  }

  /*
   * There is no HTTP door any more.
   *
   * This routed `x-iterate-app: voice` into a per-call VoiceBridge Durable
   * Object. The agent is a facet of the stream's own DO now: it is reached by
   * appending to the stream, and a call is opened by pressing a button, not by
   * fetching a URL.
   */
  async fetch(): Promise<Response> {
    return new Response("voicelab project worker — the voice agent is a facet of its stream", {
      headers: { "content-type": "text/plain" },
    });
  }
}

/**
 * Dial the provider.
 *
 * `baseUrl` overrides the endpoint so a test can point a real deployment at a
 * mock and get a provider that says exactly what the test asked for, for
 * exactly as long. It is deliberately NOT a general-purpose knob.
 *
 * THE CREDENTIAL RULE IS THE WHOLE SAFETY ARGUMENT, and it does not depend on
 * trusting whoever set the URL. A caller-chosen endpoint is a bearer token
 * waiting to follow it somewhere it should not go, so the Authorization header
 * is attached only when the host IS x.ai. Anywhere else gets the dial and no
 * key — which is all a mock ever needed, and which means the worst an attacker
 * can do by writing this field is talk to their own empty socket.
 */
export async function dialGrokSocket(baseUrl: string | null): Promise<WebSocket | null> {
  const target = new URL(baseUrl ?? GROK_REALTIME_URL);
  target.searchParams.set("model", GROK_MODEL);
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (target.hostname === "api.x.ai" || target.hostname.endsWith(".x.ai")) {
    headers.Authorization = `Bearer getSecret("${XAI_SECRET}")`;
  }
  const response = await fetch(target.toString(), { headers });
  /*
   * `?? null` RATHER THAN `=== null`, because "no socket on it" has two
   * spellings. A platform Response carries `webSocket: null` when the upgrade
   * did not happen; a Response from a runtime that has no WebSockets in it at
   * all — the one a test or a local driver holds — simply has no such property,
   * and `undefined === null` is false. The strict test therefore let the
   * undefined through, and the line below turned a provider REFUSAL into
   * `TypeError: Cannot set properties of undefined (setting 'binaryType')`
   * written on the stream where the reason belongs. Named by
   * voice-agent.fake-grok.e2e.test.ts's `?refuseUpgrade=1`.
   */
  const socket = response.webSocket ?? null;
  if (socket === null) return null;
  socket.binaryType = "arraybuffer"; // before accept(): the post-2025-03-17 default is Blob
  socket.accept();
  return socket;
}

/** The one `session.update` this facet sends, on the `session.created` edge. */
function grokSessionUpdate(serverVad: boolean): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 16_000 },
          /* A push-to-talk board segments its own turns with its button, and
           * server VAD on top of that answers halfway through a sentence. An
           * open-mic board has no button at all: without server VAD nothing
           * ever commits its audio and the call is silent forever. The board's
           * echo story decides which it is (the SKILL's
           * capture_is_echo_cancelled rule), carried here per client. */
          turn_detection: serverVad ? { type: "server_vad", ...SERVER_VAD } : null,
        },
        output: { format: { type: "audio/pcm", rate: 16_000 }, voice: GROK_VOICE },
      },
    },
  };
}

/**
 * Clients whose microphone rides the whole call open (hardware/tuned echo
 * cancellation, no talk button). Their turns belong to server VAD; everyone
 * else segments manually with ptt-start/ptt-end.
 */
const OPEN_MIC_CLIENTS = new Set([
  "/clients/stackchan",
  "/clients/home-assistant-voice-preview-edition",
]);

/**
 * How hard the provider listens before it believes somebody is talking.
 *
 * xAI's own defaults are `threshold: 0.85` (of a documented 0.1–0.9) and
 * `prefix_padding_ms: 333`, and sending `{ type: "server_vad" }` with nothing
 * else — which this did — takes them. 0.85 is the most conservative setting
 * the API offers, chosen upstream for devices whose microphone carries their
 * own loudspeaker: it is a way of not believing an echo. Measured cost on a
 * board that does not need that protection: x.ai reported an interruption
 * 2489 ms after the Mac started speaking, twice, within six milliseconds of
 * each other — a detector waiting for the loudest syllable of the sentence
 * rather than its onset.
 *
 * This board earns a lower threshold rather than assuming one. On the AEC tap
 * its echo residual sits about a decibel above the room floor and a person
 * lands 7 to 21 dB above THAT, so there is real distance to spend, and the
 * `ANSWER` line in `voicelab aec --real` is the check that spending it has
 * not started the device interrupting itself. If self-interruptions ever
 * reappear, this number is the first thing to move back up — and the tap it
 * depends on is the reason it can be this low at all
 * (apps/kit/firmware/devices/havpe/voice_pe_hardware_config.c).
 *
 * `prefix_padding_ms` keeps the audio just BEFORE the detector fired, so a
 * lower threshold does not cost the first consonant of the interruption.
 */
const SERVER_VAD = {
  threshold: 0.4,
  prefix_padding_ms: 333,
} as const;

/*
 * ============================================================================
 * THE VOICE AGENT AS A FACET
 * ============================================================================
 *
 * One processor, hosted in the Stream Durable Object that owns the call's own
 * stream, that happens to hold a Grok socket open behind it.
 *
 * WHY THIS IS FASTER, and it is the whole point. The bridge above is a second
 * Durable Object: every 20 ms microphone frame was appended here, delivered
 * over RPC to that worker, decoded there, and pushed to Grok — one extra hop,
 * every frame, in both directions. A facet runs INSIDE this stream's own
 * incarnation, so delivery is a function call. The socket is the only network
 * boundary left between a device's microphone and the model.
 *
 * The shape is deliberately boring: `reduce` is one switch and is pure,
 * `processEvent` is one switch and never blocks the lane. Everything slow —
 * dialing Grok, waiting for a session, playing audio back — happens in
 * background work owned by the incarnation, and the fold is what recovers it.
 */

/**
 * The live Grok session for ONE call, owned by one processor incarnation.
 *
 * Deliberately not durable and deliberately not in reduced state: a socket
 * cannot be folded. What survives an eviction is the stream's own record that
 * a call was requested and not yet ended, and the at-head pass re-dials from
 * that. This class is therefore free to be plain mutable state.
 *
 * FRAMES ARRIVING BEFORE THE SESSION IS UP ARE BUFFERED, NOT DROPPED. A device
 * starts talking the instant its button goes down — that is the entire latency
 * budget — and the handshake takes as long as it takes. Audio captured during
 * the handshake is exactly the audio the user cared about most, so it queues
 * here and is flushed in order the moment the provider is ready.
 */

class GrokCall {
  readonly conversationId: string;
  /** Null until `session.updated`; queued PCM is flushed on that edge. */
  #socket: WebSocket | null = null;
  #ready = false;
  #closed = false;
  /**
   * Everything to say to the provider, held until the session is configured.
   *
   * MESSAGES, not PCM. Queueing decoded audio meant only audio was queued:
   * `input_audio_buffer.clear` and a text turn went straight to `send`, so
   * before the socket existed they were dropped on the floor, and after it
   * existed but before `session.updated` they were pushed into a session that
   * was not configured yet. One queue orders all three for free.
   *
   * Null once the provider is configured — the flag and the buffer are the
   * same thing, so they cannot disagree.
   */
  #pending: Record<string, unknown>[] | null = [];
  #openedAtMs: number;
  #readyAtMs: number | null = null;
  #framesQueued = 0;
  /**
   * THE ANSWER, HELD HERE INSTEAD OF ON THE DEVICE.
   *
   * The provider emits a ninety-second answer in a few seconds. Somebody has
   * to hold the difference, and for a while it was the board — its ring was
   * grown to thirty seconds and redescribed as "the answer" rather than a
   * cushion. This is that buffer, moved to where memory is free and a unit
   * test can watch it. See speaker.ts; everything about pacing lives there and
   * nothing about it lives here.
   */
  speaker: SpeakerState = speakerStart();
  /** Set while the facet's drain loop is alive for this call. */
  pacerRunning = false;
  /** Tail of this call's speaker append chain — see {@link inSpeakerOrder}. */
  #speakerTail: Promise<unknown> = Promise.resolve();
  /*
   * THE MOUTH IS THE SERVER'S, not the board's.
   *
   * Boards have subscribed to `viseme` since the sprite work landed, and the
   * facet has never emitted one — every reference to the emitter lived in the
   * bridge, so lip-sync has been silently off for the whole facet era. The
   * classifier is unchanged and still covered by its own tests; all that was
   * missing was a caller on this side.
   *
   * It rides the speaker lane deliberately: a viseme is a claim about a
   * position in the answer's audio, so it has to be ordered against the frames
   * it describes, and appending it in the same batch makes that free.
   */
  #visemes: ReturnType<typeof createVisemeEmitter>;
  #answerSeq = 0;
  /** The provider's own id for the answer in flight — see {@link answerIs}. */
  #answerId: string | null = null;
  /*
   * THE OBLIGATION THAT KEEPS THE DURABLE OBJECT UP, and its one release.
   *
   * A call is work in flight for as long as it is open, so the processor
   * registers this promise as `runInBackground` work at the dial (see `#dial`)
   * and the runner's keepalive holds the object — and revives it — until the
   * promise settles. There is no `setAlarm` anywhere in this file, and there
   * must not be: the keepalive already parks a durable alarm ahead of tracked
   * work, and a second timer would be a second answer to the same question.
   *
   * It resolves in {@link close}, which is deliberate rather than convenient:
   * `close` is the ONE route out of a call — the idle end, a device's own, a
   * provider close, a failed dial, being superseded — so "the object may
   * hibernate" and "this call is over" are the same event by construction and
   * cannot come apart.
   */
  #declareOver!: () => void;
  readonly over: Promise<void>;

  /** The processor's clock, so `spoke` stays a one-line assignment at every
   * call site — including `send`, where forgetting it would silently stop a
   * whole class of traffic counting as somebody talking. */
  readonly #now: () => number;

  constructor(conversationId: string, now: () => number) {
    this.conversationId = conversationId;
    this.#now = now;
    this.#openedAtMs = now();
    /* Opening a call IS somebody speaking; the minute starts here, so a dial
     * that neither completes nor errors ages out on the same clock as a
     * silence rather than never. */
    this.lastSpokeAtMs = this.#openedAtMs;
    this.#visemes = createVisemeEmitter(conversationId);
    this.over = new Promise<void>((resolve) => {
      this.#declareOver = resolve;
    });
  }

  get ready(): boolean {
    return this.#ready;
  }
  get closed(): boolean {
    return this.#closed;
  }
  /**
   * When THIS dial began — the identity of one attempt at a conversation.
   *
   * A rescued call re-dials under the SAME conversationId, so anything keyed
   * on the conversation alone claims to be the same fact twice. For a
   * statement that is genuinely per-dial (how long the handshake took, how
   * much audio it held) that is a lie the stream REJECTS rather than
   * deduplicates, and the rejection takes its whole append batch with it.
   */
  get openedAtMs(): number {
    return this.#openedAtMs;
  }

  /**
   * Is this call still worth talking to?
   *
   * A socket can die without its close listener ever running — the provider
   * goes away, the incarnation is resumed, the event is simply missed — and
   * the call object survives as a corpse. Every later press then folds into
   * it: `ptt-start` sees a non-null call, decides this is the same
   * conversation, sends `input_audio_buffer.clear` into a dead socket, and
   * nothing dials. Measured on a board: 479 microphone frames delivered to a
   * facet that dropped every one, with no error anywhere.
   *
   * Ask the socket rather than trusting a flag we might never have been told
   * to set.
   */
  alive(now: number): boolean {
    if (this.#closed) return false;
    /*
     * A HANDSHAKE THAT NEVER FINISHES IS ALSO A CORPSE, and a quieter one:
     * this returned true for anything still dialling, so a dial that neither
     * completed nor errored made the call immortal. Measured on this stream: a
     * provider socket closed after 32 minutes, the next press dialled
     * `057e8469`, and no acceptance and no failure ever followed it — four
     * consecutive presses folded into a handshake that was never going to end,
     * with nothing on the stream to say so.
     *
     * A usable session takes about a second. Ten is not a tuning parameter,
     * it is the point past which waiting is worse than dialling again.
     */
    if (!this.#ready) return now - this.#openedAtMs < GROK_HANDSHAKE_DEADLINE_MS;
    if (this.#socket === null) return true;
    return this.#socket.readyState === WebSocket.OPEN;
  }

  /** Whether this call's session asks the provider to run server VAD. */
  serverVad = false;
  /** Milliseconds from dial to a usable session, or null while still dialing. */
  get handshakeMs(): number | null {
    return this.#readyAtMs === null ? null : this.#readyAtMs - this.#openedAtMs;
  }
  /** How much captured audio the handshake made us hold. */
  get framesQueued(): number {
    return this.#framesQueued;
  }

  attach(socket: WebSocket): void {
    this.#socket = socket;
  }

  /**
   * A new answer begins, and it supersedes whatever was in flight.
   *
   * Anything of the previous answer still held is dead: nobody will hear it,
   * and sending it first would delay the answer the person interrupted FOR.
   * The device is told by the `drop` that `speakerReplace` arms on the next
   * chunk — the decision travelling with the audio it invalidates, rather than
   * on a second lane that could be reordered against it.
   */
  beginAnswer(_now: number, responseId: string | null = null): void {
    this.#answerSeq++;
    this.#answerId = responseId;
    speakerReplace(this.speaker);
    this.#visemes.reset();
  }

  /**
   * Whether a completion event belongs to the answer currently in flight.
   *
   * IDS, NOT A FLAG, and the reason is measured: xAI OVERLAPS responses rather
   * than erroring, so with two live the first one's `response.done` arrives
   * while the second is still speaking. Completing the answer on it would mark
   * a chunk `last` in the middle of the reply the listener is actually hearing
   * — and, worse, close the speaker, so every delta after it is held for ever
   * and the rest of that answer is silent.
   *
   * An unnamed completion (or one arriving before any `response.created` was
   * seen) counts: a provider that names neither cannot be disambiguated
   * anyway, and an answer left open for ever is the worse failure of the two.
   */
  answerIs(responseId: string | null): boolean {
    return responseId === null || this.#answerId === null || responseId === this.#answerId;
  }

  /**
   * The provider produced more audio for the answer in flight.
   *
   * Mu-law goes in, because the encode has to happen anyway and the face
   * needs the PCM16 it came from — doing it here means it happens once.
   * Nothing is decided about WHEN any of it leaves; speaker.ts owns that, and
   * this call owns no timer at all.
   */
  pushAudio(mulaw: Uint8Array): void {
    speakerPush(this.speaker, mulaw);
  }

  /**
   * The provider has finished this answer. What is held is all there is.
   *
   * Not "send the last frame now": the tail may still be several seconds of
   * audio the listener has not caught up with, and shipping it early is
   * exactly the burst this lane exists to prevent. The `last` bit is attached
   * to whichever chunk turns out to be final — see speakerRelease.
   */
  completeAnswer(): void {
    speakerComplete(this.speaker);
  }

  /**
   * Somebody started talking. Whatever is still held will never be wanted.
   *
   * `beginAnswer` already does this, and for most of a conversation that is
   * enough: the provider cancels, answers, and the `response.created` for the
   * new answer drops the old one's tail. It is NOT enough for an
   * interruption, because between "stop talking" and the provider having
   * something to say there is a gap — it is still listening — and this lane
   * is paced, so it spends that gap faithfully playing out the answer the
   * person just asked it to stop.
   *
   * Measured against x.ai: the provider reported the interruption 2.5 s in
   * and the board kept talking for another five to eight seconds. Nothing was
   * wrong with the echo canceller, the uplink, or the provider's detector —
   * the audio had already arrived and nobody had told the lane it was dead.
   */
  abandonHeldAudio(): void {
    speakerReplace(this.speaker);
    this.#visemes.reset();
  }

  /** What may go to the device now, and when to come back. */
  releaseAudio(now: number, limits: SpeakerLimits): SpeakerRelease {
    return speakerRelease(this.speaker, now, limits);
  }

  /**
   * ONE APPEND ORDER FOR THE SPEAKER LANE, whoever is doing the appending.
   *
   * `#drainSpeaker` appends from two places: the provider's delta handler,
   * un-awaited, straight off the socket-message turn, and the pacer's drain
   * loop, which awaits its own. Both are RPCs to the Stream Durable Object, so
   * two of them in flight at once commit in whatever order they arrive — and
   * one of them is always in flight, because a conversation is ONE call across
   * many answers and the previous answer's loop is still alive when the next
   * one begins (it exits only on `nextWakeMs === null`).
   *
   * The chunk that loses is the one that matters. `speakerReplace` arms `drop`
   * on the first chunk of the new answer, so an inverted append lands the
   * CLEAR behind audio it then tells the device to throw away. MEASURED on the
   * mock, against boards whose clock counters were all zero: 0.7 s discarded
   * on turn 2 and 2.0 s on turn 4, never once on turn 1 — the only answer with
   * no loop already running. The device dedupes by offset, so a clear that
   * acted really did carry the highest offset of its group; the inversion was
   * in the append, not in delivery.
   *
   * A FIFO of ONE promise fixes it, and it has to be here rather than at the
   * call sites because the two sites disagree about awaiting by design: the
   * delta handler must not block the delivery lane, and the pacer's await is
   * its backpressure. Enqueuing is what they can both do.
   *
   * THE FIRST CHUNK OF AN ANSWER IS THE LATENCY EVERYBODY NOTICES (~1150 ms
   * press-to-audio), so what this costs it is worth stating: one microtask
   * when the lane is idle, and otherwise however long the one append already
   * in flight takes — a single append into the stream this facet is hosted
   * IN. It cannot deadlock the synchronous `processEvent` path either: that
   * path never awaits what it enqueues, and the chain only ever waits on
   * appends, never on anything that waits on the chain.
   *
   * A failed append must not wedge the lane, so the tail is advanced by a
   * derivative that cannot reject. The caller still sees its own rejection.
   */
  inSpeakerOrder<T>(append: () => Promise<T>): Promise<T> {
    const committed = this.#speakerTail.then(append, append);
    this.#speakerTail = committed.then(
      () => undefined,
      () => undefined,
    );
    return committed;
  }

  /**
   * The mouth shapes for this delta's audio, if any.
   *
   * Read from the PCM16 the speaker will actually play, before the mu-law
   * encode — a companding curve is not speech and the classifier would read
   * its quantisation steps as one.
   */
  visemesFor(pcm: Uint8Array) {
    if (pcm.length < 2) return [];
    return this.#visemes.push(
      new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1),
      this.#answerSeq,
    );
  }

  /** The answer is over, so the mouth closes. SIL, once. */
  closeMouth() {
    return this.#visemes.end(this.#answerSeq);
  }

  /** A new turn's gaps are its own; the silence since the last one is not one. */
  resetFrameClock(): void {
    this.#lastFrameAtMs = null;
  }

  /** Say this to the provider, or hold it until the session is configured. */
  send(message: Record<string, unknown>): void {
    if (this.#closed) return;
    /* EVERY send is the client's half of "either side": audio frames, the
     * buffer verbs a press writes, a text turn. Restarting here rather than at
     * each call site is what makes it impossible to add a new send and forget
     * that it keeps the call alive. */
    this.spoke();
    if (this.#pending !== null) {
      this.#pending.push(message);
      return;
    }
    this.sendNow(message);
  }

  /**
   * Bypass the queue. Exactly one caller: `session.update` is the message that
   * ENDS the queue, so queueing it would deadlock the handshake.
   */
  sendNow(message: Record<string, unknown>): void {
    if (this.#socket === null || this.#closed) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      /* The socket is going away; teardown follows from its close event. */
    }
  }

  /**
   * Hand one decoded PCM16 frame to the provider. Never awaits: this is called
   * straight off the delivery lane, and the only work is a base64 encode.
   */
  offer(pcm: ArrayBuffer, now: number): void {
    if (this.#pending !== null) this.#framesQueued++;
    if (this.framesThisTurn === 0) this.firstFrameAtMs = now;
    if (this.#lastFrameAtMs !== null) {
      this.maxFrameGapMs = Math.max(this.maxFrameGapMs, now - this.#lastFrameAtMs);
    }
    this.#lastFrameAtMs = now;
    this.framesThisTurn++;
    this.send({
      type: "input_audio_buffer.append",
      audio: bytesToBase64(new Uint8Array(pcm)),
    });
  }

  /*
   * WHERE THE TURN'S TIME WENT, on the only clock that can see all of it.
   *
   * Press-to-answer is measured at the client, and from there the middle of it
   * is one opaque number: an answer that took 1.1s says nothing about whether
   * the delay was reaching us, us reaching the provider, or the model
   * thinking. These four stamps split it, and cost one tiny ephemeral event
   * per turn — as against reading the same thing off the verbatim `grok-event`
   * lane, which would ship every audio delta to the observer and inflate the
   * very measurement it was opened to take.
   */
  endSeenAtMs: number | null = null;
  commitSentAtMs: number | null = null;
  committedAckAtMs: number | null = null;
  /** Cleared per answer, so exactly one timing event is emitted per turn. */
  timingReported = false;
  /*
   * DID THE FACET KEEP UP WITH THE MICROPHONE?
   *
   * The delivery lane hands ephemeral events to a facet in bounded batches. If
   * a turn's frames arrive faster than the lane drains them, the backlog is
   * paid AFTER the button comes up — the release waits behind audio the person
   * has already finished speaking. These two turn the question into
   * arithmetic: the facet's own span from first frame to release, against the
   * span the client actually spoke.
   */
  firstFrameAtMs: number | null = null;
  framesThisTurn = 0;
  /**
   * The longest silence between two consecutive frames of one turn.
   *
   * A lane that is merely slow drifts; a lane that STALLS shows one large gap
   * and nothing else. Measured on this stream: seven turns in eight arrived
   * ahead of real time, and the eighth arrived 1.9 seconds late — which is a
   * stall to find, not a throughput to tune.
   */
  maxFrameGapMs = 0;
  #lastFrameAtMs: number | null = null;

  /**
   * NO AUDIO AFTER THE RELEASE, until the next press.
   *
   * A frame that lands after the commit is audio the provider's own VAD reads
   * as the user starting to talk again — and a barge-in one millisecond after
   * `response.created` cancels the answer before a single delta is generated.
   * Measured on this stream: four turns in six, `response.created` immediately
   * followed by `input_audio_buffer.speech_started` and then nothing at all,
   * forever. The client races its own frames (a fire-and-forget append can
   * overtake the release that follows it), and a device on a lossy link will
   * reorder too, so the rule belongs here rather than in any one client.
   *
   * Open-mic calls are exempt: they have no release, their turns are the
   * provider's own to segment, and gating them would deafen the board.
   */
  turnClosed = false;
  /** Frames refused by that rule, so "rare" is a number and not a hope. */
  droppedAfterEnd = 0;

  /*
   * WHEN SOMEBODY LAST SPOKE, whichever way round — a timestamp and nothing
   * more.
   *
   * A provider socket held open keeps this stream's Durable Object awake, and
   * xAI only drops an idle session after 900 seconds — so a call nobody ends
   * pins a DO, and burns a provider session, for fifteen minutes of silence.
   * The wrong fix for that was hanging up as soon as an answer had been handed
   * over: streams are not meant to hibernate between button presses, and a
   * push-to-talk caller ended up re-dialling the provider on every press.
   *
   * THIS USED TO BE A `setTimeout` AND IT NEVER FIRED. MEASURED on preview-3:
   * a call went live, nobody spoke for 150 seconds, and no end was ever
   * requested — the facet was demonstrably alive throughout (it answered a
   * warm-up probe in 154ms) and the stream carried no traffic at all, so
   * nothing had restarted the countdown. A timer armed from the SYNCHRONOUS
   * body of a delivery belongs to a request context that ends with that
   * delivery; whatever the callback then tries to do, it does with no I/O
   * context to do it in. The pacer's `sleep` loop works for the opposite
   * reason: it runs inside a `runInBackground` closure the keepalive holds.
   *
   * So the countdown is that same shape now — `VoiceAgentFacetProcessor`'s
   * `#holdUntilIdle`, one keepalive-backed loop that sleeps exactly as long as
   * this call has left and reads this field when it wakes. All this has to do
   * is be current, which makes {@link spoke} a single assignment on a path
   * that runs fifty times a second.
   *
   * It is the FAST and COMPLETE half of the deadline: it sees both directions,
   * so a long answer cannot age a call out. It cannot outlive the object,
   * which is what the other half — {@link idleDeadlinePassed}, read off the
   * fold when no socket is held — is for. Neither half hangs up by itself:
   * both append `conversation-end-requested` and let the ordinary delivery
   * lane do the ending, so there stays exactly one way to end a call and three
   * things that can decide to.
   */
  lastSpokeAtMs: number;

  /** Something was said, whichever way round: the minute starts again. */
  spoke(): void {
    if (this.#closed) return;
    this.lastSpokeAtMs = this.#now();
  }

  /** The turn is complete: commit what was captured and ask for an answer. */
  commit(now: number): void {
    this.turnClosed = true;
    this.endSeenAtMs = now;
    this.committedAckAtMs = null;
    this.timingReported = false;
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
    /* AFTER the sends, deliberately: what this stamps is the moment the
     * messages were handed to the socket, which is where the facet's own
     * contribution to the turn ends. */
    this.commitSentAtMs = this.#pending === null ? now : null;
  }

  /**
   * The session is usable. Flush everything the handshake made us hold, in
   * order, before anything newer can reach the provider — and if the user
   * already let go of the button, commit that turn immediately rather than
   * waiting for another frame to notice.
   */
  markReady(now: number): void {
    if (this.#ready || this.#closed) return;
    this.#ready = true;
    this.#readyAtMs = now;
    /* Drain in arrival order, and close the queue FIRST so a message sent from
     * inside this loop cannot be appended to a list already being drained. */
    const held = this.#pending ?? [];
    this.#pending = null;
    for (const message of held) this.sendNow(message);
    /* A turn that ended during the handshake had its commit held with
     * everything else; this flush is when it actually left. */
    if (this.endSeenAtMs !== null && this.commitSentAtMs === null) this.commitSentAtMs = now;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    /* EVERY route out of a call comes through here — the idle end, a device's
     * own, a provider close, a failed dial, being superseded — so this line is
     * what ends the countdown loop, releases the keepalive, and lets the
     * Durable Object hibernate the moment the last call on it is over. */
    this.#declareOver();
    this.#pending = null;
    /* Nobody will ever hear what is still held, and the drain loop checks
     * `closed` before every release, so this only frees the memory. */
    speakerReplace(this.speaker);
    try {
      this.#socket?.close();
    } catch {
      /* Already gone. */
    }
    this.#socket = null;
  }
}

/** What the facet processor folds: one call at a time, and whether it is open. */
const VoiceFacetState = z.object({
  birthCertificate: z
    .strictObject({ providerBaseUrl: z.string().optional() })
    .nullable()
    .default(null),
  /**
   * Which brief setup last marked current, folded from delivery.
   *
   * Held in state rather than looked up because the marker ARRIVES through
   * this subscription, in order, ahead of the token it has to answer. Its
   * absence therefore means this processor was genuinely never told — a
   * failure to report, not a gap to paper over with a scan of history.
   */
  briefCurrent: z
    .strictObject({ setupId: z.string(), briefKey: z.string(), contentHash: z.string() })
    .nullable()
    .default(null),
  /**
   * The call this stream is on, as an OBLIGATION rather than a closure.
   *
   * A socket dies with its incarnation; this does not. `conversation-requested`
   * opens it, `conversation-ended` closes it, and the at-head pass re-dials
   * anything still open — which is what makes an eviction mid-call recoverable
   * without anybody having to notice it happened.
   */
  call: z
    .object({
      /** Server-minted, and stamped on everything belonging to this call. */
      conversationId: z.string(),
      /**
       * When a client was last heard on this call, on the stream's own clock.
       *
       * The durable half of the idle deadline — see {@link idleDeadlinePassed}
       * for why it is folded rather than appended, and why "a client" rather
       * than "either side" is the honest name for what it can see.
       */
      lastHeardAtMs: z.number(),
      /**
       * Somebody has decided this call is over, and why.
       *
       * The obligation, in the ordinary shape: the request is the durable
       * desire, `conversation-ended` is the completion, and the at-head pass
       * is what performs one and recovers the other. Holding the reason here
       * is what lets a revived incarnation finish a teardown it did not start
       * and still write the same sentence the decider gave.
       */
      endRequested: z.strictObject({ reason: z.string() }).nullable(),
    })
    .nullable()
    .default(null),
});

const EPH = { ephemeral: true as const };
/**
 * One frame of captured audio.
 *
 * `seq` is the CLIENT's own counter and the only ordering this trusts. There
 * is deliberately no conversationId: the client does not know which call it is
 * on and does not need to — frames belong to whatever call the press opened,
 * and asking the client to name one made it a second source of truth for a
 * fact only the server holds.
 */
const MicFrame = z.looseObject({
  seq: z.number().optional(),
  pcm: z.string(),
  enc: z.string().optional(),
});
/** One frame of the answer, stamped with the call the server minted. */
const AudioFrame = z.looseObject({
  conversationId: z.string(),
  pcm: z.string(),
  enc: z.string().optional(),
  /*
   * THE TWO BITS A CLIENT NEEDS TO MANAGE ITS SPEAKER, carried by the audio
   * rather than alongside it. Both used to be read off the provider's own
   * event firehose — a subscription to everything xAI says, for two bits.
   * Riding the frames means they cannot be reordered against the audio they
   * are about, and a board's whole buffer policy becomes: drop on `drop`,
   * release on `last`, and otherwise play what arrives.
   */
  /** Discard anything still queued before playing this one. */
  drop: z.boolean().optional(),
  /** The answer ends here: drain, and stop waiting for more. */
  last: z.boolean().optional(),
});

/**
 * The facet's own contract, and it is deliberately not the bridge's.
 *
 * A different processor with a different fold: this one holds ONE call as an
 * obligation and nothing else, because everything the bridge kept in reduced
 * state (briefs, warm-up tokens) belonged to the worker that no longer exists.
 */
export const VoiceAgentFacetContract = defineProcessorContract({
  /* The subscription NAME selects the contract, and the live subscription is
   * named for this slug. They are one identity; drifting them apart is the
   * failure that took every board offline on the v30 flag day. */
  slug: VOICE_AGENT_PROCESSOR_SLUG,
  /* 2.1.0: the fold gained the idle deadline and the end-request. A persisted
   * 2.0.0 fold has no `lastHeardAtMs`, so it must be re-reduced rather than
   * trusted — bumping is how the runner is told to, and re-reducing a call
   * whose ephemeral utterances are long gone correctly concludes it is over. */
  version: "2.1.0",
  description: "Runs a voice call in the stream's own Durable Object, holding the Grok socket.",
  stateSchema: VoiceFacetState,
  events: {
    "events.iterate.com/voice-agent/created": {
      description: "The voice-agent facet exists on this stream.",
      payloadSchema: z.strictObject({
        /** Dial this instead of x.ai. Test seam; carries no credential. */
        providerBaseUrl: z.string().optional(),
      }),
    },
    "events.iterate.com/voice-agent/conversation-accepted": {
      description: "The provider accepted the session; the call is live.",
      payloadSchema: z.looseObject({ conversationId: z.string() }),
    },
    "events.iterate.com/voice-agent/conversation-failed": {
      description: "The call is not happening, and why.",
      payloadSchema: z.looseObject({ conversationId: z.string(), reason: z.string() }),
    },
    /*
     * SOMEBODY HAS DECIDED, and this is where they say so.
     *
     * ONE WAY TO END A CALL AND THREE THINGS THAT CAN DECIDE TO: the person,
     * the model, and the clock. Deciding and doing are separated because the
     * decider is often not holding the socket — the clock notices a minute has
     * passed in an incarnation that was revived precisely because the old one
     * (and its socket) died. So the decision is an append with a reason, the
     * facet consumes it on its ordinary delivery lane, and the ending itself
     * stays exactly one code path.
     *
     * Deliberately provider-agnostic: nothing here says "Grok", "socket" or
     * "disconnect". What ends is the conversation.
     */
    "events.iterate.com/voice-agent/conversation-end-requested": {
      description: "Somebody has decided this call is over, and why.",
      payloadSchema: z.looseObject({ conversationId: z.string(), reason: z.string() }),
    },
    "events.iterate.com/voice-agent/conversation-ended": {
      description: "The call is over.",
      payloadSchema: z.looseObject({ conversationId: z.string() }),
    },
    "events.iterate.com/voice-agent/device-presence": {
      description:
        "The board on this call connected or disconnected, copied from its client scope.",
      payloadSchema: z.looseObject({ connected: z.boolean(), client: z.string().optional() }),
    },
    /*
     * THREE VERBS, and that is the whole client contract: the button went
     * down, here is audio, the button came up. Whether a call exists, what it
     * is called and when it ends are the SERVER's, because the server is the
     * only side that can know them. Having the client ask for a call as well
     * was a second source of truth for one fact, and the two disagreeing is
     * what a wedged stream looks like.
     */
    "events.iterate.com/voice-agent/ptt-start": {
      description: "The user began speaking. Opens a call if one is not already up.",
      ...EPH,
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/voice-agent/mic-frame": {
      description: "One 20 ms capture frame, in the client's own sequence.",
      ...EPH,
      payloadSchema: MicFrame,
    },
    "events.iterate.com/voice-agent/ptt-end": {
      description: "The user stopped speaking; the turn is complete.",
      ...EPH,
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/voice-agent/call-started": {
      description: "The server opened a call, and what it is called.",
      payloadSchema: z.looseObject({ conversationId: z.string() }),
    },
    /*
     * THE NUMBER THIS DESIGN EXISTS FOR. Audio captured while the provider was
     * still being dialled is held and flushed the instant it is usable; this
     * says how much was held and what the hold cost, so "did buffering earn
     * anything" is a measurement rather than an argument.
     */
    /*
     * WHAT THE PROVIDER SAID WENT WRONG, on the stream where it can be read.
     *
     * Without this the facet dropped every provider event it did not handle,
     * so "Grok took the audio and answered nothing" and "Grok rejected the
     * commit" were the same observation: silence. An error nobody can see
     * costs an hour every time it happens.
     */
    "events.iterate.com/voice-agent/provider-error": {
      description: "The provider reported an error, verbatim.",
      payloadSchema: z.looseObject({ conversationId: z.string(), message: z.string() }),
    },
    "events.iterate.com/voice-agent/buffer-flushed": {
      description: "Queued capture went to the provider; how many frames, and the handshake cost.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        frames: z.number(),
        handshakeMs: z.number(),
      }),
    },
    "events.iterate.com/voice-agent/spk-frame": {
      description: "One frame of the answer, for the device's speaker.",
      ...EPH,
      payloadSchema: AudioFrame,
    },
    "events.iterate.com/voice-agent/grok-event": {
      description:
        "The provider's VAD/transcript subset: speech edges for barge-in, transcripts for instruments.",
      ...EPH,
      payloadSchema: z.looseObject({ conversationId: z.string(), t: z.number() }),
    },
    "events.iterate.com/voice-agent/turn-timing": {
      description:
        "Where this turn's time went, on the facet's clock: end seen, commit, ack, delta.",
      ...EPH,
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        endSeenT: z.number(),
        commitSentT: z.number().nullable(),
        committedAckT: z.number().nullable(),
        firstDeltaT: z.number(),
        /** First frame of the turn as the FACET saw it, and how many arrived. */
        firstFrameT: z.number().nullable(),
        micFrames: z.number(),
        /** Longest silence between two frames: a stall, as against a drift. */
        maxFrameGapMs: z.number(),
        /** Frames that arrived after the release and were refused, lifetime. */
        droppedAfterEnd: z.number(),
      }),
    },
    "events.iterate.com/voice-agent/say": {
      description: "A turn made of text rather than speech.",
      ...EPH,
      payloadSchema: z.looseObject({ text: z.string() }),
    },
    /*
     * THE WARM-UP HANDSHAKE. Setup blocks on this, so a facet that does not
     * answer it cannot be installed at all — which is exactly how the first
     * attempt failed: the types were in the subscription filter but not in
     * `consumes`, and delivery is the INTERSECTION, so the token never arrived.
     */
    "events.iterate.com/voice-agent/brief-current": {
      description: "Setup's statement of which brief is current.",
      payloadSchema: z.looseObject({
        setupId: z.string(),
        briefKey: z.string(),
        contentHash: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/warmup": {
      description: "A readiness probe for this stream's processor. Starts nothing.",
      payloadSchema: z.looseObject({ token: z.string() }),
    },
    "events.iterate.com/voice-agent/warmup-ready": {
      description: "This facet is built, running, and knows its brief; echoes the token.",
      payloadSchema: z.looseObject({ token: z.string() }),
    },
    "events.iterate.com/voice-agent/warmup-unresolved": {
      description: "The facet woke for a warm-up but could not resolve its brief.",
      payloadSchema: z.looseObject({ token: z.string() }),
    },
    /*
     * WHERE THE IDLE COUNTDOWN GOT TO, on the stream, because from outside a
     * loop that never ticks and a loop that ticks but never concludes are the
     * same observation: no end requested. Durable on purpose — the whole point
     * is to read it after fifteen minutes of nobody being connected.
     */
    "events.iterate.com/voice-agent/idle-countdown": {
      description: "One step of the idle countdown: which lap, which phase, how idle.",
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        phase: z.string(),
        lap: z.number(),
        idleForMs: z.number(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/created",
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/conversation-end-requested",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/conversation-failed",
    "events.iterate.com/voice-agent/device-presence",
    "events.iterate.com/voice-agent/brief-current",
    "events.iterate.com/voice-agent/warmup",
    /* The live half. Naming them is the whole opt-in — `"*"` never matches an
     * ephemeral event, so no processor gets this firehose by accident. */
    "events.iterate.com/voice-agent/ptt-start",
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/ptt-end",
    "events.iterate.com/voice-agent/say",
  ],
  emits: [
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/buffer-flushed",
    "events.iterate.com/voice-agent/provider-error",
    "events.iterate.com/voice-agent/conversation-accepted",
    "events.iterate.com/voice-agent/conversation-end-requested",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/conversation-failed",
    "events.iterate.com/voice-agent/spk-frame",
    "events.iterate.com/voice-agent/grok-event",
    "events.iterate.com/voice-agent/turn-timing",
    "events.iterate.com/voice-agent/warmup-ready",
    "events.iterate.com/voice-agent/warmup-unresolved",
    "events.iterate.com/voice-agent/idle-countdown",
  ],
});
export type VoiceAgentFacetContract = typeof VoiceAgentFacetContract;

/**
 * The voice agent. Two switches: `reduce` folds, `processEvent` acts.
 *
 * Nothing here awaits the provider on the delivery lane. A microphone frame
 * costs one decode and one `send`, which is the floor — anything more would
 * put the model's round trip inside the audio path.
 */
/**
 * One chunk of the answer, as the speaker lane ships it.
 *
 * FOUR FIELDS, and three of them are the client's entire buffer policy: clear
 * on `drop`, release the fence on `last`, otherwise write `pcm` and play it.
 *
 * What used to be here as well — `answer`, `frame`, `seq`, `t`, `enc` — was a
 * numbering scheme the device used to work out, on its own, whether a chunk
 * belonged to an answer it should still be playing. It cost 230 lines of
 * high-water marks and abandoned-answer latches on the board, every one of
 * which could silence it permanently, and it was answering a question the
 * sender already knows the answer to. The sender says `drop` instead.
 */
interface SpkFramePayload {
  /* The contract's schema is loose, so the lane's own shape has to admit the
   * same open record or the two types cannot meet. */
  [key: string]: unknown;
  conversationId: string;
  /** Discard anything still queued before playing this one. */
  drop?: boolean;
  /** The answer ends here: drain, and stop waiting for more. */
  last?: boolean;
  /** Mu-law, base64. Empty only on a chunk whose sole job is to close. */
  pcm: string;
}

/** One released chunk, shaped for the append lane. */
function asSpkFrame(call: GrokCall, chunk: SpeakerChunk) {
  const payload: SpkFramePayload = {
    conversationId: call.conversationId,
    pcm: chunk.mulaw.length === 0 ? "" : bytesToBase64(chunk.mulaw),
  };
  /* Both bits are omitted rather than sent false: they are exceptions, they
   * ride in every chunk's envelope, and the device treats absent as false. */
  if (chunk.drop) payload.drop = true;
  if (chunk.last) payload.last = true;
  return {
    type: "events.iterate.com/voice-agent/spk-frame" as const,
    ephemeral: true as const,
    payload,
  };
}

export class VoiceAgentFacetProcessor extends StreamProcessor<
  VoiceAgentFacetContract,
  {
    now(): number;
    /**
     * The ONLY way this processor waits, and there is deliberately no second
     * one. Both the pacer's drain loop and the idle countdown are
     * `runInBackground` closures that sleep, which is what puts their wakes
     * inside a context the keepalive holds — see `#holdUntilIdle` for the
     * measurement that says a bare `setTimeout` is not a substitute. Injected
     * so a sixty-second deadline is tested on a virtual clock rather than by
     * waiting a minute.
     */
    sleep(ms: number): Promise<void>;
    /** `baseUrl` is the birth certificate's override, or null for x.ai. */
    dialGrok(baseUrl: string | null): Promise<WebSocket | null>;
  }
> {
  readonly contract = VoiceAgentFacetContract;
  /**
   * How hard the speaker lane is allowed to push, and it is a FIELD.
   *
   * Overridable per instance so a test can pin a tighter lead and prove the
   * same invariants in milliseconds, and so a device profile that cannot take
   * 300 ms chunks can be served without editing this file. The defaults are
   * the firmware's real ceilings — see speaker.ts, where the failure modes of
   * exceeding each one are written down.
   */
  speakerLimits: SpeakerLimits = DEFAULT_SPEAKER_LIMITS;
  /** The live call, or null. Empty after an eviction — deliberately. */
  #call: GrokCall | null = null;
  /**
   * THE CALL THIS INCARNATION HAS ALREADY BURIED, until the log agrees.
   *
   * An obituary is APPENDED, which means there is a window — a write and a
   * delivery wide — in which this processor has let a call go and the fold
   * still says it is open. Every caught-up delivery landing inside that window
   * reads "the log owes a call and I am not holding it" and does the one thing
   * that used to be right: re-dials it.
   *
   * The window barely existed while calls were dialled once and held; hanging
   * up after every push-to-talk answer put it milliseconds in front of the
   * next press, which is the worst possible place for it. Two things went
   * wrong there, and both look from outside like a server that stopped
   * answering. The at-head pass opened a second provider session for a
   * conversation that was over — undoing the hang-up it had just performed —
   * and the press that arrived next found that freshly dialled corpse `alive`,
   * folded into it instead of opening its own call, and was then killed
   * outright when the obituary finally landed. No `call-started`, no answer,
   * no error: one silent round per press.
   *
   * Remembering the id closes it. This is in-memory ONLY, which is exactly
   * right: an eviction is the case the at-head pass exists for, and a revived
   * incarnation has buried nothing and must re-dial whatever the log says is
   * open.
   */
  #retiredId: string | null = null;

  /* ------------------------------------------------------------------ fold */

  reduce({ state, event }: ReduceArgs<VoiceAgentFacetContract>) {
    switch (event.type) {
      case "events.iterate.com/voice-agent/created":
        return {
          ...state,
          birthCertificate:
            event.payload.providerBaseUrl === undefined
              ? {}
              : { providerBaseUrl: event.payload.providerBaseUrl },
        };
      case "events.iterate.com/voice-agent/brief-current":
        return {
          ...state,
          briefCurrent: {
            setupId: event.payload.setupId,
            briefKey: event.payload.briefKey,
            contentHash: event.payload.contentHash,
          },
        };
      case "events.iterate.com/voice-agent/call-started":
        /* The server's own record that a call is up. Deterministic under
         * replay because the id was minted INTO the event, not here — and the
         * deadline starts here for the same reason: minting a call IS somebody
         * speaking, so the stamp the stream gave this event is the floor under
         * every later utterance, including for a call whose first press was
         * ephemeral and is already gone. */
        return {
          ...state,
          call: {
            conversationId: event.payload.conversationId,
            lastHeardAtMs: eventTimeMs(event),
            endRequested: null,
          },
        };
      case "events.iterate.com/voice-agent/ptt-start":
      case "events.iterate.com/voice-agent/mic-frame":
      case "events.iterate.com/voice-agent/ptt-end":
      case "events.iterate.com/voice-agent/say":
        /*
         * SOMEBODY IS TALKING, which is the only fact these four leave behind.
         *
         * Their BODIES still never reach the fold — reduced state that
         * depended on a buffer no restart can replay would be a lie — but
         * their commit STAMPS are as durable as any event's, and folding the
         * newest is what makes the idle deadline outlive an eviction without
         * a single extra append. `max` because a redelivered batch must not
         * be able to walk the deadline backwards.
         */
        return state.call === null
          ? state
          : {
              ...state,
              call: {
                ...state.call,
                lastHeardAtMs: Math.max(state.call.lastHeardAtMs, eventTimeMs(event)),
              },
            };
      case "events.iterate.com/voice-agent/conversation-end-requested":
        /* Decided, not yet done. The call stays open in the fold until the
         * obituary lands — what changes is that nothing will re-dial it, and
         * that any incarnation reaching head now owes the ending. */
        return state.call !== null &&
          namesThisCall(state.call.conversationId, String(event.payload.conversationId))
          ? { ...state, call: { ...state.call, endRequested: { reason: event.payload.reason } } }
          : state;
      case "events.iterate.com/voice-agent/conversation-ended":
      case "events.iterate.com/voice-agent/conversation-failed":
        /* An obituary closes the call it NAMES — and a mis-named one still
         * closes the current call; see {@link namesThisCall}. */
        return state.call !== null &&
          namesThisCall(state.call.conversationId, String(event.payload.conversationId))
          ? { ...state, call: null }
          : state;
      default:
        return state;
    }
  }

  /* ----------------------------------------------------------------- react */

  processEvent(args: ProcessEventArgs<VoiceAgentFacetContract>): undefined {
    const { state, event, delivery, append, runInBackground } = args;
    /*
     * Which provider this stream dials, read from the FOLD rather than held in
     * a field. A field would be empty in exactly the incarnation that needs it
     * — the revived one, dialling from the at-head pass — and the call would
     * silently go to x.ai instead of the mock a test had pointed it at.
     */
    const providerBaseUrl = state.birthCertificate?.providerBaseUrl ?? null;
    /* The log has caught up with the obituary, so stop remembering it. */
    if (state.call?.conversationId !== this.#retiredId) this.#retiredId = null;
    /*
     * THE AT-HEAD PASS IS THE RECOVERY. An eventless caught-up delivery is how
     * a revived incarnation learns it owes a call, so this runs before the
     * event switch and is the only thing that ever dials.
     */
    const wanted = state.call;
    if (delivery.caughtUp && wanted !== null) {
      if (wanted.endRequested !== null) {
        /*
         * THE OBLIGATION'S RECOVERY PASS, and its ordinary execution too.
         *
         * Somebody has decided this call is over. Doing it from here rather
         * than from the per-event switch is what makes a dropped attempt
         * self-healing: the desire is in the fold, so an incarnation that dies
         * — or merely fails to write the obituary — is simply asked again the
         * next time anything reaches head. It is also the only place that CAN
         * do it after an eviction, where the decider left no socket behind.
         *
         * Deliberately NOT behind the `#retiredId` guard. That guard exists to
         * stop a DIAL resurrecting a call this incarnation has already let go
         * of; re-running the ending is the opposite — idempotent by key, and
         * the only thing that ever retries a refused obituary.
         */
        this.#endAsRequested(wanted.conversationId, wanted.endRequested.reason, append);
      } else if (
        wanted.conversationId !== this.#retiredId &&
        this.#call?.conversationId !== wanted.conversationId
      ) {
        /*
         * THE FOLD OWES A CALL THIS INCARNATION IS NOT HOLDING, which is
         * either a call to rescue or a call to bury, and telling those two
         * apart is what stops the loop below.
         *
         * THE LOOP, measured: a call held open as background work arms the
         * runner's keepalive, the keepalive revives the processor every ten
         * seconds, and every revival's at-head pass re-dialled — burning one
         * provider session per lap and, because the deadline lived only in the
         * dead incarnation's memory, starting the minute again on each one. An
         * abandoned call kept alive forever by the machinery meant to rescue
         * it. The cure is that the deadline is derivable from the fold: a
         * revival can ask "is this past due" instead of "is this open".
         *
         * A NEWER CALL STILL SUPERSEDES THE ONE IN FLIGHT. The guard used to
         * be `this.#call === null`, which reads as "only dial when idle" and
         * is really "dial once, ever": one test call that was never ended made
         * this incarnation refuse every later request in silence. Comparing
         * the id makes the rule the honest one — whatever the fold says the
         * current call is, that is the call this incarnation holds — and a
         * repeat of the SAME id stays a no-op, so a redelivery does not churn
         * a live socket.
         */
        if (idleDeadlinePassed(wanted.lastHeardAtMs, this.deps.now())) {
          this.#requestEnd(wanted.conversationId, IDLE_END_REASON, append, runInBackground);
        } else {
          this.#endCall("superseded by a newer call on this stream");
          this.#dial(wanted.conversationId, providerBaseUrl, append, runInBackground);
        }
      }
    }
    if (event === null) return;
    const call = this.#call;
    switch (event.type) {
      case "events.iterate.com/voice-agent/ptt-start": {
        /*
         * THE PRESS IS THE ONLY TRIGGER, and it does two things at once: opens
         * a call if none is up, and tells a provider that already is that a
         * fresh utterance starts here.
         *
         * Dialling begins NOW, in the background, while the user is already
         * talking. That overlap is the entire latency design: by the time
         * somebody has said two or three seconds of anything, the session is up
         * and the audio they spoke into the handshake has already been flushed.
         */
        if (call === null || !call.alive(this.deps.now())) {
          /* A dead call is not a call. Retire it and dial a fresh one rather
           * than folding this press into a corpse. */
          if (call !== null) {
            this.#endCall(
              call.ready ? "provider socket is gone" : "provider handshake never completed",
              append,
            );
          }
          const conversationId = crypto.randomUUID().slice(0, 8);
          this.#dial(
            conversationId,
            providerBaseUrl,
            append,
            runInBackground,
            OPEN_MIC_CLIENTS.has(String(event.payload.client ?? "")),
          );
          runInBackground(async () => {
            await append({
              type: "events.iterate.com/voice-agent/call-started",
              payload: { conversationId },
            });
          });
          return;
        }
        /* Whatever the provider still holds is from a turn that never
         * committed; prepending it would answer a blend of two utterances.
         * (And, being a send, it is also what restarts this call's idle
         * countdown for a caller who paused to think and then pressed again.) */
        call.send({ type: "input_audio_buffer.clear" });
        /* A fresh utterance starts here, so the frame count that measures
         * whether this facet keeps up with the microphone starts here too —
         * and audio is welcome again. */
        call.turnClosed = false;
        call.framesThisTurn = 0;
        call.firstFrameAtMs = null;
        call.maxFrameGapMs = 0;
        call.resetFrameClock();
        /*
         * SAY YES AGAIN. The device latches call_active from
         * `conversation-accepted` on its live connection, and the original
         * accept was emitted once, under this call's idempotency key, possibly
         * hours ago to a connection that no longer exists. A press that folds
         * into a live call therefore produced NOTHING the presser could see:
         * the call was up, the device never learned it, the face slept on.
         * Re-accepting per press (keyed by the press's own clock so a
         * redelivery cannot duplicate it) closes the loop for every press, not
         * just the one that dialled.
         */
        void append({
          type: "events.iterate.com/voice-agent/conversation-accepted",
          idempotencyKey: this.idempotencyKey(
            `accepted:${call.conversationId}:press:${String(event.payload.t ?? "-")}`,
          ),
          payload: { conversationId: call.conversationId },
        });
        return;
      }
      case "events.iterate.com/voice-agent/mic-frame": {
        /* The hot path, and it stays this short on purpose: one decode, one
         * send, no await. Held instead if the session is not up — see
         * GrokCall.offer. */
        if (call === null) return;
        /* A frame is somebody talking whatever we then do with it, so this is
         * BEFORE the refusal below on purpose: a client that keeps streaming
         * past its own release is still a client on this call. */
        call.spoke();
        /* Straggling audio from a turn that has already been committed would
         * read to the provider as a barge-in and cancel the answer. */
        if (call.turnClosed && !call.serverVad) {
          call.droppedAfterEnd++;
          return;
        }
        /* PCM16, always. This read `enc === "u" ? mulawToPcm16(bytes) : bytes`
         * until the boards stopped sending mu-law, after which it was a live
         * conditional on a value nothing produced — correct only by taking its
         * else arm every time, and one stray "u" away from decoding PCM16 as
         * G.711. The contract no longer carries a codec field. */
        call.offer(base64ToBytes(event.payload.pcm), this.deps.now());
        return;
      }
      case "events.iterate.com/voice-agent/ptt-end": {
        if (call === null) return;
        call.commit(this.deps.now());
        return;
      }
      case "events.iterate.com/voice-agent/say": {
        if (call === null) return;
        const text = event.payload.text.trim();
        if (text.length === 0 || text.length > 4096) return;
        call.send({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        });
        call.send({ type: "response.create" });
        return;
      }
      case "events.iterate.com/voice-agent/warmup": {
        /*
         * BEING HERE IS THE PROOF. The old handshake had to go and warm a
         * separate bridge worker and report how long that took; the facet IS
         * the bridge, so a delivered warm-up means the class is already loaded
         * and running in this stream's own Durable Object. The only thing left
         * that can be missing is the brief.
         */
        const token = event.payload.token;
        const marker = state.briefCurrent;
        runInBackground(async () => {
          if (marker === null) {
            await append({
              type: "events.iterate.com/voice-agent/warmup-unresolved",
              payload: {
                token,
                streamPath: this.path,
                reason: "no brief-current has reached this processor",
                stage: "brief",
              },
            });
            return;
          }
          await append({
            type: "events.iterate.com/voice-agent/warmup-ready",
            payload: {
              token,
              streamPath: this.path,
              briefKey: marker.briefKey,
              briefSetupId: marker.setupId,
              briefContentHash: marker.contentHash,
              /* Zero, and honestly so: there is no second worker to build. */
              bridgeWarmMs: 0,
              bridgeBuilding: false,
              protocolRevision: WARMUP_PROTOCOL_REVISION,
              processorSlug: VOICE_AGENT_PROCESSOR_SLUG,
            },
          });
        });
        return;
      }
      case "events.iterate.com/voice-agent/device-presence": {
        /* The board left, said out loud rather than inferred from silence. */
        if (event.payload.connected === false) this.#endCall("device disconnected");
        return;
      }
      case "events.iterate.com/voice-agent/conversation-ended": {
        /* Same rule as the fold — see {@link namesThisCall}. The log keeps the
         * firmware's self-naming visible until the device echoes the real id. */
        if (call !== null) {
          const named = String(event.payload.conversationId);
          if (!namesThisCall(call.conversationId, named)) return;
          if (call.conversationId !== named) {
            console.log(
              `conversation-ended self-named: live=${call.conversationId} ` +
                `event=${named} — retiring the live call`,
            );
          }
          this.#endCall("conversation-ended event");
        }
        return;
      }
      default:
        return;
    }
  }

  /* --------------------------------------------------------------- private */

  /**
   * Dial Grok for a call the fold says is open.
   *
   * Runs in background work and returns immediately, so a cold provider never
   * sits on the delivery lane. The device may already be sending audio — that
   * is the point of `GrokCall`'s queue — so the call object exists BEFORE the
   * socket does and starts collecting frames straight away.
   */
  #dial(
    conversationId: string,
    providerBaseUrl: string | null,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentFacetContract>["runInBackground"],
    serverVad = false,
  ): void {
    const call = new GrokCall(conversationId, this.deps.now);
    call.serverVad = serverVad;
    this.#call = call;
    /*
     * A LIVE CALL IS WORK IN FLIGHT, and saying so is the whole keepalive.
     *
     * `runInBackground` is keepalive-backed: while this promise is unsettled
     * the runner parks a durable alarm ahead of it, so the object stays up
     * through a silence and a dead incarnation is revived rather than
     * forgotten. The loop ends when `GrokCall.close` resolves `over`, which is
     * why there is no alarm code in this file and no second definition of
     * "the call is over".
     *
     * Its answer to "what recovers the OUTCOME if this attempt drops?" is the
     * at-head pass above, reading `lastHeardAtMs` out of the fold: a revival
     * either re-dials a conversation that is still going or asks for the end
     * of one that is not. Without that reading, this registration IS the
     * eternal re-dial loop — which is exactly how it was measured.
     *
     * AND IT IS A CORRECTNESS FIX, NOT ONLY A COST ONE. MEASURED on the
     * platform: a worker-loader facet whose PARENT goes 73 seconds (±2)
     * without inbound activity is CORRUPTED rather than reaped — its timers
     * keep firing and its outbound socket keeps sending (one ran 15+ hours),
     * its storage writes begin throwing, and the next `facets.get()` hands out
     * a SECOND fresh facet beside the zombie still holding the provider
     * socket. A periodic alarm on the parent is the measured cure (30s 9/9
     * intact, 45s 6/6, 60s 4/4, 120s 0/3), and this registration is exactly
     * that alarm: the keepalive re-arms ten seconds ahead of in-flight work on
     * EVERY fire, not once, so a silent call pokes its parent six or seven
     * times inside the minute it has left. The margin that matters is that
     * ten, not the thirteen seconds between the deadline and the threshold.
     * (Checked, not assumed: "keeps the parent poked on a ten-second cadence"
     * in voice-agent.facet.test.ts.)
     *
     * The keepalive's own wedge detector — 90 consecutive fires with nothing
     * settling, after which the cadence decays into the revival backoff and
     * would cross the threshold — sits at ~15 minutes, fourteen past the
     * deadline that ends a silent call. It cannot be reached from here.
     *
     * The countdown rides the SAME registration rather than a timer of its
     * own, because "this call is still open" and "this call has been quiet
     * long enough" are one question asked twice. See `#holdUntilIdle` for why
     * a bare `setTimeout` could not answer it.
     */
    runInBackground(() => this.#holdUntilIdle(call, append));
    runInBackground(async () => {
      let failure: string | null = null;
      try {
        const socket = await this.deps.dialGrok(providerBaseUrl);
        if (socket === null) failure = "provider refused the websocket upgrade";
        else if (call.closed) {
          /*
           * BEING SUPERSEDED IS NOT FAILING. This fell through to the obituary
           * below with `failure` still null, so a call that was deliberately
           * replaced — a second press, a revival — wrote
           * `conversation-failed` with an EMPTY reason. Two of those appeared
           * on the boards' stream the first time they successfully called,
           * which reads as a broken dial rather than a tidy hand-over.
           */
          socket.close();
          return;
        } else {
          call.attach(socket);
          this.#listen(call, socket, append, runInBackground);
          return;
        }
      } catch (error) {
        failure = String(error);
      }
      /* Say so on the stream. A device that hears nothing cannot tell "still
       * connecting" from "never going to happen", and used to wait forever. */
      if (this.#call === call) this.#call = null;
      /* `conversation-failed` closes the call in the fold exactly as an
       * obituary does, so it opens the same re-dial window. */
      this.#retiredId = call.conversationId;
      call.close();
      await append({
        type: "events.iterate.com/voice-agent/conversation-failed",
        idempotencyKey: this.idempotencyKey(`failed:${conversationId}`),
        payload: { conversationId, reason: (failure ?? "").slice(0, 500) },
      });
    });
  }

  /** Wire the provider's events to the stream. Nothing here blocks delivery. */
  #listen(
    call: GrokCall,
    socket: WebSocket,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentFacetContract>["runInBackground"],
  ): void {
    socket.addEventListener("close", () => {
      /*
       * A PROVIDER-SIDE CLOSE MUST REACH THE FOLD, not just this incarnation's
       * memory. Only the in-memory call was retired here, so an abandoned call
       * (opened, never spoken into, never hung up) stayed open in `state.call`
       * forever — and the at-head recovery re-dialled it on every caught-up
       * delivery. Measured on two boards' streams: the same conversationId
       * collecting a "timed out after 900.0 seconds due to inactivity" error
       * every ~15 minutes, all night — an eternal re-dial loop burning one
       * provider session per lap, with every fresh press folding into the
       * loop's "alive" call instead of opening its own.
       *
       * The supersede path also lands here after it retires a call; its end is
       * a mismatched 8-hex obituary by then, which the fold ignores — so this
       * cannot close a successor.
       */
      const wasLive = this.#call === call;
      if (wasLive) {
        this.#call = null;
        /* Same window as `#endCall`'s: this obituary is a write away from the
         * fold, and until it lands the at-head pass would re-dial the corpse. */
        this.#retiredId = call.conversationId;
      }
      call.close();
      if (wasLive) {
        /* CAUGHT, for the reason `#endCall` spells out: a socket close is the
         * last thing that happens before this Durable Object is allowed to go
         * quiet, so a bare rejection here is an unhandled rejection racing the
         * eviction it just permitted. Losing the obituary costs a fold that
         * names a dead call until the next press; `#retiredId` above already
         * stops the at-head pass resurrecting it in the meantime. */
        void append({
          type: "events.iterate.com/voice-agent/conversation-ended",
          payload: { conversationId: call.conversationId, reason: "provider socket closed" },
        }).catch((error: unknown) => {
          console.log(
            `voice call ${call.conversationId} obituary failed to append: ${String(error)}`,
          );
        });
      }
    });
    socket.addEventListener("message", (message: MessageEvent) => {
      if (typeof message.data !== "string") return;
      let provider: { type?: string; delta?: string; response?: { id?: string } };
      try {
        provider = JSON.parse(message.data) as {
          type?: string;
          delta?: string;
          response?: { id?: string };
        };
        /* Every provider event, so a silent call can be explained from the
         * log rather than guessed at. Audio deltas are excluded by name:
         * there are hundreds and they say nothing the frames do not. */
        if (provider.type !== "response.output_audio.delta") {
          console.log(`grok <- ${String(provider.type)}`);
        }
      } catch {
        return;
      }
      /*
       * THE OTHER HALF OF "EITHER SIDE". A ninety-second answer is the model
       * talking, and ageing the call out from under it would cut the reply off
       * mid-sentence; the provider's own turn edges and transcripts are the
       * same conversation.
       *
       * BUT NOT ITS KEEPALIVE. This used to count every provider message and
       * said in its own comment that "xAI sends nothing on an idle session".
       * That was wrong: xAI sends a `ping` roughly every fifty seconds.
       * Measured on preview, `lastSpokeAtMs` advanced every 50.002 s through
       * a silence nobody was speaking into, so the sixty-second deadline was
       * reset forever and the call ran until xAI's own 900 s inactivity
       * timeout ended it — the deadline never fired once in fifteen minutes.
       *
       * The retiring bridge knew this and its own idle timeout excluded
       * liveness pings by name, with the reason written down: a device
       * pinging into an empty room is not a conversation. The same is true of
       * a provider pinging into one.
       */
      if (provider.type !== "ping") call.spoke();
      /* The verbatim lane first, unconditionally — deltas included. */
      this.#forwardGrokEvent(call, provider as Record<string, unknown>, append);
      switch (provider.type) {
        case "session.created":
          /* The ONLY edge that makes us configure the session; miss it and the
           * handshake never completes and the call hangs, silently. */
          call.sendNow(grokSessionUpdate(call.serverVad));
          return;
        case "session.updated": {
          /* Usable. Everything the handshake made us hold goes now. */
          call.markReady(this.deps.now());
          const framesQueued = call.framesQueued;
          void append(
            {
              type: "events.iterate.com/voice-agent/conversation-accepted",
              idempotencyKey: this.idempotencyKey(`accepted:${call.conversationId}`),
              payload: { conversationId: call.conversationId },
            },
            {
              type: "events.iterate.com/voice-agent/buffer-flushed",
              /* Per DIAL, not per conversation — see GrokCall.openedAtMs. A
               * call rescued after an eviction handshakes again, and its
               * numbers are its own; keyed on the conversation, the second
               * handshake's append was rejected outright and took the
               * acceptance beside it down too. */
              idempotencyKey: this.idempotencyKey(
                `flushed:${call.conversationId}:${call.openedAtMs}`,
              ),
              payload: {
                conversationId: call.conversationId,
                frames: framesQueued,
                handshakeMs: call.handshakeMs ?? 0,
              },
            },
          );
          return;
        }
        case "error": {
          const detail = JSON.stringify(provider).slice(0, 600);
          console.log(`grok error: ${detail}`);
          /* Durable, as its declaration says: the whole point is that a
           * silent call can be explained later, and an ephemeral one is gone
           * as soon as the buffer rolls. */
          void append({
            type: "events.iterate.com/voice-agent/provider-error",
            payload: { conversationId: call.conversationId, message: detail },
          });
          return;
        }
        case "input_audio_buffer.speech_started":
          /*
           * THE FLOOR HAS BEEN TAKEN, AND BOTH ENDS HAVE TO BE TOLD.
           *
           * Dropping what is held is not enough on its own, and the reason is
           * an asymmetry in the API: xAI's `turn_detection` has no
           * `interrupt_response` field, so detecting speech does NOT cancel
           * the answer it is generating. It keeps producing deltas, the pacer
           * keeps releasing them, and the board keeps talking — measured at
           * about six seconds past the interruption with the held queue
           * already cleared, which is what made it look like a flush bug
           * rather than a missing request.
           *
           * TURN TAKING IS THE SERVER'S JOB. The device's half of this is to
           * send microphone frames up and play what comes down; it does not
           * decide anything about turns, and nothing here asks it to. What it
           * does need is to be TOLD, because it is holding up to `leadMs` of
           * audio that is now dead — and `speakerReplace` only arms `drop` on
           * the next chunk, which after an interruption never comes, because
           * the whole point is that there is no more audio.
           *
           * An empty chunk carrying `drop` is already a shape this lane sends
           * (the one whose sole job is to close), so this is the existing
           * mechanism used at the one moment it was missing, not a new one.
           *
           * `response.cancel` was tried here and removed: the provider's own
           * event log shows `response.done` arriving BEFORE
           * `speech_started`, so there is never an in-flight response to
           * cancel and the request came back as an error every time.
           */
          call.abandonHeldAudio();
          append(asSpkFrame(call, { drop: true, last: false, mulaw: new Uint8Array(0) }));
          return;
        case "input_audio_buffer.committed":
          /* The provider has the turn. Everything before this stamp is ours
           * and the wire; everything after it until the first delta is the
           * model. */
          call.committedAckAtMs = this.deps.now();
          return;
        case "response.created":
          /* Numbering the answer makes a barge-in a comparison: a client
           * holding frames from answer 3 drops them on seeing a 4. */
          call.beginAnswer(this.deps.now(), provider.response?.id ?? null);
          return;
        case "response.output_audio.delta":
          if (typeof provider.delta === "string") {
            this.#reportTurnTiming(call, append);
            this.#speak(call, provider.delta, append, runInBackground);
          }
          return;
        case "response.done":
        case "response.output_audio.done": {
          /*
           * THE ANSWER IS OVER, AND THE PROVIDER GETS TO SAY SO ITS OWN WAY.
           *
           * `response.done` is the end of a turn as this codebase has always
           * observed it: the retired bridge freed the floor on it, `direct.ts`
           * counts turns with it against the real xAI endpoint, and it is what
           * `fake-grok.ts` sends. `response.output_audio.done` is the realtime
           * spelling for the audio part specifically, and the facet used to
           * handle ONLY that — a name that appears nowhere else in this
           * repository, including in the code that has actually talked to xAI.
           *
           * With neither name handled, `speakerComplete` never ran: no chunk
           * was ever marked `last`, the device's fence was never released, and
           * the mouth stayed open on the final shape it was given. A reply
           * that plays and then a board that has gone deaf. Both existing
           * facet suites missed it because their inline providers send the
           * event the implementation happened to handle — see
           * voice-agent.fake-grok.e2e.test.ts, which sends what a provider
           * sends.
           *
           * Whichever arrives first ends the answer, and a second one changes
           * nothing: `speakerComplete` is a flag and `closeMouth` is guarded.
           */
          if (!call.answerIs(provider.response?.id ?? null)) return;
          /* THE MOUTH MUST CLOSE. Without a closing SIL the face holds the
           * last shape it was given, so the board sits there mid-syllable
           * until the next answer — which reads as a crash, not a pause. */
          this.#foldFace(call.closeMouth());
          /*
           * AND THE CALL STAYS UP. This used to hang up the provider socket
           * here, on every push-to-talk answer, so the next press re-dialled —
           * which is a new conversation per button press rather than one
           * conversation across many. The socket now goes when the call does:
           * a minute after the last utterance, or when either side ends it.
           */
          /* NOT "send the closing chunk now". The tail may still be seconds
           * of audio the listener has not caught up with; `last` is attached
           * to whichever chunk turns out to be final, and the drain loop is
           * what finds out which. */
          call.completeAnswer();
          this.#drainSpeaker(call, append, runInBackground);
          return;
        }
        default:
          /* Already on the verbatim lane above; nothing else to do. */
          return;
      }
    });
  }

  /**
   * The provider's timeline, verbatim, as ephemeral `grok-event`s — audio
   * deltas included. The paced `spk-frame` lane says what the device was
   * GIVEN; this lane says what the provider SENT and when. They deliberately
   * need not match: consuming both off one stream is the whole buffer-
   * management debugging story, no device in hand.
   */
  #forwardGrokEvent(
    call: GrokCall,
    provider: Record<string, unknown>,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
  ): void {
    /*
     * THE TIMELINE, AND NOT ONE FRAME OF THE AUDIO.
     *
     * Forwarding provider events verbatim meant forwarding `delta`: tens of
     * kilobytes of base64 per chunk, hundreds of chunks per answer, to every
     * subscriber. The host CLI died on it — `protoFail=10 recvFail=10`, the
     * `/api` socket torn down and re-dialled every few seconds for a whole
     * conversation — because an embedded client reassembles a delivery batch
     * into a fixed buffer and a delta does not fit.
     *
     * Replacing the bytes with their length fixed the buffer and left the
     * worse half of the problem: hundreds of EVENTS an answer, each competing
     * for a slot in a board's sixteen-event batch against the speaker frames
     * that are the point. So the audio delta does not ride this lane at all.
     * It is the one provider event whose content is already here, paced and
     * framed, on `spk-frame` — and `turn-timing` says when the first one
     * landed, which is the only thing its timestamp was ever read for.
     *
     * Everything else stays verbatim, because a silent call is diagnosed from
     * the transitions: this lane is what proved a barge-in one millisecond
     * after `response.created` was cancelling four answers in six.
     */
    if (provider.type === "response.output_audio.delta") return;
    void append({
      type: "events.iterate.com/voice-agent/grok-event",
      payload: { conversationId: call.conversationId, t: this.deps.now(), event: provider },
    });
  }

  /**
   * The turn's four facet-side stamps, once, as the answer's first byte lands.
   *
   * Read against a client's own release time (aligned with a `ping`/`pong`
   * round trip) this turns press-to-answer into four terms that can each be
   * attacked separately: reaching the facet, the facet's own work, the facet's
   * round trip to the provider, and the model thinking.
   */
  #reportTurnTiming(
    call: GrokCall,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
  ): void {
    if (call.timingReported || call.endSeenAtMs === null) return;
    call.timingReported = true;
    void append({
      type: "events.iterate.com/voice-agent/turn-timing",
      ephemeral: true,
      payload: {
        conversationId: call.conversationId,
        endSeenT: call.endSeenAtMs,
        commitSentT: call.commitSentAtMs,
        committedAckT: call.committedAckAtMs,
        firstDeltaT: this.deps.now(),
        firstFrameT: call.firstFrameAtMs,
        micFrames: call.framesThisTurn,
        maxFrameGapMs: call.maxFrameGapMs,
        droppedAfterEnd: call.droppedAfterEnd,
      },
    });
  }

  /*
   * THE FACE IS A VALUE, NOT A STREAM.
   *
   * Mouth shapes arrive tens of times a second, and sending each as an event
   * would put a second firehose on the lane we just cleared of the first —
   * every shape competing with the speaker frames it describes for a slot in
   * a board's delivery batch, to deliver something that is stale the instant
   * the next one exists. Audio is a stream because every sample matters and a
   * gap is audible. A face is the opposite: only the latest matters, and a
   * missed intermediate pose is invisible.
   *
   * So the shapes fold here and are published through `liveState`, which
   * coalesces by nature — a client that falls behind gets the current pose
   * rather than a backlog of positions the mouth has already left. It is
   * deliberately not durable: after a restart the mouth should be shut, not
   * restored to whatever shape it held when the incarnation died.
   */
  #face: { viseme: number; answer: number; playoutSamples: number; at: number } | null = null;

  #foldFace(
    shapes: readonly { payload: { viseme: number; answer: number; playoutSamples: number } }[],
  ): void {
    const latest = shapes.at(-1);
    if (latest === undefined) return;
    this.#face = { ...latest.payload, at: this.deps.now() };
  }

  /**
   * What a face-rendering client watches. `liveState` pins this against the
   * runner's snapshot, so a board reads one consistent picture of the call and
   * the mouth rather than two that can disagree.
   */
  override async getRuntimeState() {
    return {
      runtime: {
        face: this.#face,
        conversationId: this.#call?.conversationId ?? null,
        ready: this.#call?.ready === true,
        /*
         * THE CLOCK, WHICH IS WHY `ping`/`pong` ARE GONE.
         *
         * Those two event types existed to prove this incarnation was alive
         * and to let a caller align its clock with it. Both were duplicates: a
         * WebSocket has its own ping/pong and already knows whether it is
         * alive, the platform hands the stream a real connection-layer ping
         * (t0/t1/t2) for transport RTT, and reading THIS bag is itself proof
         * that the facet is loaded and answering. A read that has to happen
         * anyway is a better liveness probe than two event types on the lane
         * we are trying to reduce to almost nothing.
         */
        now: this.deps.now(),
        /*
         * THE SPEAKER LANE, IN MILLISECONDS.
         *
         * The audio itself is never published — it is megabytes, and it is
         * already on its way to the only consumer that wants it. What is
         * published is the answer to the question anybody debugging this asks
         * first: how much is held, how much has gone, and how far ahead of the
         * listener we are. `overflowBytes` non-zero means audio was dropped.
         */
        speaker: this.#call === null ? null : speakerSummary(this.#call.speaker, this.deps.now()),
      },
    };
  }

  /** Provider audio out to the device, paced by speaker.ts. */
  #speak(
    call: GrokCall,
    deltaBase64: string,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentFacetContract>["runInBackground"],
  ): void {
    /* The PCM the classifier reads is the PCM the speaker will play, so it is
     * taken before the mu-law encode spends it. */
    const pcm = new Uint8Array(base64ToBytes(deltaBase64));
    /*
     * The mouth moves on every delta, including one too short to release. Its
     * audio has still been seen by the classifier, and holding the shapes back
     * would make the face lag the voice by however long the provider takes to
     * send the rest.
     */
    this.#foldFace(call.visemesFor(pcm));
    call.pushAudio(encodeMulawFromPcm16(pcm));
    this.#drainSpeaker(call, append, runInBackground);
  }

  /**
   * Release what the listener has room for, and keep one loop alive to release
   * the rest.
   *
   * ONE LOOP PER CALL, and it is the only thing in this file that decides when
   * audio moves. It sleeps exactly as long as speaker.ts says — never a fixed
   * tick — so a ninety-second answer costs ninety wakes rather than one every
   * four hundred milliseconds forever, and a call with nothing to say costs
   * none at all.
   *
   * Re-entrant by design: every provider delta calls this, and all but the
   * first find the loop already running and simply return. The loop exits when
   * the answer is fully handed over, which is what lets the Durable Object
   * hibernate between turns instead of being pinned by a pacer.
   */
  #drainSpeaker(
    call: GrokCall,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentFacetContract>["runInBackground"],
  ): void {
    const first = call.releaseAudio(this.deps.now(), this.speakerLimits);
    if (first.chunks.length > 0) {
      call.spoke();
      const frames = first.chunks.map((c) => asSpkFrame(call, c));
      /* ENQUEUED, not fired. Un-awaited here is deliberate — this runs on the
       * delivery lane and must not block it — and un-ORDERED was the bug; see
       * GrokCall.inSpeakerOrder. */
      void call.inSpeakerOrder(() => append(...frames));
    }
    if (first.nextWakeMs === null || call.pacerRunning) return;
    call.pacerRunning = true;
    runInBackground(async () => {
      try {
        let wake = first.nextWakeMs;
        while (!call.closed && wake !== null) {
          await this.deps.sleep(wake);
          if (call.closed) break;
          const release = call.releaseAudio(this.deps.now(), this.speakerLimits);
          if (release.chunks.length > 0) {
            /*
             * HANDING SPEECH TO THE LISTENER IS THE CALL BEING USED.
             *
             * The provider dumps a ninety-second answer in a few seconds, so
             * `lastSpokeAtMs` stopped advancing the moment the last delta
             * landed — and then the idle countdown, which has no idea an
             * answer is still going out, ended the call sixty seconds into it.
             * MEASURED: a count to one hundred delivered 63 s of 90 s and then
             * `conversation-ended: no utterance from either side for 60s`,
             * mid-sentence. The provider going quiet is not the room going
             * quiet while we are still talking.
             */
            call.spoke();
            const frames = release.chunks.map((c) => asSpkFrame(call, c));
            /* Through the same queue as the delta handler's, and still awaited
             * — the await is this loop's backpressure, the queue is what stops
             * it overtaking a clear the delta handler enqueued first. */
            await call.inSpeakerOrder(() => append(...frames));
          }
          wake = release.nextWakeMs;
        }
      } finally {
        /* Cleared however the loop leaves — a throw here used to strand the
         * flag set, and a stranded flag means no later delta can ever start a
         * drain again, which is an answer that arrives and is never sent. */
        call.pacerRunning = false;
      }
    });
  }

  /**
   * Stay in flight for the life of this call, and ASK for its end when a whole
   * minute has passed with nothing said either way.
   *
   * TWO JOBS, ONE PROMISE, and they belong together. Unsettled, this is the
   * obligation that keeps the Durable Object up (and its parent poked, which
   * is what stops a facet being corrupted at 73 seconds); settled, it is the
   * release that lets the object hibernate. Asking for the end is simply the
   * last thing it does before settling.
   *
   * IT IS A LOOP AND NOT A TIMER, and that is the whole repair. A
   * `setTimeout` armed from the synchronous body of a delivery belongs to a
   * request context that ends with that delivery — MEASURED on preview-3: a
   * live call, 150 seconds of silence, a facet demonstrably alive (it answered
   * a warm-up probe in 154ms), a stream with no traffic on it at all, and no
   * end ever requested. Running inside a `runInBackground` closure is what
   * gives the wake somewhere to happen and the append something to happen in;
   * the pacer's drain loop has always worked for exactly this reason.
   *
   * The sleep is EXACTLY as long as the call has left, so somebody speaking
   * costs nothing (the next wake simply recomputes) and the deadline is the
   * deadline rather than a polling interval rounded up.
   *
   * Not a hang-up: this appends the decision and lets the delivery lane do the
   * ending in {@link #endAsRequested}, so there stays one code path that
   * closes a socket and writes an obituary however the decision was reached.
   */
  async #holdUntilIdle(
    call: GrokCall,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
  ): Promise<void> {
    let lap = 0;
    this.#countdownStep(call, "entered", 0, append);
    while (!call.closed) {
      lap += 1;
      const idleForMs = this.deps.now() - call.lastSpokeAtMs;
      if (idleForMs < IDLE_TIMEOUT_MS) {
        /* Racing `over` is what makes a call that ends by any other route —
         * a device's hang-up, a provider close, being superseded — release
         * this immediately instead of holding the object for the rest of the
         * minute it no longer has. */
        this.#countdownStep(call, "sleeping", lap, append, IDLE_TIMEOUT_MS - idleForMs);
        await Promise.race([this.deps.sleep(IDLE_TIMEOUT_MS - idleForMs), call.over]);
        this.#countdownStep(call, call.closed ? "woke-closed" : "woke", lap, append);
        continue;
      }
      this.#countdownStep(call, "due", lap, append, idleForMs);
      try {
        await append({
          type: "events.iterate.com/voice-agent/conversation-end-requested",
          idempotencyKey: this.idempotencyKey(`end-requested:${call.conversationId}`),
          payload: { conversationId: call.conversationId, reason: IDLE_END_REASON },
        });
      } catch (error) {
        /* Nothing was decided, so nothing will end this call unless the next
         * minute is started here. */
        console.log(
          `voice call ${call.conversationId} idle end-request failed to append: ${String(error)}`,
        );
        this.#countdownStep(call, `ask-failed: ${String(error).slice(0, 120)}`, lap, append);
        call.spoke();
        continue;
      }
      this.#countdownStep(call, "asked", lap, append);
      /*
       * ASKED, NOT DONE. Settling now would release the keepalive between the
       * decision and the ending — the object could hibernate holding a socket
       * nobody has closed. So wait for the delivery lane to close the call;
       * if a minute passes and it somehow has not, ask again (the idempotency
       * key collapses the repeat into the request already on the log).
       */
      await Promise.race([call.over, this.deps.sleep(IDLE_TIMEOUT_MS)]);
    }
    this.#countdownStep(call, "released", lap, append);
  }

  /**
   * Say on the stream where the countdown got to.
   *
   * Fire-and-forget on purpose: an instrument that can throw, block, or change
   * the control flow it is measuring is not an instrument. Durable because the
   * thing being measured is a stream nobody is connected to.
   */
  #countdownStep(
    call: GrokCall,
    phase: string,
    lap: number,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
    idleForMs = this.deps.now() - call.lastSpokeAtMs,
  ): void {
    console.log(`voice call ${call.conversationId} countdown lap ${String(lap)}: ${phase}`);
    void append({
      type: "events.iterate.com/voice-agent/idle-countdown",
      idempotencyKey: this.idempotencyKey(
        `countdown:${call.conversationId}:${String(lap)}:${phase}`,
      ),
      payload: { conversationId: call.conversationId, phase, lap, idleForMs },
    }).catch(() => undefined);
  }

  /**
   * Ask for a call to end, from inside a delivery.
   *
   * Keyed on the conversation, so the countdown and the at-head pass racing
   * each other collapse into ONE request rather than a queue of identical
   * decisions. Within one incarnation they cannot race — a live one reads only
   * its countdown, a revived one only the fold — so the key is for the case
   * across incarnations, where a dying incarnation's request is still in
   * flight as its successor concludes the same thing. That race is real and no
   * unit test here can stage it (a crash drops in-flight closures), which is
   * exactly why {@link IDLE_END_REASON} is a constant: same key, same body,
   * collapse rather than the rejection a differing body would earn.
   *
   * Registered as background work so the append rides the keepalive; if it
   * drops, the next at-head pass asks again — the same recovery the request
   * itself provides for the obituary.
   */
  #requestEnd(
    conversationId: string,
    reason: string,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentFacetContract>["runInBackground"],
  ): void {
    console.log(`voice call ${conversationId} end requested: ${reason}`);
    runInBackground(async () => {
      await append({
        type: "events.iterate.com/voice-agent/conversation-end-requested",
        idempotencyKey: this.idempotencyKey(`end-requested:${conversationId}`),
        payload: { conversationId, reason },
      });
    });
  }

  /**
   * Somebody decided; do it. Close the provider socket if this incarnation is
   * the one holding it, and write the obituary either way.
   *
   * EITHER WAY is the load-bearing half. A revived incarnation holds no
   * socket, and if it declined to write the obituary on that account the fold
   * would name an open call forever and every later pass would ask for the
   * same ending again. The idempotency key makes the retry free and the
   * duplicate impossible.
   */
  #endAsRequested(
    conversationId: string,
    reason: string,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
  ): void {
    /* Only if it is THIS call: an in-flight `call-started` can mean the socket
     * in hand is a successor the fold has not heard about yet. */
    if (this.#call?.conversationId === conversationId) this.#endCall(reason);
    this.#retiredId = conversationId;
    void append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      idempotencyKey: this.idempotencyKey(`ended:${conversationId}`),
      payload: { conversationId, reason },
    }).catch((error: unknown) => {
      /* CAUGHT, for the reason `#endCall` spells out: this is the last thing
       * the facet does before the object is allowed to hibernate. Losing it
       * costs one more pass — the fold still says an end was requested, so the
       * next incarnation to reach head writes it. */
      console.log(`voice call ${conversationId} obituary failed to append: ${String(error)}`);
    });
  }

  /**
   * Retire the live call, and SAY SO on the stream.
   *
   * The obituary used to come only from the socket's close listener, which
   * means a call whose socket never opened produced none at all: the fold went
   * on believing a call was open, and the at-head recovery re-dialled that
   * same dead id on every caught-up delivery, forever. Emitting it here covers
   * both — the listener's own append is guarded on still being the live call,
   * so a close that follows this one cannot duplicate it.
   */
  #endCall(reason: string, append?: ProcessEventArgs<VoiceAgentFacetContract>["append"]): void {
    const call = this.#call;
    if (call === null) return;
    this.#call = null;
    this.#retiredId = call.conversationId;
    console.log(`voice call ${call.conversationId} ended: ${reason}`);
    /* Takes the idle countdown with it — see GrokCall.close. */
    call.close();
    if (append !== undefined) {
      /*
       * CAUGHT, because this is the LAST thing the facet does before going
       * quiet, and an uncaught rejection here is an unhandled rejection inside
       * the Durable Object at the exact moment it is allowed to hibernate —
       * a fire-and-forget append racing the eviction it has just permitted.
       *
       * Losing the obituary is not fatal. The call is already retired in
       * memory and `#retiredId` stops the at-head pass re-dialling it, so the
       * only cost is a fold that still names a dead call until the next press
       * opens a live one. Saying so out loud is the point: silence here would
       * make that state impossible to explain from the log.
       */
      void append({
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { conversationId: call.conversationId, reason },
      }).catch((error: unknown) => {
        console.log(
          `voice call ${call.conversationId} obituary failed to append: ${String(error)}`,
        );
      });
    }
  }
}

/**
 * The whole userspace facet: recovery on (this processor owes a live call it
 * must re-dial after an eviction) and one factory. Everything else — the itx
 * alarm proxy, the stream handle, configure/handleAlarm — is the base.
 */
export class VoiceAgentFacet extends StreamProcessorFacet {
  protected readonly recovery = true;
  protected createProcessor(deps: ProcessorHostDeps) {
    return new VoiceAgentFacetProcessor({
      ...deps,
      now: () => Date.now(),
      /* A plain `setTimeout`, and it is safe to be one BECAUSE of where it is
       * awaited: every wait in this processor happens inside a
       * `runInBackground` closure the keepalive holds, so the object is up to
       * receive it and there is an I/O context to append from. What covers the
       * silence a live object cannot — because it died anyway — is the same
       * deadline folded into reduced state. Nothing here needs to know either. */
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      dialGrok: (baseUrl) => dialGrokSocket(baseUrl),
    });
  }
}
