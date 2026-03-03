export type SerializedHarBody = {
  text: string;
  encoding?: "base64";
  size: number;
};

export async function readRequestBodyBytes(request: Request): Promise<Uint8Array | null> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;

  const cloned = request.clone();
  const arrayBuffer = await cloned.arrayBuffer();
  if (arrayBuffer.byteLength === 0) return null;
  return new Uint8Array(arrayBuffer);
}

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
