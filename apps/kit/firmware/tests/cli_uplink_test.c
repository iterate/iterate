#include <assert.h>
#include <string.h>
#include "cli_runtime.h"
#include "cli_uplink.h"

static struct cli_runtime runtime;
static uint64_t clock_ms;
static unsigned starts;
static unsigned commits;
static size_t sent_frames;
static enum capnweb_status wire_status;

uint64_t cli_runtime_now_ms(void *context) { (void)context; return clock_ms; }
void cli_runtime_log(const char *level, const char *format, ...) {
  (void)level; (void)format;
}

enum capnweb_status iterate_kit_voicelab_mark_turn(
    struct iterate_kit_voicelab *wire, enum iterate_kit_voicelab_turn turn) {
  assert(wire == &runtime.voicelab);
  if (turn == ITERATE_KIT_VOICELAB_TURN_START) ++starts;
  else ++commits;
  return wire_status;
}
enum capnweb_status iterate_kit_voicelab_append_frames(
    struct iterate_kit_voicelab *wire, const uint8_t *const *frames,
    size_t count, size_t length, uint32_t sequence, uint64_t at_ms) {
  assert(wire == &runtime.voicelab && frames[0][0] == 7U);
  assert(length == ITERATE_KIT_VOICE_FRAME_BYTES && sequence == sent_frames);
  assert(at_ms == clock_ms);
  if (wire_status == CAPNWEB_OK) sent_frames += count;
  return wire_status;
}

static void setup(void) {
  memset(&runtime, 0, sizeof(runtime));
  runtime.options.live_mic = true;
  runtime.wants_talk = true;
  runtime.transport.state = ITERATE_KIT_POSIX_ITX_READY;
  runtime.connection.generation = 1U;
  runtime.voicelab_generation = 1U;
  runtime.voicelab.state = ITERATE_KIT_VOICELAB_READY;
  starts = 0U; commits = 0U; sent_frames = 0U;
  clock_ms = 100U; wire_status = CAPNWEB_OK;
}

static void capture(size_t count) {
  uint8_t frame[ITERATE_KIT_VOICE_FRAME_BYTES];
  memset(frame, 7, sizeof(frame));
  for (size_t i = 0; i < count; ++i) {
    assert(cli_microphone_push(&runtime.microphone, frame, sizeof(frame)) == CLI_MICROPHONE_OK);
  }
}

int main(void) {
  /* A press/release while the stream is mounting survives into the first
   * admitted turn. The adapter stamps release/commit at their actual edges. */
  setup();
  runtime.voicelab.state = ITERATE_KIT_VOICELAB_IDLE;
  cli_uplink_step(&runtime, clock_ms);
  capture(2U);
  clock_ms += 100U;
  runtime.wants_talk = false;
  cli_uplink_step(&runtime, clock_ms);
  assert(runtime.turn_released_ms == clock_ms && starts == 0U);
  clock_ms += 2000U;
  runtime.voicelab.state = ITERATE_KIT_VOICELAB_READY;
  cli_uplink_step(&runtime, clock_ms);
  assert(starts == 1U && commits == 1U && sent_frames == 2U);
  assert(runtime.turn_committed_ms == clock_ms && runtime.microphone.used == 0U);

  /* Failed publication requests process recovery and accounts every frame
   * removed from the actual host microphone queue, exactly once. */
  setup(); cli_uplink_step(&runtime, clock_ms); capture(5U);
  wire_status = CAPNWEB_E_STATE;
  cli_uplink_step(&runtime, clock_ms);
  assert(runtime.restart_requested && !runtime.wants_talk);
  assert(runtime.mic_frames_dropped == 5U && runtime.microphone.used == 0U);
  cli_uplink_step(&runtime, clock_ms);
  assert(runtime.mic_frames_dropped == 5U);

  /* Server VAD uses the same batching but sends neither PTT marker. */
  setup(); runtime.options.open_mic = true;
  cli_uplink_step(&runtime, clock_ms); capture(4U);
  cli_uplink_step(&runtime, clock_ms);
  runtime.wants_talk = false;
  cli_uplink_step(&runtime, clock_ms);
  assert(sent_frames == 4U && starts == 0U && commits == 0U);
  return 0;
}
