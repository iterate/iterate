// The chat composer's attachment model. The + sheet, the camera, the
// hold-to-record button, and the document picker all produce one of these;
// the chips row renders them; the send mutation turns them back into the two
// wire shapes the platform has: `agent.addFiles` byte payloads for anything
// with bytes, and one html attachment part per attachment appended to the
// message text (the vocabulary lives in iterate/processors
// user-message-describer.ts next to its parser, so emitter and parser cannot
// drift — a project's derivation processor turns the parts into typed
// render facts).
//
// Bytes are deliberately NOT held here (except photos, whose picker already
// hands back base64 — see lib/attachments.ts). A recorded video or picked
// PDF stays a local file uri until send time, so attaching is instant and an
// abandoned draft never held 30MB in JS memory.

import { formatAttachmentPartLine, type DescribedAttachment } from "iterate/processors";
import type { PickedImage } from "./attachments.ts";
import { base64ToUint8Array } from "./encoding.ts";

export type ComposerAttachment =
  | { kind: "photo"; image: PickedImage }
  | {
      kind: "video";
      /** The photo library's own id, when the video came from it — the
       * attachment sheet's carousel uses it for its checkmarks and
       * tap-again-to-detach (null for fresh recordings). */
      assetId: string | null;
      filename: string;
      contentType: string;
      /** Local file uri; bytes are read from it at send time. */
      uri: string;
      /** Poster/thumbnail uri when we have one (camera roll gives one, a
       * fresh recording does not). */
      previewUri: string | null;
      durationSeconds: number | null;
      sizeBytes: number | null;
      /** Pixel dimensions when the source knows them (library assets do,
       * fresh recordings don't) — sent as an <attachment .../> part so
       * renderers can lay out before the media loads. */
      width: number | null;
      height: number | null;
    }
  | {
      kind: "file";
      filename: string;
      contentType: string;
      uri: string;
      sizeBytes: number | null;
    }
  | {
      kind: "audio";
      filename: string;
      contentType: string;
      uri: string;
      durationSeconds: number | null;
      /** On-device transcription of a recorded clip (lib/voice-transcription
       * .ts), hydrated at send time; null while pending/unavailable and for
       * picked audio files. Rides the <voice-note transcript /> attribute. */
      transcript: string | null;
    }
  | {
      kind: "location";
      latitude: number;
      longitude: number;
      accuracyMeters: number | null;
      capturedAt: string;
    };

/** The library asset id behind an attachment, when there is one — how the
 * attachment sheet's carousel knows a tile is already attached. */
export function attachmentAssetId(attachment: ComposerAttachment): string | null {
  if (attachment.kind === "photo") return attachment.image.assetId;
  if (attachment.kind === "video") return attachment.assetId;
  return null;
}

/** Stable identity for list keys and the remove dialog. */
export function attachmentKey(attachment: ComposerAttachment): string {
  switch (attachment.kind) {
    case "photo":
      return `photo:${attachment.image.previewUri}`;
    case "location":
      return `location:${attachment.capturedAt}`;
    default:
      return `${attachment.kind}:${attachment.uri}`;
  }
}

/** What the chip says under/over its glyph, and what the remove dialog names. */
export function attachmentLabel(attachment: ComposerAttachment): string {
  switch (attachment.kind) {
    case "photo":
      return attachment.image.filename;
    case "video":
      return attachment.durationSeconds === null
        ? attachment.filename
        : `video · ${formatClipDuration(attachment.durationSeconds)}`;
    case "file":
      return attachment.filename;
    case "audio":
      return attachment.durationSeconds === null
        ? "voice clip"
        : `voice · ${formatClipDuration(attachment.durationSeconds)}`;
    case "location":
      return `${attachment.latitude.toFixed(5)}, ${attachment.longitude.toFixed(5)}`;
  }
}

export function formatClipDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Payloads past this ride the wire as a chunked ReadableStream instead of
 * one Uint8Array arg: capnweb multiplexes stream chunks into separate
 * websocket frames with flow control, while a single big arg becomes one
 * frame — and Cloudflare closes inbound websocket messages over ~1MiB (the
 * "RPC session was shut down" a 10MB PDF used to die with). */
export const STREAM_UPLOAD_THRESHOLD_BYTES = 512 * 1024;
export const UPLOAD_CHUNK_BYTES = 256 * 1024;

/** The bytes as a pull-based stream of frame-sized chunks. */
export function chunkedUploadStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES));
      offset += UPLOAD_CHUNK_BYTES;
    },
  });
}

/** Human-readable refusal, or null when the size is fine/unknown. Unknown
 * sizes pass — the read at send time is the backstop. */
export function oversizeReason(sizeBytes: number | null): string | null {
  if (sizeBytes === null || sizeBytes <= MAX_UPLOAD_BYTES) return null;
  const mb = (sizeBytes / (1024 * 1024)).toFixed(0);
  return `That's ${mb}MB — too big to send (max ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB). Try a shorter clip or a smaller file.`;
}

/** The `agent.addFiles` payloads for every byte-carrying attachment, read
 * lazily via `readBase64` (a uri → base64 boundary so tests never touch the
 * filesystem). */
export async function attachmentUploads(
  attachments: ComposerAttachment[],
  readBase64: (uri: string) => Promise<string>,
): Promise<
  { contentType: string; data: Uint8Array | ReadableStream<Uint8Array>; filename: string }[]
> {
  const uploads: {
    contentType: string;
    data: Uint8Array | ReadableStream<Uint8Array>;
    filename: string;
  }[] = [];
  const wireShape = (bytes: Uint8Array) =>
    bytes.byteLength > STREAM_UPLOAD_THRESHOLD_BYTES ? chunkedUploadStream(bytes) : bytes;
  for (const attachment of attachments) {
    if (attachment.kind === "location") continue;
    if (attachment.kind === "photo") {
      uploads.push({
        contentType: attachment.image.contentType,
        data: wireShape(base64ToUint8Array(attachment.image.base64)),
        filename: attachment.image.filename,
      });
      continue;
    }
    const data = base64ToUint8Array(await readBase64(attachment.uri));
    const refusal = oversizeReason(data.byteLength);
    if (refusal !== null) throw new Error(`${attachment.filename}: ${refusal}`);
    uploads.push({
      contentType: attachment.contentType,
      data: wireShape(data),
      filename: attachment.filename,
    });
  }
  return uploads;
}

/** The note composer's wire shape: every byte-carrying attachment as an
 * inline base64 blob, matching lib/pending-notes.ts PendingNoteAttachment —
 * capture must never lose data (a pending note has to survive offline in
 * AsyncStorage, local file uris don't), so bytes are read eagerly here.
 * Locations carry no bytes; fold them into the note text with
 * locationXmlPart instead. */
export async function pendingNoteAttachments(
  attachments: ComposerAttachment[],
  readBase64: (uri: string) => Promise<string>,
): Promise<
  { filename: string; contentType: string; base64: string; width: number; height: number }[]
> {
  const out: {
    filename: string;
    contentType: string;
    base64: string;
    width: number;
    height: number;
  }[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "location") continue;
    if (attachment.kind === "photo") {
      out.push({
        filename: attachment.image.filename,
        contentType: attachment.image.contentType,
        base64: attachment.image.base64,
        width: attachment.image.width,
        height: attachment.image.height,
      });
      continue;
    }
    const base64 = await readBase64(attachment.uri);
    const refusal = oversizeReason(Math.floor(base64.length * 0.75));
    if (refusal !== null) throw new Error(`${attachment.filename}: ${refusal}`);
    out.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      base64,
      width: attachment.kind === "video" ? attachment.width || 0 : 0,
      height: attachment.kind === "video" ? attachment.height || 0 : 0,
    });
  }
  return out;
}

/**
 * One composer attachment as the vocabulary's typed shape. Null when the
 * attachment adds no metadata beyond its uploaded bytes (a photo whose
 * dimensions are unknown would, but the picker always knows them).
 */
export function describedAttachment(attachment: ComposerAttachment): DescribedAttachment | null {
  switch (attachment.kind) {
    case "photo": {
      const { filename, width, height } = attachment.image;
      if (width <= 0 || height <= 0) return null;
      return { kind: "image", filename, width: Math.round(width), height: Math.round(height) };
    }
    case "video":
      return {
        kind: "video",
        filename: attachment.filename,
        ...(attachment.width !== null &&
          attachment.height !== null &&
          attachment.width > 0 && {
            width: Math.round(attachment.width),
            height: Math.round(attachment.height),
          }),
        ...(attachment.durationSeconds === null
          ? {}
          : { durationSeconds: attachment.durationSeconds }),
      };
    case "audio":
      // Recorded clips carry a duration and announce themselves as voice
      // notes; document-picked audio (durationSeconds null) is just a file.
      if (attachment.durationSeconds === null) {
        return {
          kind: "file",
          filename: attachment.filename,
          contentType: attachment.contentType,
        };
      }
      return {
        kind: "audio",
        filename: attachment.filename,
        durationSeconds: attachment.durationSeconds,
        ...(attachment.transcript === null || attachment.transcript === ""
          ? {}
          : { transcript: attachment.transcript }),
      };
    case "file":
      return {
        kind: "file",
        filename: attachment.filename,
        contentType: attachment.contentType,
        ...(attachment.sizeBytes === null ? {} : { sizeBytes: attachment.sizeBytes }),
      };
    case "location":
      return {
        kind: "location",
        latitude: attachment.latitude,
        longitude: attachment.longitude,
        ...(attachment.accuracyMeters === null
          ? {}
          : { accuracyMeters: attachment.accuracyMeters }),
        capturedAt: attachment.capturedAt,
      };
  }
}

/** The message text that actually sends: the typed text, then each html
 * attachment part on its own line. */
export function messageWithAttachmentParts(
  message: string,
  attachments: ComposerAttachment[],
): string {
  const parts = attachments.flatMap((attachment) => {
    const described = describedAttachment(attachment);
    return described === null ? [] : [formatAttachmentPartLine(described)];
  });
  if (parts.length === 0) return message;
  return [message, ...parts].filter((line) => line !== "").join("\n");
}

const ATTACHMENT_PART_PATTERN = /<attachment filename="([^"]*)" width="(\d+)" height="(\d+)" \/>/g;

/** filename → pixel dimensions, parsed back out of a received message's
 * <attachment .../> parts. */
export function parseAttachmentDimensions(
  text: string,
): Record<string, { width: number; height: number }> {
  const dimensions: Record<string, { width: number; height: number }> = {};
  for (const match of text.matchAll(ATTACHMENT_PART_PATTERN)) {
    dimensions[unescapeXmlAttribute(match[1]!)] = {
      width: Number(match[2]),
      height: Number(match[3]),
    };
  }
  return dimensions;
}

const VOICE_NOTE_PART_PATTERN =
  /<voice-note filename="([^"]*)" duration-seconds="\d+"(?: transcript="([^"]*)")? \/>/g;

/** filename → on-device transcript, parsed back out of a received message's
 * <voice-note .../> parts — the audio player shows it under the waveform. */
export function parseVoiceNoteTranscripts(text: string): Record<string, string> {
  const transcripts: Record<string, string> = {};
  for (const match of text.matchAll(VOICE_NOTE_PART_PATTERN)) {
    if (match[2] !== undefined && match[2] !== "") {
      transcripts[unescapeXmlAttribute(match[1]!)] = unescapeXmlAttribute(match[2]);
    }
  }
  return transcripts;
}

const LOCATION_PART_PATTERN =
  /<user-location latitude="(-?[\d.]+)" longitude="(-?[\d.]+)"(?: accuracy-meters="(\d+)")? captured-at="([^"]*)" \/>/g;

/** The shared locations in a received message's <user-location .../> parts —
 * each one renders as a map card instead of raw XML. */
export function parseUserLocations(
  text: string,
): { latitude: number; longitude: number; accuracyMeters: number | null; capturedAt: string }[] {
  return [...text.matchAll(LOCATION_PART_PATTERN)].map((match) => ({
    latitude: Number(match[1]),
    longitude: Number(match[2]),
    accuracyMeters: match[3] === undefined ? null : Number(match[3]),
    capturedAt: match[4]!,
  }));
}

/** The caption a human should see: <attachment .../> parts are layout
 * metadata, <user-location .../> parts render as map cards,
 * <voice-note .../> parts render as players, and the server's default
 * "[Files attached: …]" note is redundant next to rich attachment renders —
 * none of them belong in the visible text. */
export function stripAttachmentXmlParts(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !/^<attachment filename=.* \/>$/.test(trimmed) &&
        !/^<user-location .* \/>$/.test(trimmed) &&
        !/^<voice-note .* \/>$/.test(trimmed) &&
        !/^\[Files attached: .*\]$/.test(trimmed)
      );
    })
    .join("\n")
    .trim();
}

function unescapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
