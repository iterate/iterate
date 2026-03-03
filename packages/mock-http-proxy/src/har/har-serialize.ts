export type SerializedHarBody = {
  text: string;
  encoding?: "base64";
  size: number;
};

export function shouldTreatAsText(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded") ||
    normalized.includes("multipart/form-data")
  );
}

export function serializeBodyForHar(
  bytes: Uint8Array | null,
  contentType: string,
): SerializedHarBody | null {
  if (!bytes || bytes.byteLength === 0) return null;

  const buffer = Buffer.from(bytes);
  if (shouldTreatAsText(contentType)) {
    return {
      text: buffer.toString("utf8"),
      size: buffer.byteLength,
    };
  }

  return {
    text: buffer.toString("base64"),
    encoding: "base64",
    size: buffer.byteLength,
  };
}
