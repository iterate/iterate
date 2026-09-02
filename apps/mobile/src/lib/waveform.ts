// Bar heights for the audio player's Telegram-style waveform. There is no
// decoded audio to draw (the file is a remote url; decoding it client-side
// for a decoration isn't worth the bytes), so the bars are DETERMINISTIC
// pseudo-random from the file's identity: the same clip always draws the
// same waveform, on every device, with a natural-looking spread. The
// waveform's real job — being a scrubber with visible progress — doesn't
// depend on the heights being spectral truth.

/** How many bars the player draws; the scrubber's resolution. */
export const WAVEFORM_BAR_COUNT = 36;

/** Heights in 0.15..1, deterministic for a given seed (use the file url or
 * name). Smoothed so neighbours relate like real audio does. */
export function waveformBars(seed: string, count: number): number[] {
  // FNV-1a, then an xorshift stream off it — tiny, stable, no deps.
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // >>> 0 makes it unsigned; scale to 0..1.
    return (state >>> 0) / 4294967296;
  };
  const raw = Array.from({ length: count }, () => next());
  // One smoothing pass (each bar averaged with its neighbours) keeps it
  // looking like speech rather than static.
  return raw.map((value, index) => {
    const previous = raw[index - 1] === undefined ? value : raw[index - 1]!;
    const following = raw[index + 1] === undefined ? value : raw[index + 1]!;
    const smoothed = (previous + value * 2 + following) / 4;
    return 0.15 + smoothed * 0.85;
  });
}
