// Record a voice stream's LIVE side — the ephemeral events a later read can
// never show — with the facet's own clocks, so a call's timing can be judged
// after the fact from the server's point of view.
//
//   doppler run --config prd -- pnpm cli voicelab tap --project iterate \
//     --path /agents/voice/2609090928 --out /tmp/tap.jsonl --minutes 3
//
// WHY THIS EXISTS. The host CLI's report says what the DEVICE saw: frames
// received, ring occupancy, starvation. When playback starves while every
// frame still arrives (the back-office consultation of 2026-09-09), that
// report cannot say whether the provider delivered late or the facet
// released late. The facet stamps both: every mirrored provider event and
// client control carries `receivedAtFacetMs`, every spk-frame carries
// `sentAtFacetMs`, and the durable colleague events say when the back office
// spoke. This tap writes them all as one JSONL, one row per event, with the
// tap's own arrival clock beside the facet's — the whole timeline of a call
// in a file `voicelab tap-report` can judge.
import fs from "node:fs";
import { openStream } from "./probe-audio.ts";
import type { VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab tap`. */
export interface TapOptions extends VoicelabConnectOptions {
  /** The voice stream to watch. */
  path: string;
  /** JSONL file to write, one row per event. */
  out: string;
  /** How long to listen. */
  minutes?: number;
}

/** One row of the tap: the tap's arrival clock, the event, and its facet stamps. */
export interface TapRow {
  /** Milliseconds since the tap opened, on the tap's clock. */
  atTapMs: number;
  type: string;
  /** Facet clock at the moment the facet stamped the event, when it did. */
  receivedAtFacetMs?: number;
  sentAtFacetMs?: number;
  /** spk-frame: sequence and base64 length (bytes = length * 3 / 4). */
  deviceSpeakerFrameSeq?: number;
  pcmB64Length?: number;
  lastFrameOfAnswer?: boolean;
  clearSpeakerBufferBeforeFrame?: boolean;
  /** grok-event: the provider event's own type and, for audio deltas, its byte count. */
  providerType?: string;
  deltaBytes?: number;
  /** Everything else the event carried, minus audio bytes. */
  payload?: Record<string, unknown>;
}

const LIVE_TYPES = [
  "events.iterate.com/voice-agent/spk-frame",
  "events.iterate.com/voice-agent/grok-event",
  "events.iterate.com/voice-agent/mic-frame",
  "events.iterate.com/voice-agent/call-started",
  "events.iterate.com/voice-agent/conversation-accepted",
  "events.iterate.com/voice-agent/conversation-end-requested",
  "events.iterate.com/voice-agent/conversation-ended",
  "events.iterate.com/voice-agent/utterance-transcript",
  "events.iterate.com/voice-agent/answer-transcript",
  "events.iterate.com/voice-agent/colleague-status",
  "events.iterate.com/voice-agent/colleague-note",
  "events.iterate.com/voice-agent/provider-error",
];

export async function tap(options: TapOptions): Promise<void> {
  if (!options.path.startsWith("/")) {
    throw new Error(`--path must be absolute; received ${JSON.stringify(options.path)}`);
  }
  const minutes = options.minutes ?? 3;
  const stream = await openStream({ ...options, streamPath: options.path });
  const file = fs.openSync(options.out, "w");
  const openedAt = Date.now();
  let rows = 0;
  let closed = false;
  const connection = await stream.openConnection({
    connectionKey: `tap-${openedAt}`,
    eventTypes: LIVE_TYPES,
    processEventBatch: (batch) => {
      /* A batch already in flight can land after the window ends; the file is
       * gone by then, so it is dropped rather than written to a dead descriptor. */
      if (closed) return;
      const atTapMs = Date.now() - openedAt;
      for (const event of batch.events ?? []) {
        /* Rows are what the payload says it is; the shapes below are the
         * contract's own field names, read loosely because a tap must never
         * refuse a row it did not expect. */
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const type = event.type.replace("events.iterate.com/voice-agent/", "");
        const row: TapRow = { atTapMs, type };
        if (typeof payload.receivedAtFacetMs === "number")
          row.receivedAtFacetMs = payload.receivedAtFacetMs;
        if (typeof payload.sentAtFacetMs === "number") row.sentAtFacetMs = payload.sentAtFacetMs;
        if (type === "spk-frame") {
          if (typeof payload.deviceSpeakerFrameSeq === "number")
            row.deviceSpeakerFrameSeq = payload.deviceSpeakerFrameSeq;
          if (typeof payload.pcm === "string") row.pcmB64Length = payload.pcm.length;
          if (payload.lastFrameOfAnswer === true) row.lastFrameOfAnswer = true;
          if (payload.clearSpeakerBufferBeforeFrame === true)
            row.clearSpeakerBufferBeforeFrame = true;
        } else if (type === "grok-event") {
          if (typeof payload.type === "string") row.providerType = payload.type;
          if (typeof payload.deltaBytes === "number") row.deltaBytes = payload.deltaBytes;
          const { type: _t, deltaBytes: _b, delta: _d, receivedAtFacetMs: _r, ...rest } = payload;
          row.payload = rest;
        } else if (type === "mic-frame") {
          if (typeof payload.pcm === "string") row.pcmB64Length = payload.pcm.length;
        } else {
          row.payload = payload;
        }
        fs.writeSync(file, `${JSON.stringify(row)}\n`);
        rows += 1;
      }
    },
  });
  console.log(`tapping ${options.path} for ${minutes} min → ${options.out}`);
  try {
    await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
  } finally {
    /* The subscription closes BEFORE the file: batches keep arriving until the
     * live stream hears the close, and a write after closeSync would throw. */
    closed = true;
    connection.close();
    fs.closeSync(file);
  }
  console.log(`${rows} rows`);
}
