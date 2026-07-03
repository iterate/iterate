// Plays queued PCM16 frames through the speaker, resampling from the source
// rate to the device rate with linear interpolation.
//
// Audio lives in a fixed Float32Array ring buffer addressed by absolute sample
// counters, so steady-state playback performs no allocation and no array
// shifting on the audio thread.
class PcmOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceSampleRate = 24000;
    this.minBufferMs = 80;
    this.capacity = 24000 * 30; // 30 seconds of queued audio
    this.ring = new Float32Array(this.capacity);
    this.writeCount = 0; // total samples enqueued, ever
    this.readPos = 0; // fractional absolute read position
    this.started = false;
    this.underruns = 0;
    this.drainedAt = null;
    this.reportCounter = 0;

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "configure") {
        this.sourceSampleRate = message.sourceSampleRate || 24000;
        this.minBufferMs = message.minBufferMs || 80;
      } else if (message.type === "enqueue") {
        this.enqueue(new Int16Array(message.buffer));
      } else if (message.type === "clear") {
        this.readPos = this.writeCount;
        this.started = false;
        this.drainedAt = null;
      }
    };
  }

  enqueue(pcm) {
    for (let index = 0; index < pcm.length; index++) {
      this.ring[this.writeCount % this.capacity] = pcm[index] / 32768;
      this.writeCount++;
    }
    if (this.writeCount - this.readPos > this.capacity) {
      this.readPos = this.writeCount - this.capacity;
    }

    // Audio arriving shortly after the buffer drained means the drain was a
    // genuine underrun (the provider was mid-utterance), not the natural end
    // of an utterance.
    if (!this.started && this.drainedAt != null && currentTime - this.drainedAt < 0.25) {
      this.underruns++;
      this.drainedAt = null;
    }
    if (!this.started && this.queuedMs() >= this.minBufferMs) {
      this.started = true;
      this.drainedAt = null;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const channelCount = output ? output.length : 0;
    if (!output || channelCount === 0) return true;

    const frameCount = output[0].length;
    const ratio = this.sourceSampleRate / sampleRate;

    for (let frame = 0; frame < frameCount; frame++) {
      let value = 0;
      if (this.started && this.readPos < this.writeCount) {
        const leftIndex = Math.floor(this.readPos);
        const fraction = this.readPos - leftIndex;
        const left = this.ring[leftIndex % this.capacity] || 0;
        const right =
          leftIndex + 1 < this.writeCount ? this.ring[(leftIndex + 1) % this.capacity] : left;
        value = left + (right - left) * fraction;
        this.readPos += ratio;
      }
      for (let channel = 0; channel < channelCount; channel++) {
        output[channel][frame] = value;
      }
    }

    if (this.started && this.readPos >= this.writeCount) {
      this.readPos = this.writeCount;
      this.started = false;
      this.drainedAt = currentTime;
    }

    this.reportCounter++;
    if (this.reportCounter >= 30) {
      this.reportCounter = 0;
      this.port.postMessage({
        type: "status",
        queuedMs: Math.round(this.queuedMs()),
        underruns: this.underruns,
      });
    }

    return true;
  }

  queuedMs() {
    return (Math.max(0, this.writeCount - this.readPos) / this.sourceSampleRate) * 1000;
  }
}

registerProcessor("pcm-output-processor", PcmOutputProcessor);
