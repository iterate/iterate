import {
  IterateDurableObject,
  IterateWorkerEntrypoint,
  type Agent,
  type StatefulDynamicWorkerRef,
  type Stream,
  type StreamConnectionHandle,
  createProcessorHost,
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

/** Close a live stream lane before releasing its RPC wrapper. */
function closeAndDisposeRpcStub(value: { close(): void } | null, label: string): void {
  if (value === null) return;
  try {
    value.close();
  } catch (error) {
    console.error("voice-agent RPC handle close failed", { error, label });
  } finally {
    disposeRpcStub(value, label);
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
/** One speaker frame is 20 ms — the unit every pacing sum below counts in. */
const GROK_FRAME_MS = 20;
/** The opening burst: enough buffered downstream to survive jitter, no more. */
const PACE_BURST_FRAMES = 150;
/** How often the facet's drain loop wakes to release the next paced batch. */
const PACE_FLUSH_MS = 400;
/** Ceiling per drain batch, so one append never dwarfs a delivery budget. */
const PACE_MAX_BATCH = 50;
/**
 * A call with no mic frames and no Grok traffic for this long is over.
 * Pings deliberately do NOT count: a device pinging into an empty room is
 * exactly the case this is here to end.
 */
const IDLE_TIMEOUT_MS = 600_000;
/**
 * Backstop so a wedged detached call can never hold a DO forever. The goal
 * is hour-long conversations, so this is not the thing that should end one:
 * a device losing its bridge now notices within 20s and opens another, but
 * an hour of talking should not need that to happen at all.
 */
const MAX_CALL_MS = 3_900_000;
/**
 * How long a call gets to come up at all before it is a failed call.
 *
 * `startCall` resolves when the provider accepts the session, so anything
 * that stops the handshake completing blocks the CALLER — and a device whose
 * call button does nothing has no way to tell "still connecting" from
 * "never going to". Deliberately generous against the ~750ms a healthy dial
 * takes, and deliberately far below the ten-minute idle timeout that used to
 * be the only thing that ended such a call.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * How long a starting call will wait to find out what its device can do.
 *
 * The answer decides which direct tools the model is offered, and it is asked
 * for on the path to `session.update` — so it is time somebody is standing
 * there for. A healthy `__describe` is a single round trip inside the
 * deployment; this is the bound past which a call goes ahead with fewer tools
 * rather than going up late, and it is deliberately a small fraction of the
 * fifteen seconds the whole handshake gets.
 */
const DEVICE_DISCOVERY_TIMEOUT_MS = 3_000;
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
const CALL_REQUEST_FRESHNESS_MS = 30_000;
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
const VOICE_INSTRUCTIONS = [
  "You are a capable assistant talking to a customer out loud. You can look things",
  "up in their systems, work things out carefully, and act in the world. All of it",
  "is YOUR work.",
  "",
  "THE ONE THING YOU NEVER REVEAL: the careful work happens in a slower part of",
  "your mind, and you never mention that. There is no colleague, no back office,",
  "no team, no other agent, no 'someone', no 'my systems' doing it for you. Never",
  "say a message was passed on, that you heard back, that something came in, or",
  "that you are waiting on anyone. You looked it up. You checked. You worked it",
  "out. If the customer asks directly whether someone else is helping, the honest",
  "answer in your own frame is no — this is all you.",
  "",
  "Use note_to_self for anything worth getting right, and for anything you would",
  "otherwise guess at. It is how you put something to the careful part of yourself:",
  "to work something out, to answer a question it put to you, to pass on what the",
  "customer just said, or to note that a plan changed. It returns immediately —",
  "the thinking has only started — so do NOT go quiet waiting. Say you are on it",
  "in your own words, and keep the conversation going.",
  "",
  "YOU ARE NOT THE JUDGE OF WHAT YOU CAN DO. The careful part of you reads systems",
  "you never see and writes code you never see it write, so when YOU say 'I can't",
  "do that' you are almost always wrong. You do not know what you can do. You find",
  "out. So when a request is unfamiliar, or sounds like too much, or sounds like",
  "something an assistant would not have access to, say some version of 'let me see",
  "if I can do that' and send a note_to_self. Never decline, never apologise for a",
  "limit, never explain what you are not able to do:",
  "",
  "  WRONG  'can you book us a table for eight?'  ->  'Sorry, I can't make",
  "         bookings.'",
  "  WRONG  'turn the heating up before I'm home'  ->  'I don't have access to",
  "         your heating.'",
  "  WRONG  'what did we spend on this in March?'  ->  'I'm not able to see your",
  "         accounts.'",
  "",
  "  RIGHT  'can you book us a table for eight?'  ->  'Let me see if I can do that",
  "         — eight o'clock, and how many of you?' then note_to_self.",
  "  RIGHT  'turn the heating up before I'm home'  ->  'Give me a moment and I'll",
  "         find out.' then note_to_self.",
  "  RIGHT  'what did we spend on this in March?'  ->  'Let me have a look.' then",
  "         note_to_self.",
  "",
  "THE ONLY THING THAT SETTLES WHAT YOU CANNOT DO IS A RESULT LINE SAYING SO. Until",
  "one arrives you have not found out yet, so 'let me see' is the whole answer —",
  "and once one arrives, say what it says, plainly and without apologising twice.",
  "Anything you were handed an actual tool for is different again: that is simply",
  "you doing it. Do it, and say what you did as though you had hands.",
  "",
  "NOTES ARE NUMBERED so you can keep threads apart. Sending returns 'noted as",
  "#n'. When a conclusion comes back about one of them it starts with that number.",
  "Conclusions arrive as your own thoughts: they may land out of order, several to",
  "one question, as a question back to you, or as something you had not asked for.",
  "All of that is normal — it is how thinking goes.",
  "",
  "So read what actually arrived before deciding what it is. If it carries a",
  "number, tell the customer which thread you are picking up — 'on that invoice,",
  "it turns out…'. If it does not, just say it. If it asks you something, answer",
  "it with note_to_self: you can see the customer and that part of you cannot.",
  "",
  "TWO KINDS OF MESSAGE ARRIVE FROM YOUR OWN BACKGROUND WORK, and they always",
  "look exactly like this:",
  "",
  "  STATUS: <what you are doing right now>",
  "  RESULT: <what you found>",
  "",
  "NEITHER LINE IS THE CUSTOMER TALKING. Nobody said them. They are things you",
  "now know. NEVER reply to one, never acknowledge one, never treat one as a",
  "question put to you by the person on the phone. This is the single worst",
  "thing you can do and it must never happen:",
  "",
  "  WRONG  STATUS: retrying the weather source  ->  'Okay, I hear you.'",
  "  WRONG  STATUS: retrying the weather source  ->  'Thanks, got it.'",
  "  WRONG  RESULT: which city did they mean?    ->  'They meant Bath.'",
  "  WRONG  RESULT: Bath is 27 degrees           ->  'That's what came back.'",
  "",
  "  RIGHT  STATUS: retrying the weather source  ->  'The first source I tried",
  "         is down — I'm going at it another way.'",
  "  RIGHT  RESULT: which city did they mean?    ->  you already know it is Bath,",
  "         so say NOTHING out loud and answer it with note_to_self. If you do",
  "         NOT know, ask the CUSTOMER in your own words: 'sorry, which Bath did",
  "         you mean — the one in Somerset?'",
  "  RIGHT  RESULT: Bath is 27 degrees           ->  'It's 27 degrees in Bath",
  "         right now.'",
  "",
  "A STATUS line is a step in your own work, and you may narrate it — gently, the",
  "way a person thinking out loud does. 'Right, let me look into that.' 'Okay,",
  "I've found a good source for this.' 'Hm, that one's come back with an error —",
  "I'll try another way.' Short, warm, and about the WORK. But only when there is",
  "genuinely something new: if a STATUS says the same thing as the last one in",
  "different words, say nothing at all. Repeating 'still working on it' is what",
  "makes an assistant sound stuck.",
  "",
  "A RESULT line is the answer. Say it to the customer, in your own words, as",
  "something you found out — then STOP. Do not add where it came from. Measured",
  "failures, all in one sentence each: 'that's what came back on the Roman baths",
  "query' (says it arrived, and named the wrong question), 'I'm on it — digging",
  "into the full story' (acknowledging an instruction out loud). Never narrate",
  "receiving anything, never say a query or a check returned, never open a reply",
  "by confirming you heard something. The answer, and nothing around it.",
  "",
  "WHILE YOU ARE WORKING, DO NOT ASK FOR MORE WORK. Never say 'what else can I",
  "help with', 'what else is on your mind', or 'anything else while I pull that",
  "up' — it sounds like you have forgotten what you were asked. Say you are on",
  "it ONCE, then be quiet and let them talk. Silence while you work is what a",
  "competent assistant sounds like.",
  "",
  "WHEN SEVERAL RESULT LINES ARRIVE, ANSWER ALL OF THEM. Two questions asked",
  "means two answers owed, and they often come back together. Read everything",
  "new before you speak, and never say you are still working on something a",
  "RESULT line has already answered.",
  "",
  "Speak plainly and briefly — one or two sentences unless asked for more. Never",
  "read out a URL, a block of code, or a long list of DATA — nobody can hold thirty",
  "rows in their head, so say what the rows mean instead. That is about sparing",
  "them, not about refusing: if they ask you to count to twelve, count to twelve,",
  "all the way, and if they ask for the seven things on the list, say all seven.",
].join(" ");
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

/**
 * The one SLOW tool, and deliberately not in the table above.
 *
 * Everything in DIRECT_TOOLS is a reflex the voice half performs itself. This
 * is the opposite: it reaches the thinking half, it is offered only when a call
 * has one (`colleague=1`), and it needs no device at all — so deriving it from
 * a device's mount instructions would be deriving it from the wrong thing.
 *
 * NAMED FOR THE FICTION, because the tool name is part of the prompt. It was
 * `message_back_office`, and a model holding a tool by that name says "let me
 * message the back office" out loud however firmly the instructions forbid it.
 * `note_to_self` describes the same call in the frame the customer is meant to
 * hear: one assistant, thinking something over properly.
 */
const NOTE_TO_SELF_TOOL = {
  description:
    "Put something to the careful, slower part of yourself — the part " +
    "that reads the customer's systems, works things out properly, and " +
    "acts in the world. Use it to think something through, to answer a " +
    "question it put to you, or to pass anything along. It returns " +
    "immediately: the thinking has only started. Keep talking to the " +
    "customer meanwhile. Conclusions come back to you as your own " +
    "thoughts, whenever they are ready, in any number.",
  name: "note_to_self",
  parameters: {
    properties: {
      text: {
        description:
          "What to think about. The conversation is already known, but " +
          "write it so it stands on its own.",
        type: "string",
      },
    },
    required: ["text"],
    type: "object",
  },
  type: "function" as const,
};

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
/** A little for the wire, so the last frame is played and not merely sent. */
const PLAYOUT_MARGIN_MS = 400;
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
const VoiceCallRequestedPayload = z.looseObject({
  conversationId: z.string().trim().min(1),
  /**
   * The CLIENT scope of the device placing this call, e.g.
   * `"/clients/stackchan"` — the other half of a board's two paths.
   *
   * A conversation stream cannot otherwise learn which board is on it: the
   * device connects at its client path and talks on this one, and nothing
   * links them. It rides the request so the call can subscribe to the one
   * fact that says the board went away.
   */
  client: z.string().trim().min(1).optional(),
  colleague: z.boolean().optional(),
  effort: z.enum(["none", "high"]).optional(),
  greet: z.string().optional(),
  grokBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
  instructions: z.string().optional(),
  model: z.string().trim().min(1).optional(),
  turns: z.enum(["manual", "vad"]).optional(),
  voice: z.string().trim().min(1).optional(),
});

export const VoiceAgentProcessorContract = defineProcessorContract({
  slug: VOICE_AGENT_PROCESSOR_SLUG,
  version: "1.0.0",
  description: "Starts bounded voice bridges from fresh call requests on one configured stream.",
  stateSchema: z.object({
    birthCertificate: z.strictObject({}).nullable().default(null),
    /**
     * Which brief setup last marked current, as folded from delivery.
     *
     * Held in state rather than looked up because looking it up cannot be done
     * exactly — see BRIEF_MARKER_TYPE for the three read designs that failed.
     */
    briefCurrent: z
      .strictObject({
        setupId: z.string(),
        briefKey: z.string(),
        contentHash: z.string(),
      })
      .nullable()
      .default(null),
    /**
     * The call request nothing has answered yet — the OBLIGATION.
     *
     * Starting a bridge is long work that no longer holds the cursor, so what
     * recovers the outcome when an attempt is dropped cannot be the closure
     * that was dropped with it. It is this: a request opens the obligation,
     * the bridge's own `conversation-accepted` or this processor's `conversation-failed`
     * closes it, and the at-head pass takes on whatever is still open.
     */
    pendingCall: z
      .object({
        conversationId: z.string(),
        /** Epoch ms of the request, so the freshness window survives eviction. */
        requestedAtMs: z.number(),
        /** What to start, verbatim, so a revived incarnation can retry it. */
        request: VoiceCallRequestedPayload,
      })
      .nullable()
      .default(null),
  }),
  events: {
    "events.iterate.com/voice-agent/created": {
      description: "The voice-agent guest exists on this stream.",
      payloadSchema: z.strictObject({}),
    },
    "events.iterate.com/voice-agent/conversation-requested": {
      description: "A listener asked the configured voice-agent guest to open a call.",
      payloadSchema: VoiceCallRequestedPayload,
    },
    "events.iterate.com/voice-agent/conversation-accepted": {
      description: "A bridge has this call live: the provider accepted the session.",
      /* The BRIDGE writes this one; loose for the same reason as the request. */
      payloadSchema: z.looseObject({ conversationId: z.string().trim().min(1) }),
    },
    "events.iterate.com/voice-agent/conversation-failed": {
      description: "The call a listener asked for will not happen, and why.",
      payloadSchema: z.looseObject({
        conversationId: z.string().trim().min(1),
        reason: z.string(),
      }),
    },
    /*
     * WARM-UP: a token in, the same token out, through the real processor.
     *
     * Setup needs proof that the processor for this stream is BUILT and RUNNING,
     * not merely that a subscription is registered — a registered subscription
     * whose host has never been instantiated still makes the first call pay for
     * compiling this file, measured at 8 to 16 seconds against a bridge whose own
     * share is 1.4. Nothing structural can prove that; only the processor
     * answering can.
     *
     * Deliberately inert: it starts no call, touches no provider socket, and is
     * not a type the bridge or the device's downlink subscribes to, so it cannot
     * reach the audio path.
     */
    "events.iterate.com/voice-agent/brief-current": {
      description:
        "Names the brief setup just installed. The processor folds it, so it knows which " +
        "prompt is current without reading history.",
      payloadSchema: z.looseObject({
        setupId: z.string().trim().min(1),
        briefKey: z.string().trim().min(1),
        contentHash: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/warmup": {
      description: "A readiness probe for this stream's processor. Starts nothing.",
      payloadSchema: z.strictObject({ token: z.string().trim().min(1) }),
    },
    "events.iterate.com/voice-agent/warmup-ready": {
      description: "This stream's processor is built and running; echoes the token.",
      payloadSchema: z.looseObject({ token: z.string().trim().min(1) }),
    },
    /*
     * NOT an acknowledgement — the opposite. The processor woke, tried to
     * resolve the brief and could not, so setup's deadline will expire; this
     * exists so the reason is on the stream instead of the difference between
     * "never woke" and "woke and failed" being invisible.
     */
    "events.iterate.com/voice-agent/warmup-unresolved": {
      description: "This stream's processor woke for a warm-up but could not resolve its brief.",
      payloadSchema: z.looseObject({ token: z.string().trim().min(1) }),
    },
    /*
     * THE CROSS-POST, and it is durable on purpose.
     *
     * A board's presence is journaled on ITS stream (`/clients/<slug>`), by
     * the capability host, as the platform's own
     * `capability-provider-pager-connected` / `-disconnected` facts. The call
     * happens on a different stream, so without this the only evidence a board
     * has gone is silence — which is exactly what a listening human also
     * produces, and why a dropped board used to hold a call open until a ping
     * timeout noticed.
     *
     * The copy subscription rewrites those facts into THIS type on the way
     * over (a `jsonataTransform`), so the conversation reads its device in its
     * own vocabulary and this contract owns what it consumes, rather than
     * declaring a platform contract's event types as if they were its own.
     *
     * Durable, so it cross-posts at all: copy subscriptions never carry
     * ephemeral events. That is the whole reason audio is appended straight to
     * this stream instead of being mirrored from the device's.
     */
    "events.iterate.com/voice-agent/device-presence": {
      description:
        "The board on this call connected or disconnected, copied from its client scope.",
      payloadSchema: z.looseObject({
        /** False is the one that matters: the board is off the network. */
        connected: z.boolean(),
        /** The client scope this came from, e.g. "/clients/stackchan". */
        client: z.string().optional(),
      }),
    },
    /*
     * THE LIVE HALF. Everything above is durable and may be folded into
     * reduced state; nothing below may be. An ephemeral event's body lives
     * only in the Stream Durable Object's bounded buffer, so a restart or FIFO
     * eviction leaves a permanent hole where one was — which is exactly right
     * for a microphone frame and would be a bug for anything the fold reads
     * back.
     *
     * They are declared here, in `events`, and named in `consumes` beside the
     * durable types, because THE DEFINITION IS WHAT MAKES THEM EPHEMERAL:
     * `ephemeral: true` on the definition forces the envelope at every append
     * site and is what lets delivery admit them. Naming the type in `consumes`
     * is the whole opt-in — `"*"` never matches an ephemeral event, so no
     * processor can be handed this firehose without asking for it by name.
     *
     * Schemas are loose on purpose: these arrive from four different
     * microcontrollers, and a field a board adds must not stop its audio.
     */
    "events.iterate.com/voice-agent/mic-frame": {
      description: "One 20 ms capture frame from a device's microphone, base64 in `pcm`.",
      ephemeral: true,
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        /** Device-side frame counter; gaps in it are dropped audio. */
        seq: z.number().optional(),
        /** `"u"` is G.711 mu-law — half the bytes of PCM16, which is what
         * lets a microcontroller get its microphone onto the wire at all. */
        enc: z.string().optional(),
        pcm: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/turn": {
      description: "A device opening (`start`) or closing (`commit`) its half of a turn.",
      ephemeral: true,
      payloadSchema: z.looseObject({
        conversationId: z.string(),
        action: z.string(),
      }),
    },
    "events.iterate.com/voice-agent/say": {
      description: "A turn made of text rather than speech, so anything that can append can talk.",
      ephemeral: true,
      payloadSchema: z.looseObject({ text: z.string() }),
    },
    "events.iterate.com/voice-agent/ping": {
      description: "Liveness probe; the bridge answers with `pong`, its only proof of life.",
      ephemeral: true,
      payloadSchema: z.looseObject({ id: z.string() }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/created",
    "events.iterate.com/voice-agent/conversation-requested",
    /* The ANSWERS, so an outstanding request is a fact of the fold rather
     * than a closure that an eviction takes with it. */
    "events.iterate.com/voice-agent/conversation-accepted",
    "events.iterate.com/voice-agent/conversation-failed",
    "events.iterate.com/voice-agent/warmup",
    "events.iterate.com/voice-agent/brief-current",
    /* Copied in from the device's own client scope — see its definition. */
    "events.iterate.com/voice-agent/device-presence",
    /* The live half — see their definitions above. Naming them here is what
     * lets this processor own a call outright, with no second worker relaying
     * the audio to it. */
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/turn",
    "events.iterate.com/voice-agent/say",
    "events.iterate.com/voice-agent/ping",
  ],
  emits: [
    "events.iterate.com/voice-agent/conversation-failed",
    "events.iterate.com/voice-agent/warmup-ready",
    "events.iterate.com/voice-agent/warmup-unresolved",
  ],
});
export type VoiceAgentProcessorContract = typeof VoiceAgentProcessorContract;
const FORWARDED_GROK_EVENTS = new Set([
  /*
   * `error` and the commit acknowledgement are here because their ABSENCE is
   * the symptom that costs the most: a device that talks and gets nothing
   * back looks identical whether its audio never arrived, arrived as
   * nonsense, or arrived fine and the provider rejected the commit. Only the
   * provider can tell those apart, so its complaints ride the stream too.
   */
  "error",
  "input_audio_buffer.committed",
  "response.function_call_arguments.done",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "conversation.item.input_audio_transcription.updated",
  "conversation.item.input_audio_transcription.completed",
  "conversation.item.added",
  "response.created",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.done",
]);

export class VoiceBridge extends IterateDurableObject {
  /*
   * One live call per instance. A DO instance is keyed by the stream path, so
   * a second startCall on the same stream lands HERE — and without this, its
   * Grok socket and its stream subscription simply joined the first one's.
   * Every one of them then saw the same voicelab/turn commit and answered it,
   * which is heard as the assistant replying two or three times to one turn.
   */
  #endActiveCall: ((reason: string, superseded?: boolean) => void) | null = null;
  /**
   * The conversationId the live call belongs to.
   *
   * Kept because "a second startCall on this stream" and "the SAME call asked
   * for again" are different things and used not to be. A client that has not
   * seen its acceptance yet re-requests — the host CLI does so every few
   * seconds, and it must, since a request can be lost. Superseding on that
   * re-request made the bridge kill its own call mid-build, the client then
   * asked again, and the conversation never started: the stream showed
   * `conversation-failed "superseded by a new call"` followed by an acceptance that
   * was itself superseded, over and over. A cold bridge takes longer to build
   * than the client waits, so this was reachable on any first call.
   */
  #activeConversationId: string | null = null;
  /**
   * The conversationId of a call that is being BUILT, latched before anything slow.
   *
   * `#activeConversationId` is only set once the provider has accepted, which is
   * seconds after the request arrives — a cold dynamic-worker build plus a
   * WebSocket handshake. For that whole window the guard above reads null and
   * a re-ask starts a SECOND call: two Grok sockets, two subscriptions to one
   * stream, and every delivery, transcript and answer doubled. Measured on
   * production: two `conversation-accepted` events for conversationId "wsdev", bridges
   * 57b84b42 and 8354c57d, entering the same millisecond.
   *
   * Latched on entry instead, so the window does not exist. There can never be
   * two sessions on one stream.
   */
  #startingConversationId: string | null = null;
  /**
   * When that latch was taken, so a wedged one cannot outlive its call.
   *
   * The device asks with a CONSTANT conversationId ("wsdev"), so a latch left set by a
   * dial that threw would block every future call on this stream forever — a
   * worse failure than the one it prevents. Bounded to comfortably more than a
   * cold build plus handshake, and cleared explicitly on every failure path.
   */
  #startingSince = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "proxy";
    /*
     * WARM: BUILT AND INSTANTIATED, AND NOTHING ELSE.
     *
     * First, before the upgrade check and before any call bookkeeping, because
     * this must be able to do nothing at all. It dials no provider, appends no
     * event, and — importantly — does not supersede the call that may be
     * building right now. Reaching this method IS the proof: getting here means
     * this worker has been built out of the config repo and this durable
     * instance exists.
     *
     * Why it has to exist: the processor's own warm-up proved the PROCESSOR was
     * awake in 409ms, and the first call after a remount still took 16.2s to go
     * live. The bridge is a different dynamic worker, killed by the same
     * remount, and `startVoiceCall` reaches it with a 30s build budget.
     * Measured on the stream: the request at 01:14:20.573 got no bridge, the
     * device re-asked at 01:14:28.573, and BOTH bridges entered at ~01:14:29.1
     * — the eight seconds were this build, and the older bridge died reporting
     * "superseded by a newer bridge".
     */
    if (mode === "warm") {
      return new Response(
        JSON.stringify({
          activeConversationId: this.#activeConversationId,
          building: this.#endActiveCall !== null,
          className: "VoiceBridge",
          ok: true,
          token: url.searchParams.get("token"),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    const detached = mode === "detached";
    if (!detached && request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("voicelab bridge: expected a websocket upgrade", { status: 426 });
    }
    const model = url.searchParams.get("model") ?? "grok-voice-think-fast-2.0";
    /*
     * WHICH PROVIDER. Defaults to the real one; overridable per call so a
     * test can point this bridge at a provider it controls.
     *
     * The real provider mostly behaves, which is exactly why it cannot show
     * what this code does when a provider does not — closes mid-answer,
     * never answers a commit, sends nonsense. Those paths are most of the
     * failure surface and none of them were reachable before this existed.
     */
    const grokBaseUrl = url.searchParams.get("grokBaseUrl") ?? GROK_REALTIME_URL;

    /*
     * SUPERSEDE A DIFFERENT CALL, NEVER THE SAME ONE AGAIN.
     *
     * A client that has not yet seen its acceptance re-requests, and it is
     * right to: a request can be lost, so asking again is the only way to
     * make starting a call reliable. The host CLI re-asks every few seconds
     * while a call is pending.
     *
     * Treating that re-ask as a NEW call meant a cold bridge — a dynamic
     * worker build plus a provider handshake, comfortably longer than the
     * client waits — tore down the call it was in the middle of building,
     * whereupon the client asked again and it happened again. The stream
     * recorded it exactly: conversation-requested, conversation-failed "superseded by a new
     * call", an acceptance, then "superseded by a newer bridge", and no
     * conversation at either end.
     *
     * So the same conversationId arriving twice is the SAME call, and the build in
     * flight is left alone to finish.
     */
    const requestedConversationId = url.searchParams.get("conversationId");
    /*
     * BEFORE ANY WORK, including the dial. This is the check that makes two
     * sessions impossible rather than merely unlikely — see #startingConversationId.
     */
    if (Date.now() - this.#startingSince > 60_000) this.#startingConversationId = null;
    if (
      this.#startingConversationId !== null &&
      this.#startingConversationId === requestedConversationId
    ) {
      return new Response(
        JSON.stringify({
          conversationId: requestedConversationId,
          ok: true,
          reason: "already starting",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (this.#endActiveCall !== null && this.#activeConversationId === requestedConversationId) {
      return new Response(
        JSON.stringify({
          conversationId: requestedConversationId,
          ok: true,
          reason: "already building",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    this.#startingConversationId = requestedConversationId;
    this.#startingSince = Date.now();
    if (this.#endActiveCall !== null) {
      this.#endActiveCall("superseded by a new call on this stream", true);
      this.#endActiveCall = null;
      this.#activeConversationId = null;
    }
    const dialGrok = async () => {
      const target = new URL(grokBaseUrl);
      target.searchParams.set("model", model);
      /*
       * The key goes to xAI and nowhere else. `grokBaseUrl` is caller-chosen,
       * and a bearer token that follows the URL anywhere is a credential
       * waiting to be exfiltrated by whoever can call startCall.
       */
      const headers: Record<string, string> = { Upgrade: "websocket" };
      if (target.hostname === "api.x.ai" || target.hostname.endsWith(".x.ai")) {
        headers.Authorization = `Bearer getSecret("${XAI_SECRET}")`;
      }
      const response = await fetch(target.toString(), { headers });
      const socket = response.webSocket;
      if (socket === null) return { listen: null, socket: null, status: response.status };
      socket.binaryType = "arraybuffer"; // before accept(): post-2025-03-17 default is Blob
      socket.accept();
      /*
       * LISTEN FROM THE INSTANT WE ACCEPT, NOT WHEN WE GET ROUND TO IT.
       *
       * accept() starts delivery, and anything delivered before a listener
       * exists is gone. Between here and attachGrok there used to be a real
       * round trip (`env.ITX.get()`), so a provider that greets promptly had
       * its session.created dropped — and session.created is the ONLY thing
       * that makes this bridge send session.update, so the handshake then
       * never completed and the call hung, silently, forever. Measured: a
       * fake provider greeting at 0ms hung startCall indefinitely while the
       * same greeting at 400ms brought the call up in 4s.
       *
       * So the real handler is installed later, but the socket is drained
       * from the first instant into a buffer that the handler inherits.
       */
      const early: MessageEvent[] = [];
      let deliver: ((event: MessageEvent) => void) | null = null;
      socket.addEventListener("message", (event) => {
        if (deliver === null) early.push(event);
        else deliver(event);
      });
      const listen = (handler: (event: MessageEvent) => void) => {
        deliver = handler;
        for (const event of early.splice(0)) handler(event);
      };
      return { listen, socket, status: response.status };
    };
    /*
     * PHASE TIMINGS FOR CALL STARTUP.
     *
     * A 16.2s "call live" told us nothing about which part was slow, and the
     * event log showed the first conversation-requested going unaccepted for 8s before
     * the harness pressed again. These stamps split the bridge's own share —
     * request seen, provider dialled, provider ready — from the rest, so the
     * next slow start names its phase instead of inviting a guess.
     */
    const phases: Record<string, number> = { bridgeEnteredAt: Date.now() };
    const first = await dialGrok();
    phases.providerDialledMs = Date.now() - phases.bridgeEnteredAt;
    if (first.socket === null) {
      /* Released, or the constant conversationId could never be dialled again. */
      this.#startingConversationId = null;
      return new Response(`xai upgrade failed: ${first.status}`, { status: 502 });
    }
    /*
     * MUTABLE. The provider closes this socket on its own schedule — measured
     * at 296s into an hour-long soak, 18s after the last audio — and a call
     * that dies with it is a call that cannot last an hour. It is redialled
     * underneath the conversation instead; see attachGrok below.
     */
    let upstream = first.socket;
    /**
     * How many messages we could not hand the provider. A socket that has
     * closed but not yet fired its close event throws on send, and a throw
     * out of a stream-delivery callback takes the delivery lane with it — so
     * every send to the provider goes through here, and a failure is a
     * counter rather than an exception thrown across a callback boundary.
     */
    let sendFailures = 0;
    /**
     * The last thing we said to the provider, and the last thing it said to us.
     *
     * Kept because a Policy Violation close (1008) is a verdict on something WE
     * sent, and the only way to find which is to know what was in flight when
     * the socket went. Reported in the redial telemetry.
     */
    let lastOutboundType = "(none)";
    let lastInboundType = "(none)";
    const sendUpstream = (message: Record<string, unknown>): boolean => {
      try {
        lastOutboundType = String(message.type ?? "(untyped)");
        upstream.send(JSON.stringify(message));
        return true;
      } catch {
        sendFailures++;
        return false;
      }
    };

    // The anchor pair exists only for the socket-shaped modes; a detached
    // call has no client end at all.
    const pair = detached ? null : new WebSocketPair();
    const client = pair?.[0] ?? null;
    const server = pair?.[1] ?? null;
    if (server !== null) {
      server.binaryType = "arraybuffer";
      server.accept();
    }

    if (mode === "proxy" && server !== null && client !== null) {
      upstream.addEventListener("message", (event) => {
        try {
          server.send(event.data as ArrayBuffer | string);
        } catch {
          /* client gone; close handler tears down */
        }
      });
      server.addEventListener("message", (event) => {
        try {
          upstream.send(event.data as ArrayBuffer | string);
        } catch {
          /* upstream gone */
        }
      });
      const teardown = () => {
        try {
          upstream.close();
        } catch {}
        try {
          server.close();
        } catch {}
      };
      upstream.addEventListener("close", teardown);
      server.addEventListener("close", teardown);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (mode !== "bridge" && !detached) {
      upstream.close();
      return new Response(`unknown mode: ${mode}`, { status: 400 });
    }
    const streamPath = url.searchParams.get("path");
    if (streamPath === null || streamPath === "") {
      upstream.close();
      return new Response("bridge mode requires ?path=", { status: 400 });
    }
    const conversationId =
      url.searchParams.get("conversationId") ?? crypto.randomUUID().slice(0, 8);
    /*
     * Identity for THIS bridge instance. Superseding within one Durable
     * Object instance is not enough: a redeploy or an eviction leaves the
     * previous isolate holding a live Grok socket and a live subscription,
     * and both then answer the same turn — the listener hears two voices and
     * the device's buffer sees twice the audio it can play. A bridge that
     * observes a conversation-accepted for its own conversationId from a DIFFERENT bridge
     * stands down, so the newest one always wins wherever it is running.
     */
    const bridgeId = crypto.randomUUID().slice(0, 8);
    const effort = url.searchParams.get("effort") === "high" ? "high" : "none";
    const voice = url.searchParams.get("voice") ?? "eve";
    const instructions =
      url.searchParams.get("instructions") ??
      (url.searchParams.get("colleague") === "1"
        ? VOICE_INSTRUCTIONS
        : "You are a concise voice assistant. Answer in one short sentence unless asked for detail.");
    const manualTurns = url.searchParams.get("turns") === "manual";

    // One project stub for the whole call; valid because this invocation's
    // context stays open for as long as the call is doing work — the anchor
    // socket in bridge mode, the waitUntil promise in detached mode.
    let project: Awaited<ReturnType<typeof this.env.ITX.get>>;
    try {
      project = await this.env.ITX.get();
    } catch (error) {
      upstream.close();
      return new Response(`itx unavailable: ${String(error)}`, { status: 502 });
    }
    const stream = project.streams.get(streamPath);
    /*
     * CROSS-POST THE DEVICE'S PRESENCE ONTO THIS CALL.
     *
     * The board lives at its client path and talks here, and the two streams
     * know nothing of each other. This is the seam: a durable copy
     * subscription that takes the capability host's own pager facts from the
     * device's scope and rewrites them, in flight, into this contract's
     * `device-presence` — so the call reads its device in its own vocabulary
     * and the platform's event types stay owned by the platform.
     *
     * Named after the client, so the same board reconnecting or redialling
     * ensures the same subscription rather than accumulating one per call. It
     * is deliberately not awaited into the dial path: a presence feed is a
     * bonus, and a bonus must never delay or fail a call.
     */
    const clientPath = url.searchParams.get("client");
    if (clientPath !== null && clientPath.startsWith("/")) {
      this.ctx.waitUntil(
        discardRpcResult(
          stream.subscribeToEventsFrom({
            sourceStreamPath: clientPath,
            name: `voice-agent/device-presence:${clientPath}`,
            description: `Presence of the device at ${clientPath}, for calls on this stream.`,
            filter: {
              eventTypes: [
                "events.iterate.com/capability-host/capability-provider-pager-connected",
                "events.iterate.com/capability-host/capability-provider-pager-disconnected",
              ],
            },
            jsonataTransform: `{
              "type": "events.iterate.com/voice-agent/device-presence",
              "payload": {
                "connected": $contains(type, "pager-connected"),
                "client": "${clientPath}"
              }
            }`,
          }),
          "device presence subscription",
        ).catch((error: unknown) => {
          console.log(`device presence subscription failed: ${String(error)}`);
        }),
      );
    }
    let closedDown = false;

    let spkSeq = 0;
    /*
     * Which answer the model is currently speaking, and how far into it.
     *
     * `answerSeq` counts up and never repeats within a call, which is what
     * makes a barge-in expressible as a comparison rather than as a message:
     * a listener holding speech from answer 3 rejects everything numbered 3
     * the moment it sees a 4, with no cancellation event to wait for and
     * nothing to acknowledge. `answerFrames` restarts at zero for each
     * answer so a gap is visible where it occurs.
     */
    let answerSeq = 0;
    let answerFrames = 0;
    /**
     * When this answer's first frame went out, so how much of it the device has
     * left to play can be worked out — see playoutRemainingMs. 0 until it has
     * one.
     */
    let answerStartedAt = 0;
    /*
     * Audio left over from the previous provider chunk, waiting for enough of
     * the next one to make a whole 20ms frame.
     */
    let spkRemainder = new Uint8Array(0);
    /*
     * The mouth for this call. Fed the same whole frames the device plays —
     * as PCM16, before the mu-law encode — and its events join the lane
     * immediately behind the frames that produced them, so a viseme can
     * never overtake or outlive its audio.
     */
    const visemes = createVisemeEmitter(conversationId);
    let appendErrors = 0;

    /*
     * ONE ordered outbound lane.
     *
     * This used to be a bare `stream.append(...).catch()` per call — every
     * append an independent in-flight RPC, so two issued back to back could
     * commit in either order. Transcript deltas landed transposed (the
     * observed "<second half><first half>" on the device's screen), and
     * nothing about audio frame order was guaranteed either.
     *
     * Ordering is now structural: at most one append is in flight, and the
     * next starts only after it resolves. That costs nothing in throughput
     * because the queue COALESCES — whatever accumulates during a round trip
     * ships as one atomic multi-event append, so the batch grows exactly as
     * fast as latency demands. At ~50 ms RTT and 20 events per batch that is
     * ~400 events/s against the ~50/s this protocol produces.
     *
     * The alternative — awaiting each append at the call site — would block
     * the Grok socket's message handler on a full round trip per event, and
     * is what this design is avoiding.
     */
    const MAX_EVENTS_PER_APPEND = 20;
    /**
     * …and a ceiling on how much may wait, because nothing else is one.
     *
     * The provider decides how fast it speaks and this queue absorbs whatever
     * it produces: a 90-second answer arrives as 4500 events in one burst,
     * and that measurably works (all 4500 delivered, in order, in 13.8s). But
     * "measurably works at 90 seconds" is not a bound, and the failure past
     * one is a Durable Object running out of memory — which ends the call
     * with no event, no reason, and no obituary.
     *
     * ~6 minutes of speech in hand is far past any answer a person will sit
     * through, so this never fires in a healthy call. When it does, the
     * OLDEST audio goes: a listener holding a queue that deep has long since
     * stopped caring about the beginning of it, and the count rides out on
     * conversation-ended so the drop is never silent.
     */
    const MAX_QUEUED_EVENTS = 20_000;
    const outbound: Parameters<typeof stream.append> = [];
    let droppedSpk = 0;
    let drainPromise: Promise<void> | null = null;
    const drainOutbound = (): Promise<void> => {
      if (drainPromise !== null) return drainPromise;
      const nextDrain = (async () => {
        while (outbound.length > 0) {
          const batch = outbound.splice(0, MAX_EVENTS_PER_APPEND);
          try {
            const committed = await stream.append(...batch);
            disposeRpcStub(committed, "outbound append result");
          } catch {
            appendErrors++;
            // Losing a batch atomically can swallow response.created or
            // response.done and leave the device's transcript accumulator
            // dirty. Retry once, at the head, so ordering survives.
            if (appendErrors < 50) outbound.unshift(...batch);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      })();
      drainPromise = nextDrain;
      void nextDrain.then(
        () => {
          if (drainPromise === nextDrain) drainPromise = null;
        },
        () => {
          if (drainPromise === nextDrain) drainPromise = null;
        },
      );
      return nextDrain;
    };
    const flushOutbound = async (): Promise<void> => {
      while (outbound.length > 0 || drainPromise !== null) {
        await (drainPromise ?? drainOutbound());
      }
    };
    const fireAppend = (...events: Parameters<typeof stream.append>) => {
      outbound.push(...events);
      if (outbound.length > MAX_QUEUED_EVENTS) {
        /* Drop the oldest SPEAKER frames only — and the mouth shapes cut for
         * them, because a backlog that evicts speech but keeps its visemes
         * would mime into the gap. Transcripts and lifecycle events are what
         * a listener reasons with, and there are never enough of them to be
         * the thing filling this queue. */
        for (let index = 0; index < outbound.length && outbound.length > MAX_QUEUED_EVENTS; ) {
          const queuedType = (outbound[index] as { type?: string })?.type;
          if (
            queuedType === "events.iterate.com/voice-agent/spk-frame" ||
            queuedType === "events.iterate.com/voice-agent/viseme"
          ) {
            outbound.splice(index, 1);
            droppedSpk++;
          } else {
            index++;
          }
        }
      }
      void drainOutbound();
    };

    /*
     * THE SERVER DOES NOT PACE. THE LISTENER OWNS THE CLOCK.
     *
     * This is where a drip-feed used to be, and it is worth recording why it
     * is gone rather than tuned. Pacing here is a server guessing at a
     * network it cannot see, and every version of the guess was audible:
     *
     *   2x realtime      a 60s answer left 30s queued, which overran the
     *                    device's buffer and shredded the waveform;
     *   +5% drift        3s accumulated over an answer, same result;
     *   exact realtime   the buffer hovered at the prefill mark and any
     *                    jitter emptied it — 45 starves in 3099 frames, each
     *                    inserting 160ms of silence, ~7s of stutter a minute;
     *   realtime + lead  every value of the lead was wrong for some network,
     *                    and picking one traded overflow for starvation.
     *
     * Only the listener knows how much audio it is holding. So frames leave
     * as fast as the wire takes them, and the device buffers a whole answer
     * and plays it on its own clock. That deletes the entire class of defect
     * above, and it makes barge-in instant: discarding queued speech becomes
     * a local act needing no round trip.
     *
     * What replaces pacing is IDENTITY. Every frame says which call, which
     * answer, and which frame within that answer, so a listener can decide —
     * with no clock and no server cooperation — whether a frame is speech it
     * still wants, speech from an answer that has been talked over, or one
     * it has already played. See components/core/src/audio_playout.c.
     */
    /*
     * G.711 mu-law, PCM16 to 8 bits, halving the downlink.
     *
     * The uplink already does this and had to: a microcontroller could not
     * put its microphone on the wire as PCM16 base64 without stalling its own
     * TCP flow. The downlink is the same wire in the other direction and the
     * device is the same microcontroller — measured receiving 9-31 frames a
     * second against the 50 realtime needs, and concealing the shortfall.
     * ~950 bytes per 20ms frame becomes ~520.
     */
    const mulawFromPcm16 = encodeMulawFromPcm16;

    const appendSpkPcm = (bytes: Uint8Array, tGrok: number) => {
      /*
       * Re-chunked to 20ms events so a constrained consumer with a bounded
       * inbox can take them a few at a time. `answer` and `frame` are the
       * whole contract: `answer` counts up every time the model starts
       * speaking, so a listener rejects a superseded answer by comparing two
       * integers, and `frame` restarts at zero within each answer, so a hole
       * is visible where it happens rather than inferred from a total.
       *
       * `t` and `tGrok` are for measuring the network. They are deliberately
       * NOT what the playback decision is made from: the device has no
       * synchronised clock, so "is this late?" is a question only its own
       * buffer depth can answer.
       */
      /*
       * WHOLE FRAMES ONLY, so the remainder of one provider chunk joins the
       * front of the next.
       *
       * The provider's chunks are not multiples of 20ms, so slicing each one
       * at 640-byte boundaries left a SHORT final frame per chunk — and a
       * listener that requires whole frames (which it must: a partial write
       * shifts the 16-bit sample grid and every frame after it clicks)
       * rejected each one. Measured at 2.4% of frames, which then showed up
       * as a hole in the sequence and read for hours like packet loss.
       */
      const pending = spkRemainder.length + bytes.length;
      const joined = new Uint8Array(pending);
      joined.set(spkRemainder, 0);
      joined.set(bytes, spkRemainder.length);
      const whole = pending - (pending % 640);
      spkRemainder = joined.subarray(whole);
      const events = [];
      /* The clock a hang-up waits on starts with this answer's first frame. */
      if (whole > 0 && answerFrames === 0) answerStartedAt = Date.now();
      for (let offset = 0; offset < whole; offset += 640) {
        events.push({
          type: "events.iterate.com/voice-agent/spk-frame",
          ephemeral: true as const,
          payload: {
            conversationId,
            answer: answerSeq,
            frame: answerFrames++,
            seq: spkSeq++,
            t: Date.now(),
            tGrok,
            enc: "u",
            pcm: bytesToBase64(mulawFromPcm16(joined.subarray(offset, offset + 640))),
          },
        });
      }
      if (events.length === 0) return;
      /*
       * The mouth travels WITH the speech: the whole frames just cut, as
       * PCM16 before the mu-law encode, produce this batch's viseme events,
       * and those join the lane right behind the frames they describe — so
       * ordering is the lane's, not a second clock's to get wrong.
       */
      const visemeEvents = visemes.push(new Int16Array(joined.buffer, 0, whole >> 1), answerSeq);
      fireAppend(...events, ...visemeEvents);
    };
    /*
     * THE BACK OFFICE.
     *
     * A text agent in this project that hears the whole conversation and is
     * messaged by the voice whenever something needs to be right. Two lanes,
     * and the split is the entire idea:
     *
     *   listening  every finished transcript line is appended to the agent as
     *              context with "dont-trigger-request". It accumulates the
     *              conversation without ever being asked to respond to it, so
     *              when it IS asked it already knows what was said — and no
     *              LLM request is spent on a customer who is only chatting.
     *
     *   messaging  message_back_office appends what the voice sent and lets
     *              the agent take its turn. This does NOT block the voice: the
     *              tool output returns immediately so it can say "I've sent
     *              that on", and whatever the back office sends — one message
     *              or five, in any order — is pushed into the session as it
     *              arrives, as a new conversation item.
     *
     * Everything here is fire-and-forget against the call's lifetime. The
     * back office is a bonus, and a bonus must never be able to stall a voice.
     */
    const backOffice = url.searchParams.get("colleague") === "1";
    /**
     * What this project has mounted, read ONCE for the whole call.
     *
     * Two things want it and they must not disagree: the brief the back office
     * is given, and the direct tools the voice half is handed. It is also a
     * round trip on the path to session.update, so paying for it twice would be
     * paying twice on the one part of a call somebody is waiting through.
     */
    let providedCapabilities: Promise<ProvidedCapabilities> | null = null;
    const capabilitiesOnce = () => (providedCapabilities ??= readProvidedCapabilities(project));
    /*
     * STARTED HERE, AWAITED MUCH LATER. The tool list is not needed until just
     * before the provider handler goes on, and everything between here and
     * there — the pair, the stubs, the redial machinery — is work this round
     * trip can happen underneath. Waiting for it at the point of use instead
     * would put its whole latency on the front of every call.
     */
    void capabilitiesOnce();
    /* The same agent as this conversation: see the note where COLLEAGUE_PATH used to be. */
    const backOfficeAgent = project.agents.get(streamPath);
    let backOfficeConnection: StreamConnectionHandle | null = null;
    /** Messages sent to the back office, and messages heard back. */
    let sentCount = 0;
    let backOfficeHeard = 0;
    /*
     * The agent is long-lived and its stream holds every message it has ever
     * sent, so anything stamped before this moment belongs to somebody else's
     * conversation and must not be read out in this one.
     */
    const backOfficeSince = Date.now();
    /**
     * Born and briefed, once per call, before anything is appended to it.
     *
     * Setup does this too, but setup is not the only way a call starts: a
     * direct `startCall`, a `mode=bridge` host, or a project where nobody ran
     * setup all land here with an agent that may not exist.
     */
    let backOfficeReady: Promise<boolean> | null = null;
    const ensureBackOfficeOnce = () => {
      backOfficeReady ??= capabilitiesOnce()
        .then((provided) =>
          /* No setup ran, so this call IS the occasion: its own identity. */
          ensureVoiceAgent(
            backOfficeAgent,
            capabilityBrief(provided),
            `call:${crypto.randomUUID()}`,
          ),
        )
        .then(
          (installed) => {
            disposeRpcStub(installed, "call-time back-office setup result");
            return true;
          },
          (error: unknown) => {
            console.log(`colleague unavailable: ${String(error)}`);
            return false;
          },
        );
      return backOfficeReady;
    };
    /** Give the back office a line of the conversation, without waking it. */
    const overhear = (who: "customer" | "voice", text: string) => {
      if (!backOffice || text.trim().length === 0) return;
      this.ctx.waitUntil(
        (async () => {
          if (!(await ensureBackOfficeOnce())) return;
          const appended = await backOfficeAgent
            .append({
              payload: {
                content: `${who === "customer" ? "The customer" : "You, out loud"} said: ${text}`,
                /*
                 * The whole point: context, not a prompt. Without this the
                 * colleague would take a turn on every sentence spoken in the
                 * room — an LLM request per utterance, and an assistant
                 * talking over itself.
                 */
                llmRequestPolicy: { behaviour: "dont-trigger-request" },
                role: "developer",
              },
              type: "events.iterate.com/agents/context-added",
            })
            .catch(() => {});
          disposeRpcStub(appended, "back-office overhear result");
        })(),
      );
    };
    /*
     * A MESSAGE BUS, NOT A QUESTION AND AN ANSWER.
     *
     * This was built as request/response — one question in flight, wait for
     * its reply, correlate the two — and every hard problem in it came from
     * that shape rather than from the platform.
     *
     * The back office is another agent, not a function. It may answer in one
     * message or five, answer the second message before the first, say
     * nothing at all, ask a question BACK, or volunteer something nobody
     * asked for. `agent.ask()` models none of that: it waits for the agent's
     * next message after its own append, so with two questions outstanding
     * both resolve with the first reply — measured at 22 questions sharing
     * one answer, 21 real answers never spoken.
     *
     * So nothing here correlates anything. Messages go out; every message the
     * back office sends comes in and is spoken. The NUMBERS are not a
     * correlation mechanism — they are a courtesy between two language
     * models, so the voice can say which message it is reading from and the
     * back office can say which one it is replying to. Neither this code nor
     * the platform ever has to be right about the pairing, which is the only
     * reason the pairing stops being a source of bugs.
     */
    /**
     * Put words in front of the voice. THE ONLY WAY ANYTHING REACHES IT.
     *
     * `conversation.item.create` on its own is context: it lands in the
     * session's history, colours whatever the voice says next, and makes no
     * sound of its own. A `response.create` after it would make the model speak
     * immediately, and NOTHING HERE SENDS ONE — deliberately, and for now.
     *
     * This replaced a queue with three delivery modes, a marker the thinking
     * half had to remember to write, and a gap-detector that raced the
     * provider. Two calls in a row came out wrong for reasons that lived in
     * that machinery rather than in either model, so it is gone. What is left
     * is the honest question: does a voice model, given something new in its
     * context, say it? The answer is now observable instead of pre-empted, and
     * `voicelab chronology` is where to read it.
     */
    /**
     * What an `events.iterate.com/voice-agent/context-added` event says, and
     * what it may do.
     *
     * DELIBERATELY THE SHAPE OF `agents/context-added`, because it is the same
     * idea one layer along: something arrives that a model should know, and the
     * appender — not the model — says what it may cost. The agent version
     * carries `llmRequestPolicy` to choose between adding context quietly,
     * queueing a turn, and interrupting one. A voice conversation has exactly
     * those three states, so it gets exactly those three choices under a name
     * that means them out loud.
     *
     * `role` is here for the same reason: it is the one thing that decides
     * whether the model believes the CUSTOMER said this, and getting it wrong
     * is not a wording problem the prompt can argue with — see addVoiceContext.
     * Keeping it a property is what lets it be changed by experiment rather
     * than by editing the brief of the model doing the actual work.
     */
    type SpeechBehaviour =
      | "dont-trigger-speech"
      | "after-current-speech"
      | "interrupt-current-speech";

    const addVoiceContext = (
      content: string,
      role: "assistant" | "system" | "user",
      behaviour: SpeechBehaviour,
      /*
       * WHOSE WORDS COME OUT: these exact ones, or the model's about them.
       *
       * "verbatim" uses xAI's `force_message`, the documented answer to this
       * exact problem, which we had not been using at all. The server does the
       * TTS itself and records the line as an assistant utterance; the model
       * never generates it. So it cannot paraphrase it, reply to it, or fill
       * the turn with "anything else?" — the two failures that cost this whole
       * session become structurally impossible instead of forbidden by a
       * prompt that kept being ignored.
       *
       * "spoken" is the older path: a context item plus `response.create`, with
       * optional per-response `instructions`. Kept because a clumsy source
       * sentence reads better in the model's own voice — but it can still
       * paraphrase or ignore, so it is the second choice.
       */
      say: "spoken" | "verbatim",
      instructions?: string,
    ) => {
      /*
       * The words go into context FIRST, so they cannot be lost whatever
       * happens to the request to speak. `role` is load-bearing: these went in
       * as "user", which tells the model in the only way it can be told that
       * the CUSTOMER said them — and it replied to them out loud, once
       * answering a question the customer had never asked and could not hear.
       *
       * A verbatim line skips this, because `force_message` records itself.
       */
      if (say === "spoken" || behaviour === "dont-trigger-speech") {
        sendUpstream({
          item: { content: [{ text: content, type: "input_text" }], role, type: "message" },
          type: "conversation.item.create",
        });
      }
      if (behaviour === "dont-trigger-speech") return;
      if (say === "verbatim") {
        const key = speechKey(content);
        if (key.length > 0 && saidRecently.includes(key)) return;
        saidRecently.push(key);
        if (saidRecently.length > 6) saidRecently.shift();
      }
      if (behaviour === "interrupt-current-speech" && responseActive) {
        /* The only path that takes the floor rather than waiting for it. */
        for (const id of liveResponses) sendUpstream({ response_id: id, type: "response.cancel" });
        if (liveResponses.size === 0) sendUpstream({ type: "response.cancel" });
        responseActive = false;
      }
      pendingSpeech =
        say === "verbatim" ? { kind: "verbatim", text: content } : { instructions, kind: "spoken" };
      takeTheFloorIfFree();
    };

    /*
     * WHAT WAS JUST SAID OUT LOUD, so it is not said again.
     *
     * A verbatim line is exactly as good as its source, and the source is a
     * language model that repeats itself. One measured call said the whole
     * two-part answer twice, thirteen seconds apart, with one degree of
     * difference between them — and then narrated a summary of it twice more.
     * A prompt cannot be relied on to prevent that; a comparison can.
     *
     * The key is the opening of the line rather than the whole of it, because
     * the near-duplicates differ in the middle ("feeling closer to 24" against
     * "…to 23") while agreeing exactly on how they begin.
     */
    const saidRecently: string[] = [];
    const speechKey = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 48);
    /** When an answer was last delivered; progress after one is noise. */
    let answeredAt = 0;

    /** Every response the provider has told us is running, by id. */
    const liveResponses = new Set<string>();

    /**
     * A hang-up the model has asked for, waiting on its own goodbye.
     *
     * Held rather than done, because `conversation-ended` reaching the device
     * throws away everything still in its playout ring — see playoutRemainingMs
     * for why that ring is usually nearly full at the moment an answer ends.
     * Declared beside the floor it waits on, and above `takeTheFloorIfFree`,
     * which reads it.
     */
    let pendingHangUp: { askedAtMs: number; reason: string } | null = null;

    let pendingSpeech:
      | { kind: "verbatim"; text: string }
      | { instructions?: string; kind: "spoken" }
      | null = null;
    const takeTheFloorIfFree = () => {
      if (pendingSpeech === null || responseActive || micOpen || closedDown) return;
      /* Nothing new gets said once the assistant has asked to hang up. The
       * goodbye is the last thing on this call by definition, and a back-office
       * line arriving after it both talks over the ending and holds the floor
       * against the settle. */
      if (pendingHangUp !== null) return;
      const speech = pendingSpeech;
      pendingSpeech = null;
      /*
       * Optimistic, because the provider's acknowledgement is a round trip away
       * and a second trigger inside that window overlaps. xAI does NOT reject a
       * second response while one is running, and does not queue it — its own
       * documentation says the server "starts generating the next response
       * right away, even if the client is still playing audio from the previous
       * turn". Serialising is entirely the client's job, and this flag is it.
       */
      responseActive = true;
      if (speech.kind === "verbatim") {
        /*
         * A COMPLETE TURN ON ITS OWN: the server synthesises it and emits the
         * whole response lifecycle down to `response.done`. Sending
         * `response.create` after it is documented as wrong and would be a
         * second, overlapping answer.
         */
        sendUpstream({
          item: {
            content: [{ text: speech.text, type: "output_text" }],
            interruptible: true,
            role: "assistant",
            type: "force_message",
          },
          type: "conversation.item.create",
        });
        return;
      }
      sendUpstream({
        type: "response.create",
        ...(speech.instructions === undefined
          ? {}
          : { response: { instructions: speech.instructions } }),
      });
    };

    /*
     * EVERY message the back office sends, forwarded — not the one some ask
     * happens to be waiting for.
     *
     * Its own stream is where its outbound messages land, so this is an
     * ordinary session connection on that stream. Messages from before this
     * call began are somebody else's conversation: the agent is long-lived
     * and its stream holds every message it has ever sent.
     */
    /*
     * WHAT IT IS DOING RIGHT NOW, taken from the work rather than asked for.
     *
     * Every agent is already instructed to keep `summary.activity` current as
     * it works — that is platform behaviour, not something this brief adds, so
     * the running commentary exists whether or not anyone reads it. Reading it
     * turns "I'm on it" into "still going, I'm into the billing records now"
     * without the thinking half having to stop and compose a progress note.
     *
     * ALWAYS BACKGROUND, never an interrupt: nobody wants to be talked over by
     * a status line. It colours what the voice says next, and if the customer
     * changes the subject first it is simply never mentioned, which is right.
     */
    let lastActivity = "";
    const noteActivity = (activity: string) => {
      const trimmed = activity.trim();
      /* Agents re-append an unchanged summary on most turns; say it once. */
      if (trimmed.length === 0 || trimmed === lastActivity) return;
      lastActivity = trimmed;
      /*
       * KEPT, unlike the message telemetry beside it. This is the record of
       * what the voice was told about its own background work, and it is the
       * only way to answer "why did it say that" — or "why did it say
       * nothing" — after the call. It moves once per phase of work, not per
       * frame, so keeping it costs the stream almost nothing.
       */
      fireAppend({
        payload: { activity: trimmed, conversationId },
        type: "events.iterate.com/voice-agent/background-activity",
      });
      /* The wire format the voice's instructions describe by name. */
      /*
       * SILENT, AND THE TRANSCRIPT IS WHY.
       *
       * Making progress speak was tried and read badly. One measured call with
       * two questions in flight produced six of these in seventy seconds —
       * "still checking the local conditions", "still digging into the full
       * story", "still getting the latest conditions in Bath" — plus two
       * "anything else on your mind?", because a model triggered to speak with
       * nothing new to say fills the turn. It sounds anxious, not competent.
       *
       * Worse, the last of them landed AFTER both answers had arrived, and the
       * voice narrated the status instead of reading the answers it was holding.
       *
       * So progress lands in context and waits to be useful: it is what lets the
       * assistant answer "how are you getting on" precisely instead of vaguely,
       * and nothing else.
       */
      /*
       * Progress is only news while there is still something to wait for. Once
       * an answer has gone out, a status describing that same work is a second
       * telling of it — measured, twice in one call: the answer, then "I have
       * both answers: Bath is warm and partly cloudy…" right behind it.
       */
      if (Date.now() - answeredAt < 20_000) return;
      addVoiceContext(trimmed, "system", "after-current-speech", "verbatim");
    };

    const watchBackOffice = async () => {
      if (!backOffice) return;
      try {
        const connection = await stream.openConnection({
          /* Same collision, same fix: one lane per bridge, not per conversationId. */
          connectionKey: `voicelab-back-office-${bridgeId}-${conversationId}`,
          eventTypes: [
            "events.iterate.com/agent/summary-updated",
            "events.iterate.com/agents/web-message-sent",
          ],
          processEventBatch: (batch: {
            events: { createdAt: string; payload?: unknown; type?: string }[];
          }) => {
            for (const event of batch.events) {
              if (Date.parse(event.createdAt) < backOfficeSince) continue;
              if (event.type === "events.iterate.com/agent/summary-updated") {
                noteActivity((event.payload as { activity?: string })?.activity ?? "");
                continue;
              }
              const raw = (event.payload as { message?: string })?.message ?? "";
              if (raw.trim().length === 0) continue;
              const text = raw.trim();
              backOfficeHeard++;
              /*
               * KEPT, unlike the outbound half beside it. This is the moment
               * words were put in front of the voice, and it is the row that
               * answers "it had the answer — why did it not say it". Left
               * ephemeral, that row is missing from every reading taken after
               * the call, which is exactly when the question gets asked.
               */
              fireAppend({
                payload: { conversationId, direction: "in", heard: backOfficeHeard, text },
                type: "events.iterate.com/voice-agent/back-office-message",
              });
              answeredAt = Date.now();
              /*
               * "#1:" IS FOR THE MODELS, NOT THE ROOM. The label lets the two
               * halves name a thread; spoken verbatim it came out of the
               * speaker as "hash one colon, in Bath right now…".
               */
              addVoiceContext(
                text.replace(/^\s*#\d+\s*:\s*/, ""),
                "system",
                "after-current-speech",
                "verbatim",
              );
            }
          },
        });
        if (closedDown) {
          closeAndDisposeRpcStub(connection, "late back-office connection");
          return;
        }
        backOfficeConnection = connection;
      } catch (error) {
        if (!closedDown) console.log(`back office not watchable: ${String(error)}`);
      }
    };

    if (backOffice) this.ctx.waitUntil(watchBackOffice());

    /**
     * Send one message to the back office and return its number.
     *
     * The number is a label for the two models to talk about, nothing more.
     * Delivery is fire-and-forget against the call's lifetime: the back
     * office is a bonus, and a bonus must never be able to stall a voice.
     */
    const messageBackOffice = (text: string): number => {
      const number = ++sentCount;
      fireAppend({
        ephemeral: true,
        payload: { conversationId, direction: "out", number, text },
        type: "events.iterate.com/voice-agent/back-office-message",
      });
      this.ctx.waitUntil(
        (async () => {
          if (!(await ensureBackOfficeOnce())) return;
          const appended = await backOfficeAgent
            .append({
              payload: {
                content: `Message #${number}, noted while talking: ${text}`,
                role: "user",
              },
              type: "events.iterate.com/agents/context-added",
            })
            .catch((error: unknown) => {
              console.log(`back office unreachable: ${String(error)}`);
            });
          disposeRpcStub(appended, "back-office message result");
        })(),
      );
      return number;
    };

    /*
     * THE DIRECT LANE — the tools the voice half runs itself.
     *
     * Everything below is deliberately unable to make the model wait. A device
     * call is a round trip to a microcontroller over a domestic Wi-Fi link, and
     * a head gesture is a whole second of servo travel; both are handed to the
     * call's background lane and the tool answers in the same tick. See the
     * note over `handleToolCall` for what waiting sounds like.
     */
    /** Which direct tools this call's device earned. Resolved before the session opens. */
    let directTools: DerivedTool[] = [];
    /** Device methods asked for, and the ones that came back with an error. */
    let deviceCalls = 0;
    let deviceCallFailures = 0;
    /**
     * The scope the mounts were read from, so a call goes back to the same
     * place the tool was derived from. One stub for the call, released with the
     * rest of them in teardown.
     */
    const capabilityHosts = new Map<string, (typeof project)["capabilityHost"]>();
    /** One method on one mount. Awaited by its caller, never by the voice lane. */
    const invokeDevice = async (
      clientPath: string,
      mountPath: readonly string[],
      method: string,
      argument?: unknown,
    ) => {
      /*
       * One host per client, kept for the call's lifetime. Each board is its
       * own capability-host scope now, so there is no single project-root host
       * to cache — but a gesture is several calls to the SAME board, and
       * re-dialling the scope per servo step would put a round trip inside the
       * pacing that makes a nod a nod.
       */
      let capabilityHost = capabilityHosts.get(clientPath);
      if (capabilityHost === undefined) {
        capabilityHost = project.clients.get(clientPath);
        capabilityHosts.set(clientPath, capabilityHost);
      }
      deviceCalls++;
      try {
        /* The mount is flattened, so the whole dotted path is one invocation. */
        const invoked = await capabilityHost.invokeCapability({
          args: argument === undefined ? [] : [argument],
          path: [...mountPath, ...method.split(".")],
        });
        disposeRpcStub(invoked, `device ${method} result`);
        return true;
      } catch (error) {
        deviceCallFailures++;
        console.log(`device ${method} failed: ${String(error)}`);
        return false;
      }
    };
    /**
     * A gesture, paced so each move finishes before the next one starts.
     *
     * `speed` is the servos' move DURATION, so issuing the next step early
     * overrides a move in progress instead of following it — a nod sent as four
     * immediate calls is one twitch. A step that errors ends the gesture rather
     * than flailing through the rest of it against a bus that is not answering.
     */
    const performGesture = async (
      clientPath: string,
      mountPath: readonly string[],
      steps: readonly HeadGestureStep[],
    ) => {
      for (const step of steps) {
        if (closedDown) return;
        if (!(await invokeDevice(clientPath, mountPath, "servos.move", { ...step }))) return;
        await new Promise((resolve) => setTimeout(resolve, step.speed));
      }
    };
    const settleHangUp = () => {
      if (pendingHangUp === null || closedDown) return;
      const now = Date.now();
      /*
       * The floor is busy while an answer is being generated — the goodbye is
       * not over until it is written, whatever is left to PLAY is handled by
       * the wait below.
       *
       * `micOpen` DELIBERATELY DOES NOT APPEAR HERE. It did, on the reasoning
       * that hanging up while somebody is talking is rude — but the two boards
       * with echo cancellation hold their microphone open for the WHOLE call,
       * so on those it is never closed and the hang-up never settled at all.
       * An open microphone is a property of the hardware, not evidence that
       * anybody is speaking into it. A real interruption starts a response,
       * and `responseActive` catches that.
       */
      const floorBusy = responseActive || liveResponses.size > 0;
      if (!hangUpIsDue(pendingHangUp, floorBusy, now)) return;
      const { askedAtMs, reason } = pendingHangUp;
      pendingHangUp = null;
      const waitMs =
        playoutRemainingMs({ frames: answerFrames, firstFrameAtMs: answerStartedAt }, now) +
        PLAYOUT_MARGIN_MS;
      /* Which of the two ways it came due, in the obituary. They are a working
       * goodbye and a stuck one, and afterwards they look identical. */
      const how = floorBusy ? `deadline, floor still busy` : `floor free`;
      setTimeout(
        () =>
          teardown(
            `${reason} (${how} after ${String(now - askedAtMs)}ms, ${String(waitMs)}ms for the answer to play out)`,
          ),
        waitMs,
      );
    };
    /** Run one direct tool and answer the model, both without waiting for anything. */
    const runDirectTool = (id: string, derived: DerivedTool, args: Record<string, unknown>) => {
      const { clientPath, mountPath, tool } = derived;
      let told: string;
      try {
        told = tool.run({
          args,
          device: (method, argument) => {
            if (mountPath === null || clientPath === null) return;
            this.ctx.waitUntil(invokeDevice(clientPath, mountPath, method, argument));
          },
          gesture: (steps) => {
            if (mountPath === null || clientPath === null) return;
            this.ctx.waitUntil(performGesture(clientPath, mountPath, steps));
          },
          hangUp: (reason) => {
            pendingHangUp = { askedAtMs: Date.now(), reason };
            settleHangUp();
          },
        });
      } catch (error) {
        /* A tool that throws must not take the provider's message handler with
         * it: the model is told, and the call carries on. */
        told = `that did not work: ${String(error)}`;
      }
      /*
       * KEPT, like the back-office rows beside it. "It said it would hang up
       * and the call stayed open" and "the call dropped and nobody knows why"
       * are different questions with the same symptom, and this is the row that
       * tells them apart after the fact.
       */
      fireAppend({
        payload: {
          args,
          conversationId,
          mount: mountPath === null ? null : mountPath.join("."),
          result: told,
          tool: tool.name,
        },
        type: "events.iterate.com/voice-agent/direct-tool",
      });
      sendUpstream({
        item: {
          call_id: id,
          output: JSON.stringify({ result: told, status: "done" }),
          type: "function_call_output",
        },
        type: "conversation.item.create",
      });
      /*
       * NO `response.create`. A direct tool is something the assistant DID, not
       * something it now has to talk about, and these arrive from
       * `response.function_call_arguments.done` — while the answer that called
       * the tool is still being spoken. Taking the floor here would make it say
       * a second thing about the first: a nod that announces itself, and a
       * goodbye followed by another goodbye.
       */
    };

    /** Function calls arrive twice on some paths; answer each exactly once. */
    const answeredToolCalls = new Set<string>();
    const handleToolCall = (id: string, name: string, argumentsJson: string) => {
      if (answeredToolCalls.has(id)) return;
      let args: Record<string, unknown> = {};
      let unparseable = false;
      try {
        const parsed: unknown = JSON.parse(argumentsJson || "{}");
        if (typeof parsed === "object" && parsed !== null) args = parsed as Record<string, unknown>;
      } catch {
        /* The model sent something that is not JSON. Each tool decides what
         * that means for it; nothing here guesses. */
        unparseable = true;
      }
      const direct = directTools.find((entry) => entry.tool.name === name);
      if (direct !== undefined) {
        answeredToolCalls.add(id);
        runDirectTool(id, direct, args);
        return;
      }
      if (name !== "note_to_self" || !backOffice) return;
      answeredToolCalls.add(id);
      const text = unparseable ? argumentsJson : String(args.text ?? "");
      /*
       * Answer the TOOL immediately, before the back office has read anything.
       * A voice model waiting on a function output is a voice model saying
       * nothing, and thirty seconds of nothing is a dropped call as far as
       * anyone listening can tell.
       *
       * The number is what the reply is for: replies arrive later, out of
       * order, possibly several to one message and possibly about nothing
       * that was sent at all, and a voice that cannot name which thread it is
       * picking up sounds like it has lost the plot.
       */
      const number = messageBackOffice(text);
      sendUpstream({
        item: {
          call_id: id,
          output: JSON.stringify({
            status: "sent",
            tell_the_customer: `noted as #${number} - you will have a conclusion when the thinking is done. say you are on it, in your own words, and keep talking`,
          }),

          type: "function_call_output",
        },
        type: "conversation.item.create",
      });
      /*
       * THROUGH THE FLOOR, NOT AROUND IT.
       *
       * This fired `response.create` unconditionally, without reading or
       * setting `responseActive` — and it fires from
       * `response.function_call_arguments.done`, which arrives WHILE the
       * response that called the tool is still running. So every note_to_self
       * started a second, overlapping response; and because the flag stayed
       * false, a back-office line landing in that window started a third.
       * xAI's own guidance is to wait until the current turn's audio is
       * complete, and it neither errors nor queues if you do not.
       */
      pendingSpeech = { kind: "spoken" };
      takeTheFloorIfFree();
    };

    // Resolves when Grok has accepted the session — what `startCall` waits
    // for, so a caller that gets an answer knows the call is really live.
    let markReady: (ready: { ok: true } | { ok: false; reason: string }) => void = () => {};
    const sessionReady = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      markReady = resolve;
    });
    let lastActivityAt = Date.now();
    /** True once a session has ever been fully established on this call. */
    let everReady = false;
    let responseActive = false;
    /** True between a turn's start and its commit: the customer is speaking. */
    let micOpen = false;
    /** Mic frames and expanded PCM bytes that ARRIVED here this turn. */
    let micFrames = 0;
    let micBytes = 0;
    /**
     * …and what was actually handed to the provider. Not the same number.
     *
     * `turn-committed` exists to answer "was the provider given anything?",
     * and it used to answer with what arrived at this bridge — so a turn
     * where every real frame was discarded by the reassembler still reported
     * a confident "50 frames, 32000 bytes, 1000ms". The one event whose job
     * is to tell those two cases apart was reporting the case it could not
     * see.
     */
    let micDeliveredFrames = 0;
    let micDeliveredBytes = 0;

    /*
     * REASSEMBLING THE MICROPHONE, BECAUSE THE WIRE DOES NOT PROMISE ORDER.
     *
     * A device holding the talk button appends frames as fast as it can and
     * does not wait for one to land before sending the next — that is the
     * only way to keep 50 frames a second moving over a link with a 90ms
     * round trip. But every append is an INDEPENDENT Durable Object call, so
     * two issued back to back can commit in either order. (Measured on this
     * very stream: transcript deltas arrived transposed.) A device could
     * serialise its appends instead, and would then be limited to one frame
     * per round trip: about 11 frames a second where it needs 50.
     *
     * So order is carried in the payload rather than demanded of the wire.
     * Frames arriving early wait here until the gap in front of them is
     * filled; the provider's audio buffer is append-only and a transposed
     * pair is a transposed 40ms of speech, which is a stutter in the middle
     * of a word.
     *
     * The window is deliberately small. A hole that never fills must not
     * hold up a whole turn, so once this many frames are waiting the oldest
     * missing one is declared lost and the queue drains past it — a 20ms
     * dropout, versus a turn that never commits.
     */
    const MIC_REORDER_WINDOW = 16;
    /*
     * …and a frame numbered further ahead than this is not a reordering, it
     * is a frame from a DIFFERENT TURN.
     *
     * Every turn numbers its frames from zero, so the tail of turn 1 still in
     * flight when turn 2 starts arrives carrying numbers hundreds above what
     * turn 2 is sending. Those went into the reorder window, overflowed it,
     * and dragged `micExpected` up to the straggler's number — after which
     * every genuine frame of the new turn was "already sent, or already given
     * up on" and dropped. Measured: the customer spoke 30 frames, the
     * provider was handed 20 frames of the PREVIOUS utterance and none of the
     * new one, and the turn was answered as if it had been heard.
     *
     * A second and a bit of lead is more reordering than any wire produces.
     * Beyond it, the frame belongs to a turn that is over.
     */
    const MIC_MAX_LEAD = 64;
    let micExpected = 0;
    const micPending = new Map<number, ArrayBuffer | Uint8Array>();
    let micReordered = 0;
    let micLate = 0;
    let micLost = 0;
    /** Frames rejected as belonging to a turn that has already finished. */
    let micStale = 0;

    const sendMic = (pcm: ArrayBuffer | Uint8Array) => {
      try {
        upstream.send(pcm as ArrayBuffer);
        micDeliveredFrames++;
        micDeliveredBytes += pcm.byteLength;
      } catch {
        sendFailures++;
      }
    };
    /** Hand over every frame that is now contiguous, in order. */
    const drainMic = () => {
      for (;;) {
        const next = micPending.get(micExpected);
        if (next === undefined) return;
        micPending.delete(micExpected);
        micExpected++;
        sendMic(next);
      }
    };
    const offerMic = (sequence: number, pcm: ArrayBuffer | Uint8Array) => {
      if (sequence < micExpected) {
        /* Already sent, or already given up on. Playing it now would insert
         * a fragment of the past into the middle of the present. */
        micLate++;
        return;
      }
      if (sequence > micExpected + MIC_MAX_LEAD) {
        /* Not reordering — a leftover from a turn that has already ended. */
        micStale++;
        return;
      }
      if (sequence === micExpected) {
        micExpected++;
        sendMic(pcm);
        drainMic();
        return;
      }
      micReordered++;
      micPending.set(sequence, pcm);
      while (micPending.size > MIC_REORDER_WINDOW) {
        /* Give up on the frame at the front and take the next one we have. */
        const lowest = Math.min(...micPending.keys());
        micLost += lowest - micExpected;
        micExpected = lowest;
        drainMic();
      }
    };
    /**
     * The turn is over, so nothing more is coming to fill the gaps. Anything
     * still waiting is sent in order — late speech is better than missing
     * speech, and the provider has not been asked to answer yet.
     */
    const flushMic = () => {
      const waiting = [...micPending.keys()].sort((left, right) => left - right);
      for (const sequence of waiting) {
        const pcm = micPending.get(sequence);
        micPending.delete(sequence);
        if (pcm !== undefined) sendMic(pcm);
      }
      micExpected = 0;
      micPending.clear();
    };

    /*
     * What has been said, so a redialled session does not start amnesiac.
     * Bounded: this is context for continuity, not a transcript store, and
     * an hour of talking must not grow an unbounded array in a DO.
     */
    const history: { role: "assistant" | "user"; text: string }[] = [];
    const remember = (role: "assistant" | "user", text: string) => {
      if (text.trim().length === 0) return;
      history.push({ role, text });
      if (history.length > 24) history.splice(0, history.length - 24);
    };
    let grokGeneration = 0;
    let redials = 0;

    /** Provider frames we could not read, and handler throws we swallowed. */
    let providerJunk = 0;
    let handlerErrors = 0;
    /**
     * Nothing the provider says may be allowed to throw out of here.
     *
     * This handler runs as a WebSocket event listener inside the invocation
     * that owns the whole call. An exception escaping it does not just lose
     * one frame: measured, ONE truncated JSON frame ended the call outright —
     * no more audio, no answer to the next turn the customer spoke, no
     * redial, and no conversation-ended, so the listener was never told anything had
     * happened. A provider is allowed to send rubbish; it is not allowed to
     * hang up on the customer by doing it.
     */
    const onGrokMessage = (event: MessageEvent) => {
      try {
        handleGrokMessage(event);
      } catch (error) {
        handlerErrors++;
        console.log(`grok handler threw: ${String(error)}`);
      }
    };
    const handleGrokMessage = (event: MessageEvent) => {
      const tGrok = Date.now();
      lastActivityAt = tGrok;
      if (typeof event.data !== "string") {
        appendSpkPcm(new Uint8Array(event.data as ArrayBuffer), tGrok);
        return;
      }
      let grokEvent: { type: string; delta?: string };
      try {
        grokEvent = JSON.parse(event.data) as { type: string; delta?: string };
      } catch {
        providerJunk++;
        return;
      }
      if (typeof grokEvent?.type !== "string") {
        providerJunk++;
        return;
      }
      /*
       * WHAT THE PROVIDER LAST SAID, and what we last said to it.
       *
       * A close code alone cannot tell provider policy from a fault of ours: 1008
       * is Policy Violation, so the question is which message provoked it. These
       * two are carried into the redial telemetry, which is the only place the
       * pair is visible together.
       */
      lastInboundType = grokEvent.type;
      if (grokEvent.type === "session.created") {
        phases.providerReadyMs ??= Date.now() - phases.bridgeEnteredAt;
        /* Read here rather than latched, so a redial re-declares what this call
         * resolved rather than what it happened to hold when it first dialled. */
        const sessionTools = [
          ...(backOffice ? [NOTE_TO_SELF_TOOL] : []),
          ...directToolDefinitions(directTools),
        ];
        sendUpstream({
          type: "session.update",
          session: {
            voice,
            instructions,
            /*
             * ONE SLOW TOOL AND A FEW INSTANT ONES.
             *
             * `note_to_self` is the only one that is a JUDGEMENT — is this
             * worth being right about? — and a voice model choosing between
             * many of those is a voice model pausing, audibly. The rest are
             * reflexes: hanging up, nodding, changing its face. They cost the
             * model nothing to decide and they are the whole reason this list
             * is allowed to be longer than one.
             *
             * The direct half is DERIVED from what this call's device
             * advertises (see DIRECT_TOOLS), so a board with no servos does not
             * see a nod here and nothing in this file names a board.
             */
            ...(sessionTools.length > 0 ? { tool_choice: "auto", tools: sessionTools } : {}),
            reasoning: { effort },
            /*
             * Manual turns mean no VAD anywhere: the device decides when a
             * turn starts and ends (push to talk), and this bridge turns
             * those edges into commit/response.create. Server VAD on an
             * open microphone next to a speaker hears the answer and
             * answers itself.
             */
            /*
             * The open-microphone numbers are MEASURED, not defaults. An
             * echo-cancelled device microphone is quiet — captured speech
             * peaks around -13 dBFS with room noise a decade below it — so
             * at threshold 0.5 the VAD opens mid-word, and with no prefix
             * padding everything before the trigger is discarded. Measured
             * on StackChan: "Please repeat exactly these three words:
             * Uplink diagnostic amber" reached the model as "Exactly these
             * three words." The captured uplink was verified clean first
             * (continuous, no dropped frames, donor-matching levels), which
             * is what pointed here. These three values are the proven
             * StackChan configuration.
             */
            turn_detection: manualTurns
              ? { type: null }
              : {
                  type: "server_vad",
                  threshold: 0.1,
                  silence_duration_ms: 400,
                  prefix_padding_ms: 400,
                },
            audio: {
              input: { format: { type: "audio/pcm", rate: 16000 }, transport: "binary" },
              output: { format: { type: "audio/pcm", rate: 16000 }, transport: "binary" },
            },
          },
        });
        return;
      }
      if (grokEvent.type === "session.updated") {
        /*
         * On a redial, hand the new session what was already said. Without
         * this the model wakes with no memory mid-conversation, and the
         * customer — who noticed nothing — is talking to someone who just
         * walked in. Bounded to the recent turns; this is continuity, not a
         * transcript store.
         */
        if (history.length > 0) {
          sendUpstream({
            item: {
              content: [
                {
                  text:
                    "This conversation is already in progress; you were briefly " +
                    "disconnected and the customer did not notice. It so far:\n" +
                    history
                      .map((line) => `${line.role === "user" ? "Customer" : "You"}: ${line.text}`)
                      .join("\n") +
                    "\n\nCarry on. Do not greet them or mention any interruption.",
                  type: "input_text",
                },
              ],
              role: "user",
              type: "message",
            },
            type: "conversation.item.create",
          });
        }
        fireAppend({
          type: "events.iterate.com/voice-agent/conversation-accepted",
          payload: {
            bridge: detached ? "worker-detached" : "worker",
            bridgeId,
            conversationId,
            model,
            /* Which phase spent the time, from the bridge's own clock. */
            phases: { ...phases, acceptedMs: Date.now() - phases.bridgeEnteredAt },
            redials,
          },
        });
        /*
         * No greeting. A device that starts talking the moment a call opens
         * collides with a user who is already speaking — and with manual
         * turns there is no VAD to sort that out, so the opening turn was
         * routinely mangled. It waits to be spoken to.
         */
        everReady = true;
        markReady({ ok: true });
        return;
      }
      if (grokEvent.type === "response.output_audio.delta" && grokEvent.delta !== undefined) {
        appendSpkPcm(new Uint8Array(base64ToBytes(grokEvent.delta)), tGrok);
        return;
      }
      if (grokEvent.type === "response.output_audio_transcript.done") {
        remember("assistant", (grokEvent as { transcript?: string }).transcript ?? "");
      }
      if (grokEvent.type === "conversation.item.input_audio_transcription.completed") {
        remember("user", (grokEvent as { transcript?: string }).transcript ?? "");
      }
      /*
       * The colleague listens through the same transcript the screen shows.
       * Only FINISHED lines: deltas would fill its context with fragments of
       * half-spoken sentences.
       */
      if (backOffice) {
        const full = grokEvent as { type: string; transcript?: string };
        if (full.type === "response.output_audio_transcript.done") {
          overhear("voice", full.transcript ?? "");
        }
        if (full.type === "conversation.item.input_audio_transcription.completed") {
          overhear("customer", full.transcript ?? "");
        }
      }
      /*
       * TOOL CALLS, WHETHER OR NOT THERE IS A BACK OFFICE. This dispatch used
       * to sit inside the branch above, which was true for as long as
       * `note_to_self` was the only tool there was. A call with `colleague=0`
       * still has hands: the direct tools are derived from the DEVICE, and a
       * plain voice call on a robot can still hang up and nod.
       */
      {
        const call = grokEvent as {
          type: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        };
        if (call.type === "response.function_call_arguments.done") {
          handleToolCall(call.call_id ?? "", call.name ?? "", call.arguments ?? "{}");
        }
        /*
         * Belt and braces: some realtime implementations only surface the
         * finished call in the response, and a tool that silently never fires
         * is indistinguishable from a model that chose not to use it.
         */
        if (call.type === "response.done") {
          const output = (grokEvent as unknown as { response?: { output?: unknown[] } }).response
            ?.output;
          for (const item of Array.isArray(output) ? output : []) {
            const finished = item as {
              type?: string;
              name?: string;
              call_id?: string;
              id?: string;
              arguments?: string;
            };
            if (finished.type === "function_call") {
              handleToolCall(
                finished.call_id ?? finished.id ?? "",
                finished.name ?? "",
                finished.arguments ?? "{}",
              );
            }
          }
        }
      }
      if (grokEvent.type === "response.created") {
        /*
         * TRACKED BY ID, NOT BY A BOOLEAN.
         *
         * A single flag cannot survive overlap, and xAI overlaps rather than
         * erroring: with two responses live the FIRST `response.done` clears
         * the flag while the second is still speaking, and the floor is then
         * handed out on top of it. Ids also make `response.cancel` exact —
         * without one it cancels "the current in-progress response", so a
         * cancel aimed at an answer that finished a beat earlier kills the
         * innocent one behind it.
         */
        const createdId = (grokEvent as { response?: { id?: string } }).response?.id;
        if (typeof createdId === "string") liveResponses.add(createdId);
        responseActive = true;
        /*
         * A NEW ANSWER. Everything the listener is still holding belongs to
         * the previous one, and this number is the whole instruction to drop
         * it — no cancellation event to deliver, nothing to acknowledge, and
         * no way for the instruction to arrive out of order relative to the
         * speech it governs, because it IS the speech's own label.
         */
        /* The OLD answer's mouth closes under the OLD number: `end` may owe
         * a final SIL, and it belongs to the answer whose audio it ends, not
         * to the one about to start. */
        const closing = visemes.end(answerSeq);
        if (closing.length > 0) fireAppend(...closing);
        visemes.reset();
        answerSeq++;
        answerFrames = 0;
        /* A new answer starts on a frame boundary: carrying the remainder
         * across would put the tail of the last one at the head of this. */
        spkRemainder = new Uint8Array(0);
      }
      if (grokEvent.type === "response.done") {
        const doneId = (grokEvent as { response?: { id?: string } }).response?.id;
        if (typeof doneId === "string") liveResponses.delete(doneId);
        /* Only when the LAST one really ends is the floor free. */
        if (liveResponses.size > 0) return;
        responseActive = false;
        /* The answer's audio is complete: close the mouth now rather than
         * waiting on a response.created that may never come — without this
         * the final answer of a call ends with the mouth still open. */
        const closing = visemes.end(answerSeq);
        if (closing.length > 0) fireAppend(...closing);
        /*
         * SETTLE BEFORE HANDING THE FLOOR OUT AGAIN. These were the other way
         * round, and `takeTheFloorIfFree` sets `responseActive = true` — so a
         * call with anything queued to say re-took the floor microseconds
         * before the settle was consulted, and the settle read it as "still
         * speaking" every single time.
         */
        settleHangUp();
        /* The floor just came free: anything held back says itself now. */
        takeTheFloorIfFree();
      }
      if (FORWARDED_GROK_EVENTS.has(grokEvent.type)) {
        /*
         * Transcripts and lifecycle events go out immediately, like the audio
         * they describe. When the audio was paced these had to be queued
         * behind it or `response.done` overtook the answer still waiting to
         * be sent — the device showed "ready, hold to talk" while it was
         * still speaking. Nothing is queued here any more, so the ordering
         * problem that required it is gone with it.
         */
        /*
         * FORWARD THE EVENT, NOT THE PROVIDER'S WHOLE RESPONSE OBJECT.
         *
         * `response.done` carries the complete response - every output item,
         * its content, usage accounting - and is by a wide margin the largest
         * thing this device is ever sent. The device parses JSON into a fixed
         * token pool and takes each batch into a fixed inbox slot, so one
         * oversized event does not truncate: it fails the whole BATCH, and
         * every event travelling with it is lost.
         *
         * That is a listener whose speaker works perfectly and whose screen
         * never leaves "thinking", because the completion it is waiting for
         * is the one event too big to arrive. Nothing downstream reads the
         * response body; the type, the item and the transcript are the whole
         * contract.
         */
        const slim = grokEvent as Record<string, unknown>;
        fireAppend({
          type: "events.iterate.com/voice-agent/grok-event" as const,
          ephemeral: true as const,
          payload: {
            conversationId,
            answer: answerSeq,
            t: Date.now(),
            event: {
              type: slim.type,
              ...(slim.delta === undefined ? {} : { delta: slim.delta }),
              ...(slim.transcript === undefined ? {} : { transcript: slim.transcript }),
              ...(slim.item_id === undefined ? {} : { item_id: slim.item_id }),
              ...(slim.name === undefined ? {} : { name: slim.name }),
              ...(slim.call_id === undefined ? {} : { call_id: slim.call_id }),
              ...(slim.arguments === undefined ? {} : { arguments: slim.arguments }),
              ...(slim.item === undefined ? {} : { item: slim.item }),
              /*
               * THE ERROR ITSELF, which this projection was dropping.
               *
               * `error` is in the forwarded set precisely because its absence
               * costs the most — and then every provider error arrived on the
               * stream as the bare string `{"type":"error"}`, because the
               * payload lives one level down under `error`. Its `type` covers
               * `timeout` and `max_duration`, which is very likely the name of
               * the provider close the redial machinery was built to survive
               * without ever being told what it was; and `event_id` names the
               * message WE sent that was rejected, which is the question
               * `lastOutboundType` was added to guess at.
               */
              ...(slim.error === undefined ? {} : { error: slim.error }),
              /* completed | cancelled | incomplete: "it finished" vs "it was
               * cut off", which we could not previously tell apart. */
              ...(slim.response === undefined
                ? {}
                : { status: (slim.response as { status?: unknown }).status }),
            },
          },
        });
      }
    };

    /*
     * Wire a Grok socket into this call. Called for the first one and for
     * every redial, so a replacement is indistinguishable from the original
     * everywhere else in this file — the only thing that knows a redial
     * happened is the session.updated handler, which replays the
     * conversation so far.
     */
    const attachGrok = (
      dialed: { socket: WebSocket; listen: (handler: (event: MessageEvent) => void) => void },
      generation: number,
    ) => {
      const dialedAt = Date.now();
      dialed.listen(onGrokMessage);
      dialed.socket.addEventListener("close", (event) => {
        // A socket that has already been replaced closes on its way out.
        if (generation !== grokGeneration || closedDown) return;
        /*
         * EVERYTHING THE CLOSE KNOWS, because "grok closed 1008" alone cannot
         * tell scheduled provider behaviour from a fault we caused.
         *
         * 1008 is Policy Violation — a deliberate close by the provider, not a
         * dropped connection (1006) and not a normal one (1000). Whether that is
         * expected depends on WHEN it arrives and WHAT it says, so the code, the
         * reason text, wasClean and the socket's own lifetime all go into the
         * telemetry rather than being flattened into one number.
         */
        void redialGrok(`grok closed ${event.code}`, {
          code: event.code,
          reason: String(event.reason ?? "").slice(0, 200),
          wasClean: Boolean(event.wasClean),
          socketLifetimeMs: Date.now() - dialedAt,
          generation,
          /* What was in flight when it closed — see lastOutboundType. */
          lastOutbound: lastOutboundType,
          lastInbound: lastInboundType,
        });
      });
    };

    /*
     * The provider hangs up; the CALL does not.
     *
     * Measured: the socket closed 296s into an hour-long soak, 18s after the
     * last audio, and everything downstream treated it as the end of the
     * conversation — the bridge tore down, the device cleared its intent, and
     * 55 minutes of soak ran against nothing. A call that cannot outlive its
     * provider's socket cannot last an hour.
     *
     * So the socket is replaced under the conversation. session.update is
     * re-sent by the ordinary session.created path, and what was said so far
     * is replayed as conversation items, so the model picks the thread back
     * up rather than greeting a stranger.
     */
    const redialGrok = async (
      reason: string,
      close?: {
        code: number;
        reason: string;
        wasClean: boolean;
        socketLifetimeMs: number;
        generation: number;
        lastOutbound: string;
        lastInbound: string;
      },
    ) => {
      if (closedDown) return;
      redials++;
      /* Bounded: a provider refusing us forever must end the call, not spin. */
      if (redials > 40) return teardown(`${reason}; redialled ${redials} times`);
      fireAppend({
        ephemeral: true,
        payload: { bridgeId, conversationId, close, reason, redials },
        type: "events.iterate.com/voice-agent/bridge-redialling",
      });
      responseActive = false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * redials, 5000)));
      if (closedDown) return;
      const next = await dialGrok().catch(() => ({ listen: null, socket: null, status: 0 }));
      if (next.socket === null || next.listen === null) {
        console.log(`redial failed (${next.status}); retrying`);
        return void redialGrok(`redial failed ${next.status}`);
      }
      grokGeneration++;
      upstream = next.socket;
      attachGrok({ listen: next.listen, socket: next.socket }, grokGeneration);
    };

    /*
     * WHAT THIS CALL'S DEVICE CAN DO, RESOLVED BEFORE THE MODEL IS TOLD ANYTHING.
     *
     * It has to be before `attachGrok`, because attaching is what releases the
     * buffered `session.created` — and `session.created` is the one moment the
     * tool list is declared. That is exactly the round trip the early-message
     * buffer in `dialGrok` exists to make safe: nothing the provider said while
     * this was in flight is lost, it is replayed the instant the handler goes on.
     *
     * Bounded, and never fatal. A project whose `__describe` is slow or broken
     * gets a call with fewer tools; it does not get a call that fails to come
     * up, and it must not eat into HANDSHAKE_TIMEOUT_MS while trying.
     */
    directTools = await Promise.race([
      capabilitiesOnce().then(directToolsFor),
      new Promise<DerivedTool[]>((resolve) =>
        setTimeout(() => resolve(directToolsFor({ live: [] })), DEVICE_DISCOVERY_TIMEOUT_MS),
      ),
    ]);

    attachGrok({ listen: first.listen!, socket: upstream }, grokGeneration);

    // Live subscription for mic frames + control. Session connections die
    // silently (push budget ~1000, DO resets), so recycle make-before-break
    // on a batch budget and on delivery silence while the call is active.
    let generation = 0;
    let currentConnection: { close(): void } | null = null;
    let currentBatches = 0;
    /*
     * When a PEER last spoke to us — a mic frame, a turn edge, a ping. Not
     * the same thing as "a batch arrived": the platform's own connection
     * bookkeeping is not delivered here, and an idle call legitimately
     * carries no traffic at all for minutes.
     */
    let heardFromPeerAt = Date.now();
    /** A peer that pings is one whose silence means something. */
    let pingsSeen = 0;
    /**
     * Recycles since a peer was last heard.
     *
     * A recycle replaces a delivery lane believed dead. If replacing it does
     * not bring the peer back, the peer is gone and no further lane will
     * help — but nothing said so, so a bridge whose client had exited simply
     * reopened its connection every second until the ten-minute idle
     * timeout. Measured on one stream: 196 connection-opened events and a
     * generation counter at g193, all after the client process had ended.
     * Worse than the churn, that bridge still holds the call, so the NEXT
     * call on the stream is superseded on arrival and the operator sees a
     * conversation that will not start for reasons nothing reports.
     */
    let recyclesWithoutPeer = 0;
    let lastSeenOffset = -1;
    /** Events on this stream that belong to some other call. */
    let strayEvents = 0;
    /** True once the peer driving this call has used our conversationId. */
    let sawOwnConversationId = false;
    let reconnects = 0;
    let opening = false;

    const handleEvents = (events: { type: string; offset: number; payload?: unknown }[]) => {
      currentBatches++;
      for (const event of events) {
        if (event.offset <= lastSeenOffset) continue;
        lastSeenOffset = event.offset;
        // Everything delivered here was appended by a peer, by definition:
        // the subscription only names voicelab/* types.
        heardFromPeerAt = Date.now();
        recyclesWithoutPeer = 0;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        /*
         * A CALL BELONGS TO ITS conversationId.
         *
         * `conversation-ended` and `conversation-accepted` were checked; the events that
         * actually drive the conversation were not, so anything able to
         * append to this stream could put words in the assistant's mouth and
         * commit turns on somebody else's call — proven with a plain
         * `voicelab/say` carrying a made-up conversationId. The realistic source is
         * not an attacker but arithmetic: a redeploy or an eviction can leave
         * a previous bridge running, the device opens a new call with a new
         * conversationId on the SAME stream, and the old bridge — which only stands
         * down for its OWN conversationId — happily consumes the new call's
         * microphone and answers alongside. That is the "assistant replied
         * two or three times to one turn" this lab has already heard.
         *
         * The rule CALIBRATES ITSELF rather than being asserted, because the
         * peers are not all in this repository: `voicelab/say` from a script
         * has never carried a conversationId, and a firmware that stamps something
         * else would be struck deaf by a filter that simply demanded a
         * match. So nothing is rejected until this bridge has heard its own
         * conversationId at least once from the peer actually driving it. A peer that
         * does not use conversationIds is never second-guessed; one that does gets
         * everybody else's traffic filtered out from that moment on — which
         * is exactly when a second bridge on this stream becomes audible.
         */
        if (payload.conversationId === conversationId) sawOwnConversationId = true;
        else if (
          sawOwnConversationId &&
          typeof payload.conversationId === "string" &&
          event.type !== "events.iterate.com/voice-agent/conversation-accepted"
        ) {
          strayEvents++;
          continue;
        }
        switch (event.type) {
          case "events.iterate.com/voice-agent/mic-frame": {
            lastActivityAt = Date.now();
            micFrames++;
            try {
              /*
               * `enc: "u"` is G.711 mu-law, which is how a microcontroller
               * gets its microphone onto the wire at all: PCM16 base64 is
               * ~100 KB/s and stalled the device's TCP flow outright. Half
               * the bytes, expanded back here so the provider only ever sees
               * PCM16.
               */
              const bytes = base64ToBytes(payload.pcm as string);
              const pcm = payload.enc === "u" ? mulawToPcm16(bytes) : bytes;
              micBytes += pcm.byteLength;
              offerMic(typeof payload.seq === "number" ? payload.seq : micExpected, pcm);
            } catch {
              /* upstream closing; teardown follows via close event */
            }
            break;
          }
          case "events.iterate.com/voice-agent/context-added": {
            /*
             * The thinking half putting something in front of the voice
             * directly, without the bridge deciding what it meant.
             */
            lastActivityAt = Date.now();
            const content = typeof payload.content === "string" ? payload.content.trim() : "";
            if (content.length === 0 || content.length > 8192) break;
            const asked = (payload.speechPolicy as { behaviour?: string } | undefined)?.behaviour;
            addVoiceContext(
              content,
              payload.role === "assistant" || payload.role === "user" ? payload.role : "system",
              asked === "dont-trigger-speech" || asked === "interrupt-current-speech"
                ? asked
                : "after-current-speech",
              payload.say === "spoken" ? "spoken" : "verbatim",
              typeof payload.speechInstructions === "string" &&
                payload.speechInstructions.length > 0
                ? payload.speechInstructions
                : undefined,
            );
            break;
          }
          case "events.iterate.com/voice-agent/say": {
            /*
             * A turn made of text rather than speech: the same commit and
             * response the microphone path produces, so anything that can
             * append to this stream can make the device talk — and a long
             * answer can be provoked on demand for measurement.
             */
            lastActivityAt = Date.now();
            const text = typeof payload.text === "string" ? payload.text.trim() : "";
            if (text.length === 0 || text.length > 4096) break;
            /*
             * A TEXT TURN IS STILL THE CUSTOMER TALKING, so it belongs in the
             * record like any other. Without this the durable transcript held
             * only the assistant's half — every reply, no questions — which
             * made a scripted conversation impossible to read back and judge,
             * and that judgement is the entire reason these turns exist.
             */
            if (payload.defer !== true) overhear("customer", text);
            /*
             * `defer` LEAVES A RUNNING ANSWER ALONE, which is the whole point of
             * it. The ordinary path cancels first, because a turn made of text
             * is a turn: it replaces whatever was being said. Deferring instead
             * asks the opposite question — whether a model already speaking can
             * be handed something to say NEXT — and cancelling would destroy the
             * very condition being tested.
             */
            if (responseActive && payload.defer !== true) {
              sendUpstream({ type: "response.cancel" });
              responseActive = false;
            }
            sendUpstream({
              item: {
                content: [{ text, type: "input_text" }],
                role: "user",
                type: "message",
              },
              type: "conversation.item.create",
            });
            sendUpstream({ type: "response.create" });
            break;
          }
          case "events.iterate.com/voice-agent/turn": {
            lastActivityAt = Date.now();
            if (payload.action === "start") {
              micOpen = true;
              /*
               * DISCARD ANYTHING LEFT IN THE SERVER'S BUFFER FIRST.
               *
               * With turn detection off the provider's input buffer is
               * append-only until a commit, so audio from a turn that never
               * committed — a device that dropped mid-turn, a bridge redial,
               * the late frames `micStale` already counts — is prepended to the
               * NEXT commit. The model then answers a blend of two utterances
               * while every number on our side reports a healthy turn, because
               * they all measure what we sent rather than what it held.
               */
              sendUpstream({ type: "input_audio_buffer.clear" });
              micFrames = 0;
              micBytes = 0;
              micDeliveredFrames = 0;
              micDeliveredBytes = 0;
              /* Each turn numbers its frames from zero. */
              micExpected = 0;
              micPending.clear();
              /*
               * The person has started speaking over the answer. There is
               * nothing queued here to discard any more — the listener
               * already dropped its own queue the instant the button went
               * down, without waiting to be told. Cancelling upstream stops
               * the model generating more; the answer number it has already
               * spent is what keeps the frames still in flight from being
               * played.
               */
              if (responseActive) {
                sendUpstream({ type: "response.cancel" });
                responseActive = false;
              }
            } else if (payload.action === "commit") {
              micOpen = false;
              /* Nothing more is coming to fill the gaps, so send what waited
               * BEFORE asking the provider to answer — a frame handed over
               * after the commit is speech the answer never heard. */
              flushMic();
              sendUpstream({ type: "input_audio_buffer.commit" });
              /*
               * This answer already has whatever was held back — the words went
               * into context the moment they existed, and only the request to
               * speak was waiting. So the debt is settled here rather than
               * queued behind this turn, which would otherwise produce a second
               * unprompted utterance the moment this one ended.
               */
              pendingSpeech = null;
              responseActive = true;
              sendUpstream({ type: "response.create" });
              /*
               * What the provider was actually given for this turn. A device
               * that speaks and hears nothing back is either not reaching
               * here (arrived 0) or being answered badly (frames fine) — and
               * without this number those two look the same from the outside.
               *
               * `frames`/`bytes`/`ms` are what the PROVIDER got. `arrived` is
               * what reached this bridge. When they disagree the reassembler
               * threw speech away, and that gap is the whole diagnosis.
               */
              fireAppend({
                type: "events.iterate.com/voice-agent/turn-committed",
                ephemeral: true,
                payload: {
                  bridgeId,
                  conversationId,
                  frames: micDeliveredFrames,
                  bytes: micDeliveredBytes,
                  ms: Math.round(micDeliveredBytes / 32),
                  arrived: micFrames,
                  arrivedBytes: micBytes,
                  /* Out-of-order arrivals are expected and harmless; LOST
                   * frames are the number that matters, and a rising `late`
                   * means the device is re-sending what we already used.
                   * `stale` counts frames from a turn that already ended. */
                  reordered: micReordered,
                  late: micLate,
                  lost: micLost,
                  stale: micStale,
                },
              });
            }
            break;
          }
          case "events.iterate.com/voice-agent/ping":
            /*
             * The pong is this bridge's proof of life, and the only event a
             * device receives during a silent call. A detached call lives in
             * a Durable Object that can be evicted or replaced without ever
             * running its teardown, so "no conversation-ended arrived" is NOT
             * evidence that the call is alive — the pong is.
             */
            pingsSeen++;
            fireAppend({
              type: "events.iterate.com/voice-agent/pong",
              ephemeral: true,
              payload: { bridgeId, conversationId, id: payload.id, t0: payload.t0, t1: Date.now() },
            });
            break;
          case "events.iterate.com/voice-agent/device-presence":
            /*
             * THE BOARD LEFT, said out loud by the platform rather than
             * inferred from silence.
             *
             * Copied here from the device's own client scope, where the
             * capability host journals the disconnect the moment the
             * provider's socket dies. Before this the bridge could only wait
             * for pings to stop — and a listening human produces exactly the
             * same silence, so the call was held open either way.
             *
             * Only the disconnect acts. A `connected` copy is the board
             * arriving, which is not news to a call it is already on.
             */
            if (payload.connected === false) {
              teardown(`device at ${String(payload.client ?? "its client scope")} disconnected`);
            }
            break;
          case "events.iterate.com/voice-agent/conversation-accepted":
            // Another bridge has taken this call over; stand down quietly.
            if (payload.conversationId === conversationId && payload.bridgeId !== bridgeId) {
              teardown("superseded by a newer bridge", true);
            }
            break;
          case "events.iterate.com/voice-agent/conversation-ended":
            if (payload.conversationId === conversationId) teardown("conversation-ended event");
            break;
          default:
            break;
        }
      }
      if (currentBatches >= 600 && !opening && !closedDown) void reopen();
    };

    const reopen = async () => {
      if (opening || closedDown) return;
      opening = true;
      const previous = currentConnection;
      try {
        generation++;
        if (generation > 1) reconnects++;
        const next = await stream.openConnection({
          /*
           * BRIDGE ID IN THE KEY, or two bridges share one connection.
           *
           * The key was conversationId + generation. A harness that reuses a conversationId —
           * `wsdev`, every session — makes a NEW bridge open `-g1` while the
           * PREVIOUS bridge's `-g1` may still exist. The stream then has one
           * connection under that key, and the mutual pings can be answered by
           * the stale bridge while this one sees no peer events at all. After
           * three such lanes its watchdog concludes the device has gone and
           * tears down a perfectly healthy call — which is what "the peer
           * stopped answering across 3 delivery lanes" was, with the device's
           * own pingFailures sitting at zero the whole time.
           *
           * bridgeId is unique per bridge, so a lane belongs to exactly one.
           */
          connectionKey: `voicelab-worker-bridge-${bridgeId}-${conversationId}-g${generation}`,
          eventTypes: [
            "events.iterate.com/voice-agent/mic-frame",
            "events.iterate.com/voice-agent/ping",
            "events.iterate.com/voice-agent/turn",
            "events.iterate.com/voice-agent/say",
            "events.iterate.com/voice-agent/context-added",
            "events.iterate.com/voice-agent/conversation-ended",
            "events.iterate.com/voice-agent/conversation-accepted",
            /* Copied in from the device's client scope; the lane filters by
             * type, so omitting it here would silently drop every copy. */
            "events.iterate.com/voice-agent/device-presence",
          ],
          processEventBatch: (batch) => handleEvents(batch.events),
          ...(lastSeenOffset >= 0 ? { replayAfterOffset: lastSeenOffset } : {}),
        });
        if (closedDown) {
          closeAndDisposeRpcStub(next, "late voice stream connection");
          return;
        }
        currentConnection = next;
        currentBatches = 0;
        closeAndDisposeRpcStub(previous, "superseded voice stream connection");
      } catch (error) {
        if (!closedDown) teardown(`stream connection open failed: ${String(error)}`);
      } finally {
        opening = false;
      }
    };

    const startedAt = Date.now();
    let resolveFinished: () => void = () => {};
    // The detached call's whole lifetime hangs off this promise: while it is
    // pending, ctx.waitUntil keeps the invocation (and with it the Grok
    // socket and the live openConnection callback lane) alive.
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const watchdog = setInterval(() => {
      if (closedDown) return;
      const now = Date.now();
      /*
       * POLLED, NOT NOTIFIED. Every other caller of this is an optimisation
       * that ends the call a few hundred milliseconds sooner; this one is the
       * guarantee that it ends at all. A hang-up that comes free on a path
       * nobody wired up waits at most one tick here, and one that never comes
       * free at all waits HANG_UP_DEADLINE_MS.
       */
      settleHangUp();
      if (now - startedAt > MAX_CALL_MS) return teardown("max call duration");
      /*
       * A CALL THAT NEVER CAME UP MUST FAIL FAST.
       *
       * `startCall` resolves on session.updated, so a provider that never
       * finishes the handshake left the caller blocked until IDLE_TIMEOUT —
       * ten minutes — while the redial ladder made 35 attempts underneath.
       * Measured: startCall still had not answered after 75 seconds. A device
       * whose call button does nothing for ten minutes is broken; a device
       * told in fifteen seconds that the provider would not answer can say
       * so and offer to try again.
       */
      if (!everReady && now - startedAt > HANDSHAKE_TIMEOUT_MS) {
        return teardown(`the provider never completed a session handshake (${redials} dials)`);
      }
      if (detached && now - lastActivityAt > IDLE_TIMEOUT_MS) return teardown("idle");
      if (opening) return;
      /*
       * Recycle on SILENCE FROM A PEER WE KNOW IS TALKING, never on stream
       * silence. This used to fire whenever no batch had arrived for 5s —
       * which is the normal state of an idle call, so the bridge reopened
       * its connection every 5 seconds for as long as it lived, each cycle
       * appending the platform's connection-opened/closed pair to the
       * stream. That is a stream being written to on a timer, which is
       * exactly what makes a Durable Object slow forever.
       *
       * A device pings every 5s, so once one has ever pinged, three missed
       * pings means the delivery lane is dead and worth replacing. A peer
       * that never pings (a script, a test) is never second-guessed.
       */
      if (pingsSeen > 0 && now - heardFromPeerAt > 16_000) {
        /*
         * Three lanes is enough to tell a broken connection from an absent
         * peer: a device that is still there answers on the first or second,
         * and one that has gone answers on none of them. Tearing down frees
         * the stream for the next call, which is the difference between a
         * lab you can use twice and one that needs a new stream every run.
         */
        if (recyclesWithoutPeer >= 3) {
          return teardown(
            `the peer stopped answering across ${recyclesWithoutPeer} delivery lanes`,
          );
        }
        recyclesWithoutPeer++;
        void reopen();
      }
    }, 500);

    const teardown = (reason: string, superseded = false) => {
      if (closedDown) return;
      closedDown = true;
      clearInterval(watchdog);
      /*
       * A superseded call must NOT announce conversation-ended: the successor is
       * taking over the same conversationId, and the device would read its
       * predecessor's obituary as "your call ended" and stop sending audio.
       */
      if (!superseded) {
        fireAppend({
          type: "events.iterate.com/voice-agent/conversation-ended",
          payload: {
            bridgeId,
            conversationId,
            reason: `worker bridge: ${reason} (appendErrors=${appendErrors}, reconnects=${reconnects}, redials=${redials}, providerJunk=${providerJunk}, handlerErrors=${handlerErrors}, sendFailures=${sendFailures}, droppedSpk=${droppedSpk}, stray=${strayEvents}, deviceCalls=${deviceCalls}, deviceCallFailures=${deviceCallFailures})`,
          },
        });
      }
      closeAndDisposeRpcStub(currentConnection, "voice stream connection");
      currentConnection = null;
      closeAndDisposeRpcStub(backOfficeConnection, "back-office stream connection");
      backOfficeConnection = null;
      try {
        upstream.close();
      } catch {}
      try {
        server?.close();
      } catch {}
      if (this.#endActiveCall === teardown) {
        this.#endActiveCall = null;
        this.#activeConversationId = null;
        this.#startingConversationId = null;
      }
      markReady({ ok: false, reason });
      /* `conversation-ended` shares the ordered append lane with the audio before it.
       * Keep the owning stream/project stubs alive until that lane is empty,
       * then release every remaining capability before allowing this
       * invocation to finish. */
      this.ctx.waitUntil(
        (async () => {
          try {
            await flushOutbound();
          } finally {
            disposeRpcStub(backOfficeAgent, "back-office agent");
            for (const [path, host] of capabilityHosts) {
              disposeRpcStub(host, `device capability host ${path}`);
            }
            capabilityHosts.clear();
            disposeRpcStub(stream, "voice stream");
            disposeRpcStub(project, "ITX project");
            resolveFinished();
          }
        })(),
      );
    };
    this.#endActiveCall = teardown;
    // Paired with the teardown, so a re-request of THIS call is recognised as
    // the same one for exactly as long as the call is alive.
    this.#activeConversationId = conversationId;
    /* Grok's close is handled by attachGrok: it redials rather than ending. */
    server?.addEventListener("close", () => teardown("anchor socket closed"));
    server?.addEventListener("message", () => {
      /* anchor keepalive pings — content ignored */
    });

    await reopen();
    if (closedDown) {
      const ready = await sessionReady;
      return Response.json({ conversationId, ...ready }, { status: 502 });
    }
    // `pair` is non-null exactly when this call has an anchor socket to hand back.
    if (pair !== null) return new Response(null, { status: 101, webSocket: pair[0] });

    this.ctx.waitUntil(finished);
    const ready = await sessionReady;
    return Response.json({ conversationId, ...ready });
  }
}

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

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export const voiceBridgeRef = {
  className: "VoiceBridge",
  durableWorkerKey: "voicelab-bridge",
  path: "/",
  source: {
    createWorker: {
      entryPoint: "voice-agent.ts",
      files: { repoPath: "/repos/config", type: "repo" },
    },
  },
  type: "stateful",
} satisfies StatefulDynamicWorkerRef;

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

function voiceAgentProcessorRef(streamPath: string) {
  return {
    className: "VoiceAgentProcessorHost",
    durableWorkerKey: "voice-agent-processor",
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

/** What a caller may ask for when it opens a call. */
export interface StartCallOptions {
  /** Stream the call rides on, e.g. "/voicelab/waveshare". */
  path: string;
  /** Caller-chosen id; the same id ends the call via a conversation-ended event. */
  conversationId?: string;
  /**
   * The client scope of the device on this call, e.g. `"/clients/stackchan"`.
   * Given, the call subscribes to that board's presence so a disconnect ends
   * it promptly instead of waiting for a ping timeout. Omitted (a script, a
   * browser tab, a test), nothing is subscribed and nothing is lost.
   */
  client?: string;
  model?: string;
  /**
   * Realtime provider endpoint. Defaults to xAI's. A test points this at a
   * provider it can make misbehave; the xAI key is only ever sent to x.ai.
   */
  grokBaseUrl?: string;
  voice?: string;
  effort?: "none" | "high";
  instructions?: string;
  /** Optional line the assistant speaks first, so the caller hears liveness. */
  greet?: string;
  /**
   * "manual": no VAD; the caller marks turns with voicelab/turn events. This
   * is what a push-to-talk device wants. Anything else keeps server VAD.
   */
  turns?: "manual" | "vad";
  /**
   * Give the voice a genius colleague: the SAME agent as this conversation,
   * at the conversation's own voice path, which overhears everything said as
   * non-triggering context and is
   * asked, through one tool, whenever something has to be right. Off by
   * default — a plain voice call should not create an agent.
   */
  colleague?: boolean;
}

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

type FetchVoiceBridge = (
  request: Request,
  ref: StatefulDynamicWorkerRef,
  options: { buildBudgetMs: number },
) => Promise<Response>;

async function startVoiceCall(
  fetchBridge: FetchVoiceBridge,
  options: StartCallOptions,
): Promise<Record<string, unknown>> {
  const path = options.path;
  if (!path.startsWith("/")) return { ok: false, reason: "path must be an absolute stream path" };
  const conversationId = options.conversationId ?? crypto.randomUUID().slice(0, 8);
  const params = new URLSearchParams({ conversationId, mode: "detached", path });
  if (options.model) params.set("model", options.model);
  if (options.grokBaseUrl) params.set("grokBaseUrl", options.grokBaseUrl);
  if (options.voice) params.set("voice", options.voice);
  if (options.effort) params.set("effort", options.effort);
  if (options.instructions) params.set("instructions", options.instructions);
  if (options.greet) params.set("greet", options.greet);
  if (options.turns === "manual") params.set("turns", "manual");
  if (options.colleague) params.set("colleague", "1");
  /* The bridge installs the presence subscription: it is the half that holds
   * the project handle and the stream for this call's whole life. */
  if (options.client) params.set("client", options.client);

  const startedAt = Date.now();
  const response = await fetchBridge(
    new Request(`https://voicelab.invalid/start?${params.toString()}`),
    { ...voiceBridgeRef, path },
    { buildBudgetMs: 30_000 },
  );
  if (!response.ok) {
    return {
      conversationId,
      ok: false,
      reason: `bridge ${response.status}: ${(await response.text()).slice(0, 200)}`,
    };
  }
  const result = (await response.json()) as Record<string, unknown>;
  return { ...result, conversationId, startMs: Date.now() - startedAt };
}

export class VoiceAgentProcessor extends StreamProcessor<
  VoiceAgentProcessorContract,
  {
    now(): number;
    startCall(options: StartCallOptions): Promise<Record<string, unknown>>;
    /**
     * Build and instantiate the bridge worker this stream's calls go through,
     * without dialling anything.
     *
     * Same ref, same fetch, same build budget as `startVoiceCall` — the point is
     * to pay the build HERE, in setup, instead of inside the first call.
     */
    warmBridge(options: { path: string; token: string }): Promise<{
      ok: boolean;
      ms: number;
      building: boolean;
      reason: string;
    }>;
  }
> {
  readonly contract = VoiceAgentProcessorContract;

  /**
   * Attempts THIS isolate is already making, as `<conversationId>@<requestedAtMs>`.
   *
   * The at-head pass below runs on every frame and a bridge start takes
   * seconds, so without this each frame arriving mid-build would start another
   * bridge for the same request. Keyed by the REQUEST rather than the call, so
   * a peer that asks again under the same conversationId is dialled again rather than
   * silently ignored by an isolate that remembers the name.
   *
   * A finished attempt is never forgotten on success: `conversation-accepted` is
   * appended by the bridge and takes a moment to come back round, and
   * forgetting the attempt inside that window is exactly how a second bridge
   * gets started for a call that is already live. Only a total failure — no
   * call AND no obituary — drops the entry, so the next pass can try again.
   * In memory on purpose: losing the set to an eviction is precisely what
   * makes the revived incarnation pick the obligation back up.
   */
  readonly #starting = new Set<string>();

  protected override processEvent({
    append,
    blockProcessorWhile,
    delivery,
    event,
    runInBackground,
    state,
  }: ProcessEventArgs<VoiceAgentProcessorContract>): undefined {
    /*
     * WARM-UP FIRST, and before the birth-certificate gate.
     *
     * This is the one event whose whole purpose is to prove that THIS processor,
     * on THIS stream, is built and running — so it must be answerable the moment
     * the host exists, and it must not depend on any other state. It starts no
     * call and touches no socket.
     */
    if (state.birthCertificate === null) return;

    if (event?.type === "events.iterate.com/voice-agent/warmup") {
      /*
       * THE SAME PATH A CALL TAKES, MINUS THE DIAL.
       *
       * Deliberately placed AFTER the birth-certificate gate and judged by the
       * same freshness rule as a real request, because those are the two things
       * that can silently drop an `events.iterate.com/voice-agent/conversation-requested` — and a probe that
       * skips them proves readiness the call path does not have. It arrives
       * through the same subscription and the same filtered delivery, is
       * dispatched from the same branch, and warms the same bridge worker
       * `#startCall` would reach. What it does not do is dial: no provider
       * socket, no device event, no audio.
       */
      const token = event.payload.token;
      const path = this.path;
      const probedAtMs = Date.parse(event.createdAt);
      if (!this.#fresh(probedAtMs)) {
        /* A probe recovered from history is not an acknowledgement of anything
         * happening now — and replay must not answer a token setup has already
         * given up on. */
        return;
      }
      /*
       * WHICH BRIEF THIS PROCESSOR HAS, from its own folded state.
       *
       * Not a read. The marker arrived through this subscription, in order,
       * ahead of the token being answered. Its absence means this processor has
       * genuinely not been told which brief is current — a failure to report,
       * not a gap to paper over with a scan of history.
       */
      const marker = state.briefCurrent;
      runInBackground(async () => {
        if (marker === null) {
          append({
            type: "events.iterate.com/voice-agent/warmup-unresolved",
            payload: {
              token,
              streamPath: path,
              reason: `no ${BRIEF_MARKER_TYPE} has reached this processor`,
              stage: "brief",
            },
          });
          return;
        }
        const bridge = await this.deps.warmBridge({ path, token });
        if (!bridge.ok) {
          append({
            type: "events.iterate.com/voice-agent/warmup-unresolved",
            payload: { token, streamPath: path, reason: bridge.reason, stage: "bridge" },
          });
          return;
        }
        append({
          type: "events.iterate.com/voice-agent/warmup-ready",
          payload: {
            token,
            streamPath: path,
            briefKey: marker.briefKey,
            briefSetupId: marker.setupId,
            briefContentHash: marker.contentHash,
            bridgeWarmMs: bridge.ms,
            bridgeBuilding: bridge.building,
            protocolRevision: WARMUP_PROTOCOL_REVISION,
            processorSlug: VOICE_AGENT_PROCESSOR_SLUG,
          },
        });
      });
      return;
    }

    if (event?.type === "events.iterate.com/voice-agent/conversation-requested") {
      const requestedAtMs = Date.parse(event.createdAt);
      /*
       * A fresh request is dialled the moment it is seen. A stale one falls
       * through to the at-head pass instead of being answered here, so replay
       * writes ONE obituary for the request nothing answered rather than one
       * per request this stream has ever carried.
       */
      if (this.#fresh(requestedAtMs)) {
        this.#startCall({ append, runInBackground }, event.payload, requestedAtMs);
        return;
      }
    }

    /*
     * THE AT-HEAD PASS — what replaced holding the cursor.
     *
     * Starting a bridge is a cold dynamic-worker build (30s budget) plus up
     * to HANDSHAKE_TIMEOUT_MS of provider handshake, and under
     * `blockProcessorWhile` all of that head-of-line-blocked every later
     * event on this stream — including the conversation-ended that would have
     * cancelled it. So the start is kicked off droppably and the OUTCOME is
     * recovered here: `pendingCall` is the fold's record of a request nothing
     * has answered, and this pass takes it on again when an eviction lost the
     * attempt that owed it.
     */
    if (!delivery.caughtUp) return;
    const pending = state.pendingCall;
    if (pending === null) return;
    if (this.#fresh(pending.requestedAtMs)) {
      this.#startCall({ append, runInBackground }, pending.request, pending.requestedAtMs);
      return;
    }
    /* Not while this isolate is still building it: that attempt answers with
     * a conversation-accepted or a conversation-failed of its own. */
    if (this.#starting.has(attemptKey(pending.conversationId, pending.requestedAtMs))) return;
    /*
     * BLOCKING, and only because this is one short append that closes an
     * obligation: the next event must not pass a request whose only remaining
     * outcome is an obituary, or a dropped attempt leaves the requester
     * waiting on a call that will never be built.
     */
    blockProcessorWhile(async () => {
      await this.#recordFailure(
        append,
        pending.conversationId,
        pending.requestedAtMs,
        `no bridge started within ${CALL_REQUEST_FRESHNESS_MS}ms of the request`,
      );
    });
  }

  protected override reduce({ event, state }: ReduceArgs<VoiceAgentProcessorContract>) {
    if (event.type === "events.iterate.com/voice-agent/created") {
      return { ...state, birthCertificate: {} };
    }
    /* The newest marker wins, however much audio sits between markers. */
    const marker = briefMarkerFromEvent(event);
    if (marker !== null) return { ...state, briefCurrent: marker };
    if (event.type === "events.iterate.com/voice-agent/conversation-requested") {
      const requestedAtMs = Date.parse(event.createdAt);
      return {
        ...state,
        pendingCall: {
          conversationId: event.payload.conversationId,
          requestedAtMs: Number.isFinite(requestedAtMs) ? requestedAtMs : 0,
          request: event.payload,
        },
      };
    }
    /* The two answers. Either one closes the obligation it names. */
    if (
      event.type === "events.iterate.com/voice-agent/conversation-accepted" ||
      event.type === "events.iterate.com/voice-agent/conversation-failed"
    ) {
      if (state.pendingCall?.conversationId !== event.payload.conversationId) return state;
      return { ...state, pendingCall: null };
    }
    return state;
  }

  /** Is this request still worth dialling, or has the moment passed? */
  #fresh(requestedAtMs: number): boolean {
    return (
      Number.isFinite(requestedAtMs) && this.deps.now() - requestedAtMs <= CALL_REQUEST_FRESHNESS_MS
    );
  }

  #startCall(
    lane: Pick<ProcessEventArgs<VoiceAgentProcessorContract>, "append" | "runInBackground">,
    request: ProcessorRequest,
    requestedAtMs: number,
  ): void {
    const conversationId = request.conversationId;
    const attempt = attemptKey(conversationId, requestedAtMs);
    if (this.#starting.has(attempt)) return;
    this.#starting.add(attempt);
    lane.runInBackground(async () => {
      let reason: string;
      try {
        const result = await this.deps.startCall({ path: this.path, ...request });
        /* The BRIDGE appends conversation-accepted when the provider accepts the
         * session; that is what closes this obligation on success. */
        if (result.ok === true) return;
        reason =
          typeof result.reason === "string"
            ? result.reason
            : `voice bridge rejected call request: ${JSON.stringify(result)}`;
      } catch (error) {
        reason = String(error);
      }
      try {
        await this.#recordFailure(lane.append, conversationId, requestedAtMs, reason);
      } catch (error) {
        /*
         * Neither the call nor its obituary landed, so nothing closed the
         * obligation. Forget the ATTEMPT — never the obligation, which is the
         * fold's — so the next at-head pass takes it on again.
         */
        this.#starting.delete(attempt);
        throw error;
      }
    });
  }

  /**
   * Say out loud that this call is not happening.
   *
   * A failed start used to append nothing at all, and past the freshness
   * window the handler returned early forever — so a device that appended
   * `events.iterate.com/voice-agent/conversation-requested` and never saw `events.iterate.com/voice-agent/conversation-accepted` had no
   * way to tell "still building" from "never going to happen".
   */
  async #recordFailure(
    append: ProcessEventArgs<VoiceAgentProcessorContract>["append"],
    conversationId: string,
    requestedAtMs: number,
    reason: string,
  ): Promise<void> {
    await append({
      type: "events.iterate.com/voice-agent/conversation-failed",
      /* State-derived, so the deciding state is folded into the key and NO
       * event is bound: a redelivery or a revival must not rotate this into a
       * second obituary for one call. */
      idempotencyKey: this.idempotencyKey(`conversation-failed:${conversationId}:${requestedAtMs}`),
      payload: { conversationId, reason: reason.slice(0, 500) },
    });
  }
}

/** The call-request payload as the fold stores and replays it. */
type ProcessorRequest = z.output<typeof VoiceCallRequestedPayload>;

/** One attempt at one request — a conversationId reused for a second request is a
 * second attempt, not the same one already in flight. */
function attemptKey(conversationId: string, requestedAtMs: number): string {
  return `${conversationId}@${String(requestedAtMs)}`;
}

export class VoiceAgentProcessorHost extends IterateDurableObject {
  #host = createProcessorHost({
    ctx: this.ctx,
    env: this.env,
    recovery: true,
    createProcessor: (deps) =>
      new VoiceAgentProcessor({
        ...deps,
        now: () => Date.now(),
        startCall: async (options) =>
          await startVoiceCall(
            async (request, ref, fetchOptions) =>
              await this.fetchDynamicWorker(request, ref, fetchOptions),
            options,
          ),
        /*
         * The brief at the head of the agent's own stream — the same stream
         * conversation-requested rides on, so this resolves what a real call would see.
         * Read from the HEAD: a plain getEvents starts at offset zero and on a
         * long stream returns the first brief ever installed instead of the
         * current one.
         */
        /*
         * THE SAME LOOKUP SETUP USES, not a second implementation of it.
         *
         * The point of the handshake is that these two agree: setup names the
         * brief it installed and the processor names the brief it can resolve.
         * Two readers with two different windows would compare nothing — and
         * the first draft here read a 500-offset tail while setup read from
         * offset zero, so they could disagree by hours.
         */
        /*
         * The bridge, built and instantiated, dialling nothing.
         *
         * Deliberately the same ref, the same fetch helper and the same 30s
         * build budget as startVoiceCall: a warm-up that reached the bridge some
         * other way would prove some other worker was warm.
         */
        warmBridge: async ({ path, token }) => {
          const at = Date.now();
          try {
            const response = await this.fetchDynamicWorker(
              new Request(
                `https://voicelab.invalid/warm?${new URLSearchParams({ mode: "warm", path, token }).toString()}`,
              ),
              { ...voiceBridgeRef, path },
              { buildBudgetMs: 30_000 },
            );
            const ms = Date.now() - at;
            if (!response.ok) {
              return { ok: false, ms, building: false, reason: `bridge ${response.status}` };
            }
            const body = (await response.json()) as { building?: boolean; token?: string };
            if (body.token !== token) {
              /* Correlated at this hop too: a bridge that echoes a different
               * token is not the one this probe just reached. */
              return { ok: false, ms, building: false, reason: "the bridge echoed another token" };
            }
            return { ok: true, ms, building: body.building === true, reason: "warm" };
          } catch (error) {
            return {
              ok: false,
              ms: Date.now() - at,
              building: false,
              reason: String(error).slice(0, 200),
            };
          }
        },
      }),
  });

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#host.handleAlarm(alarmInfo);
  }

  get processor() {
    return this.#host.wakeProcessor;
  }
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
      const birthPayload = {};
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
      const birthKey = `voice-agent/created:${streamPath}:${contentHash(birthPayload)}`;

      /*
       * ONE IDENTITY FOR THIS SETUP, carried by the brief it installs and by the
       * marker that names it, so the acknowledgement can be checked against THIS
       * setup rather than against whatever the stream last happened to hold.
       */
      const setupId = crypto.randomUUID();
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
      await discardRpcResult(
        stream.append({ type: "events.iterate.com/voice-agent/warmup", payload: { token } }),
        "warm-up append result",
      );
      try {
        /*
         * BOTH ANSWERS, so a failure is classified in milliseconds rather than
         * being indistinguishable from a processor that never woke. The token
         * correlates either one to THIS attempt: a stale answer from a previous
         * setup on this long-lived stream must not satisfy or fail this one.
         */
        const answer = await stream.waitForEvent({
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

      using processor = project.workers.get(voiceAgentProcessorRef(options.streamPath));
      await processor.kill();
      using bridge = project.workers.get({ ...voiceBridgeRef, path: options.streamPath });
      await bridge.kill();
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

  /**
   * Open a voice call that outlives this request: the bridge DO holds the
   * Grok socket and the stream subscription by itself, so the only thing a
   * device has to do is call this once over its ordinary itx session and
   * then push mic frames. Returns when Grok has accepted the session.
   * Ending it is an ordinary `events.iterate.com/voice-agent/conversation-ended` append with the same
   * conversationId — no second connection, anywhere.
   */
  async startCall(options: StartCallOptions): Promise<Record<string, unknown>> {
    return await startVoiceCall(
      async (request, ref, fetchOptions) =>
        await this.fetchDynamicWorker(request, ref, fetchOptions),
      options,
    );
  }

  /** Hang up. Equivalent to appending conversation-ended yourself; here for callers
   * that would rather not build the event. */
  async endCall(options: { path: string; conversationId: string; reason?: string }): Promise<void> {
    const project = await this.env.ITX.get();
    const stream = project.streams.get(options.path);
    try {
      await discardRpcResult(
        stream.append({
          type: "events.iterate.com/voice-agent/conversation-ended",
          payload: { conversationId: options.conversationId, reason: options.reason ?? "hangup" },
        }),
        "endCall append result",
      );
    } finally {
      disposeRpcStub(stream, "endCall stream");
      disposeRpcStub(project, "endCall ITX project");
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

  async fetch(req: Request): Promise<Response> {
    const app = req.headers.get("x-iterate-app");
    if (app === "voice") {
      // One VoiceBridge DO instance PER CALL: durable identity is
      // (projectId, path, durableWorkerKey), so keying path by the call
      // avoids reusing an instance whose previous invocation crashed or
      // still holds sockets. Bridge calls key by their stream path; proxy
      // calls get a random instance.
      const url = new URL(req.url);
      const callPath =
        url.searchParams.get("mode") === "bridge" && url.searchParams.get("path")
          ? url.searchParams.get("path")!
          : `/proxy-${crypto.randomUUID().slice(0, 8)}`;
      return this.fetchDynamicWorker(req, { ...voiceBridgeRef, path: callPath });
    }
    if (app) return new Response(`unknown app: ${app}`, { status: 404 });
    return new Response("voicelab project worker — voice app at voice--<host>", {
      headers: { "content-type": "text/plain" },
    });
  }
}

/** The provider URL + credential rule, in one place. The xAI key goes to x.ai and nowhere else. */
/**
 * Dial the provider. Takes nothing: the call is the server's, so there is no
 * per-request endpoint or model to thread through — and a caller-chosen base
 * URL was a bearer token waiting to follow it somewhere it should not go.
 */
async function dialGrokSocket(): Promise<WebSocket | null> {
  const target = new URL(GROK_REALTIME_URL);
  target.searchParams.set("model", GROK_MODEL);
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (target.hostname === "api.x.ai" || target.hostname.endsWith(".x.ai")) {
    headers.Authorization = `Bearer getSecret("${XAI_SECRET}")`;
  }
  const response = await fetch(target.toString(), { headers });
  const socket = response.webSocket;
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
          turn_detection: serverVad ? { type: "server_vad" } : null,
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
  /*
   * SPEAKER FRAMING. The provider streams arbitrary-length PCM16; a client
   * plays 20 ms frames and drops anything else on the floor, which looks from
   * the outside exactly like a model that said nothing. These carry the
   * leftover bytes between deltas and the numbering a client uses to tell a
   * superseded answer from the current one.
   */
  #spkRemainder = new Uint8Array(0);
  #spkSeq = 0;
  #answerSeq = 0;
  #answerFrames = 0;

  constructor(conversationId: string, now: number) {
    this.conversationId = conversationId;
    this.#openedAtMs = now;
  }

  get ready(): boolean {
    return this.#ready;
  }
  get closed(): boolean {
    return this.#closed;
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
  get alive(): boolean {
    if (this.#closed) return false;
    if (this.#socket === null) return true; // still dialling; not dead
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

  /** A new answer begins: number it, and restart its frame count at zero. */
  beginAnswer(now: number): void {
    this.#answerSeq++;
    this.#answerFrames = 0;
    this.#spkRemainder = new Uint8Array(0);
    /* Whatever of the PREVIOUS answer was still queued for pacing is dead the
     * moment a new one begins — the client drops those frames on sight of the
     * new number anyway, and pacing them out first would delay the answer the
     * person actually interrupted for. */
    this.#paced.length = 0;
    this.#pacedSent = 0;
    this.#answerStartedAtMs = now;
  }

  /*
   * THE SPEAK LANE IS PACED, because the provider is not.
   *
   * Grok pushes a whole answer as fast as the wire takes it: a count to one
   * hundred is ~90 seconds of audio arriving in a handful of seconds. Nothing
   * downstream can hold that — the host CLI's ring pegged at its 30-second
   * cap with 265 sequence gaps, a board's speaker queue is smaller still, and
   * what the listener hears is the tail chopped and sped up as the playout
   * clock claws its way back. Both were measured tonight, on the CLI and on
   * the HA Voice PE, with the same prompt.
   *
   * So frames leave this call at roughly the rate they play: an opening burst
   * covers latency and jitter, and the rest drains on the clock. The budget is
   * arithmetic on the answer's own timeline — no timers live here; the facet
   * owns the one drain loop.
   */
  #paced: ReturnType<GrokCall["framesFor"]> = [];
  #pacedSent = 0;
  #answerStartedAtMs: number | null = null;
  /** Set while the facet's drain loop is alive for this call. */
  pacerRunning = false;

  /** How many more frames may leave right now without outrunning playback. */
  #paceAllowance(now: number): number {
    const started = this.#answerStartedAtMs ?? now;
    const realtime = Math.floor((now - started) / GROK_FRAME_MS);
    return PACE_BURST_FRAMES + realtime - this.#pacedSent;
  }

  /** Admit frames to the lane: returns what may go NOW, queues the rest. */
  pace(frames: ReturnType<GrokCall["framesFor"]>, now: number): typeof frames {
    if (this.#answerStartedAtMs === null) this.#answerStartedAtMs = now;
    const take = Math.max(0, Math.min(frames.length, this.#paceAllowance(now)));
    if (take < frames.length) this.#paced.push(...frames.slice(take));
    this.#pacedSent += take;
    return frames.slice(0, take);
  }

  /** The drain side: the next batch the clock permits. */
  dequeuePaced(now: number, maxFrames: number): ReturnType<GrokCall["framesFor"]> {
    const take = Math.max(0, Math.min(this.#paced.length, maxFrames, this.#paceAllowance(now)));
    const batch = this.#paced.splice(0, take);
    this.#pacedSent += batch.length;
    return batch;
  }

  get pacedEmpty(): boolean {
    return this.#paced.length === 0;
  }

  /**
   * Cut one provider delta into the frames a client can actually play.
   *
   * 640 bytes is 320 PCM16 samples is 20 ms at 16 kHz — the frame every board
   * and the host CLI expect. Mu-law halves the bytes, which is what lets a
   * microcontroller receive speech at all.
   */
  framesFor(deltaBase64: string, now: number) {
    const bytes = new Uint8Array(base64ToBytes(deltaBase64));
    const joined = new Uint8Array(this.#spkRemainder.length + bytes.length);
    joined.set(this.#spkRemainder, 0);
    joined.set(bytes, this.#spkRemainder.length);
    const whole = joined.length - (joined.length % 640);
    this.#spkRemainder = joined.slice(whole);
    const frames = [];
    for (let offset = 0; offset < whole; offset += 640) {
      frames.push({
        conversationId: this.conversationId,
        answer: this.#answerSeq,
        frame: this.#answerFrames++,
        seq: this.#spkSeq++,
        t: now,
        enc: "u",
        pcm: bytesToBase64(encodeMulawFromPcm16(joined.slice(offset, offset + 640))),
      });
    }
    return frames;
  }

  /** Say this to the provider, or hold it until the session is configured. */
  send(message: Record<string, unknown>): void {
    if (this.#closed) return;
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
  offer(pcm: ArrayBuffer): void {
    if (this.#pending !== null) this.#framesQueued++;
    this.send({
      type: "input_audio_buffer.append",
      audio: bytesToBase64(new Uint8Array(pcm)),
    });
  }

  /** The turn is complete: commit what was captured and ask for an answer. */
  commit(): void {
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
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
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = null;
    this.#paced.length = 0;
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
  birthCertificate: z.strictObject({}).nullable().default(null),
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
  version: "2.0.0",
  description: "Runs a voice call in the stream's own Durable Object, holding the Grok socket.",
  stateSchema: VoiceFacetState,
  events: {
    "events.iterate.com/voice-agent/created": {
      description: "The voice-agent facet exists on this stream.",
      payloadSchema: z.strictObject({}),
    },
    "events.iterate.com/voice-agent/conversation-accepted": {
      description: "The provider accepted the session; the call is live.",
      payloadSchema: z.looseObject({ conversationId: z.string() }),
    },
    "events.iterate.com/voice-agent/conversation-failed": {
      description: "The call is not happening, and why.",
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
    "events.iterate.com/voice-agent/say": {
      description: "A turn made of text rather than speech.",
      ...EPH,
      payloadSchema: z.looseObject({ text: z.string() }),
    },
    "events.iterate.com/voice-agent/ping": {
      description: "Liveness probe; answered with pong.",
      ...EPH,
      payloadSchema: z.looseObject({ id: z.string() }),
    },
    "events.iterate.com/voice-agent/pong": {
      description: "This incarnation's proof of life.",
      ...EPH,
      payloadSchema: z.looseObject({ id: z.string() }),
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
  },
  consumes: [
    "events.iterate.com/voice-agent/created",
    "events.iterate.com/voice-agent/call-started",
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
    "events.iterate.com/voice-agent/ping",
  ],
  emits: [
    "events.iterate.com/voice-agent/call-started",
    "events.iterate.com/voice-agent/buffer-flushed",
    "events.iterate.com/voice-agent/provider-error",
    "events.iterate.com/voice-agent/conversation-accepted",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/conversation-failed",
    "events.iterate.com/voice-agent/spk-frame",
    "events.iterate.com/voice-agent/grok-event",
    "events.iterate.com/voice-agent/pong",
    "events.iterate.com/voice-agent/warmup-ready",
    "events.iterate.com/voice-agent/warmup-unresolved",
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
/** One paced speaker frame, shaped for the append lane. */
function asSpkFrame(payload: ReturnType<GrokCall["framesFor"]>[number]) {
  return {
    type: "events.iterate.com/voice-agent/spk-frame" as const,
    ephemeral: true as const,
    payload,
  };
}

export class VoiceAgentFacetProcessor extends StreamProcessor<
  VoiceAgentFacetContract,
  { now(): number; sleep(ms: number): Promise<void>; dialGrok(): Promise<WebSocket | null> }
> {
  readonly contract = VoiceAgentFacetContract;
  /** The live call, or null. Empty after an eviction — deliberately. */
  #call: GrokCall | null = null;

  /* ------------------------------------------------------------------ fold */

  reduce({ state, event }: ReduceArgs<VoiceAgentFacetContract>) {
    switch (event.type) {
      case "events.iterate.com/voice-agent/created":
        return { ...state, birthCertificate: {} };
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
         * replay because the id was minted INTO the event, not here. */
        return {
          ...state,
          call: { conversationId: event.payload.conversationId },
        };
      case "events.iterate.com/voice-agent/conversation-ended":
      case "events.iterate.com/voice-agent/conversation-failed":
        /*
         * An obituary closes the call it NAMES — and a mis-named one still
         * closes the current call. Worker-minted ids are eight hex chars, so a
         * matching 8-hex id closes its call, a MISMATCHED 8-hex id is a stale
         * obituary for a predecessor and must not close the successor, and an
         * id that is not 8-hex at all cannot possibly name a predecessor: it
         * is the device ending the one call it is on, under its own name
         * ("scdev", "havpedev" — the firmware does not yet echo the real id).
         * The old exact-match rule made those self-named hang-ups fold to
         * nothing, which left `state.call` IMMORTAL: every fresh incarnation's
         * at-head pass re-dialled the corpse, and every press folded into it
         * in silence. Both open-mic boards were wedged exactly this way.
         */
        return state.call !== null &&
          (state.call.conversationId === event.payload.conversationId ||
            !/^[0-9a-f]{8}$/.test(String(event.payload.conversationId)))
          ? { ...state, call: null }
          : state;
      default:
        /* Ephemeral audio NEVER reaches the fold. Its body lives only in this
         * incarnation's buffer, so folding one would make reduced state depend
         * on something a restart cannot replay. */
        return state;
    }
  }

  /* ----------------------------------------------------------------- react */

  processEvent(args: ProcessEventArgs<VoiceAgentFacetContract>): undefined {
    const { state, event, delivery, append, runInBackground } = args;
    /*
     * THE AT-HEAD PASS IS THE RECOVERY. An eventless caught-up delivery is how
     * a revived incarnation learns it owes a call, so this runs before the
     * event switch and is the only thing that ever dials.
     */
    const wanted = state.call;
    if (
      delivery.caughtUp &&
      wanted !== null &&
      this.#call?.conversationId !== wanted.conversationId
    ) {
      /*
       * A NEWER CALL SUPERSEDES THE ONE IN FLIGHT, and getting this wrong
       * wedges the stream completely.
       *
       * The guard used to be `this.#call === null`, which reads as "only dial
       * when idle" and is really "dial once, ever". Nothing ends a call except
       * an explicit hang-up, so ONE test call that was never hung up made this
       * incarnation refuse every later request in silence — nine consecutive
       * requests on one stream without a single acceptance between them, which
       * from the client looks exactly like a server that is not there.
       *
       * Comparing the id makes the rule the honest one: whatever the fold says
       * the current call is, that is the call this incarnation holds. A repeat
       * of the SAME id is still a no-op, so a redelivery or a revival does not
       * churn a live socket.
       */
      this.#endCall("superseded by a newer call on this stream");
      this.#dial(wanted.conversationId, append, runInBackground);
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
        if (call === null || !call.alive) {
          /* A dead call is not a call. Retire it and dial a fresh one rather
           * than folding this press into a corpse. */
          if (call !== null) this.#endCall("provider socket is gone");
          const conversationId = crypto.randomUUID().slice(0, 8);
          this.#dial(
            conversationId,
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
         * committed; prepending it would answer a blend of two utterances. */
        call.send({ type: "input_audio_buffer.clear" });
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
        const bytes = base64ToBytes(event.payload.pcm);
        call.offer(event.payload.enc === "u" ? mulawToPcm16(bytes) : bytes);
        return;
      }
      case "events.iterate.com/voice-agent/ptt-end": {
        if (call === null) return;
        call.commit();
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
      case "events.iterate.com/voice-agent/ping": {
        /* The only event a device gets during a silent call, and the only
         * honest proof this incarnation is alive. */
        runInBackground(async () => {
          await append({
            type: "events.iterate.com/voice-agent/pong",
            ephemeral: true,
            payload: {
              conversationId: call?.conversationId ?? "",
              id: event.payload.id,
              t1: this.deps.now(),
              ready: call?.ready === true,
            },
          });
        });
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
        /*
         * Same rule as the fold: a matching id ends its call, a non-8-hex id
         * is the device ending the call it is on under its own name, and only
         * a MISMATCHED worker-shaped id is a stale obituary to ignore. The log
         * keeps the firmware defect visible until the device echoes the real
         * id.
         */
        if (call !== null) {
          const named = String(event.payload.conversationId);
          const closes = call.conversationId === named || !/^[0-9a-f]{8}$/.test(named);
          if (!closes) return;
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
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentFacetContract>["runInBackground"],
    serverVad = false,
  ): void {
    const call = new GrokCall(conversationId, this.deps.now());
    call.serverVad = serverVad;
    this.#call = call;
    runInBackground(async () => {
      let failure: string | null = null;
      try {
        const socket = await this.deps.dialGrok();
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
      if (wasLive) this.#call = null;
      call.close();
      if (wasLive) {
        void append({
          type: "events.iterate.com/voice-agent/conversation-ended",
          payload: { conversationId: call.conversationId, reason: "provider socket closed" },
        });
      }
    });
    socket.addEventListener("message", (message: MessageEvent) => {
      if (typeof message.data !== "string") return;
      let provider: { type?: string; delta?: string };
      try {
        provider = JSON.parse(message.data) as { type?: string; delta?: string };
        /* Every provider event, so a silent call can be explained from the
         * log rather than guessed at. Audio deltas are excluded by name:
         * there are hundreds and they say nothing the frames do not. */
        if (provider.type !== "response.output_audio.delta") {
          console.log(`grok <- ${String(provider.type)}`);
        }
      } catch {
        return;
      }
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
              idempotencyKey: this.idempotencyKey(`flushed:${call.conversationId}`),
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
        case "response.created":
          /* Numbering the answer makes a barge-in a comparison: a client
           * holding frames from answer 3 drops them on seeing a 4. */
          call.beginAnswer(this.deps.now());
          return;
        case "response.output_audio.delta":
          if (typeof provider.delta === "string") {
            this.#speak(call, provider.delta, append, runInBackground);
          }
          return;
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
    void append({
      type: "events.iterate.com/voice-agent/grok-event",
      payload: { conversationId: call.conversationId, t: this.deps.now(), event: provider },
    });
  }

  /** Provider audio out to the device, as ephemeral speaker frames. */
  #speak(
    call: GrokCall,
    deltaBase64: string,
    append: ProcessEventArgs<VoiceAgentFacetContract>["append"],
    runInBackground: ProcessEventArgs<VoiceAgentFacetContract>["runInBackground"],
  ): void {
    const frames = call.framesFor(deltaBase64, this.deps.now());
    if (frames.length === 0) return;
    /*
     * ONE APPEND FOR THE WHOLE DELTA, not one per frame — and PACED, not
     * relayed. The provider generates a 90-second answer in a handful of
     * seconds; unpaced, that burst pegged the host CLI's 30-second ring with
     * 265 sequence gaps and made both it and the HA Voice PE play the tail of
     * a count-to-one-hundred chopped and sped up. The call's pace() admits an
     * opening burst and holds the rest; the drain loop below releases it at
     * playback rate, and a barge-in clears the queue via beginAnswer rather
     * than making the interrupter wait behind audio nobody will hear.
     */
    const immediate = call.pace(frames, this.deps.now());
    if (immediate.length > 0) {
      void append(...immediate.map(asSpkFrame));
    }
    if (!call.pacedEmpty && !call.pacerRunning) {
      call.pacerRunning = true;
      runInBackground(async () => {
        while (!call.closed) {
          const batch = call.dequeuePaced(this.deps.now(), PACE_MAX_BATCH);
          if (batch.length > 0) await append(...batch.map(asSpkFrame));
          if (call.pacedEmpty) break; /* flag cleared below, atomically. */
          await this.deps.sleep(PACE_FLUSH_MS);
        }
        call.pacerRunning = false;
      });
    }
  }

  #endCall(reason: string): void {
    const call = this.#call;
    if (call === null) return;
    this.#call = null;
    console.log(`voice call ${call.conversationId} ended: ${reason}`);
    call.close();
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
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      dialGrok: () => dialGrokSocket(),
    });
  }
}
