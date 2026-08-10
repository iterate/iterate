// Picking images on the phone and turning them into the byte payloads
// `agent.addFiles` wants. Mirrors the web composer's submitAgentFiles
// (apps/os routes .../agents/streams/$.tsx): one addFiles call carries every
// attachment as {contentType, data: Uint8Array, filename} over the existing
// capnweb socket — no separate upload endpoint.

import * as ImagePicker from "expo-image-picker";

export type PickedImage = {
  filename: string;
  contentType: string;
  /** Base64 payload from the picker; decoded to bytes at send time. */
  base64: string;
  /** Local uri for the composer thumbnail. */
  previewUri: string;
  /** Post-recompression pixel dimensions (0 when the picker omits them). */
  width: number;
  height: number;
};

/** Open the photo library; resolves [] when the user cancels. */
export async function pickImages(options: { selectionLimit: number }): Promise<PickedImage[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: "images",
    allowsMultipleSelection: true,
    selectionLimit: options.selectionLimit,
    // Recompress: keeps giant camera HEICs from becoming 10MB+ websocket
    // frames, and normalizes to JPEG/PNG which every downstream consumer
    // (signed-url <img>, LLM vision) understands.
    quality: 0.8,
    base64: true,
  });
  if (result.canceled) return [];
  return result.assets.flatMap((asset, index) => {
    if (!asset.base64) return [];
    const contentType = asset.mimeType || "image/jpeg";
    const extension = contentType.split("/")[1] || "jpg";
    const filename = asset.fileName || `photo-${Date.now()}-${index}.${extension}`;
    return [
      {
        filename,
        contentType,
        base64: asset.base64,
        previewUri: asset.uri,
        width: asset.width || 0,
        height: asset.height || 0,
      },
    ];
  });
}

export { base64ToUint8Array } from "./encoding.ts";
