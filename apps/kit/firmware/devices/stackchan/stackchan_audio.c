/*
 * M5Stack CoreS3 audio bring-up: AW88298 speaker, ES7210 four-slot TDM
 * capture with the analogue echo-reference divider on slot 1.
 *
 * PROVEN on donor hardware (branch c-capabilities): this exact clocking,
 * codec configuration, tuned levels, and task topology carried production
 * StackChan conversations. Every constant is the donor's final measured
 * state.
 *
 * Topology: one shared I2S clock. TX is ordinary Philips stereo for the
 * AW88298 (which is register-fixed to 64fs BCK, read-back verified, because
 * the ES7210's TDM RX forces 64fs on the shared bus). RX is four-slot TDM:
 * measured slot 2 is the production near microphone, measured slot 1 is the
 * electrical divider across the actual amplifier output — the AEC reference
 * is what the amplifier really emitted, including mute/gain/clock effects,
 * not a software copy of intended playback.
 *
 * Task topology, from the donor: the I2S ISR does exactly one bounded raw
 * 1,024-byte copy into the capture reserve (no deinterleave, no DSP, no
 * logging); the priority-23 core-1 I/O task's blocking codec write/read pair
 * IS the 8 ms audio clock. Three consecutive failures disable a direction
 * loudly. Deinterleaving happens on the portable capture task through the
 * codec seam's read().
 */
#include "stackchan_audio.h"

#include <stdatomic.h>
#include <string.h>

#include "bsp/m5stack_core_s3.h"
#include "driver/i2s_std.h"
#include "driver/i2s_tdm.h"
#include "esp_codec_dev.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "core_s3_capture_reserve.h"
#include "iterate/kit/platforms/core_s3_bsp_audio.h"

static const char tag[] = "stackchan-audio";

enum {
  TDM_SLOT_COUNT = 4,
  /*
   * Measured, not documented: neither M5Stack's public schematic nor the
   * codec API establishes TDM order. Slot 0's capsule has a broad
   * 4.5-5.7 kHz interference shelf ("Hey pal" -> "PayPal" at the STT
   * oracle); slot 2 is the other acoustic capsule and is the production
   * near channel. Slot 1 is the amplifier divider.
   */
  TDM_NEAR_SLOT = 2,
  TDM_REFERENCE_SLOT = 1,
  /* AW88298 I2S control register: BCK ratio field, forced to 64fs. */
  AW88298_I2SCTRL_REG = 0x06,
  AW88298_I2SBCK_MASK = 0x30,
  AW88298_I2SBCK_64FS = 0x20,
  /*
   * VOLUME 60, BECAUSE ABOVE ABOUT 60 THE ECHO CANCELLER STOPS CONVERGING.
   *
   * This was 80, chosen for ~1.5 dB of acoustic headroom over 85/90 — a real
   * measurement, but of loudness, and the thing it costs is not loudness. The
   * canceller's residual over a spoken answer, measured on this board's own
   * microphone against a fixed sentence (`voicelab aec`, 2026-08-11):
   *
   *   volume 80   -33.4 / -33.3 dBFS peak   filter never settles
   *   volume 60   -42.4 / -44.9 dBFS peak   settles after ~1.5 s
   *   volume 50   -43.3 / -47.2 dBFS peak   settles
   *
   * A person speaking into the same microphone at the same distance measures
   * -31 dBFS peak. So at 80 the assistant's own echo arrives at the customer's
   * level — the far end is handed two voices it cannot separate, and an
   * interruption that transcribes perfectly in silence transcribes as nothing
   * at all over an answer. At 60 the voice stands +10 to +12 dB clear of the
   * residual and the words come back. THAT is what "practically shouting at
   * it" was.
   *
   * Sixty rather than fifty because fifty is not measurably better: the knee
   * is between 60 and 80, and the loudest setting on the good side of it is
   * the one to ship. It also agrees with `loudness.ts` from the other
   * direction — second-harmonic distortion -34.9 dB at 60 against -16.8 dB at
   * 100 — so this is the same knee seen twice: past it the speaker stops being
   * a linear device, the echo stops being a linear function of the reference,
   * and no linear adaptive filter can model what it is not being told about.
   * The reference is NOT the problem; `aecReferenceClipped` was 0 at every
   * volume on every turn.
   *
   * +18 dB PGA sits 6 dB below the run that peaked at 31,932 of 32,767; the
   * divider stays at unity — its x8 calibration is digital, inside the
   * processor, where clipping is counted.
   */
  SPEAKER_VOLUME_PERCENT = 60,
  MICROPHONE_GAIN_DB = 18,
  REFERENCE_GAIN_DB = 0,
  /* One 20 ms wire frame staged into 8 ms hardware edges. */
  WIRE_FRAME_SAMPLES = 320,
  /* Startup descriptors drained before capture publication begins. */
  RX_STARTUP_DRAIN_CHUNKS = 5,
  IO_FAILURE_LIMIT = 3,
  IO_TASK_PRIORITY = 23,
  IO_TASK_STACK_BYTES = 4096,
  AUDIO_TASK_CORE = 1,
  /* 8 ms per DMA descriptor; five in the ring (the BSP patch's geometry). */
  DMA_RING_MS = 40,
  CHUNK_MS =
      STACKCHAN_AUDIO_CHUNK_SAMPLES * 1000 / STACKCHAN_AUDIO_SAMPLE_RATE_HZ,
};

_Static_assert(
    CHUNK_MS * STACKCHAN_AUDIO_SAMPLE_RATE_HZ ==
        STACKCHAN_AUDIO_CHUNK_SAMPLES * 1000,
    "a DMA descriptor must be a whole number of milliseconds for the "
    "starvation ledger to account it exactly");

struct wire_frame {
  int16_t samples[WIRE_FRAME_SAMPLES];
  size_t sample_count;
};

static esp_codec_dev_handle_t speaker;
static uint8_t speaker_volume_percent = SPEAKER_VOLUME_PERCENT;
static esp_codec_dev_handle_t microphone;
static struct iterate_kit_core_s3_capture_reserve capture_reserve;
static QueueHandle_t playback_mailbox;

/*
 * The AW88298's BSP driver declares a fixed +15 dB external PA which
 * esp_codec_dev subtracts from requested levels; without this curve the
 * usable range collapses. Donor-proven endpoints.
 */
static esp_codec_dev_vol_map_t speaker_volume_map[] = {
  {.vol = 1, .db_value = -34.5F},
  {.vol = 100, .db_value = 15.0F},
};

/*
 * The chosen loudness survives a power cycle, same store as the provider
 * choice. This board brings its codec up before the radio, so like the mode
 * reader it initialises NVS itself — idempotent and free when the transport
 * does it again later.
 */
static uint8_t load_volume(void) {
  nvs_handle_t handle;
  uint8_t stored = SPEAKER_VOLUME_PERCENT;
  (void)nvs_flash_init();
  if (nvs_open("stackchan", NVS_READONLY, &handle) != ESP_OK) {
    return SPEAKER_VOLUME_PERCENT;
  }
  if (nvs_get_u8(handle, "vol", &stored) != ESP_OK ||
      stored > STACKCHAN_AUDIO_VOLUME_CEILING) {
    stored = SPEAKER_VOLUME_PERCENT;
  }
  nvs_close(handle);
  return stored;
}

static void store_volume(uint8_t percent) {
  nvs_handle_t handle;
  if (nvs_open("stackchan", NVS_READWRITE, &handle) != ESP_OK) return;
  if (nvs_set_u8(handle, "vol", percent) == ESP_OK) {
    (void)nvs_commit(handle);
  }
  nvs_close(handle);
}

/* Chunk meta stashed by the last successful seam read (single consumer). */
static uint32_t last_chunk_sequence;
static uint64_t last_chunk_captured_us;
static bool last_chunk_content_active;

static atomic_bool epoch_reset_pending;
static atomic_uint epoch_resets_total;
static atomic_bool capture_failed_flag;
static atomic_bool playback_failed_flag;
static atomic_bool capture_tap_enabled;
static atomic_bool playback_content_active;
static volatile uint32_t capture_driver_failures;
static volatile uint32_t playback_driver_failures;
/*
 * Codec edges that had SOME response audio and had to pad the rest with
 * zeros. That padding is a splice into the middle of speech, not idle
 * silence, and it is inaudible in every other counter: the frame was
 * received, played and never dropped. Counted so the seam's buffer depth
 * can be argued about with a number.
 */
static volatile uint32_t playback_partial_chunks;
static uint32_t last_rx_queue_overflows;

static stackchan_audio_playout_observer_fn playout_observer;
static void *playout_observer_context;

/*
 * The local sound slot: one flash-resident chime or announcement, drained
 * by the I/O task's edge composer AHEAD of the staged response audio, so it
 * starts within one 8 ms edge and PREEMPTS rather than mixes. A second
 * request replaces the first mid-note. Same contract as the HAVPE's.
 */
static portMUX_TYPE sound_lock = portMUX_INITIALIZER_UNLOCKED;
static const uint8_t *sound_pcm; /* NULL when idle; guarded by sound_lock */
static uint32_t sound_bytes;
static uint32_t sound_cursor;
/*
 * Sound-sourced DMA edges not yet completed, so the ISR tap can hold the
 * MOUTH still while a chime plays: the robot's own interface noises are not
 * speech, and a face that lip-syncs "call ended" looks like it is saying
 * it. DMA completes in write order, so a counter is an exact FIFO tag —
 * each sound edge's completion consumes one count and skips the observer.
 */
static volatile uint32_t sound_edges_in_flight;

void stackchan_audio_play_sound(const uint8_t *pcm, uint32_t bytes) {
  if (pcm == NULL || bytes < sizeof(int16_t)) return;
  portENTER_CRITICAL(&sound_lock);
  sound_pcm = pcm;
  sound_bytes = bytes & ~1U; /* whole PCM16 samples only */
  sound_cursor = 0U;
  portEXIT_CRITICAL(&sound_lock);
}

/* --- the shared codec seam ------------------------------------------------ */

static enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  struct iterate_kit_core_s3_capture_chunk chunk;
  (void)context;
  if (capture == NULL || reference == NULL ||
      capacity_samples < STACKCHAN_AUDIO_CHUNK_SAMPLES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  switch (iterate_kit_core_s3_capture_reserve_take(&capture_reserve, &chunk)) {
    case ITERATE_KIT_CORE_S3_CAPTURE_TAKE_EMPTY:
      return ITERATE_KIT_UNAVAILABLE;
    case ITERATE_KIT_CORE_S3_CAPTURE_TAKE_RESET_EPOCH:
      /*
       * The timeline broke. Surface it once; the composition resets the
       * bridge and processor before taking again, per the reserve contract.
       */
      atomic_store_explicit(
          &epoch_reset_pending, true, memory_order_release);
      atomic_fetch_add_explicit(&epoch_resets_total, 1U, memory_order_relaxed);
      return ITERATE_KIT_UNAVAILABLE;
    case ITERATE_KIT_CORE_S3_CAPTURE_TAKE_CHUNK:
      break;
  }
  /*
   * Deinterleave outside interrupt context, raw: conditioning (100 Hz
   * high-pass, x8 reference scale) belongs to the processor so every DSP
   * sample and diagnostic sees the same calibrated signal.
   */
  for (size_t frame = 0U; frame < STACKCHAN_AUDIO_CHUNK_SAMPLES; ++frame) {
    const size_t base = frame * TDM_SLOT_COUNT;
    capture[frame] = chunk.interleaved[base + TDM_NEAR_SLOT];
    reference[frame] = chunk.interleaved[base + TDM_REFERENCE_SLOT];
  }
  last_chunk_sequence = chunk.sequence;
  last_chunk_captured_us = chunk.captured_through_at_us;
  last_chunk_content_active = chunk.playback_content_active;
  *sample_count = STACKCHAN_AUDIO_CHUNK_SAMPLES;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status codec_write(
    void *context, const int16_t *playback, size_t sample_count) {
  struct wire_frame frame;
  (void)context;
  if (playback_mailbox == NULL || sample_count == 0U ||
      sample_count > WIRE_FRAME_SAMPLES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (atomic_load_explicit(&playback_failed_flag, memory_order_acquire)) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  memcpy(frame.samples, playback, sample_count * sizeof(*playback));
  frame.sample_count = sample_count;
  return xQueueSend(playback_mailbox, &frame, 0) == pdTRUE
      ? ITERATE_KIT_OK
      : ITERATE_KIT_BACKPRESSURE;
}

static const struct iterate_kit_audio_codec_ops codec_ops = {
  .read = codec_read,
  .write = codec_write,
};

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = STACKCHAN_AUDIO_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = STACKCHAN_AUDIO_SAMPLE_RATE_HZ,
  .capture_channels = 1,
  .playback_channels = 1,
  /*
   * TRUE, and physically meant: the reference plane is the amplifier
   * divider sampled in the same TDM frame as the near microphone.
   */
  .has_reference_channel = true,
  .has_output_gain_control = true,
  .output_gain_ceiling_centi_db = 0,
};

/* --- absolute-deadline starvation ledger (see m5sticks3_audio.c) ---------- */

static portMUX_TYPE ledger_lock = portMUX_INITIALIZER_UNLOCKED;
static bool ledger_watch;
static bool ledger_draining;
static bool ledger_stale_ring;
static int64_t ledger_empty_at_us;
static uint32_t ledger_written_ms;
static uint32_t ledger_starved_ms;
static uint32_t ledger_starve_events;

static uint32_t saturating_add_u32(uint32_t value, uint32_t delta) {
  const uint32_t sum = value + delta;
  return sum < value ? 0xffffffffU : sum;
}

void stackchan_audio_watch(bool active) {
  portENTER_CRITICAL(&ledger_lock);
  if (active && !ledger_watch) {
    ledger_written_ms = 0U;
    ledger_empty_at_us = esp_timer_get_time() +
        (ledger_stale_ring ? (int64_t)DMA_RING_MS * 1000 : 0);
    ledger_stale_ring = false;
  }
  if (active) ledger_draining = false;
  ledger_watch = active;
  portEXIT_CRITICAL(&ledger_lock);
}

void stackchan_audio_draining(void) {
  portENTER_CRITICAL(&ledger_lock);
  ledger_draining = true;
  portEXIT_CRITICAL(&ledger_lock);
}

void stackchan_audio_note_flush(void) {
  portENTER_CRITICAL(&ledger_lock);
  ledger_stale_ring = true;
  portEXIT_CRITICAL(&ledger_lock);
}

void stackchan_audio_reserve_write(uint32_t ms) {
  const int64_t now_us = esp_timer_get_time();
  portENTER_CRITICAL(&ledger_lock);
  if (ledger_watch && !ledger_draining && ledger_empty_at_us > 0 &&
      ledger_written_ms >= (uint32_t)DMA_RING_MS &&
      now_us > ledger_empty_at_us) {
    ledger_starved_ms = saturating_add_u32(
        ledger_starved_ms,
        (uint32_t)((now_us - ledger_empty_at_us) / 1000));
    ledger_starve_events = saturating_add_u32(ledger_starve_events, 1U);
  }
  {
    const int64_t base_us =
        now_us > ledger_empty_at_us ? now_us : ledger_empty_at_us;
    ledger_empty_at_us = base_us + (int64_t)ms * 1000;
  }
  ledger_written_ms = saturating_add_u32(ledger_written_ms, ms);
  portEXIT_CRITICAL(&ledger_lock);
}

void stackchan_audio_rollback_write(uint32_t ms) {
  portENTER_CRITICAL(&ledger_lock);
  ledger_empty_at_us -= (int64_t)ms * 1000;
  if (ledger_written_ms >= ms) ledger_written_ms -= ms;
  portEXIT_CRITICAL(&ledger_lock);
}

uint32_t stackchan_audio_starved_ms(void) {
  return ledger_starved_ms;
}

uint32_t stackchan_audio_starve_events(void) {
  return ledger_starve_events;
}

uint32_t stackchan_audio_written_ms(void) {
  return ledger_written_ms;
}


/* --- ISR tap ---------------------------------------------------------------- */

static bool IRAM_ATTR i2s_tap(
    bool transmit,
    uint32_t sequence,
    uint64_t completed_at_us,
    const void *pcm,
    size_t bytes,
    void *user_data) {
  (void)user_data;
  if (transmit) {
    /* A completed local-sound edge keeps the mouth still; see the counter. */
    uint32_t sound_edges = __atomic_load_n(
        &sound_edges_in_flight, __ATOMIC_ACQUIRE);
    while (sound_edges != 0U) {
      if (__atomic_compare_exchange_n(
              &sound_edges_in_flight,
              &sound_edges,
              sound_edges - 1U,
              false,
              __ATOMIC_ACQ_REL,
              __ATOMIC_ACQUIRE)) {
        return false;
      }
    }
    /* The mouth animates audio the hardware actually played. */
    if (playout_observer != NULL && pcm != NULL &&
        bytes == STACKCHAN_AUDIO_CHUNK_SAMPLES * sizeof(int16_t)) {
      return playout_observer(
          sequence,
          completed_at_us,
          pcm,
          STACKCHAN_AUDIO_CHUNK_SAMPLES,
          playout_observer_context);
    }
    return false;
  }
  if (!atomic_load_explicit(&capture_tap_enabled, memory_order_acquire)) {
    return false;
  }
  /*
   * Exactly one bounded raw copy; deinterleave and every DSP operation stay
   * on tasks. The portable capture task polls the reserve, so no wake is
   * needed — the chunk is visible the moment push_raw publishes it.
   */
  (void)iterate_kit_core_s3_capture_reserve_push_raw(
      &capture_reserve,
      sequence,
      completed_at_us,
      atomic_load_explicit(&playback_content_active, memory_order_acquire),
      pcm,
      bytes);
  return false;
}

/* --- boot + the blocking I/O owner ----------------------------------------- */

static esp_err_t configure_speaker_for_shared_tdm_clock(void) {
  int value = 0;
  if (esp_codec_dev_read_reg(speaker, AW88298_I2SCTRL_REG, &value) !=
      ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  value = (value & ~AW88298_I2SBCK_MASK) | AW88298_I2SBCK_64FS;
  if (esp_codec_dev_write_reg(speaker, AW88298_I2SCTRL_REG, value) !=
      ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  int verified = 0;
  /* Read back: a silently unfixed BCK ratio is corrupted audio, not an error. */
  if (esp_codec_dev_read_reg(speaker, AW88298_I2SCTRL_REG, &verified) !=
          ESP_CODEC_DEV_OK ||
      (verified & AW88298_I2SBCK_MASK) != AW88298_I2SBCK_64FS) {
    return ESP_FAIL;
  }
  return ESP_OK;
}

static esp_err_t initialize_codecs(void) {
  const i2s_std_config_t tx = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(STACKCHAN_AUDIO_SAMPLE_RATE_HZ),
    .slot_cfg = {
      .data_bit_width = I2S_DATA_BIT_WIDTH_16BIT,
      .slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO,
      .slot_mode = I2S_SLOT_MODE_STEREO,
      .slot_mask = I2S_STD_SLOT_BOTH,
      .ws_width = I2S_DATA_BIT_WIDTH_16BIT,
      .ws_pol = false,
      .bit_shift = true,
      .left_align = true,
      .big_endian = false,
      .bit_order_lsb = false,
    },
    .gpio_cfg = {
      .mclk = BSP_I2S_MCLK,
      .bclk = BSP_I2S_SCLK,
      .ws = BSP_I2S_LCLK,
      .dout = BSP_I2S_DOUT,
      .din = I2S_GPIO_UNUSED,
      .invert_flags = {
        .mclk_inv = false,
        .bclk_inv = false,
        .ws_inv = false,
      },
    },
  };
  const i2s_tdm_config_t rx = {
    .clk_cfg = {
      .sample_rate_hz = STACKCHAN_AUDIO_SAMPLE_RATE_HZ,
      .clk_src = I2S_CLK_SRC_DEFAULT,
      .ext_clk_freq_hz = 0,
      .mclk_multiple = I2S_MCLK_MULTIPLE_256,
      .bclk_div = 8,
    },
    .slot_cfg = {
      .data_bit_width = I2S_DATA_BIT_WIDTH_16BIT,
      .slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO,
      .slot_mode = I2S_SLOT_MODE_STEREO,
      .slot_mask =
          I2S_TDM_SLOT0 | I2S_TDM_SLOT1 | I2S_TDM_SLOT2 | I2S_TDM_SLOT3,
      .ws_width = I2S_TDM_AUTO_WS_WIDTH,
      .ws_pol = false,
      .bit_shift = true,
      .left_align = false,
      .big_endian = false,
      .bit_order_lsb = false,
      .skip_mask = false,
      .total_slot = I2S_TDM_AUTO_SLOT_NUM,
    },
    .gpio_cfg = {
      .mclk = BSP_I2S_MCLK,
      .bclk = BSP_I2S_SCLK,
      .ws = BSP_I2S_LCLK,
      .dout = I2S_GPIO_UNUSED,
      .din = BSP_I2S_DSIN,
      .invert_flags = {
        .mclk_inv = false,
        .bclk_inv = false,
        .ws_inv = false,
      },
    },
  };

  esp_err_t status = bsp_i2c_init();
  if (status != ESP_OK) {
    return status;
  }
  status = iterate_kit_core_s3_audio_init_tdm_rx(&tx, &rx);
  if (status != ESP_OK) {
    return status;
  }
  speaker = bsp_audio_codec_speaker_init();
  microphone = bsp_audio_codec_microphone_init();
  if (speaker == NULL || microphone == NULL) {
    return ESP_ERR_NOT_FOUND;
  }
  esp_codec_dev_vol_curve_t curve = {
    .vol_map = speaker_volume_map,
    .count = sizeof(speaker_volume_map) / sizeof(speaker_volume_map[0]),
  };
  esp_codec_dev_sample_info_t speaker_format = {
    .bits_per_sample = 16,
    .channel = 1,
    .channel_mask = 0,
    .sample_rate = STACKCHAN_AUDIO_SAMPLE_RATE_HZ,
    .mclk_multiple = 0,
  };
  esp_codec_dev_sample_info_t microphone_format = {
    .bits_per_sample = 16,
    .channel = TDM_SLOT_COUNT,
    .channel_mask = ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0) |
        ESP_CODEC_DEV_MAKE_CHANNEL_MASK(1) |
        ESP_CODEC_DEV_MAKE_CHANNEL_MASK(2) |
        ESP_CODEC_DEV_MAKE_CHANNEL_MASK(3),
    .sample_rate = STACKCHAN_AUDIO_SAMPLE_RATE_HZ,
    .mclk_multiple = 0,
  };
  /*
   * Gains are programmed by CHANNEL MASK while slots are picked by TDM
   * INDEX, and the ES7210's reversed ADC mapping means those orderings are
   * not the same — masks 0|1 are the acoustic capsules, mask 2 the divider.
   * Datasheet: ES7210 Rev 21.0 R1B-R1E.
   */
  /* The person's last chosen level, not the shipped default: half a dozen
   * reflashes in one afternoon each silently snapped the board back to 60,
   * which reads as "mega quiet" and not as "freshly booted". */
  speaker_volume_percent = load_volume();
  if (esp_codec_dev_set_vol_curve(speaker, &curve) != ESP_CODEC_DEV_OK ||
      esp_codec_dev_set_out_vol(speaker, (int)speaker_volume_percent) !=
          ESP_CODEC_DEV_OK ||
      esp_codec_dev_open(speaker, &speaker_format) != ESP_CODEC_DEV_OK ||
      esp_codec_dev_open(microphone, &microphone_format) !=
          ESP_CODEC_DEV_OK ||
      configure_speaker_for_shared_tdm_clock() != ESP_OK ||
      esp_codec_dev_set_in_channel_gain(
          microphone,
          ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0) |
              ESP_CODEC_DEV_MAKE_CHANNEL_MASK(1),
          (float)MICROPHONE_GAIN_DB) != ESP_CODEC_DEV_OK ||
      esp_codec_dev_set_in_channel_gain(
          microphone,
          ESP_CODEC_DEV_MAKE_CHANNEL_MASK(2),
          (float)REFERENCE_GAIN_DB) != ESP_CODEC_DEV_OK) {
    return ESP_FAIL;
  }
  return ESP_OK;
}

static void io_task_main(void *argument) {
  static int16_t playback_dma[STACKCHAN_AUDIO_CHUNK_SAMPLES];
  static int16_t capture_drain
      [STACKCHAN_AUDIO_CHUNK_SAMPLES * TDM_SLOT_COUNT];
  static struct wire_frame staging;
  size_t staging_offset = 0U;
  (void)argument;
  staging.sample_count = 0U;

  /*
   * Drain exactly the five startup DMA descriptors before capture
   * publication begins; otherwise a healthy first uplink frame starts 40 ms
   * old and the offset is permanent.
   */
  for (size_t chunk = 0U; chunk < RX_STARTUP_DRAIN_CHUNKS; ++chunk) {
    if (esp_codec_dev_read(
            microphone, capture_drain, (int)sizeof(capture_drain)) !=
        ESP_CODEC_DEV_OK) {
      ++capture_driver_failures;
      break;
    }
  }
  {
    iterate_kit_core_s3_i2s_stats_t startup_stats = {0};
    iterate_kit_core_s3_i2s_stats_snapshot(&startup_stats);
    last_rx_queue_overflows = startup_stats.rx_queue_overflows;
  }
  atomic_store_explicit(&capture_tap_enabled, true, memory_order_release);

  uint32_t consecutive_write_errors = 0U;
  uint32_t consecutive_read_errors = 0U;
  bool speaker_io_enabled = true;
  bool microphone_io_enabled = true;
  for (;;) {
    if (speaker_io_enabled) {
      /*
       * One 8 ms edge: staged response audio when there is any, silence
       * otherwise. The TX stream never stops — the divider reference and
       * the codec clock ride it.
       */
      size_t filled = 0U;
      bool from_sound = false;
      /*
       * A local sound outranks the mailbox. The slice bounds are taken
       * under the lock and the flash copy happens outside it; if the app
       * task replaces the sound mid-slice, this edge finishes from the
       * superseded PCM and the next one starts the new sound, which is the
       * preemption behaving as specified.
       */
      {
        const uint8_t *sound = NULL;
        uint32_t sound_offset = 0U;
        uint32_t sound_take = 0U;
        portENTER_CRITICAL(&sound_lock);
        if (sound_pcm != NULL) {
          const uint32_t remaining = sound_bytes - sound_cursor;
          sound = sound_pcm;
          sound_offset = sound_cursor;
          sound_take = remaining < sizeof(playback_dma)
              ? remaining
              : (uint32_t)sizeof(playback_dma);
          sound_cursor += sound_take;
          if (sound_cursor >= sound_bytes) sound_pcm = NULL;
        }
        portEXIT_CRITICAL(&sound_lock);
        if (sound != NULL) {
          memcpy(playback_dma, sound + sound_offset, sound_take);
          filled = sound_take / sizeof(int16_t);
          from_sound = true;
        }
      }
      while (!from_sound && filled < STACKCHAN_AUDIO_CHUNK_SAMPLES) {
        if (staging_offset >= staging.sample_count) {
          if (xQueueReceive(playback_mailbox, &staging, 0) != pdTRUE) {
            break;
          }
          staging_offset = 0U;
        }
        const size_t available = staging.sample_count - staging_offset;
        const size_t wanted = STACKCHAN_AUDIO_CHUNK_SAMPLES - filled;
        const size_t take = available < wanted ? available : wanted;
        memcpy(
            playback_dma + filled,
            staging.samples + staging_offset,
            take * sizeof(int16_t));
        staging_offset += take;
        filled += take;
      }
      const bool content = filled > 0U;
      if (filled < STACKCHAN_AUDIO_CHUNK_SAMPLES) {
        /* A sound's short last edge is the note ending, not a splice into
         * speech; only staged response audio may move this instrument. */
        if (content && !from_sound) {
          ++playback_partial_chunks;
        }
        memset(
            playback_dma + filled,
            0,
            (STACKCHAN_AUDIO_CHUNK_SAMPLES - filled) * sizeof(int16_t));
      }
      /*
       * Published BEFORE the write, conservatively: at worst one capture
       * edge uses processed AEC output, while publishing raw microphone
       * during an uncertain speaker edge could leak self-talk upstream.
       */
      atomic_store_explicit(
          &playback_content_active, content, memory_order_release);
      /*
       * CREDIT THE LEDGER FROM HERE, like every other board does from its
       * hardware task — DMA completion runs from inside the write, so
       * crediting afterwards would fabricate a starve. Only real answer
       * audio counts: crediting the idle silence that keeps the divider
       * reference clocking would make the ring look permanently fed and the
       * gate permanently green. Without this call ledger_written_ms stayed
       * zero, its `written_ms >= DMA_RING_MS` precondition could never hold,
       * and spkStarvedMs/spkStarveEvents — the declared audible-failure
       * gate — were structurally pinned at 0.
       */
      if (content) {
        stackchan_audio_reserve_write(CHUNK_MS);
      }
      /* Tagged before the write so the edge's own completion finds it. */
      if (from_sound) {
        __atomic_add_fetch(&sound_edges_in_flight, 1U, __ATOMIC_ACQ_REL);
      }
      if (esp_codec_dev_write(
              speaker, playback_dma, (int)sizeof(playback_dma)) ==
          ESP_CODEC_DEV_OK) {
        consecutive_write_errors = 0U;
      } else {
        if (from_sound) {
          __atomic_sub_fetch(&sound_edges_in_flight, 1U, __ATOMIC_ACQ_REL);
        }
        if (content) {
          stackchan_audio_rollback_write(CHUNK_MS);
        }
        ++playback_driver_failures;
        if (consecutive_write_errors != UINT32_MAX) {
          ++consecutive_write_errors;
        }
        if (consecutive_write_errors >= IO_FAILURE_LIMIT) {
          speaker_io_enabled = false;
          atomic_store_explicit(
              &playback_content_active, false, memory_order_release);
          atomic_store_explicit(
              &playback_failed_flag, true, memory_order_release);
          ESP_LOGE(tag, "speaker I/O disabled after repeated failures");
        }
      }
    }

    if (microphone_io_enabled) {
      /*
       * The blocking read pumps the driver; the data reaches the reserve
       * through the DMA-completion tap, not through this buffer.
       */
      if (esp_codec_dev_read(
              microphone, capture_drain, (int)sizeof(capture_drain)) ==
          ESP_CODEC_DEV_OK) {
        consecutive_read_errors = 0U;
      } else {
        ++capture_driver_failures;
        if (consecutive_read_errors != UINT32_MAX) {
          ++consecutive_read_errors;
        }
        if (consecutive_read_errors >= IO_FAILURE_LIMIT) {
          microphone_io_enabled = false;
          atomic_store_explicit(
              &capture_failed_flag, true, memory_order_release);
          atomic_store_explicit(
              &capture_tap_enabled, false, memory_order_release);
          ESP_LOGE(tag, "capture I/O disabled after repeated failures");
        }
      }
      /*
       * An IDF RX overflow silently dropped the oldest DMA buffer below
       * this API: a timeline break the reserve cannot see on its own.
       */
      iterate_kit_core_s3_i2s_stats_t stats = {0};
      iterate_kit_core_s3_i2s_stats_snapshot(&stats);
      if (stats.rx_queue_overflows != last_rx_queue_overflows) {
        last_rx_queue_overflows = stats.rx_queue_overflows;
        iterate_kit_core_s3_capture_reserve_note_discontinuity(
            &capture_reserve);
      }
    }

    if (!speaker_io_enabled && !microphone_io_enabled) {
      ESP_LOGE(tag, "both audio directions dead — suspending the I/O owner");
      vTaskSuspend(NULL);
    }
  }
}

bool stackchan_audio_init(void) {
  if (iterate_kit_core_s3_capture_reserve_init(&capture_reserve) !=
      ITERATE_KIT_OK) {
    ESP_LOGE(tag, "capture reserve init failed");
    return false;
  }
  playback_mailbox = xQueueCreate(1U, sizeof(struct wire_frame));
  if (playback_mailbox == NULL) {
    ESP_LOGE(tag, "playback mailbox allocation failed");
    return false;
  }
  if (initialize_codecs() != ESP_OK) {
    ESP_LOGE(tag, "codec bring-up failed");
    return false;
  }
  iterate_kit_core_s3_i2s_set_tap(i2s_tap, NULL);
  if (xTaskCreatePinnedToCore(
          io_task_main,
          "core-s3-io",
          IO_TASK_STACK_BYTES,
          NULL,
          IO_TASK_PRIORITY,
          NULL,
          AUDIO_TASK_CORE) != pdPASS) {
    ESP_LOGE(tag, "audio I/O task creation failed");
    return false;
  }
  ESP_LOGI(
      tag,
      "CoreS3 audio ready: near=slot%d reference=slot%d volume=%d gain=%ddB",
      TDM_NEAR_SLOT,
      TDM_REFERENCE_SLOT,
      SPEAKER_VOLUME_PERCENT,
      MICROPHONE_GAIN_DB);
  return true;
}

struct iterate_kit_audio_codec stackchan_audio_codec(void) {
  return (struct iterate_kit_audio_codec){
    .ops = &codec_ops,
    .properties = &codec_properties,
    .context = NULL,
  };
}

void stackchan_audio_last_chunk_meta(
    uint32_t *sequence,
    uint64_t *captured_through_at_us,
    bool *playback_content_active_out) {
  if (sequence != NULL) *sequence = last_chunk_sequence;
  if (captured_through_at_us != NULL) {
    *captured_through_at_us = last_chunk_captured_us;
  }
  if (playback_content_active_out != NULL) {
    *playback_content_active_out = last_chunk_content_active;
  }
}

bool stackchan_audio_take_epoch_reset(void) {
  return atomic_exchange_explicit(
      &epoch_reset_pending, false, memory_order_acq_rel);
}

bool stackchan_audio_capture_failed(void) {
  return atomic_load_explicit(&capture_failed_flag, memory_order_acquire);
}

bool stackchan_audio_playback_failed(void) {
  return atomic_load_explicit(&playback_failed_flag, memory_order_acquire);
}

void stackchan_audio_set_playout_observer(
    stackchan_audio_playout_observer_fn observer, void *context) {
  playout_observer_context = context;
  playout_observer = observer;
}

uint32_t stackchan_audio_capture_overruns(void) {
  struct iterate_kit_core_s3_capture_reserve_metrics metrics;
  iterate_kit_core_s3_capture_reserve_metrics_snapshot(
      &capture_reserve, &metrics);
  return metrics.reserve_overflows;
}

uint32_t stackchan_audio_capture_driver_failures(void) {
  return capture_driver_failures;
}

uint32_t stackchan_audio_playback_driver_failures(void) {
  return playback_driver_failures;
}

uint32_t stackchan_audio_playback_partial_chunks(void) {
  return playback_partial_chunks;
}

uint32_t stackchan_audio_epoch_resets(void) {
  return atomic_load_explicit(&epoch_resets_total, memory_order_relaxed);
}

/*
 * THE SPEAKER LEVEL IS ALSO THE AEC REFERENCE LEVEL on this board, which is
 * why the shipped default is 60 rather than 100 — see the constant for the
 * measurement. Echo cancellation is spent from the same budget as loudness,
 * and past about 60 the whole budget goes on loudness: the residual jumps ten
 * decibels and an interruption stops arriving at all.
 *
 * The ceiling below is not a physical limit — the amplifier will happily go to
 * 100 — so this method can still put the board into the deaf band. That is
 * deliberate, because a person may want the volume and not the interruption;
 * it is worth knowing that is the trade being made.
 */
enum iterate_kit_status stackchan_audio_set_volume(
    uint8_t percent, uint8_t *applied) {
  if (speaker == NULL) return ITERATE_KIT_UNAVAILABLE;
  if (percent > STACKCHAN_AUDIO_VOLUME_CEILING) {
    percent = STACKCHAN_AUDIO_VOLUME_CEILING;
  }
  if (esp_codec_dev_set_out_vol(speaker, (int)percent) != ESP_CODEC_DEV_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  if (percent != speaker_volume_percent) store_volume(percent);
  speaker_volume_percent = percent;
  if (applied != NULL) *applied = percent;
  return ITERATE_KIT_OK;
}

uint8_t stackchan_audio_volume(void) { return speaker_volume_percent; }
