// The attachment sheet's system-picker lanes: the full photo library (now
// with videos), documents, and a one-shot current-location read. Everything
// resolves to ComposerAttachment; everything but photos stays a local uri
// until send time (lib/composer-attachments.ts explains the laziness).

import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { pickedImageFromAsset } from "./attachments.ts";
import { oversizeReason, type ComposerAttachment } from "./composer-attachments.ts";

/** The full-screen library picker, photos AND videos. Resolves [] on cancel. */
export async function pickLibraryMedia(options: {
  selectionLimit: number;
}): Promise<ComposerAttachment[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: true,
    selectionLimit: options.selectionLimit,
    // Image handling matches lib/attachments.ts pickImages (recompress +
    // Compatible representation — the HEIC scar tissue).
    quality: 0.8,
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    base64: true,
    videoExportPreset: ImagePicker.VideoExportPreset.MediumQuality,
  });
  if (result.canceled) return [];
  const attachments: ComposerAttachment[] = [];
  for (const [index, asset] of result.assets.entries()) {
    if (asset.type === "video") {
      const refusal = oversizeReason(asset.fileSize || null);
      if (refusal !== null) throw new Error(refusal);
      const extension = asset.uri.split(".").at(-1)?.toLowerCase() || "mp4";
      attachments.push({
        kind: "video",
        assetId: asset.assetId || null,
        filename: asset.fileName || `video-${Date.now()}-${index}.${extension}`,
        contentType: asset.mimeType || (extension === "mov" ? "video/quicktime" : "video/mp4"),
        uri: asset.uri,
        previewUri: null,
        durationSeconds: typeof asset.duration === "number" ? asset.duration / 1000 : null,
        sizeBytes: asset.fileSize || null,
        width: asset.width || null,
        height: asset.height || null,
      });
      continue;
    }
    attachments.push(
      ...pickedImageFromAsset(asset, index).map((image) => ({ kind: "photo" as const, image })),
    );
  }
  return attachments;
}

/** The document picker — "any" for the Files row, "audio" for the Audio
 * recordings row (existing voice memos, exported recordings, music files).
 * Resolves [] on cancel. */
export async function pickDocuments(kind: "any" | "audio"): Promise<ComposerAttachment[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    // A picked iCloud/provider file may not be readable at send time; the
    // cache copy is ours until then.
    copyToCacheDirectory: true,
    type: kind === "audio" ? "audio/*" : "*/*",
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => {
    const refusal = oversizeReason(asset.size === undefined ? null : asset.size);
    if (refusal !== null) throw new Error(`${asset.name}: ${refusal}`);
    return {
      kind: kind === "audio" ? "audio" : "file",
      filename: asset.name,
      contentType: asset.mimeType || "application/octet-stream",
      uri: asset.uri,
      ...(kind === "audio" ? { durationSeconds: null } : { sizeBytes: asset.size || null }),
    } as ComposerAttachment;
  });
}

/** One current-position read for the Location row. Throws human-readable on
 * refusal. */
export async function captureCurrentLocation(): Promise<ComposerAttachment> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      "Location permission was refused — allow it in Settings to attach where you are.",
    );
  }
  const position = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  return {
    kind: "location",
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: position.coords.accuracy,
    capturedAt: new Date(position.timestamp).toISOString(),
  };
}
