// Does a conversation nobody is having actually END, against a real
// deployment — and does one that IS being had survive?
//
//   doppler run --config preview_3 -- pnpm cli voicelab teardown \
//     --project marginal-1 --stream-path /agents/voice/teardown-1
//
// Two claims, one run, both read off the stream afterwards rather than
// asserted from inside the thing under test:
//
//   1. A call with nobody speaking on it is torn down. The stream must show
//      `conversation-end-requested` carrying a reason, and then the facet
//      consuming it and appending `conversation-ended`.
//   2. A conversation across several presses over minutes stays on ONE call
//      and is not torn down mid-thought — `--presses 4 --gap-ms 45000`.
//
// THE QUIET PHASE IS QUIET, and that is the whole method. The Durable Object
// this runs against evicts at ~70 seconds without inbound activity, and the
// teardown being proved is exactly the one that has to survive that eviction —
// so this drops the itx connection entirely for the wait instead of polling or
// holding a stream connection open. A poll every five seconds would keep the
// object awake and prove the easy half of the problem. The evidence is read in
// one pass at the end, out of the journal, where the events' own `createdAt`
// stamps say when each thing happened.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { discardRpcResult, withRpcResult } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab teardown`. */
export interface TeardownOptions extends VoicelabConnectOptions {
  /** The stream to hold the conversation on. Must already be set up. */
  streamPath: string;
  /** What to say on each press. Rendered with macOS `say` + sox. */
  say?: string;
  /** A PCM16 mono 16 kHz WAV to speak instead of synthesising one. */
  micWav?: string;
  /** How many presses the conversation is made of. More than one proves the
   * negative: a real conversation stays on one call. */
  presses?: number;
  /** Silence between presses. Must be under the idle deadline to prove it. */
  gapMs?: number;
  /** How long nobody says anything at the end. Must clear the ~70s eviction
   * window and stay under the provider's own 900s. */
  quietMs?: number;
  /** Ceiling on the wait for each answer before pressing on. */
  settleMs?: number;
  /** Frames per append. Twelve is what the C client sends. */
  framesPerAppend?: number;
}

const FRAME_MS = 20;
const FRAME_SAMPLES = 320;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lifecycle events this reads a verdict out of. Audio is not evidence. */
const LIFECYCLE = [
  "events.iterate.com/voice-agent/call-started",
  "events.iterate.com/voice-agent/conversation-accepted",
  "events.iterate.com/voice-agent/conversation-end-requested",
  "events.iterate.com/voice-agent/conversation-ended",
  "events.iterate.com/voice-agent/conversation-failed",
  "events.iterate.com/voice-agent/provider-error",
  "events.iterate.com/voice-agent/buffer-flushed",
  "events.iterate.com/stream/processor-revived",
] as const;

interface JournalEvent {
  type: string;
  offset: number;
  createdAt: string;
  payload?: Record<string, unknown> | null;
}

interface StreamReader {
  getEventPage(args: { limit: number }): Promise<{ streamMaxOffset?: number } | null>;
  getEvents(args: { afterOffset: number; limit: number }): Promise<JournalEvent[] | null>;
}

/** Render text to raw 16 kHz mono PCM16 via macOS `say` + sox. */
function synthesizePcm(text: string): Buffer {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voicelab-teardown-"));
  const aiff = path.join(directory, "utterance.aiff");
  const pcm = path.join(directory, "utterance.pcm");
  execFileSync("say", ["-v", "Samantha", "-o", aiff, text]);
  execFileSync("sox", [
    aiff,
    "-r",
    "16000",
    "-c",
    "1",
    "-b",
    "16",
    "-e",
    "signed-integer",
    "-t",
    "raw",
    pcm,
  ]);
  return fs.readFileSync(pcm);
}

/** One utterance as 20 ms base64 frames, from a WAV file or synthesised text. */
function framesFor(options: TeardownOptions): string[] {
  let pcm: Buffer;
  if (options.micWav !== undefined) {
    const bytes = fs.readFileSync(options.micWav);
    /* Find the data chunk rather than assuming a 44-byte header. */
    const dataAt = bytes.indexOf("data", 12, "ascii");
    pcm = bytes.subarray(dataAt === -1 ? 44 : dataAt + 8);
  } else {
    pcm = synthesizePcm(options.say ?? "Hello. Please say one short sentence back to me.");
  }
  const frames: string[] = [];
  for (let at = 0; at + FRAME_SAMPLES * 2 <= pcm.length; at += FRAME_SAMPLES * 2) {
    frames.push(pcm.subarray(at, at + FRAME_SAMPLES * 2).toString("base64"));
  }
  return frames;
}

/** Every journaled event on a stream, paged to the platform's ceiling. */
async function readJournal(stream: StreamReader): Promise<JournalEvent[]> {
  const head = await withRpcResult(
    stream.getEventPage({ limit: 1 }),
    (page) => page?.streamMaxOffset ?? 0,
  );
  const events: JournalEvent[] = [];
  let offset = 0;
  while (offset < head) {
    const batch = await withRpcResult(
      stream.getEvents({ afterOffset: offset, limit: 500 }),
      (page) =>
        (page ?? []).map((event) => ({
          type: event.type,
          offset: event.offset,
          createdAt: event.createdAt,
          payload: (event.payload ?? {}) as Record<string, unknown>,
        })),
    );
    if (batch.length === 0) break;
    let moved = false;
    for (const event of batch) {
      if (event.offset > offset) {
        offset = event.offset;
        moved = true;
      }
      events.push(event);
    }
    if (!moved) break;
  }
  return events;
}

interface StreamWriter {
  append(...events: unknown[]): Promise<unknown>;
}

/**
 * Hold the conversation: press, speak, let go, wait for the answer, repeat.
 *
 * Returns when the LAST press has been answered (or the settle ran out), with
 * the connection dropped — everything after this point has to happen without a
 * client on the stream.
 */
async function holdConversation(
  options: TeardownOptions,
  frames: string[],
): Promise<{ pressedAt: number[]; releasedAt: number[]; heardAt: (number | null)[] }> {
  const presses = Math.max(1, options.presses ?? 1);
  const gapMs = options.gapMs ?? 45_000;
  const settleMs = options.settleMs ?? 15_000;
  const batchSize = Math.max(1, options.framesPerAppend ?? 12);

  using itx = await connectProject(options);
  const stream = (itx as never as { streams: { get(path: string): StreamWriter } }).streams.get(
    options.streamPath,
  );

  const pressedAt: number[] = [];
  const releasedAt: number[] = [];
  const heardAt: (number | null)[] = [];

  for (let press = 0; press < presses; press++) {
    const pressAt = Date.now();
    pressedAt.push(pressAt);
    await discardRpcResult(
      stream.append({
        type: "events.iterate.com/voice-agent/ptt-start",
        ephemeral: true,
        payload: { t: pressAt },
      }),
    );
    /* Paced at capture rate, because that is the shape the facet's buffering
     * is designed around — flooding it would not be a conversation. */
    let releaseAt = pressAt;
    for (let index = 0; index < frames.length; index += batchSize) {
      const due = pressAt + Math.min(index + batchSize, frames.length) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      for (let offset = 0; offset < batchSize && index + offset < frames.length; offset++) {
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: { seq: index + offset, pcm: frames[index + offset]! },
        });
      }
      if (index + batchSize >= frames.length) {
        releaseAt = Date.now();
        await discardRpcResult(
          stream.append(...events, {
            type: "events.iterate.com/voice-agent/ptt-end",
            ephemeral: true,
            payload: { t: releaseAt },
          }),
        );
      } else {
        void (stream.append(...events) as Promise<unknown>).catch(() => undefined);
      }
    }
    releasedAt.push(releaseAt);

    /*
     * Wait for the answer by watching the JOURNAL, not by holding a
     * connection: speaker frames are ephemeral, so a subscriber would be the
     * only thing that could see them — and a subscriber is exactly what must
     * not be present later. `buffer-flushed` is the durable proof that this
     * press reached a live provider session.
     */
    const deadline = Date.now() + settleMs;
    let heard: number | null = null;
    while (Date.now() < deadline) {
      await sleep(1_000);
      const journal = await readJournal(stream as never as StreamReader);
      const flushed = journal.filter(
        (event) => event.type === "events.iterate.com/voice-agent/buffer-flushed",
      );
      if (flushed.length > press) {
        heard = Date.parse(flushed[flushed.length - 1]!.createdAt);
        break;
      }
    }
    heardAt.push(heard);
    console.log(
      `  press ${String(press + 1)}/${String(presses)}: ` +
        `${((releaseAt - pressAt) / 1000).toFixed(1)}s spoken, ` +
        (heard === null ? "no provider session seen" : "provider session live"),
    );
    if (press + 1 < presses) {
      console.log(`  ...${(gapMs / 1000).toFixed(0)}s until the next press`);
      await sleep(gapMs);
    }
  }
  return { pressedAt, releasedAt, heardAt };
}

export async function teardown(options: TeardownOptions) {
  const quietMs = options.quietMs ?? 120_000;
  const frames = framesFor(options);
  console.log(
    `teardown proof on ${options.streamPath}: ` +
      `${String(Math.max(1, options.presses ?? 1))} press(es), ` +
      `${((frames.length * FRAME_MS) / 1000).toFixed(1)}s of speech each, ` +
      `then ${(quietMs / 1000).toFixed(0)}s of nobody saying anything\n`,
  );

  const spoken = await holdConversation(options, frames);
  const lastReleaseAt = spoken.releasedAt.at(-1) ?? Date.now();

  /*
   * NOTHING TOUCHES THE STREAM FROM HERE. The connection is already disposed;
   * this process now does nothing at all for the whole quiet period, which is
   * the only way the Durable Object gets to be as alone as a forgotten call
   * leaves it.
   */
  console.log(
    `\n  silence starts; nothing will touch this stream for ${(quietMs / 1000).toFixed(0)}s`,
  );
  await sleep(quietMs);

  using itx = await connectProject(options);
  const stream = (itx as never as { streams: { get(path: string): StreamReader } }).streams.get(
    options.streamPath,
  );
  const journal = await readJournal(stream);
  const lifecycle = journal.filter((event) =>
    (LIFECYCLE as readonly string[]).includes(event.type),
  );

  const zero = Date.parse(
    journal.find((event) => event.type.includes("call-started"))?.createdAt ??
      journal[0]?.createdAt ??
      new Date().toISOString(),
  );
  console.log("\n  the stream, in its own words:\n");
  for (const event of lifecycle) {
    const at = (Date.parse(event.createdAt) - zero) / 1000;
    const reason = event.payload?.reason;
    console.log(
      `    +${at.toFixed(1).padStart(6)}s  ${event.type.replace("events.iterate.com/", "")}` +
        (typeof reason === "string" ? `  — ${reason}` : ""),
    );
  }

  const started = lifecycle.filter((e) => e.type.endsWith("/call-started"));
  const requested = lifecycle.filter((e) => e.type.endsWith("/conversation-end-requested"));
  const ended = lifecycle.filter((e) => e.type.endsWith("/conversation-ended"));
  const requestAt = requested.at(-1) === undefined ? null : Date.parse(requested.at(-1)!.createdAt);
  const endedAt = ended.at(-1) === undefined ? null : Date.parse(ended.at(-1)!.createdAt);

  /*
   * ONE CALL is the negative proof, and it is only meaningful with more than
   * one press: a conversation held across minutes must not have re-dialled.
   */
  const problems: string[] = [];
  if (started.length !== 1) {
    problems.push(`expected ONE call across the conversation, saw ${String(started.length)}`);
  }
  if (requestAt === null) problems.push("no conversation-end-requested was ever appended");
  if (endedAt === null) problems.push("no conversation-ended was ever appended");
  if (requestAt !== null && endedAt !== null && endedAt < requestAt) {
    problems.push("the call ended before anybody asked it to");
  }
  if (requestAt !== null && requestAt < lastReleaseAt) {
    problems.push("the end was requested while somebody was still speaking");
  }
  const failures = lifecycle.filter(
    (e) => e.type.endsWith("/conversation-failed") || e.type.endsWith("/provider-error"),
  );

  const verdict = {
    ok: problems.length === 0,
    streamPath: options.streamPath,
    presses: spoken.pressedAt.length,
    callsStarted: started.length,
    /* From the last thing said to the decision, and from the decision to the
     * socket being let go: the two halves the design is made of. */
    lastUtteranceToRequestMs: requestAt === null ? null : requestAt - lastReleaseAt,
    requestToEndedMs: requestAt === null || endedAt === null ? null : endedAt - requestAt,
    endReason: requested.at(-1)?.payload?.reason ?? null,
    revivals: journal.filter((e) => e.type.endsWith("/processor-revived")).length,
    providerFaults: failures.map((event) =>
      String(event.payload?.reason ?? event.payload?.message ?? ""),
    ),
    problems,
  };
  console.log(`\n${JSON.stringify(verdict, null, 2)}`);
  if (!verdict.ok) process.exitCode = 1;
}
