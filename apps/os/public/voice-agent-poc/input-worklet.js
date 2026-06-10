// Captures mic audio, downsamples it to the target rate with a box low-pass
// filter, and posts fixed-size PCM16 chunks to the main thread.
//
// The audio thread must stay allocation-free in steady state: samples live in a
// fixed Float32Array ring buffer addressed by absolute sample counters, and the
// only per-chunk allocation is the transferable Int16Array that leaves the
// worklet.
class PcmInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.targetSampleRate = 16000;
    this.chunkSamples = 1600;
    this.capacity = 32768;
    this.ring = new Float32Array(this.capacity);
    this.writeCount = 0; // total samples written, ever
    this.readPos = 0; // fractional absolute read position
    this.chunk = new Int16Array(this.chunkSamples);
    this.chunkLength = 0;

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "configure") {
        this.targetSampleRate = message.targetSampleRate || 16000;
        const chunkMs = message.chunkMs || 100;
        this.chunkSamples = Math.max(1, Math.round((this.targetSampleRate * chunkMs) / 1000));
        this.chunk = new Int16Array(this.chunkSamples);
        this.chunkLength = 0;
      } else if (message.type === "set-enabled") {
        this.enabled = Boolean(message.enabled);
        if (!this.enabled) {
          this.writeCount = 0;
          this.readPos = 0;
          this.chunkLength = 0;
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
      this.ring[this.writeCount % this.capacity] = channel[index] || 0;
      this.writeCount++;
    }
    if (this.writeCount - this.readPos > this.capacity) {
      this.readPos = this.writeCount - this.capacity;
    }

    const ratio = sampleRate / this.targetSampleRate;
    while (this.readPos + ratio <= this.writeCount) {
      this.chunk[this.chunkLength++] = floatToInt16(
        this.boxAverage(this.readPos, this.readPos + ratio),
      );
      this.readPos += ratio;
      if (this.chunkLength >= this.chunkSamples) {
        this.flushChunk();
      }
    }

    return true;
  }

  // Average every source sample covered by [from, to), weighting partial
  // samples by coverage. Acts as a low-pass at the target Nyquist, so
  // downsampling doesn't fold high frequencies into the speech band the way
  // take-every-Nth decimation does.
  boxAverage(from, to) {
    let sum = 0;
    let weight = 0;
    let pos = from;
    while (pos < to) {
      const index = Math.floor(pos);
      const next = Math.min(index + 1, to);
      const sliceWeight = next - pos;
      sum += this.ring[index % this.capacity] * sliceWeight;
      weight += sliceWeight;
      pos = next;
    }
    return weight > 0 ? sum / weight : 0;
  }

  flushChunk() {
    const pcm = this.chunk.slice(0, this.chunkLength);
    this.chunkLength = 0;
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
