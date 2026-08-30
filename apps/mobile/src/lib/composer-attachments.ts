// The chat composer's attachment model. The + sheet, the camera, the
// hold-to-record button, and the document picker all produce one of these;
// the chips row renders them; the send mutation turns them back into the two
// wire shapes the platform has: `agent.addFiles` byte payloads for anything
// with bytes, and an inline XML part appended to the message text for
// location (which has none).
//
// Bytes are deliberately NOT held here (except photos, whose picker already
// hands back base64 — see lib/attachments.ts). A recorded video or picked
// PDF stays a local file uri until send time, so attaching is instant and an
// abandoned draft never held 30MB in JS memory.

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

/** Anything bigger risks an unsendable websocket frame (photos never get
 * here — the picker recompresses them well under this). */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

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
): Promise<{ contentType: string; data: Uint8Array; filename: string }[]> {
  const uploads: { contentType: string; data: Uint8Array; filename: string }[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "location") continue;
    if (attachment.kind === "photo") {
      uploads.push({
        contentType: attachment.image.contentType,
        data: base64ToUint8Array(attachment.image.base64),
        filename: attachment.image.filename,
      });
      continue;
    }
    const data = base64ToUint8Array(await readBase64(attachment.uri));
    const refusal = oversizeReason(data.byteLength);
    if (refusal !== null) throw new Error(`${attachment.filename}: ${refusal}`);
    uploads.push({ contentType: attachment.contentType, data, filename: attachment.filename });
  }
  return uploads;
}

/** Location goes into the message text itself as a self-describing XML part
 * — it has no bytes to upload, and any reader (agent, web, human) can parse
 * coordinates out of attributes. */
export function locationXmlPart(attachment: {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  capturedAt: string;
}): string {
  const attributes = [
    `latitude="${attachment.latitude}"`,
    `longitude="${attachment.longitude}"`,
    ...(attachment.accuracyMeters === null
      ? []
      : [`accuracy-meters="${Math.round(attachment.accuracyMeters)}"`]),
    `captured-at="${escapeXmlAttribute(attachment.capturedAt)}"`,
  ];
  return `<user-location ${attributes.join(" ")} />`;
}

/** The message text that actually sends: the typed text, then each XML part
 * on its own line. */
export function messageWithXmlParts(message: string, attachments: ComposerAttachment[]): string {
  const parts = attachments.flatMap((attachment) =>
    attachment.kind === "location" ? [locationXmlPart(attachment)] : [],
  );
  if (parts.length === 0) return message;
  return [message, ...parts].filter((line) => line !== "").join("\n");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
