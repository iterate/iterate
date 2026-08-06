#include "iterate/kit/conversation_overlay.h"

#include "iterate/kit/face_wake.h"

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

enum { WIDTH = 160, HEIGHT = 120 };

static uint16_t frame[WIDTH * HEIGHT];

static void clear_frame(void) {
  memset(frame, 0, sizeof(frame));
}

static bool any_pixel_in(
    uint32_t x, uint32_t y, uint32_t width, uint32_t height) {
  for (uint32_t row = y; row < y + height; ++row) {
    for (uint32_t column = x; column < x + width; ++column) {
      if (frame[row * (uint32_t)WIDTH + column] != 0U) return true;
    }
  }
  return false;
}

static struct iterate_kit_conversation_visual_state ready_state(void) {
  const struct iterate_kit_conversation_visual_state state = {
    .network = ITERATE_KIT_NETWORK_CONNECTED,
    .media_ready = true,
  };
  return state;
}

/*
 * The whole reason the rail sits in the left margin: it must never touch the
 * face. The avatars' drawn extents were measured (the narrowest free left
 * margin is eighteen columns), and this pins the promise that the overlay
 * stays inside eight of them.
 */
static void rail_stays_inside_the_left_margin(void) {
  const struct iterate_kit_conversation_visual_state state = ready_state();
  clear_frame();
  iterate_kit_conversation_overlay_render(&state, 0U, frame, WIDTH, HEIGHT);
  assert(any_pixel_in(0U, 0U, (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH, HEIGHT));
  assert(!any_pixel_in(
      (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH,
      0U,
      (uint32_t)WIDTH - (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH,
      HEIGHT));
}

/*
 * Twelve sockets, always. A sector that is off must still occupy its place,
 * or "three green" and "three green plus six dark" become the same picture.
 */
static void every_light_has_a_socket(void) {
  const struct iterate_kit_conversation_visual_state state = ready_state();
  clear_frame();
  iterate_kit_conversation_overlay_render(&state, 0U, frame, WIDTH, HEIGHT);
  for (uint32_t index = 0U;
       index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    /* Ten rows of pitch at this height; every band must contain something. */
    assert(any_pixel_in(0U, index * 10U, (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH, 10U));
  }
}

/* A ready device gets its face back: no banner, nothing over the mouth. */
static void ready_leaves_the_face_alone(void) {
  const struct iterate_kit_conversation_visual_state state = ready_state();
  clear_frame();
  iterate_kit_conversation_overlay_render(&state, 0U, frame, WIDTH, HEIGHT);
  assert(!any_pixel_in(
      (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH,
      (uint32_t)HEIGHT - (uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT,
      (uint32_t)WIDTH - (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH,
      (uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT));
}

/*
 * ...and a device that cannot work says so across the whole width. This is
 * the requirement that a person must never have to guess whether the thing
 * is connected.
 */
static void not_connected_raises_a_banner(void) {
  struct iterate_kit_conversation_visual_state state = ready_state();
  state.network = ITERATE_KIT_NETWORK_CONNECTING;
  clear_frame();
  iterate_kit_conversation_overlay_render(&state, 0U, frame, WIDTH, HEIGHT);
  assert(any_pixel_in(
      (uint32_t)WIDTH / 2U,
      (uint32_t)HEIGHT - (uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT,
      2U,
      (uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT));
  assert(!any_pixel_in(
      (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH,
      0U,
      (uint32_t)WIDTH - (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH,
      (uint32_t)HEIGHT - (uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT));
}

/* A working device must not flicker, and a broken one must not sit still. */
static void only_attention_states_breathe(void) {
  struct iterate_kit_conversation_visual_state state = ready_state();
  uint8_t lowest = 255U;
  uint8_t highest = 0U;
  assert(iterate_kit_conversation_attention_scale(&state, 0U) == 255U);
  assert(iterate_kit_conversation_attention_scale(&state, 700U) == 255U);

  state.network = ITERATE_KIT_NETWORK_CONNECTING;
  for (uint32_t now_ms = 0U; now_ms < 4200U; now_ms += 17U) {
    const uint8_t scale =
        iterate_kit_conversation_attention_scale(&state, now_ms);
    if (scale < lowest) lowest = scale;
    if (scale > highest) highest = scale;
    /* Never black: a ring that goes dark reads as a dead device. */
    assert(scale >= 70U);
  }
  assert(highest > 240U);
  assert(lowest < 100U);
}

/* NULL is a state too, and it is the worst one: say something. */
static void an_absent_state_still_says_something(void) {
  assert(iterate_kit_conversation_needs_attention(NULL));
  assert(iterate_kit_conversation_status_word(NULL) != NULL);
  clear_frame();
  iterate_kit_conversation_overlay_render(NULL, 0U, frame, WIDTH, HEIGHT);
  assert(any_pixel_in(0U, 0U, (uint32_t)WIDTH, (uint32_t)HEIGHT));
}

/*
 * Refusing beats clipping: four lights past the bottom edge would relabel
 * every sector below them.
 */
static void a_frame_too_small_is_left_alone(void) {
  clear_frame();
  {
    const struct iterate_kit_conversation_visual_state state = ready_state();
    iterate_kit_conversation_overlay_render(&state, 0U, frame, 4U, 4U);
  }
  assert(!any_pixel_in(0U, 0U, (uint32_t)WIDTH, (uint32_t)HEIGHT));
}

static void names_every_state_a_person_can_reach(void) {
  struct iterate_kit_conversation_visual_state state = ready_state();
  assert(strcmp(iterate_kit_conversation_status_word(&state), "ready") == 0);
  state.conversation_active = true;
  assert(strcmp(iterate_kit_conversation_status_word(&state), "in call") == 0);
  state.microphone_listening = true;
  assert(
      strcmp(iterate_kit_conversation_status_word(&state), "listening") == 0);
  state.speaker_peak = 4000U;
  assert(strcmp(iterate_kit_conversation_status_word(&state), "speaking") == 0);
  state.network = ITERATE_KIT_NETWORK_CONNECTING;
  assert(
      strcmp(iterate_kit_conversation_status_word(&state), "connecting") == 0);
  state.network = ITERATE_KIT_NETWORK_DISCONNECTED;
  assert(strcmp(iterate_kit_conversation_status_word(&state), "offline") == 0);
  state.media_failed = true;
  assert(
      strcmp(iterate_kit_conversation_status_word(&state), "audio fault") == 0);
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
  rail_stays_inside_the_left_margin();
  every_light_has_a_socket();
  ready_leaves_the_face_alone();
  not_connected_raises_a_banner();
  only_attention_states_breathe();
  an_absent_state_still_says_something();
  a_frame_too_small_is_left_alone();
  names_every_state_a_person_can_reach();
  the_face_sleeps_when_the_call_ends();
  a_momentary_drop_does_not_close_the_eyes();
  return 0;
}
