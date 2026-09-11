#!/bin/bash
# Regenerate the boards' baked UI sounds — the sounds_generated.inc files
# are NOT committed (21.8k lines of hex for 1.7 MB of audio nobody reviews).
# What IS committed: the one non-generable source, the official Home
# Assistant Voice PE press chime (devices/havpe/assets/center_button_press.wav,
# ESPHome project, Apache-2.0). Everything else is OpenAI TTS in marin — the
# same voice the assistant answers in — and regenerates from the texts below.
#
#   OPENAI_API_KEY=... apps/kit/firmware/tools/generate-sounds.sh
#
# Requires: curl, ffmpeg (16 kHz mono PCM16 conversion), python3.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY is required (any key with tts access; dev doppler has one)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

tts() { # tts <text> <out.wav>  — marin, 16 kHz mono PCM16
  curl -sf https://api.openai.com/v1/audio/speech \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"gpt-4o-mini-tts\",\"voice\":\"marin\",\"input\":\"$1\",\"response_format\":\"wav\"}" \
    -o "$WORK/raw.wav"
  ffmpeg -y -loglevel error -i "$WORK/raw.wav" -ar 16000 -ac 1 -c:a pcm_s16le "$2"
}

cp devices/havpe/assets/center_button_press.wav "$WORK/center_button_press.wav"

# Shared end-of-call announcement.
tts "Call ended." "$WORK/call_ended.wav"

for board in devices/*/; do mkdir -p "${board}assets"; done

python3 tools/make-sounds.py "$WORK" chime_press=center_button_press.wav chime_ended=call_ended.wav > devices/havpe/assets/sounds_generated.inc
# StackChan's VOIP canceller destroys near speech during far-end activity.
# Measured 2026-08-20: the full 1.37 s wake chime erased the opening words.
# Keep the audible 0.4 s body with a 40 ms fade so the cut does not click.
python3 tools/make-sounds.py "$WORK" chime_press=center_button_press.wav chime_ended=call_ended.wav --trim-wake > devices/stackchan/assets/sounds_generated.inc
# Preserve M5's existing full-length chime and measured x2.5 feedback gain.
python3 tools/make-sounds.py "$WORK" chime_press=center_button_press.wav chime_ended=call_ended.wav --gain 5/2 > devices/m5sticks3/assets/sounds_generated.inc
# Waveshare uses the short 0.4 s chime and x2.5 feedback gain.
python3 tools/make-sounds.py "$WORK" chime_press=center_button_press.wav chime_ended=call_ended.wav --trim-wake --gain 5/2 > devices/waveshare_s3_amoled/assets/sounds_generated.inc
python3 tools/make-sounds.py "$WORK" chime_press=center_button_press.wav chime_ended=call_ended.wav > devices/satellite1/assets/sounds_generated.inc

echo "generated:"
wc -c devices/*/assets/sounds_generated.inc
