import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const defaultReadChunkBytes = 64 * 1_024;

export interface RetainedPcm16ArtifactInspection {
  byteLength: number;
  maximumBufferedAudioBytes: number;
  sha256: string;
}

/**
 * Derives exact source-artifact facts without trusting transport metadata.
 *
 * One descriptor is held from the first stat through the final identity
 * check. Reopening by path between hashing and validation would allow a
 * replaced file to combine facts from two different artifacts. The fixed read
 * buffer also makes host memory independent of the endurance duration.
 */
export async function inspectRetainedPcm16Artifact(options: {
  artifactPath: string;
  readChunkBytes?: number;
}): Promise<RetainedPcm16ArtifactInspection> {
  if (!options.artifactPath.trim() || options.artifactPath.includes("\0")) {
    throw new Error("The retained PCM16 artifact path must be non-empty.");
  }
  const requestedReadChunkBytes = options.readChunkBytes ?? defaultReadChunkBytes;
  if (
    !Number.isSafeInteger(requestedReadChunkBytes) ||
    requestedReadChunkBytes <= 0 ||
    requestedReadChunkBytes % Int16Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new Error("The retained PCM16 read buffer must contain whole samples.");
  }

  const artifact = await open(options.artifactPath, "r");
  try {
    const before = await artifact.stat();
    if (!before.isFile()) {
      throw new Error("The retained PCM16 artifact must be a regular file.");
    }
    if (before.size <= 0 || before.size % Int16Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error("The retained PCM16 artifact must contain whole samples.");
    }
    const readBuffer = Buffer.allocUnsafe(Math.min(requestedReadChunkBytes, before.size));
    const hash = createHash("sha256");
    for (let position = 0; position < before.size; ) {
      const requestedBytes = Math.min(readBuffer.byteLength, before.size - position);
      const { bytesRead } = await artifact.read(readBuffer, 0, requestedBytes, position);
      if (bytesRead <= 0) {
        throw new Error("The retained PCM16 artifact ended before its reported file size.");
      }
      hash.update(readBuffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await artifact.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("The retained PCM16 artifact changed while it was being inspected.");
    }
    return {
      byteLength: before.size,
      maximumBufferedAudioBytes: readBuffer.byteLength,
      sha256: hash.digest("hex"),
    };
  } finally {
    await artifact.close();
  }
}
