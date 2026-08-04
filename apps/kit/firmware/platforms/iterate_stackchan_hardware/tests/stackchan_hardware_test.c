#include "iterate/kit/platforms/stackchan_hardware.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

static const uint8_t captured_jpeg[] = {0xffU, 0xd8U, 0xffU, 0xd9U};

struct fixture {
  struct iterate_kit_stackchan_hardware hardware;
  uint32_t display_colour;
  size_t display_calls;
  char rendered_url[64];
  size_t render_calls;
  uint16_t pixels[ITERATE_KIT_STACKCHAN_LED_COUNT];
  size_t led_calls;
  size_t fail_led_call;
  int16_t yaw;
  int16_t pitch;
  uint16_t duration_ms;
  size_t servo_calls;
  size_t capture_calls;
  size_t release_calls;
  void *released_handle;
};

static enum iterate_kit_status fill_display(
    void *context, uint32_t rgb888) {
  struct fixture *fixture = context;
  fixture->display_colour = rgb888;
  ++fixture->display_calls;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status render_png(
    void *context, const char *url, size_t url_length) {
  struct fixture *fixture = context;
  assert(url_length < sizeof(fixture->rendered_url));
  memcpy(fixture->rendered_url, url, url_length);
  fixture->rendered_url[url_length] = '\0';
  ++fixture->render_calls;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status write_leds(
    void *context,
    const uint16_t *rgb565,
    size_t pixel_count) {
  struct fixture *fixture = context;
  ++fixture->led_calls;
  if (fixture->fail_led_call == fixture->led_calls) {
    return ITERATE_KIT_IO_ERROR;
  }
  assert(pixel_count == ITERATE_KIT_STACKCHAN_LED_COUNT);
  memcpy(fixture->pixels, rgb565, sizeof(fixture->pixels));
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status move_head(
    void *context,
    int16_t yaw,
    int16_t pitch,
    uint16_t duration_ms) {
  struct fixture *fixture = context;
  fixture->yaw = yaw;
  fixture->pitch = pitch;
  fixture->duration_ms = duration_ms;
  ++fixture->servo_calls;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status capture_jpeg(
    void *context,
    struct iterate_kit_stackchan_photo_frame *frame) {
  struct fixture *fixture = context;
  ++fixture->capture_calls;
  *frame = (struct iterate_kit_stackchan_photo_frame){
    captured_jpeg,
    sizeof(captured_jpeg),
    (void *)(uintptr_t)fixture->capture_calls,
  };
  return ITERATE_KIT_OK;
}

static void release_jpeg(void *context, void *frame_handle) {
  struct fixture *fixture = context;
  ++fixture->release_calls;
  fixture->released_handle = frame_handle;
}

static void fixture_init(struct fixture *fixture) {
  const struct iterate_kit_stackchan_hardware_ops ops = {
    .context = fixture,
    .fill_display = fill_display,
    .render_png = render_png,
    .write_leds = write_leds,
    .move_head = move_head,
    .capture_jpeg = capture_jpeg,
    .release_jpeg = release_jpeg,
  };
  memset(fixture, 0, sizeof(*fixture));
  assert(
      iterate_kit_stackchan_hardware_init(&fixture->hardware, &ops) ==
      ITERATE_KIT_OK);
}

/*
 * Colour names belong to the generic capability, while the display backend
 * owns LVGL/BSP locking. Keeping the mapping here prevents every hardware
 * bridge and host simulator from quietly choosing a different colour format.
 */
static void screen_maps_contract_and_rejects_insecure_urls(void) {
  struct fixture fixture;
  struct iterate_kit_screen_driver driver;
  fixture_init(&fixture);
  driver = iterate_kit_stackchan_screen_driver(&fixture.hardware);

  assert(
      driver.change_colour(driver.context, ITERATE_KIT_SCREEN_RED) ==
      ITERATE_KIT_OK);
  assert(fixture.display_colour == 0xff0000U);
  assert(
      driver.change_colour(driver.context, ITERATE_KIT_SCREEN_GREEN) ==
      ITERATE_KIT_OK);
  assert(fixture.display_colour == 0x00ff00U);
  assert(fixture.display_calls == 2U);

  assert(
      driver.render_png(
          driver.context,
          "http://example.test/a.png",
          sizeof("http://example.test/a.png") - 1U) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(fixture.render_calls == 0U);
  assert(
      driver.render_png(
          driver.context,
          "https://example.test/a.png",
          sizeof("https://example.test/a.png") - 1U) ==
      ITERATE_KIT_OK);
  assert(strcmp(fixture.rendered_url, "https://example.test/a.png") == 0);
}

/*
 * The PY32 body accepts all 12 RGB565 words in one update. A shadow is needed
 * for set(index): sending just one register would let another writer's partial
 * refresh leak, while committing a failed I2C write would make later updates
 * build on pixels the body never received.
 */
static void leds_convert_rgb565_and_commit_only_success(void) {
  struct fixture fixture;
  struct iterate_kit_led_driver driver;
  fixture_init(&fixture);
  driver = iterate_kit_stackchan_led_driver(&fixture.hardware);

  assert(
      driver.fill(driver.context, 255U, 0U, 0U) == ITERATE_KIT_OK);
  for (size_t index = 0U;
       index < ITERATE_KIT_STACKCHAN_LED_COUNT;
       ++index) {
    assert(fixture.pixels[index] == 0xf800U);
  }

  assert(
      driver.set(driver.context, 3U, 0U, 255U, 0U) == ITERATE_KIT_OK);
  assert(fixture.pixels[2] == 0xf800U);
  assert(fixture.pixels[3] == 0x07e0U);

  fixture.fail_led_call = fixture.led_calls + 1U;
  assert(
      driver.set(driver.context, 3U, 0U, 0U, 255U) ==
      ITERATE_KIT_IO_ERROR);
  fixture.fail_led_call = 0U;
  assert(
      driver.set(driver.context, 4U, 255U, 255U, 255U) ==
      ITERATE_KIT_OK);
  assert(fixture.pixels[3] == 0x07e0U);
  assert(fixture.pixels[4] == 0xffffU);
}

/*
 * StackChan's two physical six-pixel runs are a different geometry, not a
 * different product language. This test protects the direct index mapping of
 * the shared HAVPE-compatible twelve-pixel render: good Wi-Fi occupies the
 * first three green pixels on one side, while an idle device leaves the audio
 * sectors dark. A future target-local status painter would fail here.
 */
static void status_uses_the_shared_twelve_pixel_grammar(void) {
  struct fixture fixture;
  const struct iterate_kit_conversation_visual_state state = {
      .network = ITERATE_KIT_NETWORK_CONNECTED,
      .has_wifi_rssi = true,
      .wifi_rssi_dbm = -48,
  };
  fixture_init(&fixture);

  assert(
      iterate_kit_stackchan_hardware_show_status(
          &fixture.hardware, &state) == ITERATE_KIT_OK);
  assert(fixture.led_calls == 1U);
  for (size_t index = 0U; index < 3U; ++index) {
    assert(fixture.pixels[index] == 0x00e0U);
  }
  for (size_t index = 3U;
       index < ITERATE_KIT_STACKCHAN_LED_COUNT;
       ++index) {
    assert(fixture.pixels[index] == 0U);
  }
}

/*
 * The platform boundary uses the same relative degree coordinate as the
 * official M5Stack Motion API. Raw zero calibration belongs to the physical
 * SCS0009 owner, not this reusable capability adapter. Duration goes through
 * without an easing queue; the body servos perform the timed move themselves.
 */
static void servos_translate_to_official_stackchan_geometry(void) {
  struct fixture fixture;
  struct iterate_kit_servo_driver driver;
  fixture_init(&fixture);
  driver = iterate_kit_stackchan_servo_driver(&fixture.hardware);

  assert(driver.move(driver.context, -25, 40, 275U) == ITERATE_KIT_OK);
  assert(fixture.yaw == -25);
  assert(fixture.pitch == 40);
  assert(fixture.duration_ms == 275U);
  assert(fixture.servo_calls == 1U);
}

/*
 * esp_camera lends one frame buffer. A second capture before Cap'n Web has
 * released the first would either overwrite reply bytes or make the camera
 * driver allocate another large buffer. Explicit backpressure is the only
 * bounded and observable answer.
 */
static void camera_allows_exactly_one_borrowed_frame(void) {
  struct fixture fixture;
  struct iterate_kit_camera_driver driver;
  struct iterate_kit_photo first = {0};
  struct iterate_kit_photo blocked = {0};
  struct iterate_kit_photo second = {0};
  fixture_init(&fixture);
  driver = iterate_kit_stackchan_camera_driver(&fixture.hardware);

  assert(driver.take_photo(driver.context, &first) == ITERATE_KIT_OK);
  assert(first.data == captured_jpeg);
  assert(first.size == sizeof(captured_jpeg));
  assert(first.release != NULL);
  assert(
      driver.take_photo(driver.context, &blocked) ==
      ITERATE_KIT_BACKPRESSURE);
  assert(fixture.capture_calls == 1U);

  first.release(first.release_context);
  assert(fixture.release_calls == 1U);
  assert(fixture.released_handle == (void *)(uintptr_t)1U);
  assert(driver.take_photo(driver.context, &second) == ITERATE_KIT_OK);
  assert(fixture.capture_calls == 2U);
  second.release(second.release_context);
  assert(fixture.release_calls == 2U);
}

/*
 * Platform discovery may find a bare CoreS3 without the StackChan body, and
 * PNG/photo support has separate bounded-decoder requirements. Driver views
 * remain structurally valid so profile assembly is deterministic, but absent
 * hardware must report UNAVAILABLE instead of pretending the command worked.
 */
static void absent_hardware_fails_explicitly(void) {
  struct iterate_kit_stackchan_hardware hardware;
  const struct iterate_kit_stackchan_hardware_ops ops = {0};
  struct iterate_kit_photo photo = {0};
  assert(
      iterate_kit_stackchan_hardware_init(&hardware, &ops) == ITERATE_KIT_OK);
  assert(
      iterate_kit_stackchan_screen_driver(&hardware).change_colour(
          &hardware, ITERATE_KIT_SCREEN_RED) == ITERATE_KIT_UNAVAILABLE);
  assert(
      iterate_kit_stackchan_led_driver(&hardware).fill(
          &hardware, 1U, 2U, 3U) == ITERATE_KIT_UNAVAILABLE);
  assert(
      iterate_kit_stackchan_servo_driver(&hardware).move(
          &hardware, 0, 90, 100U) == ITERATE_KIT_UNAVAILABLE);
  assert(
      iterate_kit_stackchan_camera_driver(&hardware).take_photo(
          &hardware, &photo) == ITERATE_KIT_UNAVAILABLE);
}

/*
 * This adapter sits beside the much larger display and camera buffers, so a
 * casual queue or copied frame would be easy to miss in an ordinary behaviour
 * test. The budget is deliberately checked on the 64-bit host, where function
 * pointers cost twice what they do on ESP32-S3. It leaves room for alignment
 * but fails if somebody adds another frame, URL buffer, or command backlog.
 */
static void adapter_state_remains_small_and_fixed(void) {
  assert(sizeof(struct iterate_kit_stackchan_hardware) <= 128U);
  assert(
      sizeof(((struct iterate_kit_stackchan_hardware *)0)->confirmed_leds) ==
      24U);
}

int main(void) {
  screen_maps_contract_and_rejects_insecure_urls();
  leds_convert_rgb565_and_commit_only_success();
  status_uses_the_shared_twelve_pixel_grammar();
  servos_translate_to_official_stackchan_geometry();
  camera_allows_exactly_one_borrowed_frame();
  absent_hardware_fails_explicitly();
  adapter_state_remains_small_and_fixed();
  printf(
      "stackchan hardware adapter tests passed (host state=%zu bytes)\n",
      sizeof(struct iterate_kit_stackchan_hardware));
  return 0;
}
