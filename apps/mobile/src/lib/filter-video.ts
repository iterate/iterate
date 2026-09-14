import type * as FileSystem from "expo-file-system/legacy";
import type { ComposerAttachment } from "./composer-attachments.ts";

/** Finish a WebView recording as a normal local attachment. Capture identity
 * is independent of filter IDs, which can contain project repository paths. */
export async function saveFilteredVideo({
  video,
  capturedAt,
  signal,
  fileSystem,
}: {
  video: { base64: string; mimeType: string; durationSeconds: number };
  capturedAt: number;
  signal: AbortSignal;
  fileSystem: Pick<typeof FileSystem, "cacheDirectory" | "writeAsStringAsync" | "deleteAsync">;
}): Promise<Extract<ComposerAttachment, { kind: "video" }> | null> {
  if (signal.aborted) return null;
  if (!fileSystem.cacheDirectory) throw new Error("The camera cache directory is unavailable");
  const extension = video.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  const filename = `filter-${capturedAt}.${extension}`;
  const uri = `${fileSystem.cacheDirectory}${filename}`;
  await fileSystem.writeAsStringAsync(uri, video.base64, { encoding: "base64" });
  if (signal.aborted) {
    await fileSystem.deleteAsync(uri);
    return null;
  }
  return {
    kind: "video",
    assetId: null,
    filename,
    contentType: video.mimeType.split(";")[0],
    uri,
    previewUri: null,
    durationSeconds: video.durationSeconds,
    sizeBytes: null,
    width: null,
    height: null,
  };
}
