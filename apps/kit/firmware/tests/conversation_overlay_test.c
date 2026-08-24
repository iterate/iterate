#include "iterate/kit/conversation_overlay.h"

#include "iterate/kit/face_wake.h"

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

static struct iterate_kit_conversation_visual_state ready_state(void) {
  const struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .media_ready = true,
  };
  return state;
}

/*
 * Twelve sockets, always. A sector that is off must still occupy its place,
 * or "three green" and "three green plus six dark" become the same picture.
 */
static void every_light_has_a_socket(void) {
  const struct iterate_kit_conversation_visual_state state = ready_state();
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  iterate_kit_conversation_lights_for_screen(&state, 0U, pixels);
  for (uint32_t index = 0U;
       index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    /* Asserted on the colours rather than on painted pixels: this module
     * stopped blitting when all three boards turned its rail off, so the
     * socket promise now lives where the colours are made. */
    assert(
        pixels[index].red != 0U || pixels[index].green != 0U ||
        pixels[index].blue != 0U);
  }
}

/* NULL is a state too, and it is the worst one: say something. */
static void an_absent_state_still_says_something(void) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  bool lit = false;
  assert(iterate_kit_conversation_needs_attention(NULL));
  iterate_kit_conversation_lights_for_screen(NULL, 0U, pixels);
  for (uint32_t index = 0U;
       index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    if (pixels[index].red > 200U) lit = true;
  }
  assert(lit);
}

/*
 * The equality gate is StackChan's repaint guard — the function whose misuse
 * once caused the 1 Hz face blackout. It must move on every state a person
 * can tell apart, and hold still within one.
 */
static void the_repaint_gate_separates_every_reachable_state(void) {
  struct iterate_kit_conversation_visual_state a = ready_state();
  struct iterate_kit_conversation_visual_state b = ready_state();
  assert(iterate_kit_conversation_overlay_equal(&a, &b));

  b.conversation_active = true;
  assert(!iterate_kit_conversation_overlay_equal(&a, &b));
  a.conversation_active = true;
  assert(iterate_kit_conversation_overlay_equal(&a, &b));

  b.microphone_listening = true;
  assert(!iterate_kit_conversation_overlay_equal(&a, &b));
  a.microphone_listening = true;

  b.speaker_peak = 4000U;
  assert(!iterate_kit_conversation_overlay_equal(&a, &b));
  a.speaker_peak = 2000U; /* same light band (1024..4095): no repaint */
  assert(iterate_kit_conversation_overlay_equal(&a, &b));

  b.network = ITERATE_KIT_NETWORK_CONNECTING;
  assert(!iterate_kit_conversation_overlay_equal(&a, &b));
  a.network = ITERATE_KIT_NETWORK_CONNECTING;
  assert(iterate_kit_conversation_overlay_equal(&a, &b));

  b.media_failed = true;
  assert(!iterate_kit_conversation_overlay_equal(&a, &b));
}

/*
 * The complaint this exists for: "when you end a call it doesn't go back to
 * sleeping face". It used to take three minutes.
 */
static void the_face_sleeps_when_the_call_ends(void) {
  struct iterate_kit_face_wake wake = {0};
  assert(!iterate_kit_face_awake(&wake, false, 1000U));
  assert(iterate_kit_face_awake(&wake, true, 2000U));
  assert(iterate_kit_face_awake(&wake, false, 2500U));
  assert(!iterate_kit_face_awake(
      &wake, false, 2000U + (uint64_t)ITERATE_KIT_FACE_AWAKE_TAIL_MS));
}

/* A call that drops for one frame must not blink the whole face off. */
static void a_momentary_drop_does_not_close_the_eyes(void) {
  struct iterate_kit_face_wake wake = {0};
  assert(iterate_kit_face_awake(&wake, true, 10000U));
  assert(iterate_kit_face_awake(&wake, false, 10100U));
  assert(iterate_kit_face_awake(&wake, true, 10200U));
  assert(iterate_kit_face_awake(&wake, false, 12000U));
}

/*
 * The complaint this exists for: three static amber dots read as a fault and
 * a single dim blue one read as "still connecting". A device that is trying
 * has to MOVE, and one that is ready has to hold still.
 */
static void connecting_walks_and_ready_holds_still(void) {
  struct iterate_kit_rgb8 a[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  struct iterate_kit_rgb8 b[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  struct iterate_kit_conversation_visual_state state = ready_state();

  iterate_kit_conversation_lights_animate(&state, 0U, a);
  iterate_kit_conversation_lights_animate(&state, 700U, b);
  assert(memcmp(a, b, sizeof(a)) == 0);

  state.network = ITERATE_KIT_NETWORK_CONNECTING;
  iterate_kit_conversation_lights_animate(&state, 0U, a);
  iterate_kit_conversation_lights_animate(&state, 700U, b);
  assert(memcmp(a, b, sizeof(a)) != 0);
  {
    /* Exactly one head, and it visits every position over a lap. */
    bool visited[ITERATE_KIT_CONVERSATION_LIGHT_COUNT] = {false};
    for (uint32_t now_ms = 0U; now_ms < 1400U; now_ms += 20U) {
      unsigned lit = 0U;
      iterate_kit_conversation_lights_animate(&state, now_ms, a);
      for (uint32_t index = 0U;
           index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
           ++index) {
        if (a[index].red > 200U) {
          ++lit;
          visited[index] = true;
        }
      }
      assert(lit == 1U);
    }
    for (uint32_t index = 0U;
         index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
         ++index) {
      assert(visited[index]);
    }
  }
}

int main(void) {
  connecting_walks_and_ready_holds_still();
  every_light_has_a_socket();
  an_absent_state_still_says_something();
  the_repaint_gate_separates_every_reachable_state();
  the_face_sleeps_when_the_call_ends();
  a_momentary_drop_does_not_close_the_eyes();
  return 0;
}
