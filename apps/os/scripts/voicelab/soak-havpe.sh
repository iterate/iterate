#!/bin/sh
# Prove HAVPE full duplex against the real provider, all night, out loud.
#
#   apps/os/scripts/voicelab/soak-havpe.sh <project> [log]
#   touch /tmp/stop-havpe-soak      # ends it after the current round
#
# A second start refuses rather than joining in — see the lock below for why.
# A kill -9 leaves the lock behind; `rmdir /tmp/havpe-soak.lock` clears it, but
# check with `pgrep -f soak-havpe` first that it is really stale.
#
# THE TWO CLAIMS BEING PROVED, and neither is provable by the other.
#
#   NO DOUBLE TALK. The assistant must not hear itself. The recording says
#     whether the microphone carried its words; the provider's own
#     `speech_started` says whether x.ai BELIEVED them. The second is the one
#     that breaks a conversation, because when it fires the answer is
#     cancelled mid-word — the reported symptom was never "there is echo", it
#     was "it stops after two words". Rounds that do NOT interrupt are the
#     pure test of this: the only voice in the room is the board's, so any
#     speech_started at all is the device hearing itself, and the ANSWER line
#     says so outright.
#
#   INTERRUPTIONS WORK, AND FAST. The Mac talks over the answer and the STOP
#     line reports the milliseconds from the interruption starting to the last
#     speaker frame. That number is the product requirement; everything else
#     here exists to make it trustworthy.
#
# WHY REAL x.ai AND NOT THE FAKE. The fake has no detector: it never cancels,
# so it can prove the uplink carries an interruption but never that anything
# acts on one, and it can never fail the double-talk test because it has no
# opinion to be wrong about. Both claims above are claims about a detector.
#
# SCENARIOS, IN ROTATION, because one shape of turn proves one thing:
#
#   1  long answer, no interruption   — the pure double-talk test
#   2  long answer, interrupted early — barge while the answer is warming up,
#                                       the case the AEC is worst at
#   3  long answer, interrupted late  — barge into a converged canceller
#   4  short answer, interrupted      — the timing that used to land in
#                                       silence and flatter the result
#
# A shell loop rather than one long process: a board that adopts a
# conversation takes its capability host away for the best part of a minute
# and one round in ten loses that race. Out here that costs one round, and how
# often it happens is itself worth knowing by morning.
set -u

project=${1:?usage: soak-havpe.sh <project> [log]}
log=${2:-/tmp/havpe-soak.log}
stop=/tmp/stop-havpe-soak
lock=/tmp/havpe-soak.lock

cd "$(dirname "$0")/../.." || exit 1

# ONE LOOP AT A TIME, and the reason is not tidiness. Two loops share one board
# and one voice agent, so each one's setupVoiceAgent lands on the other's
# processor: the warm-up handshake sees a brief it did not write
# (briefMatched=false) and the loser's call is torn down before x.ai speaks,
# which surfaces as "the provider never sent a speaker frame". Every reading in
# between is worthless too — the other loop is talking into the same room, so
# its voice is scored as the board hearing itself. mkdir is the atomic test.
if ! mkdir "$lock" 2>/dev/null; then
  printf 'a soak is already running (lock %s).\nstop it with: touch %s\n' \
    "$lock" "$stop" >&2
  exit 1
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT INT TERM

# Safe only under the lock: with no rival loop watching it, a stop flag left
# over from the last run is stale rather than someone else's instruction.
rm -f "$stop"
round=0

printf '=== soak started %s ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"

while [ ! -f "$stop" ]; do
  round=$((round + 1))
  scenario=$(( (round - 1) % 4 + 1 ))

  # `set --` builds the per-scenario flags without an array; this is /bin/sh.
  case $scenario in
    1) name="long answer, nobody interrupts"
       set -- --ask "Please count slowly from one to forty, one number per second." ;;
    2) name="interrupted early (cold canceller)"
       set -- --ask "Please count slowly from one to forty, one number per second." \
              --barge "" --barge-at-ms 1200 ;;
    3) name="interrupted late (warm canceller)"
       set -- --ask "Please count slowly from one to forty, one number per second." \
              --barge "" --barge-at-ms 6000 ;;
    4) name="short answer, interrupted"
       set -- --ask "In one short sentence, what is the capital of France?" \
              --barge "" --barge-at-ms 1500 ;;
  esac

  printf '\n=== round %d  scenario %d: %s  %s ===\n' \
    "$round" "$scenario" "$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"

  doppler run --config preview_3 -- pnpm -s cli voicelab aec \
    --project "$project" \
    --board havpe \
    --real \
    --stages 1 \
    --turns 2 \
    --quiet-seconds 3 \
    "$@" >>"$log" 2>&1 \
    || printf '!!! round %d exited %d\n' "$round" "$?" >>"$log"

  # The board needs its remount window back before the next round asks for it.
  [ -f "$stop" ] || sleep 45
done

printf '\n=== soak stopped %s after %d rounds ===\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$round" >>"$log"
