/**
 * PCM16 rate conversion — the one transcode this pipeline performs, done
 * properly, in its own file so it can be tested as arithmetic.
 *
 * WHY THE LINEAR VERSION HAD TO GO. The pipeline is 16 kHz end to end and
 * OpenAI's realtime API speaks only 24 (its GA formats are pcm16 at a fixed
 * 24 kHz or G.711 at 8 — there is no 16 kHz escape hatch), so every OpenAI
 * answer is downsampled 3:2 at the facet door. The first cut interpolated
 * linearly between neighbouring samples, per delta, and its comment claimed
 * the cost was "nothing anybody hears". Measured by ear against the OpenAI
 * app playing the same voice: substantially worse, and for two reasons the
 * comment did not know about.
 *
 *   NO ANTI-ALIASING FILTER. Decimating 24 -> 16 kHz without a low-pass
 *   first folds everything the source carries between 8 and 12 kHz back
 *   down into 4-8 kHz, mirrored — inharmonic content sitting right in the
 *   band that makes speech crisp. Linear interpolation attenuates the top
 *   octave a little; it is nowhere near a filter. That fold-down is the
 *   metallic grit. Grok never sounded wrong for exactly this reason: it is
 *   16 kHz native, the resampler was an identity, and the defect was
 *   invisible until a second provider arrived.
 *
 *   PER-DELTA ENDPOINT PINNING. The old function mapped each delta's first
 *   and last sample onto the output's first and last (`index * (n-1) /
 *   (m-1)`), so every delta was resampled at a slightly wrong, slightly
 *   different rate and the conversion phase snapped back to zero at every
 *   delta boundary — a seam per delta, at whatever cadence the provider
 *   happened to flush.
 *
 * WHAT THIS IS. A polyphase windowed-sinc resampler for the rational
 * ratios this lab actually uses (24 -> 16 and 16 -> 24), with the
 * conversion phase and a tail of input history CARRIED ACROSS PUSHES —
 * one continuous conversion per stream, however the bytes were chunked in
 * transit. Push in what arrived, get out what is ready; the filter holds
 * the last HALF_TAPS input samples (1.3 ms at 24 kHz) until the next push
 * proves what follows them, which is why per-push output length is not
 * exactly input * ratio and cumulative output is, minus that fixed
 * sub-frame latency.
 *
 * WHAT IT IS NOT. Not a codec (mu-law lived and died elsewhere — see
 * voice-agent.ts), not arbitrary-ratio (the bank is built per rational
 * ratio and cached; any pair of rates whose ratio reduces small works,
 * which is all a fleet of fixed-rate devices needs), and not zero-cost:
 * 2 * HALF_TAPS multiplies per output sample, ~200k per second of speech,
 * which a Durable Object does not notice.
 */

/**
 * Taps per side of the kernel's centre. 64 taps total.
 *
 * The knob trades treble for aliasing rejection: a Blackman-windowed sinc
 * this long has a ~2 kHz transition band, so with the cutoff below the
 * passband is honest to ~6.5 kHz, the stopband is fully down (~-58 dB, vs
 * the ZERO dB of no filter at all) by ~8.4 kHz, and the sliver of 8-8.4 kHz
 * source energy that still folds lands mirrored above 7.6 kHz at -30 dB or
 * better — under speech masking, against the old fold-down of the entire
 * 8-12 kHz band at full strength.
 */
const HALF_TAPS = 32;

/**
 * Cutoff as a fraction of the tighter Nyquist. Below 1 because a windowed
 * kernel needs somewhere to roll off; 0.92 centres the transition band just
 * under the edge instead of straddling it.
 */
const ROLLOFF = 0.92;

/** One polyphase bank per fractional phase the ratio can land on, cached
 * per ratio — building it costs trig, using it costs multiplies. */
const bankCache = new Map<string, readonly Float64Array[]>();

function filterBanks(fromRate: number, toRate: number, phases: number): readonly Float64Array[] {
  const key = `${String(fromRate)}->${String(toRate)}`;
  const cached = bankCache.get(key);
  if (cached !== undefined) return cached;
  /* Cycles per INPUT sample. Downsampling protects the OUTPUT Nyquist;
   * upsampling only has to stop short of the input's own. */
  const cutoff = 0.5 * Math.min(1, toRate / fromRate) * ROLLOFF;
  const banks: Float64Array[] = [];
  for (let phase = 0; phase < phases; phase++) {
    const taps = new Float64Array(2 * HALF_TAPS);
    let sum = 0;
    for (let k = 0; k < taps.length; k++) {
      /* Distance from this tap to the output sample's true position, in
       * input samples: the phase is the fractional part of that position. */
      const x = k - (HALF_TAPS - 1) - phase / phases;
      const window =
        0.42 +
        0.5 * Math.cos((Math.PI * x) / HALF_TAPS) +
        0.08 * Math.cos((2 * Math.PI * x) / HALF_TAPS);
      const t = 2 * cutoff * x;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      taps[k] = 2 * cutoff * sinc * window;
      sum += taps[k]!;
    }
    /* Each phase normalised to unity DC gain SEPARATELY. Normalising the
     * ratio's phases together leaves each a fraction of a percent off, and
     * that fraction is periodic at the phase rate — amplitude ripple at
     * 8 kHz, which is a tone. */
    for (let k = 0; k < taps.length; k++) taps[k] = taps[k]! / sum;
    banks.push(taps);
  }
  bankCache.set(key, banks);
  return banks;
}

/** Greatest common divisor, for reducing the rate pair to its ratio. */
function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** The bytes as samples, copying only when the view is misaligned. */
function int16From(bytes: Uint8Array): Int16Array {
  const samples = Math.floor(bytes.byteLength / 2);
  if (bytes.byteOffset % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, samples);
  }
  const copy = new Uint8Array(samples * 2);
  copy.set(bytes.subarray(0, samples * 2));
  return new Int16Array(copy.buffer);
}

/**
 * One direction of one stream's rate conversion, phase carried across pushes.
 *
 * An INSTANCE PER STREAM, not a function per chunk, because the whole point
 * is state: where the conversion is between two input samples, and the tail
 * of input the kernel is still allowed to look back at. Feed it a stream's
 * chunks in order; `reset()` at a boundary where the audio genuinely starts
 * over (a new answer), and the same-rate case is a true identity that
 * returns the caller's own bytes untouched.
 */
export class Pcm16Resampler {
  readonly fromRate: number;
  readonly toRate: number;
  /** Input samples per output sample, as the reduced ratio stepNum/phases. */
  readonly #stepNum: number;
  readonly #phases: number;
  readonly #banks: readonly Float64Array[];
  /** Retained tail of input the next push's first outputs still need. */
  #history: Int16Array = new Int16Array(0);
  /** Next output's position past the history's start, in 1/#phases units. */
  #posNum = 0;

  constructor(fromRate: number, toRate: number) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    const divisor = gcd(fromRate, toRate);
    this.#stepNum = fromRate / divisor;
    this.#phases = toRate / divisor;
    this.#banks = fromRate === toRate ? [] : filterBanks(fromRate, toRate, this.#phases);
  }

  /** Convert what arrived; return what is ready. */
  push(bytes: Uint8Array): Uint8Array {
    if (this.fromRate === this.toRate) return bytes;
    const fresh = int16From(bytes);
    const held = this.#history;
    const buffer = new Int16Array(held.length + fresh.length);
    buffer.set(held, 0);
    buffer.set(fresh, held.length);
    /* An output is ready when its whole kernel window exists: samples
     * base-HALF_TAPS+1 through base+HALF_TAPS. Before the stream's start
     * the window reads silence, which is what a stream starting from
     * nothing means. */
    const maxBase = buffer.length - 1 - HALF_TAPS;
    const out = new Int16Array(Math.ceil((buffer.length * this.#phases) / this.#stepNum) + 2);
    let produced = 0;
    let posNum = this.#posNum;
    for (;;) {
      const phase = posNum % this.#phases;
      const base = (posNum - phase) / this.#phases;
      if (base > maxBase) break;
      const taps = this.#banks[phase]!;
      const start = base - HALF_TAPS + 1;
      let acc = 0;
      for (let k = start < 0 ? -start : 0; k < taps.length; k++) {
        acc += buffer[start + k]! * taps[k]!;
      }
      const rounded = Math.round(acc);
      out[produced++] = rounded > 32767 ? 32767 : rounded < -32768 ? -32768 : rounded;
      posNum += this.#stepNum;
    }
    const nextBase = (posNum - (posNum % this.#phases)) / this.#phases;
    const keepFrom = Math.min(buffer.length, Math.max(0, nextBase - HALF_TAPS + 1));
    this.#history = buffer.slice(keepFrom);
    this.#posNum = posNum - keepFrom * this.#phases;
    return new Uint8Array(out.buffer, 0, produced * 2);
  }

  /** Forget the stream: the next push starts a new one. */
  reset(): void {
    this.#history = new Int16Array(0);
    this.#posNum = 0;
  }
}
