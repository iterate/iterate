/*
 * M5Unified board bring-up, buttons, and the little status screen.
 *
 * The screen shows the shared avatar — the same 160x120 source frame and the
 * same compiled atlas the CoreS3 renders, carrying the same status rail and
 * the same not-connected banner — with the four-line text status kept as the
 * fallback when a face cannot be had.
 *
 * The earlier port deliberately showed only text, reasoning that 38.4 KiB
 * frames over this panel's SPI bus could crowd a HALF-DUPLEX audio path where
 * capture and playback already hand I2S back and forth. That risk is real and
 * is why the frame rate here is modest and the render buffer lives in PSRAM —
 * but "no face at all" was the wrong answer to it: this is the product's face,
 * and the audio counters (spkStarvedMs, micDropped) are the instrument that
 * says whether drawing it costs anything. They read zero with it on.
 *
 * THE FACE AND THE TEXT SCREEN ARE ALTERNATIVES, NEVER LAYERS. The first
 * version of this drew the text screen at boot and then pushed a 160x120 face
 * into the middle of the panel, which left the old headline and key hints
 * framing the avatar forever — one surface superimposed on another, and it
 * looked exactly as accidental as it was. Whichever surface owns the screen
 * now owns all of it.
 */
#include "m5sticks3_board.h"

#include "esp_heap_caps.h"
#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/avatar/face_doze.h"
#include "iterate/kit/avatar/face_keyframe.h"
#include "iterate/kit/avatar/face_render.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/face_wake.h"

#include <cstdio>
#include <cstring>

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#include <M5Unified.h>
#pragma GCC diagnostic pop

#include "esp_timer.h"

namespace {

struct ui_model {
  enum m5sticks3_ui_state state;
  char status[64];
  bool call_active;
  bool link_ready;
  bool call_requested;
  /* Unrecoverable start-up fault; see m5sticks3_ui_set_fault. */
  bool fault;
  bool dirty;
  int64_t last_paint_us;
};

ui_model ui;
bool talk_held_level;
bool side_press_pending;

const char *state_label(enum m5sticks3_ui_state state) {
  switch (state) {
    case M5STICKS3_UI_IDLE:
      return "idle";
    case M5STICKS3_UI_CONNECTING:
      return "connecting";
    case M5STICKS3_UI_LISTENING:
      return "listening";
    case M5STICKS3_UI_SPEAKING:
      return "speaking";
  }
  return "?";
}

/*
 * The avatar sidecar. Everything about it is deliberately small: one registry,
 * one PSRAM source frame, and a sample clock that advances with real time so
 * the ambient performance layer (blinks, glances, breathing) animates without
 * this board needing the CoreS3's analyzer task, mutex or screenshot path.
 */
namespace {

struct FaceState {
  face_avatar_registry_t registry;
  uint16_t *frame;      /* FACE_RENDER_WIDTH x FACE_RENDER_HEIGHT, PSRAM */
  bool ready;
  int32_t x;            /* where the scaled face lands on this panel */
  int32_t y;
  int32_t width;
  int32_t height;
  uint32_t rendered;    /* frames actually pushed; the liveness instrument */
  uint32_t render_failures;
  int64_t last_frame_us;
  iterate_kit_face_wake wake;
};

FaceState face;

/* 12 Hz: fast enough for a blink to read as a blink, slow enough that the SPI
 * transfer stays a small fraction of the half-duplex audio budget. */
constexpr int64_t FACE_FRAME_INTERVAL_US = 83000;

bool face_init(void) {
  if (!face_avatar_registry_init(&face.registry)) return false;
  const size_t pixels = (size_t)FACE_RENDER_WIDTH * (size_t)FACE_RENDER_HEIGHT;
  /*
   * PSRAM, not internal: 38.4 KiB of internal heap is what Wi-Fi and the I2S
   * ring need, and a face is never worth a dropped frame of audio. The panel
   * transfer reads it with the CPU, so PSRAM latency costs a little time and
   * no correctness.
   */
  face.frame = static_cast<uint16_t *>(
      heap_caps_malloc(pixels * sizeof(uint16_t), MALLOC_CAP_SPIRAM));
  if (face.frame == nullptr) return false;

  /* Largest whole-pixel scale that fits, so the face has no resampling blur. */
  const int32_t panel_w = M5.Display.width();
  const int32_t panel_h = M5.Display.height();
  int32_t scale = panel_w / FACE_RENDER_WIDTH;
  const int32_t vertical = panel_h / FACE_RENDER_HEIGHT;
  if (vertical < scale) scale = vertical;
  if (scale < 1) scale = 1;
  face.width = FACE_RENDER_WIDTH * scale;
  face.height = FACE_RENDER_HEIGHT * scale;
  face.x = (panel_w - face.width) / 2;
  face.y = (panel_h - face.height) / 2;
  face.ready = true;
  /*
   * The panel is wider than the face card, and those margins are painted
   * exactly once here. Nothing else may ever draw outside the card: that is
   * what keeps the two surfaces from layering.
   */
  M5.Display.fillScreen(TFT_BLACK);
  return true;
}

/* The same semantic snapshot every surface in this product renders from. */
iterate_kit_conversation_visual_state face_status(void) {
  iterate_kit_conversation_visual_state status = {};
  status.network = ui.link_ready ? ITERATE_KIT_NETWORK_CONNECTED
                                 : ITERATE_KIT_NETWORK_CONNECTING;
  status.conversation_active = ui.call_active;
  status.media_ready = ui.link_ready;
  status.media_failed = ui.fault;
  status.microphone_listening = ui.state == M5STICKS3_UI_LISTENING;
  status.speaker_peak = ui.state == M5STICKS3_UI_SPEAKING ? 4096U : 0U;
  return status;
}

/* Draw one animated frame. Returns false if the face cannot be drawn at all,
 * which is the caller's cue to fall back to the text status screen. */
bool face_draw(void) {
  if (!face.ready) return false;
  const int64_t now_us = esp_timer_get_time();
  if (now_us - face.last_frame_us < FACE_FRAME_INTERVAL_US) return true;
  face.last_frame_us = now_us;

  /*
   * A neutral key plus the clock: the registry applies the ambient performance
   * itself, so idle life comes for free and the mouth stays closed until
   * something drives it. The clock is milliseconds of uptime, which is what
   * makes the animation move at all — a fixed clock renders one frozen pose.
   */
  face_render_key_t key = {};
  key.schema_version = FACE_RENDER_KEY_SCHEMA_VERSION;
  const uint32_t sample_clock = static_cast<uint32_t>(now_us / 1000);
  const size_t pixels = (size_t)FACE_RENDER_WIDTH * (size_t)FACE_RENDER_HEIGHT;
  const iterate_kit_conversation_visual_state status = face_status();
  const bool dozing = !iterate_kit_face_awake(
      &face.wake, status.conversation_active,
      static_cast<uint64_t>(now_us / 1000));
  if (dozing) face_doze_prepare_render_key(&key);
  if (!face_avatar_registry_render(
          &face.registry, &key, sample_clock, face.frame, pixels)) {
    ++face.render_failures;
    return false;
  }
  if (dozing && !face_doze_apply_overlay(face.frame, pixels, sample_clock)) {
    /* The sleeping face is a promise about lifecycle; a half-applied one
     * would say the device is awake. Fail to the text screen instead. */
    ++face.render_failures;
    return false;
  }
  iterate_kit_conversation_overlay_render(
      &status,
      sample_clock,
      /* No LEDs on this board, so the face carries them. */
      ITERATE_KIT_OVERLAY_LIGHTS_RAIL,
      face.frame,
      static_cast<uint32_t>(int{FACE_RENDER_WIDTH}),
      static_cast<uint32_t>(int{FACE_RENDER_HEIGHT}));

  /* The atlas dimensions are enum constants; widen them once so none of the
   * arithmetic below mixes an enum with a float. */
  const float source_w = static_cast<float>(int{FACE_RENDER_WIDTH});
  const float source_h = static_cast<float>(int{FACE_RENDER_HEIGHT});
  M5.Display.startWrite();
  M5.Display.pushImageRotateZoom(
      static_cast<float>(face.x) + static_cast<float>(face.width) / 2.0f,
      static_cast<float>(face.y) + static_cast<float>(face.height) / 2.0f,
      source_w / 2.0f,
      source_h / 2.0f,
      0.0f,
      static_cast<float>(face.width) / source_w,
      static_cast<float>(face.height) / source_h,
      int{FACE_RENDER_WIDTH},
      int{FACE_RENDER_HEIGHT},
      face.frame);
  M5.Display.endWrite();
  ++face.rendered;
  return true;
}

}  // namespace

void paint(void) {
  M5.Display.startWrite();
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(4, 4);
  M5.Display.setTextColor(ui.link_ready ? TFT_GREEN : TFT_ORANGE, TFT_BLACK);
  M5.Display.print(ui.link_ready ? "iterate" : "iterate (offline)");
  M5.Display.setCursor(4, 30);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.printf(
      "%s%s", state_label(ui.state), ui.call_active ? " (call)" : "");
  M5.Display.setTextSize(1);
  M5.Display.setCursor(4, 60);
  M5.Display.setTextColor(TFT_SILVER, TFT_BLACK);
  M5.Display.print(ui.status);
  M5.Display.setCursor(4, 110);
  M5.Display.setTextColor(TFT_DARKGREY, TFT_BLACK);
  M5.Display.print(
      ui.call_active ? "hold FRONT to talk / SIDE ends"
                     : "press SIDE to start a call");
  M5.Display.endWrite();
}

}  // namespace

extern "C" {

bool m5sticks3_board_init(void) {
  auto config = M5.config();
  /*
   * Enable only peripherals this target uses. Optional IMU/RTC/LED behavior
   * belongs in capability adapters, not an always-on side effect of startup.
   */
  config.clear_display = true;
  config.output_power = false;
  config.internal_imu = false;
  config.internal_rtc = false;
  config.internal_mic = true;
  config.internal_spk = true;
  config.external_imu = false;
  config.external_rtc = false;
  config.led_brightness = 0;
  /*
   * On a USB-Serial/JTAG warm reset the panel can miss M5GFX's first
   * autodetection probe; M5Unified then uses `fallback_board`, whose generic
   * ESP32-S3 default is AtomS3Lite — which made the donor process reject the
   * real Stick. The image being flashed fixes the board identity, so name it.
   * A positively detected different board still wins over this fallback and
   * is rejected below.
   */
  config.fallback_board = m5::board_t::board_M5StickS3;
  M5.begin(config);
  if (M5.getBoard() != m5::board_t::board_M5StickS3) {
    /*
     * M5Unified supports many boards with different pin/audio topology.
     * Failing closed prevents a seemingly successful flash from driving the
     * wrong speaker/microphone pins.
     */
    return false;
  }
  /*
   * Playback uses a direct ESP-IDF channel and must never coexist with
   * M5Unified's mixer task or retained playRaw() buffers; the microphone is
   * started only inside the half-duplex fence.
   */
  M5.Mic.end();
  M5.Speaker.end();
  M5.Display.setRotation(1);
  M5.Display.setColorDepth(16);
  M5.Display.setSwapBytes(true);
  M5.Display.setBrightness(96);
  ui.state = M5STICKS3_UI_CONNECTING;
  (void)snprintf(ui.status, sizeof(ui.status), "starting");
  ui.dirty = true;
  /*
   * The face is the product's surface, so it is tried first and its absence is
   * said out loud rather than silently becoming a text screen forever. The
   * text screen is drawn HERE ONLY IF THERE IS NO FACE: painting it first and
   * letting the avatar land on top is what left the old headline framing the
   * face on every boot.
   */
  if (!face_init()) {
    ESP_LOGW(
        "m5sticks3-board",
        "no avatar (registry or PSRAM frame unavailable); status text only");
    paint();
  }
  ui.last_paint_us = esp_timer_get_time();
  ui.dirty = false;
  return true;
}

void m5sticks3_board_poll(void) {
  M5.update();
  /*
   * Store the stable level plus one pending bit instead of queueing edges.
   * Push-to-talk is polled every app-loop pass; the invariant is eventual
   * agreement with the physical button, without bounce building a backlog.
   */
  if (M5.BtnA.wasPressed()) talk_held_level = true;
  if (M5.BtnA.wasReleased()) talk_held_level = false;
  if (M5.BtnB.wasPressed()) side_press_pending = true;
}

bool m5sticks3_board_talk_held(void) {
  return talk_held_level;
}

bool m5sticks3_board_take_side_press(void) {
  const bool pressed = side_press_pending;
  side_press_pending = false;
  return pressed;
}

void m5sticks3_ui_set_state(enum m5sticks3_ui_state state) {
  if (ui.state == state) return;
  ui.state = state;
  ui.dirty = true;
}

void m5sticks3_ui_set_status(const char *status) {
  if (status == nullptr) status = "";
  if (strncmp(ui.status, status, sizeof(ui.status)) == 0) return;
  (void)snprintf(ui.status, sizeof(ui.status), "%s", status);
  ui.dirty = true;
}

void m5sticks3_ui_set_call_active(bool active) {
  if (ui.call_active == active) return;
  ui.call_active = active;
  ui.dirty = true;
}

void m5sticks3_ui_set_fault(void) {
  if (ui.fault) return;
  ui.fault = true;
  ui.dirty = true;
}

void m5sticks3_ui_set_link_ready(bool ready) {
  if (ui.link_ready == ready) return;
  ui.link_ready = ready;
  ui.dirty = true;
}

void m5sticks3_ui_request_call(bool wanted) {
  ui.call_requested = wanted;
}

bool m5sticks3_ui_call_requested(void) {
  return ui.call_requested;
}

uint32_t m5sticks3_board_face_frames(void) { return face.rendered; }
uint32_t m5sticks3_board_face_failures(void) { return face.render_failures; }

void m5sticks3_ui_tick(void) {
  /*
   * The face animates on its own clock, independently of state changes — an
   * idle device that never blinks reads as a crashed one, which is the whole
   * reason the ambient layer exists. Its own interval gate keeps this cheap.
   */
  if (face_draw()) {
    /* A face is showing, so the text screen's dirty flag has nothing to do. */
    ui.dirty = false;
    return;
  }
  if (!ui.dirty) return;
  const int64_t now_us = esp_timer_get_time();
  /* 10 Hz ceiling: state churn coalesces into one repaint. */
  if (now_us - ui.last_paint_us < 100000) return;
  ui.last_paint_us = now_us;
  ui.dirty = false;
  paint();
}

}  // extern "C"
