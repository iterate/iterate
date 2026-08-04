/** Encodes mono PCM16LE as a RIFF/WAVE file accepted by macOS `afplay`. */
export function encodeMonoPcm16Wave(pcm: Uint8Array, sampleRateHz: number) {
  if (pcm.byteLength === 0 || pcm.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("A WAVE fixture must contain a non-empty whole number of PCM16 samples.");
  }
  if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error("A WAVE fixture requires a positive whole sample rate.");
  }
  const headerBytes = 44;
  const bytes = new Uint8Array(headerBytes + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * Int16Array.BYTES_PER_ELEMENT, true);
  view.setUint16(32, Int16Array.BYTES_PER_ELEMENT, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, headerBytes);
  return bytes;
}

/**
 * Extracts mono PCM16LE from a RIFF/WAVE file without assuming a 44-byte header.
 *
 * macOS `say` inserts a large FLLR chunk before `data`. Walking the declared
 * RIFF chunks is therefore part of the acoustic test's integrity: treating a
 * convenience header offset as a media invariant would silently compare
 * metadata and audio. The decoder accepts unknown, bounded chunks but rejects
 * compressed, stereo, truncated, and internally inconsistent formats before
 * they can become a false AEC oracle.
 */
export function decodeMonoPcm16Wave(wave: Uint8Array) {
  if (
    wave.byteLength < 12 ||
    readFourCharacterCode(wave, 0) !== "RIFF" ||
    readFourCharacterCode(wave, 8) !== "WAVE"
  ) {
    throw new Error("A mono PCM16 WAVE fixture requires a complete RIFF/WAVE header.");
  }
  const view = new DataView(wave.buffer, wave.byteOffset, wave.byteLength);
  const riffBytes = view.getUint32(4, true) + 8;
  if (riffBytes < 12 || riffBytes > wave.byteLength) {
    throw new Error("A mono PCM16 WAVE fixture has a truncated RIFF payload.");
  }

  let channelCount: number | undefined;
  let formatTag: number | undefined;
  let sampleBits: number | undefined;
  let sampleRateHz: number | undefined;
  let pcm: Uint8Array | undefined;
  for (let chunkOffset = 12; chunkOffset < riffBytes; ) {
    if (chunkOffset + 8 > riffBytes) {
      throw new Error("A mono PCM16 WAVE fixture has a truncated chunk header.");
    }
    const chunkKind = readFourCharacterCode(wave, chunkOffset);
    const chunkLength = view.getUint32(chunkOffset + 4, true);
    const payloadOffset = chunkOffset + 8;
    const payloadEnd = payloadOffset + chunkLength;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > riffBytes) {
      throw new Error(`A mono PCM16 WAVE fixture has a truncated ${chunkKind} chunk.`);
    }
    if (chunkKind === "fmt ") {
      if (chunkLength < 16) {
        throw new Error("A mono PCM16 WAVE fixture has an incomplete format chunk.");
      }
      formatTag = view.getUint16(payloadOffset, true);
      channelCount = view.getUint16(payloadOffset + 2, true);
      sampleRateHz = view.getUint32(payloadOffset + 4, true);
      sampleBits = view.getUint16(payloadOffset + 14, true);
    } else if (chunkKind === "data") {
      if (pcm !== undefined) {
        throw new Error("A mono PCM16 WAVE fixture must contain exactly one data chunk.");
      }
      pcm = wave.slice(payloadOffset, payloadEnd);
    }
    chunkOffset = payloadEnd + (chunkLength % 2);
  }

  if (
    formatTag !== 1 ||
    channelCount !== 1 ||
    sampleBits !== 16 ||
    typeof sampleRateHz !== "number" ||
    !Number.isSafeInteger(sampleRateHz) ||
    sampleRateHz <= 0 ||
    !pcm ||
    pcm.byteLength === 0 ||
    pcm.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new Error("A WAVE fixture must contain non-empty mono PCM16 audio.");
  }
  return { pcm, sampleRateHz };
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function readFourCharacterCode(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}
