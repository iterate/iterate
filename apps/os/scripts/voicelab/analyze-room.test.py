"""Known-waveform regression for acoustic latency measurement.

uv run --with numpy --with matplotlib python analyze-room.test.py
"""

import json
import math
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np


class AcousticMeasurementTest(unittest.TestCase):
    def measure(self, reply_rms, delay_seconds, with_short_noise=False):
        rate = 48000
        origin_ms = 1789000000000
        clock = np.arange(30 * rate) / rate
        # Constant background is audible but has little variability. A quiet
        # response above that floor must still produce the known onset.
        audio = math.sqrt(2) * 130 * np.sin(2 * np.pi * 120 * clock)
        turns = []
        for turn, start in enumerate([2, 11, 20], 1):
            prompt = (clock >= start) & (clock < start + 0.5)
            audio[prompt] += math.sqrt(2) * 4000 * np.sin(2 * np.pi * 300 * clock[prompt])
            onset = start + 0.5 + delay_seconds
            if with_short_noise:
                spike = (clock >= onset - 0.2) & (clock < onset - 0.17)
                audio[spike] += math.sqrt(2) * 230 * np.sin(2 * np.pi * 600 * clock[spike])
            reply = (clock >= onset) & (clock < onset + 0.5)
            audio[reply] += math.sqrt(2) * reply_rms * np.sin(2 * np.pi * 600 * clock[reply])
            turns.append({
                "turn": turn,
                "sayStartedAt": origin_ms + start * 1000,
                "sayCompletedAt": origin_ms + (start + 0.5) * 1000,
                "firstSpkPlayed": {
                    "previousMeasuredAt": origin_ms + (onset - 0.05) * 1000,
                    "observedAt": origin_ms + (onset + 0.05) * 1000,
                },
            })

        with tempfile.TemporaryDirectory(prefix="voicelab-acoustic-test-") as directory:
            root = Path(directory)
            wav = root / "room.wav"
            with wave.open(str(wav), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(rate)
                output.writeframes(np.rint(audio).astype("<i2").tobytes())
            wav.with_suffix(".wav.json").write_text(json.dumps({
                "validAcousticClock": True,
                "blocks": [{"wall": origin_ms / 1000}],
            }))
            probe = root / "probe.json"
            probe.write_text(json.dumps({
                "board": "known-waveform", "verdict": "PASS", "turns": turns,
            }))
            result = subprocess.run([
                sys.executable, str(Path(__file__).with_name("analyze-room.py")),
                "--wav", str(wav), "--probe", str(probe), "--out", str(root / "result"),
            ], capture_output=True, text=True, timeout=30)
            summary_path = root / "result.json"
            summary = json.loads(summary_path.read_text()) if summary_path.exists() else None
            return result, summary

    def test_quiet_reply_has_known_one_second_gap(self):
        result, summary = self.measure(reply_rms=450, delay_seconds=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary["measuredTurns"], 3)
        self.assertTrue(summary["acceptancePass"])
        for turn in summary["turns"]:
            for measurement in turn["thresholdSweep"]:
                self.assertAlmostEqual(measurement["gapMs"], 1000, delta=10)

    def test_room_noise_without_reply_cannot_pass(self):
        result, summary = self.measure(reply_rms=0, delay_seconds=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no sustained board reply", result.stderr)
        self.assertTrue(summary is None or not summary["acceptancePass"])

    def test_short_noise_before_reply_does_not_move_onset(self):
        result, summary = self.measure(reply_rms=450, delay_seconds=1, with_short_noise=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for turn in summary["turns"]:
            for measurement in turn["thresholdSweep"]:
                self.assertAlmostEqual(measurement["gapMs"], 1000, delta=10)

    def test_real_late_reply_is_measured_and_fails_budget(self):
        result, summary = self.measure(reply_rms=450, delay_seconds=4)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(summary["measuredTurns"], 3)
        self.assertFalse(summary["acceptancePass"])
        self.assertFalse(summary["withinLatencyBudget"])
        for turn in summary["turns"]:
            for measurement in turn["thresholdSweep"]:
                self.assertAlmostEqual(measurement["gapMs"], 4000, delta=10)


if __name__ == "__main__":
    unittest.main()
