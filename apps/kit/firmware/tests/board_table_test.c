#include "iterate/kit/platforms/board.h"
#include <assert.h>
#include <string.h>

static void volume_table(void) {
  const struct {
    int16_t full, floor;
    uint8_t ceiling, percent, code, applied;
  } rows[] = {
    {0, -126, 100, 0, 0x82, 0}, {0, -126, 100, 1, 0x83, 1},
    {0, -126, 100, 50, 0xc1, 50}, {0, -126, 100, 99, 0xfe, 99},
    {0, -126, 100, 100, 0, 100}, {0, -126, 100, 255, 0, 100},
    {0x9b, 0, 100, 50, 77, 50}, {0x9b, 0, 100, 100, 0x9b, 100},
    {0, 200, 100, 50, 100, 50}, {0, 200, 100, 1, 198, 1},
    {0, 200, 100, 100, 0, 100}, {0, 200, 92, 255, 16, 92},
    {48, 153, 100, 1, 152, 1}, {48, 153, 100, 100, 48, 100},
    {0, -126, 0, 100, 0x82, 0}, {0, -126, 255, 255, 0, 100},
  };
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    const struct iterate_kit_volume_register volume = {
      .full_code = rows[i].full, .floor_code = rows[i].floor,
    };
    uint8_t applied = 255;
    assert(iterate_kit_board_volume_code(&volume, rows[i].ceiling, rows[i].percent, &applied) == rows[i].code);
    assert(applied == rows[i].applied);
    assert(iterate_kit_board_volume_code(&volume, rows[i].ceiling, rows[i].percent, NULL) == rows[i].code);
  }
}

static void i2s_table(void) {
  const struct iterate_kit_i2s_codec_facts duplex = {
    .playback_port = I2S_NUM_0, .capture_port = I2S_NUM_0, .role = I2S_ROLE_SLAVE,
    .playback = {.clk_cfg = {.sample_rate_hz = 48000},
      .slot_cfg = {.data_bit_width = 32, .slot_mode = 2},
      .gpio_cfg = {.mclk = -1, .bclk = 8, .ws = 7, .dout = 9, .din = 15}},
    .capture = {.clk_cfg = {.sample_rate_hz = 48000},
      .slot_cfg = {.data_bit_width = 32, .slot_mode = 2},
      .gpio_cfg = {.mclk = -1, .bclk = 8, .ws = 7, .dout = 9, .din = 15}},
    .dma_frames = 480, .dma_descriptors = 6,
    .playback_shape = {32, 2, 0, -1, 3}, .capture_shape = {32, 2, 1, 0, 3},
    .capture_gain = 16, .amplifier_gpio = -1,
  };
  const struct {
    bool separate;
    int bclk, ws, din;
    uint16_t frames;
    uint32_t rate;
    bool valid;
  } rows[] = {
    {false, 8, 7, 15, 480, 48000, true},
    {false, 13, 7, 15, 480, 48000, false},
    {false, 8, 14, 15, 480, 48000, false},
    {false, 8, 7, 9, 480, 48000, false},
    {false, 8, 7, 15, 512, 48000, false},
    {false, 8, 7, 15, 480, 16000, false},
    {true, 13, 14, 15, 480, 16000, true},
    {true, 8, 14, 15, 480, 16000, false},
    {true, 13, 7, 15, 480, 16000, false},
    {true, 13, 14, 9, 480, 16000, false},
  };
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    struct iterate_kit_i2s_codec_facts facts = duplex;
    facts.capture.gpio_cfg.bclk = rows[i].bclk;
    facts.capture.gpio_cfg.ws = rows[i].ws;
    facts.capture.gpio_cfg.din = rows[i].din;
    facts.dma_frames = rows[i].frames;
    facts.capture.clk_cfg.sample_rate_hz = rows[i].rate;
    if (rows[i].separate) {
      facts.capture_port = I2S_NUM_1;
      facts.capture_shape.ratio = 1;
      facts.capture_dma_frames = 320;
      facts.capture_dma_descriptors = 5;
      facts.playback.gpio_cfg.din = -1;
      facts.capture.gpio_cfg.dout = -1;
    }
    assert(iterate_kit_i2s_codec_valid(&facts) == rows[i].valid);
  }
  assert(!iterate_kit_i2s_codec_valid(NULL));
}

static unsigned events[8];
static size_t event_count;
static size_t fail_at;
static bool drive(int8_t gpio, uint8_t level) {
  events[event_count++] = (unsigned)gpio * 2U + level;
  return event_count != fail_at;
}
static void wait_ms(uint16_t ms) { events[event_count++] = 1000U + ms; }

static void boot_table(void) {
  const struct iterate_kit_gpio_step boot[] = {{47, 0, 0}, {4, 1, 1}, {4, 0, 3000}};
  const struct { size_t fail; bool ok; size_t count; unsigned events[5]; } rows[] = {
    {0, true, 5, {94, 9, 1001, 8, 4000}},
    {1, false, 1, {94}}, {2, false, 2, {94, 9}},
    {4, false, 4, {94, 9, 1001, 8}},
  };
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    event_count = 0;
    fail_at = rows[i].fail;
    assert(iterate_kit_board_boot_steps(boot, 3, drive, wait_ms) == rows[i].ok);
    assert(event_count == rows[i].count);
    assert(memcmp(events, rows[i].events, event_count * sizeof(*events)) == 0);
  }
  assert(iterate_kit_board_boot_steps(NULL, 0, drive, wait_ms));
  assert(!iterate_kit_board_boot_steps(NULL, 1, drive, wait_ms));
}

int main(void) {
  volume_table();
  i2s_table();
  boot_table();
  return 0;
}
