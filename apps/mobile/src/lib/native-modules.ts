// Guarded access to the native modules the attachment surface needs. An
// installed dev client only has the native code it was built with (README:
// "two builds, one phone"), so a JS update can reach phones whose binary
// predates expo-camera & co. Requiring such a module throws at evaluation
// time; these loaders catch that once and the UI hides the feature instead
// of crashing the screen — same degradation the camera-roll strip and native
// markdown renderer established.
//
// Metro resolves literal require() calls statically, so the modules are in
// the JS bundle either way; only the native lookup can fail.

import { Platform } from "react-native";

function memoize<T>(load: () => T): () => T | null {
  let cached: { value: T | null } | null = null;
  return () => {
    if (cached === null) {
      try {
        cached = { value: load() };
      } catch {
        cached = { value: null };
      }
    }
    return cached.value;
  };
}

export const loadCamera = memoize(() => require("expo-camera") as typeof import("expo-camera"));

export const loadAudio = memoize(() => require("expo-audio") as typeof import("expo-audio"));

export const loadLocation = memoize(
  () => require("expo-location") as typeof import("expo-location"),
);

export const loadDocumentPicker = memoize(
  () => require("expo-document-picker") as typeof import("expo-document-picker"),
);

export const loadVideo = memoize(() => require("expo-video") as typeof import("expo-video"));

export const loadVideoThumbnails = memoize(
  () => require("expo-video-thumbnails") as typeof import("expo-video-thumbnails"),
);

export const loadFileSystem = memoize(
  // The legacy entry point: the SDK 54 File API is fine too, but
  // readAsStringAsync is all we need and its shape is long-stable.
  () => require("expo-file-system/legacy") as typeof import("expo-file-system/legacy"),
);

/** Whether this build can run the hold-to-record button at all (chat keeps
 * the plain dimmed send button otherwise). */
export function recordControlsAvailable(): boolean {
  return Platform.OS !== "web" && loadAudio() !== null;
}

/** Whether inline audio playback is available in this build. */
export function audioPlayerAvailable(): boolean {
  return loadAudio() !== null;
}

/** First-frame thumbnail (uri + pixel dimensions) for a remote video, cached
 * per url; data null when this build can't extract one. Both the video tile
 * and the mosaic layout read it. */
export function videoThumbnailQuery(url: string) {
  return {
    queryKey: ["video-thumbnail", url],
    queryFn: async (): Promise<{ height: number; uri: string; width: number } | null> => {
      const thumbnails = loadVideoThumbnails();
      if (thumbnails === null) return null;
      const thumb = await thumbnails.getThumbnailAsync(url, { time: 0 });
      return { height: thumb.height, uri: thumb.uri, width: thumb.width };
    },
    staleTime: Infinity,
    retry: false,
  };
}

/** Read a local file's bytes as base64 — the send-time boundary
 * lib/composer-attachments.ts's attachmentUploads takes. */
export async function readFileBase64(uri: string): Promise<string> {
  const fileSystem = loadFileSystem();
  if (fileSystem === null) throw new Error("File reading isn't available in this build");
  return await fileSystem.readAsStringAsync(uri, { encoding: "base64" });
}
