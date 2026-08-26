// The Expo-welded half of the composer's camera-roll strip: permission,
// listing the newest assets, and turning the one you tapped into the same
// PickedImage payload the + picker produces.
//
// Two things are load-bearing here.
//
// 1. Permission is read WITHOUT prompting (recent-photos-core.ts explains
//    why). Only a tap on the Allow tile calls the prompting variant.
//
// 2. Tapping a tile RE-ENCODES the asset to JPEG. MediaLibrary hands back
//    the original file, which on a default iPhone ("High Efficiency") is
//    HEIC — and lib/image-format.ts's unsupportedImageReason exists because
//    the server's toMarkdown has no HEIC converter. The + picker never hit
//    this: PHPicker's `Compatible` representation mode transcodes at pick
//    time (see lib/attachments.ts). So the strip does the same job with
//    expo-image-manipulator, at the same compress: 0.8 the picker uses —
//    which also keeps a 12MP original from becoming a 10MB websocket frame.

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as MediaLibrary from "expo-media-library";
import { Platform } from "react-native";
import type { PickedImage } from "./attachments.ts";
import { sniffImageContentType } from "./image-format.ts";
import { normalizedImageFilename } from "./media.ts";
import { photoLibraryAccessFrom, type PhotoLibraryAccess } from "./recent-photos-core.ts";

/** One camera-roll tile: enough to draw it, not enough to send it. The bytes
 * are only read when you tap (they can involve an iCloud download). */
export type RecentPhoto = {
  assetId: string;
  /** iOS hands back a `ph://` URI, which RN's Image renders directly — no
   * per-tile getAssetInfoAsync round trip just to draw the strip. */
  previewUri: string;
};

export async function readPhotoLibraryAccess(): Promise<PhotoLibraryAccess> {
  const library = webPhotoLibrary();
  if (library !== null) return library.length > 0 ? "granted" : "unavailable";
  if (Platform.OS === "web") return "unavailable";
  return photoLibraryAccessFrom(await MediaLibrary.getPermissionsAsync());
}

/** The prompting variant — reached only by a tap on the Allow tile. */
export async function requestPhotoLibraryAccess(): Promise<PhotoLibraryAccess> {
  return photoLibraryAccessFrom(await MediaLibrary.requestPermissionsAsync());
}

export async function readRecentPhotos(limit: number): Promise<RecentPhoto[]> {
  const library = webPhotoLibrary();
  if (library !== null) {
    return library.slice(0, limit).map((photo) => ({
      assetId: photo.assetId,
      previewUri: photo.dataUri,
    }));
  }
  // Everything, not just screenshots: the screenshots-only walk belongs to
  // the sync engine (lib/media-sync.ts), whose job is different.
  const page = await MediaLibrary.getAssetsAsync({
    mediaType: "photo",
    sortBy: [["creationTime", false]],
    first: limit,
  });
  return page.assets.map((asset) => ({ assetId: asset.id, previewUri: asset.uri }));
}

/** Read the tapped asset as an attachment. Throws with something a human can
 * act on — the composer surfaces it inline rather than dropping the tap. */
export async function readPhotoAsAttachment(photo: RecentPhoto): Promise<PickedImage> {
  const library = webPhotoLibrary();
  if (library !== null) {
    const found = library.find((entry) => entry.assetId === photo.assetId);
    if (found === undefined) throw new Error(`No photo ${photo.assetId} in the library`);
    return fromDataUri(found.assetId, found.filename, found.dataUri);
  }
  const info = await MediaLibrary.getAssetInfoAsync(photo.assetId);
  if (!info.localUri) {
    // An iCloud-only asset whose download failed. Not fatal: the + picker
    // can still fetch it, and that message says so.
    throw new Error("That photo isn't downloaded to this phone — try the + picker instead.");
  }
  const rendered = await ImageManipulator.manipulate(info.localUri).renderAsync();
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.8,
    base64: true,
  });
  if (!saved.base64) throw new Error("Couldn't read that photo's bytes");
  // The magic bytes beat the label even here — same scar tissue as
  // lib/attachments.ts, and the label decides the uploaded file's extension.
  const contentType = sniffImageContentType(saved.base64) || "image/jpeg";
  return {
    assetId: photo.assetId,
    filename: normalizedImageFilename(info.filename, contentType, `photo-${photo.assetId}`),
    contentType,
    base64: saved.base64,
    previewUri: saved.uri,
    width: saved.width,
    height: saved.height,
  };
}

// --- The web build's photo library ----------------------------------------
//
// A browser has no camera roll, so on web this strip has no real source. The
// web build is where this app's browser specs run (apps/mobile README, "Run
// and test it in a browser"), and the strip is pure UI — leaving it
// unrenderable there would mean the only tests that draw real screens can
// never see it. So the web build reads its library from one boundary a spec
// fills in with page.addInitScript(). Native never reads it: every caller
// above only consults the boundary, and nothing sets it outside a browser.

type WebPhoto = { assetId: string; filename: string; dataUri: string };

declare global {
  var __ITERATE_WEB_PHOTO_LIBRARY__: WebPhoto[] | undefined;
}

function webPhotoLibrary(): WebPhoto[] | null {
  if (Platform.OS !== "web") return null;
  return globalThis.__ITERATE_WEB_PHOTO_LIBRARY__ || null;
}

function fromDataUri(assetId: string, filename: string, dataUri: string): PickedImage {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const contentType = sniffImageContentType(base64) || "image/jpeg";
  return {
    assetId,
    filename: normalizedImageFilename(filename, contentType, `photo-${assetId}`),
    contentType,
    base64,
    previewUri: dataUri,
    width: 0,
    height: 0,
  };
}
