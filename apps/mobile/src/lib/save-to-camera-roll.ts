// Save any viewed media (photo or video) to the camera roll. Remote and
// data: uris become a local cache file first — MediaLibrary only takes
// local files. Shared by the photo viewer and the fullscreen video player.

import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";

export async function saveMediaToCameraRoll(uri: string, fallbackExtension: string) {
  let localUri = uri;
  if (/^https?:/.test(uri)) {
    const extension =
      /\.(jpe?g|png|gif|webp|heic|mp4|mov|m4v|webm)(\?|$)/i.exec(uri)?.[1] || fallbackExtension;
    const result = await FileSystem.downloadAsync(
      uri,
      `${FileSystem.cacheDirectory}download-${Date.now()}.${extension}`,
    );
    localUri = result.uri;
  } else if (uri.startsWith("data:")) {
    const match = /^data:(?:image|video)\/(\w+);base64,(.+)$/.exec(uri);
    if (!match) throw new Error("Unrecognized data uri");
    localUri = `${FileSystem.cacheDirectory}download-${Date.now()}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
    await FileSystem.writeAsStringAsync(localUri, match[2], {
      encoding: FileSystem.EncodingType.Base64,
    });
  }
  await MediaLibrary.saveToLibraryAsync(localUri);
}
