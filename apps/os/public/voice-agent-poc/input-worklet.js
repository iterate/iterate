class PcmInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.targetSampleRate = 16000;
    this.chunkSamples = 1600;
    this.pending = [];
    this.output = [];
    this.readIndex = 0;

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "configure") {
        this.targetSampleRate = message.targetSampleRate || 16000;
        const chunkMs = message.chunkMs || 100;
        this.chunkSamples = Math.max(1, Math.round((this.targetSampleRate * chunkMs) / 1000));
      } else if (message.type === "set-enabled") {
        this.enabled = Boolean(message.enabled);
        if (!this.enabled) {
          this.pending = [];
          this.output = [];
          this.readIndex = 0;
        }
      }
    };
  }

  process(inputs) {
    if (!this.enabled) return true;

    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    for (let index = 0; index < channel.length; index++) {
      this.pending.push(channel[index] || 0);
    }

    const ratio = sampleRate / this.targetSampleRate;
    while (this.readIndex < this.pending.length) {
      const sample = this.pending[Math.floor(this.readIndex)] || 0;
      this.output.push(floatToInt16(sample));
      this.readIndex += ratio;

      if (this.output.length >= this.chunkSamples) {
        this.flushOutput();
      }
    }

    const consumed = Math.floor(this.readIndex);
    if (consumed > 0) {
      this.pending.splice(0, consumed);
      this.readIndex -= consumed;
    }

    return true;
  }

  flushOutput() {
    const samples = this.output.splice(0, this.chunkSamples);
    const pcm = new Int16Array(samples);
    this.port.postMessage(
      {
        type: "pcm",
        sampleRate: this.targetSampleRate,
        samples: pcm.length,
        buffer: pcm.buffer,
      },
      [pcm.buffer],
    );
  }
}

function floatToInt16(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

registerProcessor("pcm-input-processor", PcmInputProcessor);
