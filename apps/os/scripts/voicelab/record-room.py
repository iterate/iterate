"""Record one acoustic clock for voicelab latency comparisons on macOS.

uv run --with sounddevice --with numpy python record-room.py --out room.wav --seconds 660
The metadata must pass its clock/drop checks before using waveform timings.
"""

import argparse
import json
import signal
import time
import wave
from pathlib import Path

import numpy as np
import sounddevice as sd

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--seconds", type=float, default=660)
parser.add_argument("--device", default=None, help="PortAudio input device name or index")
args = parser.parse_args()
if not 1 <= args.seconds <= 1800:
    parser.error("--seconds must be between 1 and 1800")
device = int(args.device) if args.device and args.device.isdigit() else args.device
args.out.parent.mkdir(parents=True, exist_ok=True)
sample_rate = 48000
blocks = []
timestamps = []
stopping = False


def stop(_signal, _frame):
    global stopping
    stopping = True


def capture(data, frames, timing, status):
    blocks.append(data.copy())
    timestamps.append({
        "monotonic": time.monotonic(),
        "wall": time.time(),
        "adcTime": timing.inputBufferAdcTime,
        "frames": frames,
        "status": str(status),
    })


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
started = time.monotonic()
started_wall = time.time()
with sd.InputStream(
    device=device, samplerate=sample_rate, channels=1, dtype="int16",
    blocksize=480, callback=capture,
) as stream:
    print(json.dumps({"recording": str(args.out), "device": stream.device,
                      "startedAt": started_wall, "sampleRate": sample_rate}), flush=True)
    while not stopping and time.monotonic() - started < args.seconds:
        time.sleep(0.1)

if len(blocks) < 2:
    raise RuntimeError("No usable audio captured")
samples = np.concatenate(blocks)
with wave.open(str(args.out), "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(sample_rate)
    output.writeframes(samples.tobytes())
sample_span = (len(samples) - timestamps[-1]["frames"]) / sample_rate
adc_span = timestamps[-1]["adcTime"] - timestamps[0]["adcTime"]
wall_span = timestamps[-1]["monotonic"] - timestamps[0]["monotonic"]
warnings = [stamp for stamp in timestamps if stamp["status"]]
clock_error = max(abs(sample_span - adc_span), abs(sample_span - wall_span))
valid = not warnings and clock_error < 0.1
summary = {
    "wav": str(args.out), "sampleRate": sample_rate,
    "startedAt": started_wall, "duration": len(samples) / sample_rate,
    "sampleSpanSeconds": sample_span, "adcSpanSeconds": adc_span,
    "callbackSpanSeconds": wall_span, "maximumClockErrorSeconds": clock_error,
    "warnings": warnings, "validAcousticClock": valid,
    "blocks": timestamps,
}
args.out.with_suffix(args.out.suffix + ".json").write_text(json.dumps(summary))
print(json.dumps({key: value for key, value in summary.items() if key != "blocks"}), flush=True)
if not valid:
    raise SystemExit("Recording has a clock discrepancy or capture overflow; do not use its latency timings")
