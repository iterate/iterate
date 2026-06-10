class PcmOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceSampleRate = 24000;
    this.minBufferMs = 80;
    this.queue = [];
    this.readIndex = 0;
    this.started = false;
    this.underruns = 0;
    this.reportCounter = 0;

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "configure") {
        this.sourceSampleRate = message.sourceSampleRate || 24000;
        this.minBufferMs = message.minBufferMs || 80;
      } else if (message.type === "enqueue") {
        const pcm = new Int16Array(message.buffer);
        for (let index = 0; index < pcm.length; index++) {
          this.queue.push(pcm[index] / 32768);
        }
        if (!this.started && this.queuedMs() >= this.minBufferMs) {
          this.started = true;
        }
      } else if (message.type === "clear") {
        this.queue = [];
        this.readIndex = 0;
        this.started = false;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const channelCount = output ? output.length : 0;
    if (!output || channelCount === 0) return true;

    const frameCount = output[0].length;
    const ratio = this.sourceSampleRate / sampleRate;

    for (let frame = 0; frame < frameCount; frame++) {
      let value = 0;
      if (this.started && this.readIndex < this.queue.length) {
        const leftIndex = Math.floor(this.readIndex);
        const rightIndex = Math.min(leftIndex + 1, this.queue.length - 1);
        const fraction = this.readIndex - leftIndex;
        const left = this.queue[leftIndex] || 0;
        const right = this.queue[rightIndex] || left;
        value = left + (right - left) * fraction;
      }

      for (let channel = 0; channel < channelCount; channel++) {
        output[channel][frame] = value;
      }

      if (this.started) {
        this.readIndex += ratio;
      }
    }

    if (this.started && this.readIndex >= this.queue.length) {
      this.queue = [];
      this.readIndex = 0;
      this.started = false;
      this.underruns++;
    }

    const consumed = Math.floor(this.readIndex);
    if (consumed > 0) {
      this.queue.splice(0, consumed);
      this.readIndex -= consumed;
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
    return (Math.max(0, this.queue.length - this.readIndex) / this.sourceSampleRate) * 1000;
  }
}

registerProcessor("pcm-output-processor", PcmOutputProcessor);
