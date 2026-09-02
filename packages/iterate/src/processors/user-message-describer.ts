// The USER-MESSAGE DESCRIBER: a reusable derivation processor that parses the
// html attachment vocabulary out of user chat messages and emits one durable
// `render/user-message-described` fact per attachment-bearing message, so
// renderers fold typed attachment metadata instead of parsing message text.
//
// The vocabulary (authored by the mobile composer; each part sits alone on
// its own line after the message text, referencing the event's `files[]` by
// filename — never a `src`, signed URLs mint at the edge):
//
//   <img alt="IMG_1.png" width="1200" height="900">
//   <video data-filename="clip.mov" width="1920" height="1080" data-duration="12"></video>
//   <audio data-filename="note.m4a" data-duration="7" data-transcript="on my way"></audio>
//   <a type="application/pdf" data-size="9800000">report.pdf</a>
//   <a href="geo:51.5,-0.13" data-accuracy-m="15" data-captured-at="2026-09-02T00:00:00Z">Shared location</a>
//
// This lives in the published package rather than one template because the
// composer is the SAME mobile app on every project: any template that wants
// rich attachment rendering installs the subscription (see
// userMessageDescriberSubscription) — project space opting into a library,
// not the kernel parsing a format.

import { z } from "zod";
import { defineProcessorContract, StreamProcessor } from "./index.ts";
import type { ProcessEventArgs, ProcessorState, ReduceArgs } from "./index.ts";

export const RENDER_USER_MESSAGE_DESCRIBED = "events.iterate.com/render/user-message-described";

const AGENT_CONTEXT_ADDED = "events.iterate.com/agents/context-added";

export const DescribedAttachment = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    filename: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("video"),
    filename: z.string(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationSeconds: z.number().nonnegative().optional(),
    /** Filename of an uploaded poster/thumbnail image, when one exists. */
    poster: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("audio"),
    filename: z.string(),
    durationSeconds: z.number().nonnegative().optional(),
    transcript: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("file"),
    filename: z.string(),
    contentType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal("location"),
    latitude: z.number(),
    longitude: z.number(),
    accuracyMeters: z.number().nonnegative().optional(),
    capturedAt: z.string().optional(),
  }),
]);
export type DescribedAttachment = z.infer<typeof DescribedAttachment>;

export const RenderUserMessageDescribed = z.strictObject({
  /** The human-visible message: the raw text with attachment part lines (and
   * the server's "[Files attached: …]" note) stripped. */
  text: z.string(),
  attachments: z.array(DescribedAttachment).min(1),
});

export const UserMessageDescriberContract = defineProcessorContract({
  slug: "user-message-describer",
  version: "0.1.0",
  description:
    "Derives typed attachment metadata (render/user-message-described) from the html attachment vocabulary in user chat messages, so renderers never parse message text.",
  stateSchema: z.object({}),
  events: {
    [AGENT_CONTEXT_ADDED]: {
      description:
        "Platform context item (declared locally — templates cannot import OS contracts); consumed for user messages carrying attachment parts.",
      payloadSchema: z.looseObject({}),
    },
    [RENDER_USER_MESSAGE_DESCRIBED]: {
      description:
        "THE feed fact for an attachment-bearing user message: stripped text plus typed attachment metadata. source.offset points at the raw user event; renderers fold this and fall back to raw only when nothing sources it.",
      payloadSchema: RenderUserMessageDescribed,
    },
  },
  consumes: [AGENT_CONTEXT_ADDED],
  emits: [RENDER_USER_MESSAGE_DESCRIBED],
});
export type UserMessageDescriberContract = typeof UserMessageDescriberContract;
export type UserMessageDescriberState = ProcessorState<UserMessageDescriberContract>;

export class UserMessageDescriberProcessor extends StreamProcessor<UserMessageDescriberContract> {
  readonly contract = UserMessageDescriberContract;

  protected override reduce({ state }: ReduceArgs<UserMessageDescriberContract>) {
    return state;
  }

  protected override processEvent(args: ProcessEventArgs<UserMessageDescriberContract>): undefined {
    const { event } = args;
    if (event === null || event.type !== AGENT_CONTEXT_ADDED) return;
    const payload = event.payload;
    const role = typeof payload?.role === "string" ? payload.role : undefined;
    if (role !== "user") return;
    const content = typeof payload?.content === "string" ? payload.content : undefined;
    if (content === undefined) return;
    const described = describeUserMessage(content);
    if (described === null) return;
    // Must-happen append: without the derived fact the message renders raw
    // (tag soup in the bubble). Held frame + per-event key dedupes replays.
    args.blockProcessorWhile(async () => {
      await args.append({
        type: RENDER_USER_MESSAGE_DESCRIBED,
        idempotencyKey: `user-message-describer/described@${event.offset}`,
        source: { offset: event.offset },
        payload: described,
      });
    });
  }
}

/**
 * Parse one user message: the typed attachments from its part lines, and the
 * text with those lines stripped. Null when no part parses — an ordinary
 * message needs no derivation (the raw event renders as today).
 */
export function describeUserMessage(
  content: string,
): { text: string; attachments: DescribedAttachment[] } | null {
  const attachments: DescribedAttachment[] = [];
  const keptLines: string[] = [];
  for (const line of content.split("\n")) {
    const attachment = parseAttachmentPartLine(line.trim());
    if (attachment !== null) {
      attachments.push(attachment);
      continue;
    }
    // The server's default note is redundant next to rich attachment renders.
    if (/^\[Files attached: .*\]$/.test(line.trim())) continue;
    keptLines.push(line);
  }
  if (attachments.length === 0) return null;
  return { text: keptLines.join("\n").trim(), attachments };
}

const IMG_RE = /^<img alt="([^"]*)" width="(\d+)" height="(\d+)">$/;
const VIDEO_RE =
  /^<video data-filename="([^"]*)"(?: width="(\d+)" height="(\d+)")?(?: poster="([^"]*)")?(?: data-duration="(\d+)")?><\/video>$/;
const AUDIO_RE =
  /^<audio data-filename="([^"]*)"(?: data-duration="(\d+)")?(?: data-transcript="([^"]*)")?><\/audio>$/;
const FILE_RE = /^<a type="([^"]*)"(?: data-size="(\d+)")?>([^<]+)<\/a>$/;
const GEO_RE =
  /^<a href="geo:(-?[\d.]+),(-?[\d.]+)"(?: data-accuracy-m="(\d+)")?(?: data-captured-at="([^"]*)")?>[^<]*<\/a>$/;

function parseAttachmentPartLine(line: string): DescribedAttachment | null {
  const img = line.match(IMG_RE);
  if (img !== null) {
    return {
      kind: "image",
      filename: unescapeHtmlAttribute(img[1] || ""),
      width: Number(img[2]),
      height: Number(img[3]),
    };
  }
  const video = line.match(VIDEO_RE);
  if (video !== null) {
    return {
      kind: "video",
      filename: unescapeHtmlAttribute(video[1] || ""),
      ...(video[2] === undefined ? {} : { width: Number(video[2]), height: Number(video[3]) }),
      ...(video[4] === undefined ? {} : { poster: unescapeHtmlAttribute(video[4]) }),
      ...(video[5] === undefined ? {} : { durationSeconds: Number(video[5]) }),
    };
  }
  const audio = line.match(AUDIO_RE);
  if (audio !== null) {
    return {
      kind: "audio",
      filename: unescapeHtmlAttribute(audio[1] || ""),
      ...(audio[2] === undefined ? {} : { durationSeconds: Number(audio[2]) }),
      ...(audio[3] === undefined || audio[3] === ""
        ? {}
        : { transcript: unescapeHtmlAttribute(audio[3]) }),
    };
  }
  const geo = line.match(GEO_RE);
  if (geo !== null) {
    return {
      kind: "location",
      latitude: Number(geo[1]),
      longitude: Number(geo[2]),
      ...(geo[3] === undefined ? {} : { accuracyMeters: Number(geo[3]) }),
      ...(geo[4] === undefined ? {} : { capturedAt: unescapeHtmlAttribute(geo[4]) }),
    };
  }
  const file = line.match(FILE_RE);
  if (file !== null) {
    return {
      kind: "file",
      filename: unescapeHtmlAttribute(file[3] || ""),
      ...(file[1] === undefined || file[1] === ""
        ? {}
        : { contentType: unescapeHtmlAttribute(file[1]) }),
      ...(file[2] === undefined ? {} : { sizeBytes: Number(file[2]) }),
    };
  }
  return null;
}

function unescapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

/**
 * The stream/subscription-configured payload that installs the describer on
 * an agent stream, for a template worker to append at agent birth. The facet
 * class must be exported from `entryFile` in the project's config repo —
 * typically a two-liner re-exporting {@link UserMessageDescriberProcessor}
 * wrapped in a StreamProcessorFacet subclass named
 * `UserMessageDescriberFacet`.
 */
export function userMessageDescriberSubscription(agentPath: string, entryFile: string) {
  return {
    name: UserMessageDescriberContract.slug,
    description:
      "Derive typed attachment metadata from user messages in this stream's own Durable Object.",
    filter: { eventTypes: [...UserMessageDescriberContract.consumes] },
    receiver: {
      action: "facet-processor",
      source: {
        kind: "userspace",
        worker: {
          className: "UserMessageDescriberFacet",
          durableWorkerKey: "user-message-describer",
          path: agentPath,
          source: {
            createWorker: {
              entryPoint: entryFile,
              files: { repoPath: "/repos/config", type: "repo" },
            },
          },
          type: "stateful",
        },
      },
    },
  };
}

/**
 * The exact inverse of the parser above: one attachment as its part line.
 * The composer imports this so emitter and parser can never drift — the
 * round-trip is pinned by the package's own tests.
 */
export function formatAttachmentPartLine(attachment: DescribedAttachment): string {
  switch (attachment.kind) {
    case "image":
      return `<img alt="${escapeHtmlAttribute(attachment.filename)}" width="${attachment.width}" height="${attachment.height}">`;
    case "video": {
      const dims =
        attachment.width === undefined || attachment.height === undefined
          ? ""
          : ` width="${attachment.width}" height="${attachment.height}"`;
      const poster =
        attachment.poster === undefined
          ? ""
          : ` poster="${escapeHtmlAttribute(attachment.poster)}"`;
      const duration =
        attachment.durationSeconds === undefined
          ? ""
          : ` data-duration="${Math.round(attachment.durationSeconds)}"`;
      return `<video data-filename="${escapeHtmlAttribute(attachment.filename)}"${dims}${poster}${duration}></video>`;
    }
    case "audio": {
      const duration =
        attachment.durationSeconds === undefined
          ? ""
          : ` data-duration="${Math.round(attachment.durationSeconds)}"`;
      const transcript =
        attachment.transcript === undefined || attachment.transcript === ""
          ? ""
          : ` data-transcript="${escapeHtmlAttribute(attachment.transcript)}"`;
      return `<audio data-filename="${escapeHtmlAttribute(attachment.filename)}"${duration}${transcript}></audio>`;
    }
    case "file": {
      const size = attachment.sizeBytes === undefined ? "" : ` data-size="${attachment.sizeBytes}"`;
      return `<a type="${escapeHtmlAttribute(attachment.contentType || "")}"${size}>${attachment.filename.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</a>`;
    }
    case "location": {
      const accuracy =
        attachment.accuracyMeters === undefined
          ? ""
          : ` data-accuracy-m="${Math.round(attachment.accuracyMeters)}"`;
      const capturedAt =
        attachment.capturedAt === undefined
          ? ""
          : ` data-captured-at="${escapeHtmlAttribute(attachment.capturedAt)}"`;
      return `<a href="geo:${attachment.latitude},${attachment.longitude}"${accuracy}${capturedAt}>Shared location</a>`;
    }
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
