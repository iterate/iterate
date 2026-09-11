"""Measure acoustic speech-end to board reply from a validated room recording.

uv run --with numpy --with matplotlib python analyze-room.py --wav room.wav --probe board.json --out acoustic
Host timestamps only locate each turn. Both measured endpoints use WAV sample time.
"""

import argparse
import json
import wave
from pathlib import Path

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--wav", type=Path, required=True)
parser.add_argument("--probe", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--max-latency-ms", type=float, default=3000)
parser.add_argument("--max-median-drift-ms", type=float, default=250)
args = parser.parse_args()
if args.max_latency_ms <= 0 or args.max_median_drift_ms < 0:
    parser.error("latency budget must be positive and drift budget non-negative")
recording = json.loads(args.wav.with_suffix(args.wav.suffix + ".json").read_text())
if recording.get("validAcousticClock") is not True:
    raise SystemExit("Recording did not pass record-room.py clock/drop validation")
probe = json.loads(args.probe.read_text())
with wave.open(str(args.wav)) as source:
    if source.getnchannels() != 1 or source.getsampwidth() != 2:
        raise SystemExit("Expected mono PCM16 room recording")
    rate = source.getframerate()
    audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(float)
window = rate // 100
rms = np.sqrt(np.mean(audio[:len(audio) // window * window].reshape(-1, window) ** 2, axis=1))
origin_wall_ms = recording["blocks"][0]["wall"] * 1000
rows = []
errors = []

for turn in probe["turns"]:
    try:
        # Broad host windows identify the two sounds; their timing is measured
        # independently below, without subtracting a host clock from a WAV clock.
        prompt_start = max(0, (turn["sayStartedAt"] - origin_wall_ms) / 1000 - 0.3)
        prompt_limit = (turn["sayCompletedAt"] - origin_wall_ms) / 1000 + 0.2
        reply_limit = (turn["firstSpkPlayed"]["observedAt"] - origin_wall_ms) / 1000 + 0.7
        if reply_limit <= prompt_limit or reply_limit * 100 >= len(rms):
            raise ValueError("missing or out-of-recording playback window")
        quiet = rms[max(0, int((prompt_start - 0.5) * 100)):int(prompt_start * 100)]
        if len(quiet) < 10:
            raise ValueError("insufficient pre-prompt room-noise sample")
        # Fan/background noise can change during a long run. Require the reply
        # to rise above its own turn's quiet floor, and search near the bounded
        # playback observation rather than mistaking any earlier noise for it.
        # A constant fan level is a baseline, not the variability a reply must
        # exceed. Multiplying that baseline rejected known replies well above
        # room noise. Sweep excess energy above the median instead, with a
        # 50-RMS minimum margin and the turn's measured noise spread.
        noise_baseline = float(np.median(quiet))
        noise_margin = max(50.0, float(np.percentile(quiet, 95)) - noise_baseline)
        playback_earliest = (turn["firstSpkPlayed"]["previousMeasuredAt"] - origin_wall_ms) / 1000 - 0.2
        measurements = []
        for threshold in [noise_baseline + noise_margin * factor for factor in [1, 2, 3]]:
            spoken = np.flatnonzero(rms[int(prompt_start * 100):int(prompt_limit * 100)] >= threshold)
            if not len(spoken):
                raise ValueError(f"no prompt at RMS {threshold}")
            speech_end = (int(prompt_start * 100) + int(spoken[-1]) + 1) / 100
            # All compared configurations use 500 ms server VAD. The 200 ms
            # separation excludes prompt decay, while remaining before its
            # earliest possible answer. Refuse to reuse this on faster VAD.
            reply_start_bin = int(max(speech_end + 0.2, playback_earliest) * 100)
            active = rms[reply_start_bin:int(reply_limit * 100)] >= threshold
            # A 20–30 ms room click can cross the lower thresholds before the
            # real reply. Confirm 50 ms of continuous activity, but report the
            # first bin rather than adding the confirmation time to latency.
            sustained = np.flatnonzero(np.convolve(active.astype(int), np.ones(5, dtype=int), "valid") == 5)
            if not len(sustained):
                raise ValueError(f"no sustained board reply at RMS {threshold}")
            reply_onset = (reply_start_bin + int(sustained[0])) / 100
            measurements.append({"rmsThreshold": round(threshold, 1), "speechEndSeconds": speech_end,
                                 "replyOnsetSeconds": reply_onset,
                                 "gapMs": round((reply_onset - speech_end) * 1000)})
        rows.append({"turn": turn["turn"], "elapsedSeconds": measurements[1]["speechEndSeconds"],
                     "gapMs": measurements[1]["gapMs"], "thresholdSweep": measurements})
    except (KeyError, TypeError, ValueError) as error:
        errors.append({"turn": turn.get("turn"), "error": str(error)})

if len(rows) < 3:
    raise SystemExit(f"Fewer than three measurable acoustic turns: {errors}")
values = np.array([row["gapMs"] for row in rows])
times = np.array([row["elapsedSeconds"] for row in rows])
third = max(1, len(values) // 3)
slope = float(np.polyfit((times - times[0]) / 60, values, 1)[0])
drift = float(np.median(values[-third:]) - np.median(values[:third]))
latency_pass = all(measure["gapMs"] <= args.max_latency_ms
                   for row in rows for measure in row["thresholdSweep"])
summary = {
    "wav": str(args.wav), "probe": str(args.probe), "probeVerdict": probe["verdict"],
    "method": "Both acoustic endpoints use the same 10 ms WAV clock. Host markers only locate windows. Per-turn thresholds are median pre-prompt RMS + [1, 2, 3] * max(50, pre-prompt 95th percentile RMS - median RMS), with 50 ms continuous activity confirming the first bin as onset. Requires 500 ms server VAD and isolated Mac prompt/board output.",
    "measuredTurns": len(rows), "unmeasurableTurns": errors,
    "medianMs": float(np.median(values)), "minMs": int(values.min()), "maxMs": int(values.max()),
    "firstThirdMedianMs": float(np.median(values[:third])),
    "lastThirdMedianMs": float(np.median(values[-third:])),
    "medianDriftMs": drift,
    "slopeMsPerMinute": slope, "turns": rows,
    "maxLatencyBudgetMs": args.max_latency_ms,
    "maxMedianDriftBudgetMs": args.max_median_drift_ms,
    "withinLatencyBudget": latency_pass,
    "acceptancePass": not errors and probe["verdict"] == "PASS" and latency_pass
                      and drift <= args.max_median_drift_ms,
}
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.with_suffix(".json").write_text(json.dumps(summary, indent=2) + "\n")
fig, axes = plt.subplots(4, 1, figsize=(11, 11), gridspec_kw={"height_ratios": [1.4, 1, 1, 1]})
axes[0].plot((times - times[0]) / 60, values, "o-", color="#245a78", markersize=4)
axes[0].axhline(np.median(values), color="#af6a31", linestyle="--", label=f"Median {np.median(values):.0f} ms")
axes[0].set(title=f"{probe['board']}: acoustic speech-end → first reply", xlabel="Minutes since first turn", ylabel="Milliseconds")
axes[0].legend()
for axis, row in zip(axes[1:], [rows[0], max(rows, key=lambda row: row["gapMs"]), rows[-1]]):
    measured = row["thresholdSweep"][1]
    start, end = measured["speechEndSeconds"], measured["replyOnsetSeconds"]
    clock = np.arange(len(rms)) / 100
    visible = (clock >= start - 1.4) & (clock <= end + 0.6)
    axis.plot(clock[visible], rms[visible], color="#245a78", linewidth=1)
    axis.set_yscale("log")
    axis.set_ylim(30, 20000)
    axis.axvline(start, color="#30745b", linestyle="--")
    axis.axvline(end, color="#af6a31", linestyle="--")
    axis.axhline(measured["rmsThreshold"], color="gray", alpha=0.4)
    axis.set(title=f"Turn {row['turn']}: {row['gapMs']} ms", xlabel="WAV time (seconds)", ylabel="10 ms RMS")
for axis in axes:
    axis.grid(alpha=0.15)
fig.tight_layout()
fig.savefig(args.out.with_suffix(".png"), dpi=150)
print(json.dumps({key: value for key, value in summary.items() if key != "turns"}, indent=2))
if errors:
    raise SystemExit("Some turns could not be measured; inspect the recording and failed windows")
if not summary["acceptancePass"]:
    raise SystemExit("Acoustic latency/drift budget or board continuity acceptance failed")
