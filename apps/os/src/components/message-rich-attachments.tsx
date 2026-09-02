// Rich attachment rendering for chat messages, driven by the fold's typed
// `item.attachments` (render/user-message-described facts from a project's
// derivation processor) — the web half of the attachment features the mobile
// app grew first: media mosaic, inline audio + transcript, video playback,
// location cards, file rows. Bytes come from the event's own files[] (signed
// urls); the attachments carry layout/semantic metadata keyed by filename.
import { FileIcon, MapPinIcon } from "lucide-react";
import type {
  AgentUiAttachment,
  AgentUiFileAttachment,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { mosaicLayout } from "@iterate-com/ui/lib/mosaic-layout";
import { cn } from "@iterate-com/ui/lib/utils";
import { formatFileSize } from "~/lib/feed-format.ts";

const MOSAIC_MAX_WIDTH = 420;

export function MessageRichAttachments({
  attachments,
  files,
  hasText,
}: {
  attachments: AgentUiAttachment[];
  files: AgentUiFileAttachment[] | undefined;
  hasText: boolean;
}) {
  const fileByName = new Map((files || []).map((file) => [file.filename, file]));
  const media = attachments.filter(
    (attachment): attachment is Extract<AgentUiAttachment, { kind: "image" | "video" }> =>
      attachment.kind === "image" || attachment.kind === "video",
  );
  const audios = attachments.filter((attachment) => attachment.kind === "audio");
  const plainFiles = attachments.filter((attachment) => attachment.kind === "file");
  const locations = attachments.filter((attachment) => attachment.kind === "location");
  // Files the derivation didn't describe (or media with no matching upload)
  // still show through the caller's plain chip row — this component renders
  // only what it has metadata AND bytes for.
  return (
    <div className={cn("flex max-w-full flex-col gap-2", hasText && "mt-1")}>
      {media.length > 0 ? <MediaMosaic media={media} fileByName={fileByName} /> : null}
      {audios.map((attachment) => (
        <AudioRow
          key={attachment.filename}
          attachment={attachment}
          file={fileByName.get(attachment.filename)}
        />
      ))}
      {plainFiles.map((attachment) => {
        const file = fileByName.get(attachment.filename);
        if (file === undefined) return null;
        return (
          <a
            key={attachment.filename}
            href={file.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <FileIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate text-foreground/80">{attachment.filename}</span>
            <span className="shrink-0 font-mono">
              {formatFileSize(
                attachment.sizeBytes === undefined ? file.size : attachment.sizeBytes,
              )}
            </span>
          </a>
        );
      })}
      {locations.map((attachment, index) => (
        <LocationCard
          key={`${attachment.latitude},${attachment.longitude},${index}`}
          attachment={attachment}
        />
      ))}
    </div>
  );
}

/** Telegram-style justified rows (packages/ui mosaic-layout — the same
 * geometry the mobile bubble uses), absolutely positioned in a fixed-height
 * container so nothing reflows when bytes arrive. */
function MediaMosaic({
  media,
  fileByName,
}: {
  media: Extract<AgentUiAttachment, { kind: "image" | "video" }>[];
  fileByName: Map<string, AgentUiFileAttachment>;
}) {
  const layout = mosaicLayout({
    aspectRatios: media.map((attachment) =>
      attachment.width !== undefined && attachment.height !== undefined
        ? attachment.width / attachment.height
        : 1,
    ),
    maxWidth: MOSAIC_MAX_WIDTH,
  });
  return (
    <div
      className="relative max-w-full overflow-hidden rounded-lg"
      style={{ width: layout.width, height: layout.height }}
    >
      {media.map((attachment, index) => {
        const rect = layout.rects[index]!;
        const file = fileByName.get(attachment.filename);
        const style = {
          position: "absolute" as const,
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        };
        if (file === undefined) {
          return <div key={attachment.filename} style={style} className="bg-muted" />;
        }
        if (attachment.kind === "video") {
          return (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- user-recorded clips carry no caption track
            <video
              key={attachment.filename}
              src={file.url}
              controls
              preload="metadata"
              style={style}
              className="rounded-sm bg-black object-cover"
            />
          );
        }
        return (
          <a
            key={attachment.filename}
            href={file.url}
            target="_blank"
            rel="noreferrer"
            style={style}
          >
            <img
              src={file.url}
              alt={attachment.filename}
              width={attachment.width}
              height={attachment.height}
              className="size-full rounded-sm bg-muted object-cover"
            />
          </a>
        );
      })}
    </div>
  );
}

function AudioRow({
  attachment,
  file,
}: {
  attachment: Extract<AgentUiAttachment, { kind: "audio" }>;
  file: AgentUiFileAttachment | undefined;
}) {
  if (file === undefined) return null;
  return (
    <div className="flex max-w-md flex-col gap-1">
      {/* The native player: scrubbing, duration, and Range-backed seeking for
          free. The mobile app draws its own waveform; the web keeps it plain. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a voice note has no caption track; its transcript renders right below */}
      <audio src={file.url} controls preload="metadata" className="h-9 w-full" />
      {attachment.transcript === undefined ? null : (
        <div className="px-1 text-xs italic leading-relaxed text-muted-foreground">
          {attachment.transcript}
        </div>
      )}
    </div>
  );
}

function LocationCard({
  attachment,
}: {
  attachment: Extract<AgentUiAttachment, { kind: "location" }>;
}) {
  const coordinates = `${attachment.latitude.toFixed(5)}, ${attachment.longitude.toFixed(5)}`;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${attachment.latitude},${attachment.longitude}`;
  return (
    <a
      href={mapsUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-md items-center gap-2 self-start rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-sm transition-colors hover:border-border"
    >
      <MapPinIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground/90">Shared location</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {coordinates}
          {attachment.accuracyMeters === undefined
            ? ""
            : ` · ±${Math.round(attachment.accuracyMeters)}m`}
        </span>
      </span>
    </a>
  );
}
