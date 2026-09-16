// The microphone → 50 ms PCM16 frames, in the audio thread. The AudioContext runs at 16 kHz, so a
// frame is 800 samples; the main thread turns each one into one `mic-frame` append. Modeled on the
// recorder worklet of OpenAI's realtime console: convert, fill, post — nothing else here.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(800);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.frame[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.filled += 1;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Int16Array(800);
        this.filled = 0;
      }
    }
    return true; // the outputs stay silent; the node is connected only to keep processing
  }
}
registerProcessor("capture", CaptureProcessor);
