// Local-file byte access for the composer's lazy uploads.

import * as FileSystem from "expo-file-system/legacy";

/** Read a local file's bytes as base64 — the send-time boundary
 * lib/composer-attachments.ts's attachmentUploads takes. */
export async function readFileBase64(uri: string): Promise<string> {
  return await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
}
