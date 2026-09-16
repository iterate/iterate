// Speaker frames → the output, in the audio thread: a queue of PCM16 chunks drained sample by
// sample, silence when it is empty. `clear` empties it (a new answer replaces what was queued).
// Modeled on the stream-player worklet of OpenAI's realtime console.
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "clear") {
        this.queue = [];
        this.offset = 0;
      } else if (message.type === "push") {
        this.queue.push(message.pcm);
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    let i = 0;
    while (i < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      out[i] = head[this.offset] / 0x8000;
      i += 1;
      this.offset += 1;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
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
