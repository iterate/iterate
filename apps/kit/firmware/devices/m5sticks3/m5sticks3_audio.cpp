/*
 * M5StickS3 audio bring-up: one ES8311, half duplex by wiring.
 *
 * PROVEN on donor hardware (branch c-capabilities): this exact codec table,
 * clock word, and pin map carried production push-to-talk conversations.
 *
 * The microphone is NOT a separate part: it is the same ES8311's ADC, driven
 * by M5Unified on I2S1 with DIN on GPIO 16, sharing MCLK/BCLK/WS
 * (GPIO 18/17/15) with this adapter's I2S0 speaker path. Two I2S masters on
 * one set of pins cannot run together, so capture and playback exchange the
 * hardware through an explicit fence:
 *
 *   playback -> capture: amplifier off -> i2s_del_channel(I2S0) -> Mic.begin()
 *   capture -> playback: Mic.end() -> recreate I2S0 -> codec table -> enable
 *
 * Deletion, not disable, is the ownership boundary: ESP-IDF leaves MCLK
 * routed after i2s_channel_disable(), and the microphone reuses that pin.
 * M5.Mic.end() powers the codec down entirely, which is why every return to
 * playback re-runs the codec register table.
 *
 * The codec clocks off BCLK, not MCLK: register 0x01 = 0xB5 selects BCLK as
 * the clock source and 0x02 = 0x18 multiplies it by 8 (32 fs x 8 = 256 fs),
 * satisfying the ES8311 User Guide's DAC clock rule. The MCLK pin is
 * electrically present but semantically irrelevant to the codec.
 */
#include "m5sticks3_audio.h"

#include <atomic>
#include <cstring>

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#include <M5Unified.h>
#pragma GCC diagnostic pop

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

namespace {

constexpr char tag[] = "m5sticks3-audio";

enum {
  /*
   * DMA geometry from Espressif's standard-mode sizing formula:
   *
   *   descriptor bytes = frames * slots * bits / 8
   *                    = 320 * 2 * 16 / 8 = 1280 (must be <= 4092)
   *   interrupt period = frames / sample rate = 320 / 16000 = 20 ms
   *   ring depth       = descriptors * period = 6 * 20 = 120 ms
   *
   * The 20 ms hardware-task cycle therefore needs more than one descriptor;
   * six leaves five cycles of scheduling headroom. The donor target used
   * sixteen (320 ms), but that number was sized for its nonblocking
   * descriptor-token lane, where a measured 250 ms interarrival gap had to
   * live entirely in hardware. This port holds jitter in the 30 s software
   * speaker queue upstream, so the ring only covers task scheduling.
   * Source: ESP-IDF 5.4 I2S documentation, "DMA buffer info and
   * configuration".
   * https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/i2s.html#dma-buffer-info-and-configuration
   */
  DMA_DESCRIPTOR_COUNT = 6,
  DMA_FRAMES_PER_DESCRIPTOR = M5STICKS3_AUDIO_FRAME_SAMPLES,
  DMA_DESCRIPTOR_MS = 20,
  DMA_RING_MS = DMA_DESCRIPTOR_COUNT * DMA_DESCRIPTOR_MS,
  PIN_I2S_MCLK = 18,
  PIN_I2S_BCLK = 17,
  PIN_I2S_WS = 15,
  PIN_I2S_DOUT = 14,
  /* One 20 ms settling frame is discarded after every microphone start. */
  CAPTURE_STARTUP_DISCARD_FRAMES = 1,
};

static_assert(
    DMA_FRAMES_PER_DESCRIPTOR * 2 * 16 / 8 <= 4092,
    "I2S descriptor exceeds the ESP32-S3 DMA limit");

constexpr std::uint8_t es8311Address = 0x18U;
constexpr std::uint8_t m5pm1Address = 0x6eU;
constexpr std::uint32_t boardI2cFrequency = 100000U;

/*
 * The direct path hands provider PCM to I2S without M5Unified's software
 * mixer. That omission is desirable for deadline predictability, but copying
 * M5Unified's codec setup verbatim also copied its 0 dB DAC setting while
 * silently discarding the mixer's normal attenuation. A 75%-scale physical
 * tone then drew enough speaker power to trip the board's brownout detector.
 *
 * Espressif defines ES8311 register 0x32 as 0.5 dB per step with 0xBF equal
 * to 0 dB. Apply a fixed -18 dB ceiling at the codec: arbitrary provider PCM
 * is reduced before the power amplifier, while the realtime path pays no
 * per-sample multiplication. This is a board power policy, not a test-tone
 * workaround; exceeding it needs a new physical power proof.
 */
constexpr std::uint8_t es8311ZeroDbVolume = 0xbfU;
constexpr std::uint8_t es8311SafeDacAttenuationHalfDbSteps = 36U;
constexpr std::uint8_t es8311SafeDacVolume =
    es8311ZeroDbVolume - es8311SafeDacAttenuationHalfDbSteps;
static_assert(es8311SafeDacVolume == 0x9bU);

/*
 * Who owns the shared audio pins right now. Each stage value has exactly one
 * task allowed to act on it, so a plain atomic is a complete protocol:
 *
 *   PLAYBACK          playback task services writes; may start a handoff
 *   MIC_HANDOFF       I2S0 is gone; capture task may start the microphone
 *   CAPTURE           capture task pumps the recorder; may end the microphone
 *   PLAYBACK_HANDOFF  microphone is gone; playback task rebuilds I2S0
 */
enum class Stage : int {
  playback = 0,
  micHandoff,
  capture,
  playbackHandoff,
};

struct audio_frame {
  int16_t samples[M5STICKS3_AUDIO_FRAME_SAMPLES];
  size_t sample_count;
};

std::atomic<int> stage{static_cast<int>(Stage::playback)};
std::atomic<bool> capture_wanted{false};

QueueHandle_t capture_mailbox;
QueueHandle_t playback_mailbox;
i2s_chan_handle_t playback_channel;
bool playback_enabled;

/* Startup capture is not loss until the portable consumer has started. */
std::atomic<bool> capture_consumer_started{false};
std::atomic<uint32_t> capture_overruns{0};
std::atomic<uint32_t> capture_driver_failures{0};
std::atomic<uint32_t> playback_driver_failures{0};
std::atomic<uint32_t> mode_switches{0};

Stage current_stage() {
  return static_cast<Stage>(stage.load(std::memory_order_acquire));
}

void publish_stage(Stage next) {
  stage.store(static_cast<int>(next), std::memory_order_release);
}

/*
 * STARVATION MEASURED AGAINST AN ABSOLUTE DEADLINE, on the writing task.
 *
 * At every write the ledger knows when the hardware ring will be empty; a
 * write arriving after that moment is starvation the listener heard, for
 * exactly the difference. Callback counting is deliberately not promoted to
 * a correctness signal here: the Waveshare port measured a 600 ms injected
 * gap that moved its ISR counter by zero, because the descriptors the ISR
 * catches are the refill after the gap. The deadline is the authoritative
 * measure and this board keeps only it.
 */
portMUX_TYPE ledger_lock = portMUX_INITIALIZER_UNLOCKED;
bool ledger_watch;
bool ledger_draining;
bool ledger_stale_ring;
int64_t ledger_empty_at_us;
uint32_t ledger_written_ms;
uint32_t ledger_starved_ms;
uint32_t ledger_starve_events;
std::atomic<uint32_t> inject_starvation_ms{0};

uint32_t saturating_add(uint32_t value, uint32_t delta) {
  const uint32_t sum = value + delta;
  return sum < value ? 0xffffffffU : sum;
}

/* --- the shared codec seam ------------------------------------------------ */

enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  struct audio_frame frame;
  (void)context;
  (void)reference;
  if (capture_mailbox == nullptr ||
      capacity_samples < M5STICKS3_AUDIO_FRAME_SAMPLES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  capture_consumer_started.store(true, std::memory_order_release);
  if (xQueueReceive(capture_mailbox, &frame, 0) != pdTRUE) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  memcpy(capture, frame.samples, frame.sample_count * sizeof(*capture));
  *sample_count = frame.sample_count;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status codec_write(
    void *context, const int16_t *playback, size_t sample_count) {
  struct audio_frame frame;
  (void)context;
  if (playback_mailbox == nullptr || sample_count == 0U ||
      sample_count > M5STICKS3_AUDIO_FRAME_SAMPLES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Playback is DISABLED, not backpressured, while the microphone owns the
   * pins. UNAVAILABLE tells the portable playback loop this is the fence,
   * not a full queue that waiting would clear.
   */
  if (capture_wanted.load(std::memory_order_acquire) ||
      current_stage() != Stage::playback) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  memcpy(frame.samples, playback, sample_count * sizeof(*playback));
  frame.sample_count = sample_count;
  return xQueueSend(playback_mailbox, &frame, 0) == pdTRUE
      ? ITERATE_KIT_OK
      : ITERATE_KIT_BACKPRESSURE;
}

const struct iterate_kit_audio_codec_ops codec_ops = {
  codec_read,
  codec_write,
};

const struct iterate_kit_audio_codec_properties codec_properties = {
  /* capture_sample_rate_hz = */ M5STICKS3_AUDIO_SAMPLE_RATE_HZ,
  /* playback_sample_rate_hz = */ M5STICKS3_AUDIO_SAMPLE_RATE_HZ,
  /* capture_channels = */ 1,
  /* playback_channels = */ 1,
  /* full_duplex = */ false,
  /* has_reference_channel = */ false,
  /* capture_is_echo_cancelled = */ false,
  /* capture_clock_is_hardware_owned = */ true,
  /* playback_clock_is_hardware_owned = */ true,
  /*
   * No runtime control: the -18 dB brownout ceiling is FIXED in the codec
   * table (0x32 = 0x9B) above, and the seam's contract makes the ceiling
   * field meaningful only when a control exists. Declaring the fixed
   * attenuation here tripped the validator on first hardware boot.
   */
  /* has_output_gain_control = */ false,
  /* output_gain_ceiling_centi_db = */ 0,
};

/* --- playback hardware ---------------------------------------------------- */

bool amplifier_set(bool on) {
  /*
   * M5Unified's board bring-up has already muxed M5PM1 GPIO3 as a push-pull
   * output. Touch only its latch: repeating mux setup in the realtime
   * lifecycle adds unnecessary I2C transactions and creates more ways for a
   * partially failed start to leave the board audible.
   */
  return on
      ? M5.In_I2C.bitOn(m5pm1Address, 0x11U, 1U << 3U, boardI2cFrequency)
      : M5.In_I2C.bitOff(m5pm1Address, 0x11U, 1U << 3U, boardI2cFrequency);
}

bool configure_codec_playback(void) {
  /*
   * Byte-identical to M5Unified's StickS3 speaker-enable sequence except
   * 0x32 (the -18 dB power ceiling above). 0x01 = 0xB5 selects BCLK as the
   * codec clock; 0x02 = 0x18 makes the internal clock 8 x BCLK = 256 fs.
   */
  struct register_value {
    std::uint8_t address;
    std::uint8_t value;
  };
  static constexpr register_value configuration[] = {
    {0x00U, 0x80U},
    {0x01U, 0xb5U},
    {0x02U, 0x18U},
    {0x0dU, 0x01U},
    {0x12U, 0x00U},
    {0x13U, 0x10U},
    {0x32U, es8311SafeDacVolume},
    {0x37U, 0x08U},
  };
  /*
   * Fail on the first unacknowledged register. Retrying here would make
   * start latency variable and hide a broken I2C/power state; the caller
   * exposes one classified driver failure instead.
   */
  for (const auto &entry : configuration) {
    if (!M5.In_I2C.writeRegister8(
            es8311Address, entry.address, entry.value, boardI2cFrequency)) {
      return false;
    }
  }
  return true;
}

void release_playback_channel(void) {
  if (playback_channel == nullptr) return;
  if (playback_enabled) {
    (void)i2s_channel_disable(playback_channel);
    playback_enabled = false;
  }
  /*
   * Deletion is the pin-ownership fence — see the file comment. A failed
   * delete would leave two masters contending, so it is counted loudly.
   */
  if (i2s_del_channel(playback_channel) != ESP_OK) {
    playback_driver_failures.fetch_add(1U, std::memory_order_relaxed);
  }
  playback_channel = nullptr;
}

bool build_playback_channel(void) {
  i2s_chan_config_t channel_config =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channel_config.dma_desc_num = DMA_DESCRIPTOR_COUNT;
  channel_config.dma_frame_num = DMA_FRAMES_PER_DESCRIPTOR;
  /*
   * Clear BEFORE the callback reuses a descriptor, so a missed refill plays
   * silence on the next wrap instead of replaying old speech.
   */
  channel_config.auto_clear_before_cb = true;
  channel_config.auto_clear_after_cb = false;
  channel_config.allow_pd = false;
  channel_config.intr_priority = 2;
  if (i2s_new_channel(&channel_config, &playback_channel, nullptr) != ESP_OK) {
    playback_channel = nullptr;
    return false;
  }
  i2s_std_config_t std_config = {};
  std_config.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(
      M5STICKS3_AUDIO_SAMPLE_RATE_HZ);
  /* Present on the pin but unused: the codec clocks off BCLK (file comment). */
  std_config.clk_cfg.mclk_multiple = I2S_MCLK_MULTIPLE_128;
  std_config.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
      I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  std_config.gpio_cfg.mclk = static_cast<gpio_num_t>(PIN_I2S_MCLK);
  std_config.gpio_cfg.bclk = static_cast<gpio_num_t>(PIN_I2S_BCLK);
  std_config.gpio_cfg.ws = static_cast<gpio_num_t>(PIN_I2S_WS);
  std_config.gpio_cfg.dout = static_cast<gpio_num_t>(PIN_I2S_DOUT);
  std_config.gpio_cfg.din = I2S_GPIO_UNUSED;
  std_config.gpio_cfg.invert_flags = {};
  if (i2s_channel_init_std_mode(playback_channel, &std_config) != ESP_OK) {
    release_playback_channel();
    return false;
  }
  /*
   * Codec setup happens with the channel not yet enabled and the amplifier
   * muted. Several ES8311 registers transiently select/reset signal paths;
   * exposing those transitions is a common source of start-of-stream pops.
   */
  if (!configure_codec_playback()) {
    release_playback_channel();
    return false;
  }
  if (i2s_channel_enable(playback_channel) != ESP_OK) {
    release_playback_channel();
    return false;
  }
  playback_enabled = true;
  return true;
}

void playback_hardware_task(void *argument) {
  static struct audio_frame frame;
  /* Mono provider PCM duplicated into both slots for the stereo channel. */
  static int16_t stereo[M5STICKS3_AUDIO_FRAME_SAMPLES * 2];
  (void)argument;
  for (;;) {
    const Stage now_stage = current_stage();
    if (now_stage == Stage::playback) {
      if (capture_wanted.load(std::memory_order_acquire)) {
        /* Fence to capture: quiet first, then give the pins away. */
        (void)amplifier_set(false);
        release_playback_channel();
        mode_switches.fetch_add(1U, std::memory_order_relaxed);
        publish_stage(Stage::micHandoff);
        continue;
      }
      if (xQueueReceive(
              playback_mailbox, &frame, pdMS_TO_TICKS(DMA_DESCRIPTOR_MS)) !=
          pdTRUE) {
        continue;
      }
      const uint32_t frame_ms = static_cast<uint32_t>(
          frame.sample_count * 1000U / M5STICKS3_AUDIO_SAMPLE_RATE_HZ);
      for (size_t index = 0; index < frame.sample_count; ++index) {
        stereo[index * 2U] = frame.samples[index];
        stereo[index * 2U + 1U] = frame.samples[index];
      }
      /*
       * Credit before the blocking write: the deadline ledger must see the
       * audio being handed over while it is being handed over. The rollback
       * keeps the ledger conserved on driver failure.
       */
      m5sticks3_audio_reserve_write(frame_ms);
      size_t written = 0;
      if (i2s_channel_write(
              playback_channel,
              stereo,
              frame.sample_count * 2U * sizeof(int16_t),
              &written,
              1000U) != ESP_OK) {
        m5sticks3_audio_rollback_write(frame_ms);
        playback_driver_failures.fetch_add(1U, std::memory_order_relaxed);
      }
    } else if (now_stage == Stage::playbackHandoff) {
      if (build_playback_channel()) {
        mode_switches.fetch_add(1U, std::memory_order_relaxed);
        publish_stage(Stage::playback);
      } else {
        /* Loud, bounded retry: the board is silent until this succeeds. */
        playback_driver_failures.fetch_add(1U, std::memory_order_relaxed);
        vTaskDelay(pdMS_TO_TICKS(100));
      }
    } else {
      vTaskDelay(pdMS_TO_TICKS(5));
    }
  }
}

/* --- capture hardware ----------------------------------------------------- */

/*
 * Allocation-free bridge from M5Unified's asynchronous recorder into the
 * depth-one seam mailbox. Two frame buffers keep both slots of the recorder
 * queue armed: while one completed frame is copied out, hardware continues
 * filling the other. Two is a hardware-continuity budget, not a backlog. The
 * recorder completes queued buffers in submission order (M5Unified FIFO), so
 * a falling isRecording() count identifies exactly the oldest buffer.
 */
struct recorder_ledger {
  int16_t slots[2][M5STICKS3_AUDIO_FRAME_SAMPLES];
  uint8_t order[2];
  uint8_t recording_count;
  uint8_t head;
  uint8_t discard_left;
  bool slot_recording[2];
};

recorder_ledger recorder;

void recorder_reset(void) {
  recorder.recording_count = 0U;
  recorder.head = 0U;
  recorder.discard_left = CAPTURE_STARTUP_DISCARD_FRAMES;
  recorder.slot_recording[0] = false;
  recorder.slot_recording[1] = false;
}

void recorder_pump(void) {
  const size_t pending = M5.Mic.isRecording();
  if (pending > recorder.recording_count) {
    /*
     * Hardware cannot own more buffers than this ledger handed it. Reset
     * rather than guess which sample pointer remains live; the loss is one
     * frame and the counter says it happened.
     */
    capture_driver_failures.fetch_add(1U, std::memory_order_relaxed);
    recorder_reset();
    return;
  }
  while (recorder.recording_count > pending) {
    const uint8_t completed = recorder.order[recorder.head];
    recorder.head = static_cast<uint8_t>((recorder.head + 1U) % 2U);
    --recorder.recording_count;
    recorder.slot_recording[completed] = false;
    if (recorder.discard_left > 0U) {
      /* Microphone settling noise never reaches the wire. */
      --recorder.discard_left;
    } else {
      static struct audio_frame frame;
      memcpy(
          frame.samples,
          recorder.slots[completed],
          sizeof(frame.samples));
      frame.sample_count = M5STICKS3_AUDIO_FRAME_SAMPLES;
      if (capture_consumer_started.load(std::memory_order_acquire) &&
          uxQueueMessagesWaiting(capture_mailbox) > 0U) {
        capture_overruns.fetch_add(1U, std::memory_order_relaxed);
      }
      (void)xQueueOverwrite(capture_mailbox, &frame);
    }
  }
  while (recorder.recording_count < 2U) {
    uint8_t free_slot = 2U;
    for (uint8_t index = 0U; index < 2U; ++index) {
      if (!recorder.slot_recording[index]) {
        free_slot = index;
        break;
      }
    }
    if (free_slot >= 2U) break;
    if (!M5.Mic.record(
            recorder.slots[free_slot],
            M5STICKS3_AUDIO_FRAME_SAMPLES,
            M5STICKS3_AUDIO_SAMPLE_RATE_HZ,
            false)) {
      /* A full/unavailable recorder queue is not worth busy-waiting on. */
      break;
    }
    recorder.slot_recording[free_slot] = true;
    recorder.order[
        static_cast<uint8_t>((recorder.head + recorder.recording_count) % 2U)] =
        free_slot;
    ++recorder.recording_count;
  }
}

void capture_hardware_task(void *argument) {
  (void)argument;
  for (;;) {
    const Stage now_stage = current_stage();
    if (now_stage == Stage::micHandoff) {
      if (!capture_wanted.load(std::memory_order_acquire)) {
        /* The hold ended before the microphone ever started. */
        publish_stage(Stage::playbackHandoff);
        continue;
      }
      if (M5.Mic.begin()) {
        recorder_reset();
        publish_stage(Stage::capture);
      } else {
        capture_driver_failures.fetch_add(1U, std::memory_order_relaxed);
        M5.Mic.end();
        /* Give the pins back rather than latching a dead microphone. */
        publish_stage(Stage::playbackHandoff);
      }
    } else if (now_stage == Stage::capture) {
      if (!capture_wanted.load(std::memory_order_acquire)) {
        /*
         * Mic.end() releases recorder buffer pointers before the ledger is
         * reset, and powers the codec down entirely — which is why the
         * playback handoff re-runs the codec register table.
         */
        M5.Mic.end();
        recorder_reset();
        publish_stage(Stage::playbackHandoff);
        continue;
      }
      recorder_pump();
      vTaskDelay(pdMS_TO_TICKS(5));
    } else {
      vTaskDelay(pdMS_TO_TICKS(5));
    }
  }
}

}  // namespace

/* --- public C surface ------------------------------------------------------ */

extern "C" {

bool m5sticks3_audio_init(void) {
  capture_mailbox = xQueueCreate(1U, sizeof(struct audio_frame));
  playback_mailbox = xQueueCreate(1U, sizeof(struct audio_frame));
  if (capture_mailbox == nullptr || playback_mailbox == nullptr) {
    ESP_LOGE(tag, "audio seam queue allocation failed");
    return false;
  }
  /* Amplifier stays muted until audio actually arrives. */
  (void)amplifier_set(false);
  if (!build_playback_channel()) {
    ESP_LOGE(tag, "playback bring-up failed");
    return false;
  }
  TaskHandle_t capture_task_handle = nullptr;
  if (xTaskCreatePinnedToCore(
          capture_hardware_task,
          "audio-hw-capture",
          4096U,
          nullptr,
          19U,
          &capture_task_handle,
          1) != pdPASS ||
      xTaskCreatePinnedToCore(
          playback_hardware_task,
          "audio-hw-playback",
          4096U,
          nullptr,
          20U,
          nullptr,
          1) != pdPASS) {
    if (capture_task_handle != nullptr) {
      vTaskDelete(capture_task_handle);
    }
    ESP_LOGE(tag, "audio hardware task creation failed");
    return false;
  }
  ESP_LOGI(tag, "ES8311 half-duplex audio ready at 16 kHz");
  return true;
}

struct iterate_kit_audio_codec m5sticks3_audio_codec(void) {
  struct iterate_kit_audio_codec codec;
  codec.ops = &codec_ops;
  codec.properties = &codec_properties;
  codec.context = nullptr;
  return codec;
}

void m5sticks3_audio_set_capture(bool capture) {
  capture_wanted.store(capture, std::memory_order_release);
}

bool m5sticks3_audio_capturing(void) {
  return current_stage() == Stage::capture;
}

bool m5sticks3_audio_mode_switching(void) {
  const Stage now_stage = current_stage();
  const bool wanted = capture_wanted.load(std::memory_order_acquire);
  if (now_stage == Stage::micHandoff || now_stage == Stage::playbackHandoff) {
    return true;
  }
  return (now_stage == Stage::playback) == wanted;
}

void m5sticks3_audio_amplifier(bool on) {
  static bool current = false;
  static bool initialized = false;
  if (initialized && on == current) return;
  if (amplifier_set(on)) {
    initialized = true;
    current = on;
  }
  /*
   * No delay on the way up. This is called from the receive path, with the
   * playout prefill in front of the first sample, so the amp settles for
   * free — and blocking here would stall the task that decodes speaker PCM.
   */
}

uint32_t m5sticks3_audio_capture_overruns(void) {
  return capture_overruns.load(std::memory_order_relaxed);
}

uint32_t m5sticks3_audio_capture_driver_failures(void) {
  return capture_driver_failures.load(std::memory_order_relaxed);
}

uint32_t m5sticks3_audio_playback_driver_failures(void) {
  return playback_driver_failures.load(std::memory_order_relaxed);
}

uint32_t m5sticks3_audio_mode_switches(void) {
  return mode_switches.load(std::memory_order_relaxed);
}

void m5sticks3_audio_watch(bool active) {
  portENTER_CRITICAL(&ledger_lock);
  if (active && !ledger_watch) {
    ledger_written_ms = 0U;
    /*
     * How much the hardware may still be holding. Zero after a normal drain;
     * one ring after an intentional flush, because that audio was never
     * un-queued and will play out without any new credit.
     */
    ledger_empty_at_us = esp_timer_get_time() +
        (ledger_stale_ring ? static_cast<int64_t>(DMA_RING_MS) * 1000 : 0);
    ledger_stale_ring = false;
  }
  if (active) ledger_draining = false;
  ledger_watch = active;
  portEXIT_CRITICAL(&ledger_lock);
}

void m5sticks3_audio_draining(void) {
  portENTER_CRITICAL(&ledger_lock);
  ledger_draining = true;
  portEXIT_CRITICAL(&ledger_lock);
}

void m5sticks3_audio_note_flush(void) {
  portENTER_CRITICAL(&ledger_lock);
  ledger_stale_ring = true;
  portEXIT_CRITICAL(&ledger_lock);
}

void m5sticks3_audio_reserve_write(uint32_t ms) {
  const int64_t now_us = esp_timer_get_time();
  portENTER_CRITICAL(&ledger_lock);
  /*
   * Late only if the ring had already run out — meaningful only while we
   * were meant to be feeding, and only once the ring has been filled for the
   * first time (an answer's opening plays into a ring that was idle).
   */
  if (ledger_watch && !ledger_draining && ledger_empty_at_us > 0 &&
      ledger_written_ms >= static_cast<uint32_t>(DMA_RING_MS) &&
      now_us > ledger_empty_at_us) {
    ledger_starved_ms = saturating_add(
        ledger_starved_ms,
        static_cast<uint32_t>((now_us - ledger_empty_at_us) / 1000));
    ledger_starve_events = saturating_add(ledger_starve_events, 1U);
  }
  /* The deadline moves out by exactly the audio this write hands over. */
  const int64_t base_us =
      now_us > ledger_empty_at_us ? now_us : ledger_empty_at_us;
  ledger_empty_at_us = base_us + static_cast<int64_t>(ms) * 1000;
  ledger_written_ms = saturating_add(ledger_written_ms, ms);
  portEXIT_CRITICAL(&ledger_lock);
}

void m5sticks3_audio_rollback_write(uint32_t ms) {
  /* The write failed, so the audio never went in: take the credit back. */
  portENTER_CRITICAL(&ledger_lock);
  ledger_empty_at_us -= static_cast<int64_t>(ms) * 1000;
  if (ledger_written_ms >= ms) ledger_written_ms -= ms;
  portEXIT_CRITICAL(&ledger_lock);
}

uint32_t m5sticks3_audio_starved_ms(void) {
  return ledger_starved_ms;
}

uint32_t m5sticks3_audio_starve_events(void) {
  return ledger_starve_events;
}

uint32_t m5sticks3_audio_written_ms(void) {
  return ledger_written_ms;
}

void m5sticks3_audio_inject_starvation(uint32_t ms) {
  inject_starvation_ms.store(ms, std::memory_order_relaxed);
}

bool m5sticks3_audio_starvation_pending(void) {
  return inject_starvation_ms.load(std::memory_order_relaxed) > 0U;
}

uint32_t m5sticks3_audio_take_injected_starvation(void) {
  return inject_starvation_ms.exchange(0U, std::memory_order_relaxed);
}

}  // extern "C"
