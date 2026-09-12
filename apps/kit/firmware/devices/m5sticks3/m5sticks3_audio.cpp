/* M5StickS3's board-owned analogue controls.
 *
 * I2S belongs to the shared table codec: one I2S0 TX/RX pair drives the
 * ES8311's DACDAT (GPIO14) and receives ADCDAT (GPIO16) under the same
 * MCLK/BCLK/WS source. M5Unified is used for display and I2C only.
 */
#include "m5sticks3_audio.h"
#include "m5sticks3_board.h"

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#include <M5Unified.h>
#pragma GCC diagnostic pop

namespace {
constexpr uint8_t m5pm1_address = 0x6eU;
constexpr uint32_t i2c_hz = 100000U;

bool amplifier_set(bool on) {
  return on
      ? M5.In_I2C.bitOn(m5pm1_address, 0x11U, 1U << 3U, i2c_hz)
      : M5.In_I2C.bitOff(m5pm1_address, 0x11U, 1U << 3U, i2c_hz);
}

bool write_register(uint8_t address, uint8_t reg, uint8_t value, uint32_t hz) {
  return M5.In_I2C.writeRegister8(address, reg, value, hz);
}

void playback_observed(
    void *context, const int16_t *samples, size_t count, bool from_sound) {
  (void)context;
  static const int16_t silence[M5STICKS3_AUDIO_SAMPLE_RATE_HZ / 50U] = {0};
  m5sticks3_board_observe_playout(from_sound ? silence : samples, count);
}

void playback_idle(void *context) {
  (void)context;
  playback_observed(NULL, NULL, M5STICKS3_AUDIO_SAMPLE_RATE_HZ / 50U, true);
}
}  // namespace

extern "C" {
bool m5sticks3_audio_prepare(void) {
  iterate_kit_board_i2c_write_with(write_register);
  /* This is visual observation only; it does not own clocks or samples. */
  iterate_kit_i2s_codec_set_playback_callbacks(
      NULL, playback_observed, playback_idle);
  /* M5Unified configures M5PM1 GPIO3 during board detection. Keep PA muted
   * until the table script and both I2S directions have started. */
  return amplifier_set(false);
}

void m5sticks3_audio_play_sound(const uint8_t *pcm, uint32_t bytes) {
  if (pcm == nullptr || bytes < 2U) return;
  /* The PA latch is on M5PM1, not an ESP GPIO, so this board owns the small
   * wrapper around the generic sound mailbox. */
  m5sticks3_audio_amplifier(true);
  iterate_kit_i2s_codec_play_sound(pcm, bytes);
}

void m5sticks3_audio_amplifier(bool on) {
  static bool initialized;
  static bool current;
  if (initialized && current == on) return;
  if (amplifier_set(on)) {
    initialized = true;
    current = on;
  }
}
}  // extern "C"
