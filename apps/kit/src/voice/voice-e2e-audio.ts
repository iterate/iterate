export function createFixedPcmFrames(
  pcm: Uint8Array,
  frameBytes: number,
  trailingSilenceFrames: number,
) {
  if (pcm.byteLength % 2 !== 0) {
    throw new Error("PCM16 input must contain complete 16-bit samples.");
  }
  if (
    !Number.isSafeInteger(frameBytes) ||
    frameBytes <= 0 ||
    frameBytes % 2 !== 0
  ) {
    throw new Error(
      "The PCM frame size must be a positive, even integer.",
    );
  }
  if (
    !Number.isSafeInteger(trailingSilenceFrames) ||
    trailingSilenceFrames < 0
  ) {
    throw new Error(
      "The trailing silence frame count must be a non-negative integer.",
    );
  }

  const audioFrameCount = Math.ceil(pcm.byteLength / frameBytes);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < audioFrameCount; index += 1) {
    const offset = index * frameBytes;
    const source = pcm.subarray(offset, offset + frameBytes);
    const frame = new Uint8Array(frameBytes);
    frame.set(source);
    frames.push(frame);
  }
  for (let index = 0; index < trailingSilenceFrames; index += 1) {
    frames.push(new Uint8Array(frameBytes));
  }
  return frames;
}
