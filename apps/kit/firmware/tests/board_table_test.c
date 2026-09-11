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
  /* An external DSP supplies the slave clocks. Driving MCLK would contend
   * with it; the same wiring is supported when the ESP is the clock master. */
  struct iterate_kit_i2s_codec_facts master_clock = duplex;
  master_clock.playback.gpio_cfg.mclk = 16;
  master_clock.capture.gpio_cfg.mclk = 16;
  assert(!iterate_kit_i2s_codec_valid(&master_clock));
  master_clock.role = I2S_ROLE_MASTER;
  assert(iterate_kit_i2s_codec_valid(&master_clock));
  master_clock.role = I2S_ROLE_SLAVE;
  master_clock.playback.clk_cfg.clk_src = I2S_CLK_SRC_EXTERNAL;
  master_clock.capture.clk_cfg.clk_src = I2S_CLK_SRC_EXTERNAL;
  assert(iterate_kit_i2s_codec_valid(&master_clock));
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

/** Omitted audio facts acquire defaults; explicit facts and absent audio survive. */
static void iterate_kit_board_defaults_table(void) {
  const struct iterate_kit_i2s_codec_facts audio = {
    .playback = {.clk_cfg = {.sample_rate_hz = 48000}},
    .dma_frames = 480, .dma_descriptors = 6,
  };
  const struct iterate_kit_i2s_codec_facts invalid_audio = {0};
  const struct {
    struct iterate_kit_board_facts facts;
    const struct iterate_kit_i2s_codec_facts *audio;
    size_t processing, capture, stack;
    uint32_t dry_wait;
  } rows[] = {
    /* One omitted audio field at a time, keeping the other three explicit. */
    {{.processing_frame_samples = 256, .capture_chunk_samples = 128,
      .capture_stack_bytes = 8192, .speaker_dry_wait_ms = 25}, NULL,
      256, 128, 8192, 25},
    {{.capture_chunk_samples = 128,
      .capture_stack_bytes = 8192, .speaker_dry_wait_ms = 25}, NULL,
      320, 128, 8192, 25},
    {{.processing_frame_samples = 256,
      .capture_stack_bytes = 8192, .speaker_dry_wait_ms = 25}, NULL,
      256, 320, 8192, 25},
    {{.processing_frame_samples = 256,
      .capture_chunk_samples = 128, .speaker_dry_wait_ms = 25}, NULL,
      256, 128, 4096, 25},
    {{.processing_frame_samples = 256,
      .capture_chunk_samples = 128, .capture_stack_bytes = 8192}, &audio,
      256, 128, 8192, 40},
    /* Explicit wait overrides TX geometry; absent/invalid audio cannot divide. */
    {{.processing_frame_samples = 256,
      .capture_chunk_samples = 128, .capture_stack_bytes = 8192,
      .speaker_dry_wait_ms = 25}, &audio, 256, 128, 8192, 25},
    {{0}, NULL, 320, 320, 4096, 0},
    {{0}, &invalid_audio, 320, 320, 4096, 0},
    {{0}, &audio, 320, 320, 4096, 40},
  };
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    const struct iterate_kit_board board = {.facts = rows[i].facts, .audio = rows[i].audio};
    const struct iterate_kit_board_facts facts = iterate_kit_board_defaults(&board);
    assert(facts.processing_frame_samples == rows[i].processing);
    assert(facts.capture_chunk_samples == rows[i].capture);
    assert(facts.capture_stack_bytes == rows[i].stack);
    assert(facts.speaker_dry_wait_ms == rows[i].dry_wait);
    assert(memcmp(&board.facts, &rows[i].facts, sizeof(board.facts)) == 0);
  }
}

/* Board.c alone translates normalized board input into grammar facts. */
static void normalized_gestures_use_the_shared_grammar(void) {
  const struct iterate_kit_voice_view idle = {0};
  const struct iterate_kit_gpio_button m5 = {.tap_wakes = true, .tap_ends = true};
  const struct iterate_kit_gpio_button waveshare = {.tap_wakes = true, .tap_ends = false};
  const struct iterate_kit_gpio_button havpe = {.tap_wakes = false, .tap_ends = true};
  const struct iterate_kit_gpio_button stackchan = {.tap_ends = true};
  struct iterate_kit_session session = {0};
  struct iterate_kit_session_actions actions;

  /* M5's physical side tap and injected tap both become a wake. */
  iterate_kit_board_apply_gestures(
      &session, &(struct iterate_kit_board_gestures){.tap = true}, &m5,
      true, &idle, 1U, &actions);
  assert(actions.start_call && actions.wake_chime && !actions.talk_held);

  /* Waveshare's dedicated lower button has no board-specific end branch. */
  iterate_kit_board_apply_gestures(
      &session, &(struct iterate_kit_board_gestures){.end_press = true}, &waveshare,
      true,
      &(struct iterate_kit_voice_view){.wants_call = true, .call_active = true},
      2U, &actions);
  assert(actions.end_call);

  /* HAVPE is fixed open-mic: a tap opens the call. */
  session = (struct iterate_kit_session){0};
  iterate_kit_board_apply_gestures(
      &session, &(struct iterate_kit_board_gestures){.tap = true}, &havpe,
      false, &idle, 3U, &actions);
  assert(actions.start_call && actions.wake_chime);

  /* StackChan's side tap has the provider-VAD open-mic meaning. */
  session = (struct iterate_kit_session){0};
  iterate_kit_board_apply_gestures(
      &session, &(struct iterate_kit_board_gestures){.tap = true}, &stackchan,
      false, &idle, 4U, &actions);
  assert(actions.start_call && actions.wake_chime);
}

static void down_edge_wakes_before_release(void) {
  struct iterate_kit_session session = {0};
  struct iterate_kit_session_actions actions;
  const struct iterate_kit_gpio_button button = {
    /* HAVPE's tap_wakes flag applied only to its deleted selectable PTT mode. */
    .gpio = 0, .active_low = true, .tap_wakes = false, .tap_ends = true,
  };
  const struct iterate_kit_voice_view idle = {0};
  iterate_kit_board_apply_gestures(
      &session, &(struct iterate_kit_board_gestures){.pressed = true}, &button,
      false, &idle, 30U, &actions);
  assert(actions.start_call && actions.wake_chime);
  /* The same down-edge during a call does not accidentally end it. */
  const struct iterate_kit_voice_view active = {.wants_call = true, .call_active = true};
  iterate_kit_board_apply_gestures(
      &session, &(struct iterate_kit_board_gestures){.pressed = true}, &button,
      false, &active, 2000U, &actions);
  assert(!actions.start_call && !actions.end_call);
}

int main(void) {
  volume_table();
  i2s_table();
  boot_table();
  iterate_kit_board_defaults_table();
  normalized_gestures_use_the_shared_grammar();
  down_edge_wakes_before_release();
  return 0;
}
