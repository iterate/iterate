// Picking images on the phone and turning them into the byte payloads
// `agent.addFiles` wants. Mirrors the web composer's submitAgentFiles
// (apps/os routes .../agents/streams/$.tsx): one addFiles call carries every
// attachment as {contentType, data: Uint8Array, filename} over the existing
// capnweb socket — no separate upload endpoint.

import * as ImagePicker from "expo-image-picker";
import { sniffImageContentType } from "./image-format.ts";
import { normalizedImageFilename } from "./media.ts";

export type PickedImage = {
  /** The photo library's own id for this image, when it has one. The
   * composer's camera-roll strip uses it to know which tiles are already
   * going into this note — including photos picked through the + button,
   * which iOS also identifies by asset id. Null for anything the library
   * cannot name (web fallbacks, future non-library sources). */
  assetId: string | null;
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
    // iOS 14+: have PHPicker hand over the most compatible representation —
    // it transcodes HEIC camera photos to JPEG at pick time, which the
    // quality option alone did not reliably do (prod: "toMarkdown failed for
    // IMG_3732.heic").
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    base64: true,
  });
  if (result.canceled) return [];
  return result.assets.flatMap((asset, index) => pickedImageFromAsset(asset, index));
}

/** One picker asset → PickedImage; [] when the picker gave no bytes. Shared
 * with the chat attachment sheet's mixed photo+video picker
 * (lib/pick-media.ts), which routes only image assets here. */
export function pickedImageFromAsset(
  asset: ImagePicker.ImagePickerAsset,
  index: number,
): PickedImage[] {
  if (!asset.base64) return [];
  // The payload's magic bytes beat asset.mimeType: iOS has labeled
  // re-encoded-to-JPEG bytes image/heic, and the label decides the uploaded
  // filename's extension — which server-side toMarkdown picks its
  // converter by. The label is only the fallback for unrecognized heads.
  const contentType = sniffImageContentType(asset.base64) || asset.mimeType || "image/jpeg";
  // The extension must match the recompressed payload, not the library's
  // original fileName (often .HEIC) — see normalizedImageFilename.
  const filename = normalizedImageFilename(
    asset.fileName,
    contentType,
    `photo-${Date.now()}-${index}`,
  );
  return [
    {
      assetId: asset.assetId || null,
      filename,
      contentType,
      base64: asset.base64,
      previewUri: asset.uri,
      width: asset.width || 0,
      height: asset.height || 0,
    },
  ];
}

export { base64ToUint8Array } from "./encoding.ts";
