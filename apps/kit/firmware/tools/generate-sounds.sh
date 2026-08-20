#!/bin/bash
# Regenerate the boards' baked UI sounds — the *_sounds_generated.inc files
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

# The HAVPE's four dial modes and the shared end-of-call announcement.
tts "Call ended." "$WORK/call_ended.wav"
tts "Grok. Push to talk." "$WORK/mode1.wav"
tts "Grok. Open mic." "$WORK/mode2.wav"
tts "OpenAI. Push to talk." "$WORK/mode3.wav"
tts "OpenAI. Open mic." "$WORK/mode4.wav"
# The StackChan's two provider announcements.
tts "Grok." "$WORK/stackchan_grok.wav"
tts "OpenAI." "$WORK/stackchan_openai.wav"

python3 devices/havpe/assets/make-sounds.py "$WORK" \
  > devices/havpe/assets/havpe_sounds_generated.inc
python3 devices/stackchan/assets/make-sounds.py "$WORK" \
  > devices/stackchan/assets/stackchan_sounds_generated.inc
python3 devices/m5sticks3/assets/make-sounds.py "$WORK" \
  > devices/m5sticks3/assets/m5sticks3_sounds_generated.inc
python3 devices/waveshare_s3_amoled/assets/make-sounds.py "$WORK" \
  > devices/waveshare_s3_amoled/assets/waveshare_sounds_generated.inc

echo "generated:"
wc -c devices/havpe/assets/havpe_sounds_generated.inc \
      devices/stackchan/assets/stackchan_sounds_generated.inc \
      devices/m5sticks3/assets/m5sticks3_sounds_generated.inc \
      devices/waveshare_s3_amoled/assets/waveshare_sounds_generated.inc
