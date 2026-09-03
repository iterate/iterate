// Pitch detection + solfège math for the sing-the-scale filter. Pure — the
// pipeline (filter-camera.tsx) feeds mic samples in; the filter consumes the
// detected frequency from its frame args.

/** Detected fundamental of one mic buffer via time-domain autocorrelation
 * (the classic tuner algorithm), or null when the signal is too quiet or
 * too noisy to call. */
export function autoCorrelatePitchHz(samples: Float32Array, sampleRate: number): number | null {
  const size = samples.length;
  let rms = 0;
  for (let i = 0; i < size; i++) rms += samples[i] * samples[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.012) return null;

  // Search lags for 70Hz..1000Hz — generous singing range in any octave.
  const minLag = Math.floor(sampleRate / 1000);
  const maxLag = Math.min(Math.floor(sampleRate / 70), size - 1);
  let bestLag = -1;
  let bestCorrelation = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let i = 0; i < size - lag; i++) correlation += samples[i] * samples[i + lag];
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;
  let zeroLag = 0;
  for (let i = 0; i < size; i++) zeroLag += samples[i] * samples[i];
  // Voiced sound correlates strongly at its period; noise doesn't.
  if (bestCorrelation / zeroLag < 0.5) return null;
  // Parabolic interpolation around the best lag for sub-sample precision —
  // integer lags alone are ~a third of a semitone coarse at singing pitch.
  const at = (lag: number) => {
    let correlation = 0;
    for (let i = 0; i < size - lag; i++) correlation += samples[i] * samples[i + lag];
    return correlation;
  };
  const previous = at(bestLag - 1);
  const next = at(bestLag + 1);
  const denominator = previous - 2 * bestCorrelation + next;
  const offset = denominator === 0 ? 0 : (0.5 * (previous - next)) / denominator;
  return sampleRate / (bestLag + Math.max(-0.5, Math.min(0.5, offset)));
}

/** The major scale as semitone offsets from do. */
export const SOLFEGE = [
  { name: "Do", semitone: 0 },
  { name: "Re", semitone: 2 },
  { name: "Mi", semitone: 4 },
  { name: "Fa", semitone: 5 },
  { name: "Sol", semitone: 7 },
  { name: "La", semitone: 9 },
  { name: "Ti", semitone: 11 },
  { name: "Do", semitone: 12 },
];

/** Signed distance in semitones from `hz` to the nearest octave-equivalent
 * of `referenceHz`, folded into [-6, 6) — "how flat or sharp, ignoring
 * which octave you chose". */
export function foldedSemitoneOffset(hz: number, referenceHz: number): number {
  const semitones = 12 * Math.log2(hz / referenceHz);
  return (((((semitones % 12) + 12) % 12) + 6) % 12) - 6;
}
