// The attachment sheet's carousel data: the newest ~10 camera-roll items,
// photos AND videos (the note composer's strip in lib/recent-photos.ts stays
// photo-only — its job is different). Same permission discipline as that
// file: read without prompting, prompt only from an explicit tap.
//
// Tapping a photo reuses readPhotoAsAttachment (re-encode to JPEG — the HEIC
// scar tissue lives there). Tapping a video resolves its local file uri and
// becomes a lazy-read video attachment; bytes only move at send time.

import * as MediaLibrary from "expo-media-library";
import { Platform } from "react-native";
import type { ComposerAttachment } from "./composer-attachments.ts";
import { oversizeReason } from "./composer-attachments.ts";
import { readPhotoAsAttachment } from "./recent-photos.ts";

export const CAROUSEL_LIMIT = 50;

export type RecentMediaItem = {
  assetId: string;
  /** iOS `ph://` uri — RN's Image renders it for photos and video posters. */
  previewUri: string;
  mediaType: "photo" | "video";
  durationSeconds: number;
  /** ❤️'d in the photo library — the carousel badges these. */
  isFavorite: boolean;
};

export async function readRecentMedia(limit: number): Promise<RecentMediaItem[]> {
  if (Platform.OS === "web") {
    // The web build (where browser specs run) reads the same injected
    // library the note composer's strip uses — photos only.
    const library = globalThis.__ITERATE_WEB_PHOTO_LIBRARY__ || [];
    return library.slice(0, limit).map((photo) => ({
      assetId: photo.assetId,
      previewUri: photo.dataUri,
      mediaType: "photo" as const,
      durationSeconds: 0,
      isFavorite: false,
    }));
  }
  const page = await MediaLibrary.getAssetsAsync({
    mediaType: ["photo", "video"],
    sortBy: [["creationTime", false]],
    first: limit,
  });
  // isFavorite only rides the per-asset info lookup; metadata-only (no
  // network) so fifty in parallel stay quick, and a straggler just loses
  // its heart badge.
  const infos = await Promise.all(
    page.assets.map((asset) =>
      MediaLibrary.getAssetInfoAsync(asset.id, { shouldDownloadFromNetwork: false }).catch(
        () => null,
      ),
    ),
  );
  return page.assets.map((asset, index) => ({
    assetId: asset.id,
    previewUri: asset.uri,
    mediaType: asset.mediaType === "video" ? "video" : "photo",
    durationSeconds: asset.duration,
    isFavorite: infos[index]?.isFavorite === true,
  }));
}

/** Turn a tapped carousel item into an attachment. Throws human-readable —
 * the sheet surfaces the message inline. */
export async function readMediaAsAttachment(item: RecentMediaItem): Promise<ComposerAttachment> {
  if (item.mediaType === "photo") {
    const image = await readPhotoAsAttachment({
      assetId: item.assetId,
      previewUri: item.previewUri,
    });
    return { kind: "photo", image };
  }
  const info = await MediaLibrary.getAssetInfoAsync(item.assetId);
  if (!info.localUri) {
    throw new Error("That video isn't downloaded to this phone — try All photos instead.");
  }
  const extension = info.localUri.split(".").at(-1)?.toLowerCase() || "mov";
  const refusal = oversizeReason(videoSizeBytes(info));
  if (refusal !== null) throw new Error(refusal);
  return {
    kind: "video",
    assetId: item.assetId,
    filename: info.filename || `video-${item.assetId}.${extension}`,
    contentType: extension === "mp4" ? "video/mp4" : "video/quicktime",
    uri: info.localUri,
    previewUri: item.previewUri,
    durationSeconds: info.duration,
    sizeBytes: videoSizeBytes(info),
    width: info.width || null,
    height: info.height || null,
  };
}

function videoSizeBytes(info: MediaLibrary.AssetInfo): number | null {
  // MediaLibrary's iOS payload doesn't type a size field; fileSize rides on
  // the raw object when the platform provides one. The `any` hop is safe
  // because the typeof check below is the only consumer — anything but a
  // number becomes null.
  const size = (info as any).fileSize;
  return typeof size === "number" ? size : null;
}
