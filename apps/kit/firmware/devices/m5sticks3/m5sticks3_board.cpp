/*
 * M5Unified board bring-up, buttons, and the little status screen.
 *
 * The screen shows the shared avatar — the same 160x120 source frame and the
 * same compiled atlas the CoreS3 renders, carrying the same status rail and
 * the same not-connected banner — with the four-line text status kept as the
 * fallback when a face cannot be had.
 *
 * The frame rate is modest and the render buffer lives in PSRAM. Audio
 * counters are the instrument for deciding whether drawing costs audio.
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
#include "iterate/kit/avatar/face_animator.h"
#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/avatar/face_doze.h"
#include "iterate/kit/avatar/face_keyframe.h"
#include "iterate/kit/avatar/face_render.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/face_wake.h"

#include "m5sticks3_audio.h"

#include <atomic>
#include <cstdio>
#include <cstring>

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#include <M5Unified.h>
#pragma GCC diagnostic pop

#include "esp_timer.h"

namespace {

/** App-task display snapshot and paint throttle. */
struct ui_model {
  enum m5sticks3_ui_state state;
  struct iterate_kit_voice_view view;
  char status[64];
  bool call_active;
  bool link_ready;
  /*
   * The two rungs beneath a call. `link_ready` is true only when the WHOLE
   * chain is usable; these say which half of it is up.
   */
  bool api_ready;
  bool stream_ready;
  bool call_requested;
  /* Unrecoverable start-up fault; latched by m5sticks3_ui_present. */
  bool fault;
  bool dirty;
  int64_t last_paint_us;
};

ui_model ui;
bool call_press_pending;

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
  /*
   * The MOUTH: the same envelope animator the CoreS3 runs, fed by the
   * playback task with the PCM it just handed to I2S, snapshotted here at
   * 12 Hz. The snapshot API is the bounded cross-task seam — a contended
   * attempt keeps the previous pose rather than waiting.
   */
  face_animator_t animator;
  face_animator_state_t latest_pose;
  /* Latest-only face request, catalogue index + 1; zero means none. */
  std::atomic<uint32_t> pending_face_index_plus_one;
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

/* 30 Hz experiment (was 66000 = 15 Hz, matching the CoreS3): the mouths are
 * compared side by side on one desk and smoother wins if the hardware
 * sustains it. The audio instruments (spkStarvedMs, micDropped) are the
 * check that the extra SPI stays affordable; they read zero at 15 and must
 * stay zero here, along with render_failures — if any of them move, back
 * off to 50000 (20 Hz) and re-measure. */
constexpr int64_t FACE_FRAME_INTERVAL_US = 33000;

bool face_init(void) {
  if (!face_avatar_registry_init(&face.registry)) return false;
  face_animator_init(&face.animator, M5STICKS3_AUDIO_SAMPLE_RATE_HZ);
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
  ui.view.fault = ui.fault;
  iterate_kit_voice_view_lights(&ui.view, &status);
  return status;
}

/*
 * The twelve lights, hard against the left edge of the panel.
 *
 * Drawn straight to the display rather than into the face, because the face
 * card is centred on a wider screen and anything inside it is part of the
 * picture. Status belongs to the device, so it sits at the device's edge. The
 * COLOURS still come from the one shared renderer — only the placement is a
 * fact about this board.
 */
void draw_edge_lights(
    const iterate_kit_conversation_visual_state &status, uint32_t sample_clock) {
  constexpr int32_t WIDTH = 6;
  constexpr int32_t MARGIN = 1;
  iterate_kit_rgb8 lights[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  iterate_kit_conversation_lights_for_screen(&status, sample_clock, lights);
  const int32_t panel_h = M5.Display.height();
  const int32_t pitch = panel_h / int{ITERATE_KIT_CONVERSATION_LIGHT_COUNT};
  const int32_t dot = pitch > 2 ? pitch - 2 : 1;
  const int32_t top =
      (panel_h - pitch * int{ITERATE_KIT_CONVERSATION_LIGHT_COUNT} + pitch -
       dot) /
      2;
  for (int32_t index = 0; index < int{ITERATE_KIT_CONVERSATION_LIGHT_COUNT};
       ++index) {
    const iterate_kit_rgb8 light = lights[index];
    M5.Display.fillRect(
        MARGIN,
        top + index * pitch,
        WIDTH,
        dot,
        M5.Display.color565(light.red, light.green, light.blue));
  }
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
  /*
   * A pending face request lands between frames, where the registry is
   * this task's alone. Validated at request time, so a failed select here
   * is a real fault, not a typo.
   */
  {
    const uint32_t requested =
        face.pending_face_index_plus_one.exchange(0U, std::memory_order_acq_rel);
    if (requested != 0U &&
        !face_avatar_registry_select(
            &face.registry, static_cast<size_t>(requested - 1U))) {
      ++face.render_failures;
    }
  }
  /*
   * The pose is the animator's — level, blink, gaze, and the MOUTH the
   * playback task has been feeding — not a neutral key. A contended
   * snapshot keeps the previous pose; the ambient clock below still moves,
   * so idle life never freezes with it.
   */
  {
    face_animator_state_t candidate = face.latest_pose;
    if (face_animator_snapshot(&face.animator, &candidate)) {
      face.latest_pose = candidate;
    }
  }
  face_render_key_t key = {};
  face_render_key_from_pose(&face.latest_pose, &key);
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
  draw_edge_lights(status, sample_clock);
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
      ui.call_active ? "press FRONT or SIDE to end"
                     : "press FRONT or SIDE to start");
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
  /* The shared table codec owns one duplex I2S0 pair. Letting M5Unified
   * create its separate I2S1 microphone or I2S0 speaker owner would put two
   * clock masters on GPIO18/17/15. */
  config.internal_mic = false;
  config.internal_spk = false;
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
  /* M5Unified reports these only after its GPIO debounce has accepted the
   * down edge. Either physical button enters the shared start/end grammar;
   * no local hold or release policy remains. */
  if (M5.BtnA.wasPressed() || M5.BtnB.wasPressed()) call_press_pending = true;
}

void m5sticks3_board_inject_call_press(void) { call_press_pending = true; }

bool m5sticks3_board_take_call_press(void) {
  const bool pressed = call_press_pending;
  call_press_pending = false;
  return pressed;
}

void m5sticks3_ui_present(const struct iterate_kit_voice_view *view) {
  ui.view = *view;
  const auto state = static_cast<enum m5sticks3_ui_state>(view->screen);
  const char *status = view->status == nullptr ? "" : view->status;
  if (ui.state != state ||
      strncmp(ui.status, status, sizeof(ui.status)) != 0 ||
      ui.call_active != view->call_active ||
      ui.link_ready != view->link_ready ||
      ui.api_ready != view->api_ready ||
      ui.stream_ready != view->stream_ready ||
      (!ui.fault && view->fault)) ui.dirty = true;
  ui.state = state;
  (void)snprintf(ui.status, sizeof(ui.status), "%s", status);
  ui.call_active = view->call_active;
  ui.link_ready = view->link_ready;
  ui.api_ready = view->api_ready;
  ui.stream_ready = view->stream_ready;
  ui.fault = ui.fault || view->fault;
}

uint32_t m5sticks3_board_face_frames(void) { return face.rendered; }
uint32_t m5sticks3_board_face_failures(void) { return face.render_failures; }

void m5sticks3_board_observe_playout(const int16_t *samples, size_t count) {
  if (!face.ready || samples == nullptr || count == 0U) return;
  /* Playback task only — the animator has ONE writer, and this is it. */
  face_animator_push_pcm(&face.animator, samples, count);
}

bool m5sticks3_board_request_face(const char *slug, size_t slug_length) {
  if (slug == nullptr || slug_length == 0U || !face.ready) return false;
  const size_t count = face_avatar_registry_count();
  for (size_t index = 0U; index < count; ++index) {
    const char *const candidate = face_avatar_registry_slug_at(index);
    if (candidate == nullptr) continue;
    if (std::strlen(candidate) == slug_length &&
        std::memcmp(candidate, slug, slug_length) == 0) {
      face.pending_face_index_plus_one.store(
          static_cast<uint32_t>(index) + 1U, std::memory_order_release);
      return true;
    }
  }
  return false;
}

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
