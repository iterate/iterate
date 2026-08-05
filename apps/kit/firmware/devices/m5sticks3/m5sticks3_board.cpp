/*
 * M5Unified board bring-up, buttons, and the little status screen.
 *
 * The screen is deliberately a four-line text status surface, not the donor
 * target's avatar/menu product UI: this consolidation ports the voice
 * endpoint, and every repaint is a few hundred pixels over the panel's own
 * SPI bus, throttled to 10 Hz, so it cannot crowd the audio path the way the
 * donor's 38.4 KiB sprite uploads could.
 */
#include "m5sticks3_board.h"

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
  paint();
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

void m5sticks3_ui_tick(void) {
  if (!ui.dirty) return;
  const int64_t now_us = esp_timer_get_time();
  /* 10 Hz ceiling: state churn coalesces into one repaint. */
  if (now_us - ui.last_paint_us < 100000) return;
  ui.last_paint_us = now_us;
  ui.dirty = false;
  paint();
}

}  // extern "C"
