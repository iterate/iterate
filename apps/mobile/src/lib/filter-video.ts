import type * as FileSystem from "expo-file-system/legacy";
import type { FilterVideo } from "../components/filter-camera-types.ts";
import type { ComposerAttachment } from "./composer-attachments.ts";

/** Native recording already owns a file; browser recording writes its result.
 * Capture identity
 * is independent of filter IDs, which can contain project repository paths. */
export async function saveFilteredVideo({
  video,
  capturedAt,
  signal,
  fileSystem,
}: {
  video: FilterVideo;
  capturedAt: number;
  signal: AbortSignal;
  fileSystem: Pick<typeof FileSystem, "cacheDirectory" | "writeAsStringAsync" | "deleteAsync">;
}): Promise<Extract<ComposerAttachment, { kind: "video" }> | null> {
  if (signal.aborted) {
    if ("uri" in video) await fileSystem.deleteAsync(video.uri);
    return null;
  }
  if (!("uri" in video) && !fileSystem.cacheDirectory)
    throw new Error("The camera cache directory is unavailable");
  const extension = video.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  const filename = `filter-${capturedAt}.${extension}`;
  const uri = "uri" in video ? video.uri : `${fileSystem.cacheDirectory}${filename}`;
  if (!("uri" in video))
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
    width: "uri" in video ? video.width : null,
    height: "uri" in video ? video.height : null,
  };
}
