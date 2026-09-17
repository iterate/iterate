// Speaker frames → the output, in the audio thread: a queue of PCM16 chunks drained sample by
// sample, silence when it is empty. `clear` empties it (a new answer replaces what was queued).
//
// A PREFILL before every start: the relay hands answer audio over in the provider's deltas,
// which arrive in bursts, so draining the moment the first chunk lands runs the queue dry a few
// chunks later and every network hiccup is audible. As the boards do (160 ms), playback waits
// until PREFILL_SAMPLES are queued after a clear or after it ran dry, then drains steadily.
// Running dry counts as an underrun only when more audio follows within a second — the boards'
// rule: audio arriving that soon after a starve means the answer was still going, so the pipe
// genuinely ran dry mid-speech; running dry at the end of an answer is just the end.
const PREFILL_SAMPLES = 16000 * 0.2; // 200 ms at 16 kHz
const STARVE_WINDOW_S = 1;
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.queued = 0;
    this.offset = 0;
    this.primed = false;
    this.underruns = 0;
    this.played = 0;
    this.ranDryAt = -1;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "clear") {
        this.queue = [];
        this.queued = 0;
        this.offset = 0;
        this.primed = false;
        this.ranDryAt = -1;
      } else if (message.type === "push") {
        if (this.ranDryAt >= 0 && currentTime - this.ranDryAt < STARVE_WINDOW_S)
          this.underruns += 1;
        this.ranDryAt = -1;
        this.queue.push(message.pcm);
        this.queued += message.pcm.length;
      } else if (message.type === "stats") {
        this.port.postMessage({ type: "stats", underruns: this.underruns, played: this.played });
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!this.primed && this.queued >= PREFILL_SAMPLES) this.primed = true;
    let i = 0;
    if (this.primed) {
      while (i < out.length && this.queue.length > 0) {
        const head = this.queue[0];
        out[i] = head[this.offset] / 0x8000;
        i += 1;
        this.offset += 1;
        this.queued -= 1;
        this.played += 1;
        if (this.offset >= head.length) {
          this.queue.shift();
          this.offset = 0;
        }
      }
      if (this.queue.length === 0 && i > 0 && i < out.length) {
        // Ran dry: silence follows, the next chunks prefill again, and whether this was an
        // underrun is decided when (if) they arrive.
        this.ranDryAt = currentTime;
        this.primed = false;
      }
    }
    while (i < out.length) {
      out[i] = 0;
      i += 1;
    }
    return true;
  }
}
registerProcessor("playback", PlaybackProcessor);
