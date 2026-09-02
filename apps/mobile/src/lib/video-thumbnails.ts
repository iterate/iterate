// First-frame thumbnails for video attachments, cached per url — the video
// tile's face and the mosaic's fallback aspect-ratio source (the composer's
// <attachment .../> dimension part wins when present).

import * as VideoThumbnails from "expo-video-thumbnails";

export function videoThumbnailQuery(url: string) {
  return {
    queryKey: ["video-thumbnail", url],
    queryFn: async (): Promise<{ height: number; uri: string; width: number }> => {
      const thumb = await VideoThumbnails.getThumbnailAsync(url, { time: 0 });
      return { height: thumb.height, uri: thumb.uri, width: thumb.width };
    },
    staleTime: Infinity,
    // A build/platform that can't extract one (web) rejects; consumers treat
    // missing data as "no thumbnail" and fall back to a placeholder face.
    retry: false,
  };
}
