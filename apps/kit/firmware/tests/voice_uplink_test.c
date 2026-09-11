/* Exercise the real shared controller against a capture queue and a recording
 * wire boundary. voicelab_stream_test covers serialization of these calls. */
#include <assert.h>
#include <string.h>
#include "iterate/kit/voice_uplink.h"

struct fixture {
  struct iterate_kit_voice_uplink uplink;
  struct iterate_kit_voicelab wire;
  struct iterate_kit_voice_uplink_input input;
  struct iterate_kit_voice_uplink_io io;
  uint8_t queue[ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH];
  size_t queued;
  size_t reads;
  unsigned prepared;
  unsigned starts;
  unsigned commits;
  unsigned sends;
  unsigned events[ITERATE_KIT_UPLINK_BACKPRESSURE_FAILED + 1];
  uint8_t sent[128];
  size_t sent_count;
  enum capnweb_status start_status;
  enum capnweb_status commit_status;
  enum capnweb_status send_status;
};
static struct fixture f;

static size_t queued(void *context) { return ((struct fixture *)context)->queued; }
static bool read_frame(void *context, uint8_t *frame) {
  struct fixture *test = context;
  if (test->queued == 0U) return false;
  memset(frame, test->queue[0], ITERATE_KIT_VOICE_FRAME_BYTES);
  --test->queued;
  memmove(test->queue, test->queue + 1, test->queued);
  ++test->reads;
  return true;
}
static void clear(void *context) { ((struct fixture *)context)->queued = 0U; }
static bool prepare(void *context) { ++((struct fixture *)context)->prepared; return true; }
static void notify(void *context, enum iterate_kit_voice_uplink_event event,
                   enum capnweb_status status) {
  (void)status;
  ++((struct fixture *)context)->events[event];
}

enum capnweb_status iterate_kit_voicelab_mark_turn(
    struct iterate_kit_voicelab *wire, enum iterate_kit_voicelab_turn turn) {
  assert(wire == &f.wire);
  if (turn == ITERATE_KIT_VOICELAB_TURN_START) {
    ++f.starts;
    return f.start_status;
  }
  ++f.commits;
  return f.commit_status;
}
enum capnweb_status iterate_kit_voicelab_append_frames(
    struct iterate_kit_voicelab *wire, const uint8_t *const *frames,
    size_t count, size_t length, uint32_t sequence, uint64_t captured_at_ms) {
  assert(wire == &f.wire);
  assert(length == ITERATE_KIT_VOICE_FRAME_BYTES);
  assert(count > 0U && count <= ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND);
  assert(sequence == f.sent_count);
  assert(captured_at_ms == f.input.now_ms);
  ++f.sends;
  if (f.send_status != CAPNWEB_OK) return f.send_status;
  for (size_t i = 0; i < count; ++i) f.sent[f.sent_count++] = frames[i][0];
  return CAPNWEB_OK;
}

static void setup(bool ready, bool marks) {
  memset(&f, 0, sizeof(f));
  f.io = (struct iterate_kit_voice_uplink_io){
    .context = &f, .queued = queued, .read = read_frame, .clear = clear,
    .prepare = prepare, .notify = notify,
  };
  f.input = (struct iterate_kit_voice_uplink_input){
    .now_ms = 100U, .ready = ready, .marks_turns = marks,
    .outbox_free = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS, .wants_talk = true,
  };
}
static void step(void) {
  iterate_kit_voice_uplink_step(&f.uplink, &f.wire, &f.io, &f.input);
}
static void capture(size_t count, uint8_t value) {
  assert(f.queued + count <= sizeof(f.queue));
  memset(f.queue + f.queued, value, count);
  f.queued += count;
}

static void test_batches_and_release_snapshot(void) {
  setup(true, true);
  capture(1U, 99U); /* pre-press room noise */
  step();
  assert(f.prepared == 1U && f.starts == 1U && f.queued == 0U);
  capture(3U, 1U);
  step();
  assert(f.sends == 0U);
  capture(4U, 2U);
  step();
  assert(f.sent_count == 4U && f.sent[0] == 1U && f.sent[3] == 2U);
  f.input.wants_talk = false;
  f.input.outbox_free = 0U;
  step();
  assert(!iterate_kit_voice_uplink_capturing(&f.uplink));
  assert(f.uplink.flush_frames_left == 3U);
  capture(2U, 99U); /* capture task raced the release: never send these */
  f.input.outbox_free = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS;
  step();
  assert(f.sent_count == 7U && f.sent[6] == 2U);
  assert(f.commits == 1U && f.queued == 0U && f.uplink.state == ITERATE_KIT_UPLINK_IDLE);
  step();
  assert(f.commits == 1U);
}

static void test_released_dial_buffer(void) {
  setup(false, true);
  step();
  assert(iterate_kit_voice_uplink_capturing(&f.uplink));
  capture(5U, 7U);
  f.input.wants_talk = false;
  step();
  assert(!iterate_kit_voice_uplink_capturing(&f.uplink));
  f.input.now_ms += 5000U;
  step();
  assert(f.starts == 0U && f.sent_count == 0U && f.queued == 5U);
  f.input.ready = true;
  step(); step();
  assert(f.starts == 1U && f.sent_count == 5U && f.commits == 1U);
}

static void test_new_press_replaces_dial_speech(void) {
  setup(false, true);
  step(); capture(2U, 1U);
  f.input.wants_talk = false; step();
  f.input.wants_talk = true; step();
  assert(f.prepared == 2U && f.queued == 0U && f.uplink.frames_dropped == 2U);
  capture(1U, 2U);
  f.input.wants_talk = false; step();
  f.input.ready = true; step();
  assert(f.sent_count == 1U && f.sent[0] == 2U && f.commits == 1U);
}

static void test_empty_dial_does_not_commit(void) {
  setup(false, true); step();
  f.input.wants_talk = false; step();
  f.input.ready = true; step();
  assert(f.starts == 0U && f.commits == 0U && f.uplink.state == ITERATE_KIT_UPLINK_IDLE);
}

static void test_open_microphone(void) {
  setup(false, false); step(); capture(4U, 3U);
  f.input.ready = true; step();
  assert(f.sent_count == 4U && f.starts == 0U);
  f.input.now_ms += ITERATE_KIT_VOICE_TURN_MAX_MS + 1U;
  step();
  assert(iterate_kit_voice_uplink_capturing(&f.uplink));
  capture(1U, 4U);
  f.input.wants_talk = false; step();
  assert(f.sent_count == 5U && f.commits == 0U);
}

static void test_backpressure_keeps_frames_until_deadline(void) {
  setup(true, true); step(); capture(6U, 1U);
  f.input.outbox_free = 3U; step();
  assert(f.reads == 0U);
  f.input.wants_talk = false; step();
  f.input.now_ms += ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS;
  step();
  assert(f.uplink.frames_dropped == 6U && f.commits == 1U);
  assert(f.events[ITERATE_KIT_UPLINK_TAIL_DROPPED] == 1U);
}

static void test_turn_limit_waits_for_release(void) {
  setup(true, true); step(); capture(1U, 1U);
  f.input.now_ms += ITERATE_KIT_VOICE_TURN_MAX_MS + 1U;
  step(); step();
  assert(f.starts == 1U && f.commits == 1U);
  assert(f.events[ITERATE_KIT_UPLINK_TURN_LIMIT] == 1U);
  f.input.wants_talk = false; step();
  f.input.wants_talk = true; step();
  assert(f.starts == 2U);
}

static void test_publication_failures_are_terminal(void) {
  setup(true, true); f.start_status = CAPNWEB_E_STATE; step(); step();
  assert(f.starts == 1U && f.uplink.marker_failures == 1U);
  assert(!iterate_kit_voice_uplink_capturing(&f.uplink));
  assert(f.uplink.state == ITERATE_KIT_UPLINK_FAILED);
  setup(true, true); step(); capture(6U, 1U);
  f.send_status = CAPNWEB_E_STATE; step(); step();
  assert(f.sends == 1U && f.uplink.frames_dropped == 6U && f.uplink.send_failures == 1U);
  assert(f.uplink.frame_sequence == 0U && f.commits == 0U);
  setup(true, true); step();
  f.commit_status = CAPNWEB_E_STATE;
  f.input.wants_talk = false; step(); step();
  assert(f.commits == 1U && f.events[ITERATE_KIT_UPLINK_COMMITTED] == 0U);
}

static void test_commit_and_buffer_waits_are_bounded(void) {
  setup(true, true); step();
  f.input.wants_talk = false; f.input.outbox_free = 0U; step();
  f.input.now_ms += ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS; step();
  assert(f.uplink.state == ITERATE_KIT_UPLINK_FAILED && f.commits == 0U);
  setup(false, true); step(); capture(1U, 1U);
  f.input.wants_talk = false; step();
  f.input.now_ms += ITERATE_KIT_VOICE_TURN_MAX_MS + 1U; step();
  assert(f.uplink.state == ITERATE_KIT_UPLINK_FAILED && f.uplink.frames_dropped == 1U);
}

static void test_live_jam_and_source_tail(void) {
  setup(true, false); step(); capture(ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH / 2U, 1U);
  f.input.outbox_free = 0U; step();
  f.input.now_ms += 3001U; step();
  assert(f.uplink.backpressure_failures == 1U && f.uplink.frames_dropped == ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH / 2U);
  setup(true, false); step(); capture(1U, 9U);
  f.input.source_finished = true; step();
  assert(f.sent_count == 1U && f.commits == 0U);
}

int main(void) {
  test_batches_and_release_snapshot();
  test_released_dial_buffer();
  test_new_press_replaces_dial_speech();
  test_empty_dial_does_not_commit();
  test_open_microphone();
  test_backpressure_keeps_frames_until_deadline();
  test_turn_limit_waits_for_release();
  test_publication_failures_are_terminal();
  test_commit_and_buffer_waits_are_bounded();
  test_live_jam_and_source_tail();
  return 0;
}
