// The spoken record of a voice stream: who said what, in words, off the
// durable transcript events (contract 13.0.0).
//
//   doppler run --config prd -- pnpm cli voicelab transcript --project iterate \
//     --path /agents/voice/2608261526
//
// WHY THIS EXISTS. Audio is ephemeral by design, so until the transcript
// events a finished call left no readable record of what was said — the one
// question every debugging session and every eval starts with. This prints
// the dialogue as the provider transcribed it, call boundaries included; pass
// --json for the raw rows (what the voicelab eval asserts against).
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab transcript`. */
export interface TranscriptOptions extends VoicelabConnectOptions {
  /** The voice stream to read. */
  path: string;
  /** Print raw JSON rows instead of the readable column. */
  json?: boolean;
}

/** One durable transcript row, in stream order. */
export interface TranscriptRow {
  offset: number;
  at: string;
  conversationId: string;
  role: "listener" | "assistant";
  text: string;
  /** Present on an answer the listener barged. */
  cancelled?: boolean;
}

/** The slice of a stream event this command reads. */
interface TranscriptEventLike {
  offset: number;
  createdAt: string;
  type: string;
  payload?: { conversationId?: string; text?: string; cancelled?: boolean; reason?: string };
}

/** Print exactly once; a returned value would make trpc-cli render the rows a second time. */
export async function transcript(options: TranscriptOptions): Promise<void> {
  if (!options.path.startsWith("/")) {
    throw new Error(`--path must be absolute; received ${JSON.stringify(options.path)}`);
  }
  using itx = await connectProject(options);
  const stream = (
    itx as {
      streams: {
        get(path: string): {
          getEvents(input: {
            afterOffset: number;
            eventTypes: string[];
            limit: number;
          }): Promise<TranscriptEventLike[] | null>;
        };
      };
    }
  ).streams.get(options.path);
  const rows: TranscriptRow[] = [];
  const boundaries: { offset: number; label: string }[] = [];
  try {
    let afterOffset = 0;
    for (;;) {
      const page =
        (await stream.getEvents({
          afterOffset,
          eventTypes: [
            "events.iterate.com/voice-agent/utterance-transcript",
            "events.iterate.com/voice-agent/answer-transcript",
            "events.iterate.com/voice-agent/call-started",
            "events.iterate.com/voice-agent/conversation-ended",
          ],
          limit: 500,
        })) ?? [];
      if (page.length === 0) break;
      for (const event of page) {
        const type = event.type.replace("events.iterate.com/voice-agent/", "");
        if (type === "call-started" || type === "conversation-ended") {
          boundaries.push({
            offset: event.offset,
            label:
              type === "call-started"
                ? `call ${event.payload?.conversationId ?? "?"}`
                : `ended: ${event.payload?.reason ?? "?"}`,
          });
          continue;
        }
        rows.push({
          offset: event.offset,
          at: event.createdAt,
          conversationId: event.payload?.conversationId ?? "?",
          role: type === "utterance-transcript" ? "listener" : "assistant",
          text: event.payload?.text ?? "",
          ...(event.payload?.cancelled === true && { cancelled: true }),
        });
      }
      afterOffset = page[page.length - 1]!.offset;
      if (page.length < 500) break;
    }
  } finally {
    disposeIgnoredRpcResult(stream);
  }

  if (options.json === true) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const column = [...rows, ...boundaries.map((b) => ({ ...b, boundary: true as const }))].sort(
    (a, b) => a.offset - b.offset,
  );
  if (column.length === 0) {
    console.log(`no durable transcript on ${options.path} — either nothing was said, or the`);
    console.log(`stream predates the transcript events (voice-agent contract 13.0.0).`);
    return;
  }
  for (const entry of column) {
    if ("boundary" in entry) {
      console.log(`--- ${entry.label}`);
      continue;
    }
    const speaker = entry.role === "assistant" ? "assistant" : "listener ";
    const marker = entry.cancelled === true ? " [barged]" : "";
    console.log(`${entry.at.slice(11, 19)} ${speaker}${marker}  ${entry.text}`);
  }
}
