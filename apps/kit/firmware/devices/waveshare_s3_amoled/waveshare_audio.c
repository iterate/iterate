/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 audio bring-up (ES8311, full duplex).
 *
 * PROVEN on hardware: a spoken question reaches Grok through this microphone
 * and the answer plays back through this speaker, both over one WebSocket.
 *
 * Recipe distilled from the board's xiaozhi-esp32 port and Waveshare's own
 * BSP:
 *  - I2C0 on SDA 15 / SCL 14; ES8311 at 0x18 (7-bit), AXP2101 at 0x34.
 *  - AXP2101: DC1 = 3.3 V main rail, ALDO1 = 3.3 V microphone rail.
 *  - One duplex I2S channel pair, master, MCLK x256 (the ES8311 driver's
 *    default divider); esp_codec_dev_open() reconfigures slots to mono.
 *  - PA on GPIO46, handled by the ES8311 driver.
 * No TCA9554 pulse here: that expander reset is panel/touch-only.
 *
 * Two tempting bring-up changes are deliberately absent:
 *  - `no_dac_ref` remains false, as in working board ports. The earlier noise
 *    diagnosis was actually two codec instances reconfiguring one I2S pair.
 *  - PGA remains 24 dB. At 30 dB measured speech clipped; the old 36 dB note
 *    described a VAD workaround rather than a safe capture level.
 *
 * Diagnostics kept for the next bring-up: waveshare_audio_dump_registers()
 * (ADC-path registers after open) and waveshare_audio_probe_din() (is
 * anything driving the data line). Note when reading captured audio off the
 * stream: 640 PCM bytes base64-encode to 854 characters, which is NOT a
 * multiple of 4 — decode each frame separately. Concatenating the strings
 * first misaligns every frame after the first and yields convincing
 * broadband "noise" that looks exactly like a dead microphone.
 */
#include "waveshare_audio.h"

#include <stdatomic.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "bsp/esp-bsp.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

/* Bring-up probe: treat the board's microphone as PDM rather than analog. */
#ifndef WAVESHARE_AUDIO_DIGITAL_MIC
#define WAVESHARE_AUDIO_DIGITAL_MIC 0
#endif

static const char tag[] = "waveshare-audio";

enum {
  DMA_DESCRIPTOR_COUNT = 6,
  DMA_FRAMES_PER_DESCRIPTOR = 240,
  /* 6 descriptors x 240 frames at 16kHz = the ring's depth in milliseconds. */
  DMA_RING_MS = 90,
  /* One descriptor: 240 frames at 16kHz. */
  DMA_DESCRIPTOR_MS = 15,
  PIN_I2C_SDA = 15,
  PIN_I2C_SCL = 14,
  PIN_I2S_MCLK = 16,
  PIN_I2S_BCLK = 9,
  PIN_I2S_WS = 45,
  PIN_I2S_DIN = 10,
  PIN_I2S_DOUT = 8,
  PIN_PA = 46,
  /*
   * How long this board's class-D amplifier needs between its enable going
   * high and it reproducing a sample faithfully. Generous rather than tuned:
   * the cost is 80 ms added to the first word of an answer, paid out of a
   * thirty-second ring that already holds the whole thing, and the failure it
   * prevents is a missing syllable that no counter can report.
   */
  AMPLIFIER_SETTLE_MS = 80,
  ADDR_ES8311_8BIT = 0x30, /* esp_codec_dev shifts to 7-bit 0x18 */
  ADDR_AXP2101 = 0x34,
};

static i2c_master_bus_handle_t i2c_bus;
/*
 * One ES8311 instance, one IN_OUT handle: the chip is one device and the I2S
 * channel pair has one owner. Two handles over one data interface meant the
 * second open() reconfigured the channels the first had set up.
 */
static esp_codec_dev_handle_t codec_dev;
static uint8_t speaker_volume_percent = WAVESHARE_AUDIO_VOLUME_DEFAULT;
/* Retained for the post-open register dump (bring-up diagnostics only). */
static const audio_codec_ctrl_if_t *registers_ctrl_if;

struct audio_frame {
  int16_t samples[WAVESHARE_AUDIO_FRAME_SAMPLES];
  size_t sample_count;
};

static QueueHandle_t capture_queue;
static QueueHandle_t playback_queue;
/* Startup capture is not loss until the portable consumer has started. */
static atomic_bool capture_consumer_started;
static volatile uint32_t capture_overruns;
static volatile uint32_t capture_driver_failures;
static volatile uint32_t playback_driver_failures;

static enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  struct audio_frame frame;
  (void)context;
  (void)reference;
  if (capture_queue == NULL || capacity_samples < WAVESHARE_AUDIO_FRAME_SAMPLES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  atomic_store_explicit(
      &capture_consumer_started, true, memory_order_release);
  if (xQueueReceive(capture_queue, &frame, 0) != pdTRUE) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  memcpy(capture, frame.samples, frame.sample_count * sizeof(*capture));
  *sample_count = frame.sample_count;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status codec_write(
    void *context, const int16_t *playback, size_t sample_count) {
  struct audio_frame frame;
  (void)context;
  if (playback_queue == NULL || sample_count == 0U ||
      sample_count > WAVESHARE_AUDIO_FRAME_SAMPLES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memcpy(frame.samples, playback, sample_count * sizeof(*playback));
  frame.sample_count = sample_count;
  return xQueueSend(playback_queue, &frame, 0) == pdTRUE
      ? ITERATE_KIT_OK
      : ITERATE_KIT_BACKPRESSURE;
}

static const struct iterate_kit_audio_codec_ops codec_ops = {
  .read = codec_read,
  .write = codec_write,
};

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
  .capture_channels = 1,
  .playback_channels = 1,
  .has_reference_channel = false,
  .has_output_gain_control = true,
  .output_gain_ceiling_centi_db = 0,
};

/*
 * ONLY THESE TASKS CALL THE BLOCKING ESP CODEC DRIVER.
 *
 * That ownership is what makes the public seam honestly nonblocking. Capture
 * keeps the newest complete capture-clock-contiguous frame in a depth-one
 * mailbox; playback accepts at most one complete frame beyond the one the
 * hardware task is currently handing to DMA. Neither direction can grow an
 * unbounded latency queue.
 */
static void capture_hardware_task(void *argument) {
  struct audio_frame frame = {.sample_count = WAVESHARE_AUDIO_FRAME_SAMPLES};
  (void)argument;
  for (;;) {
    if (esp_codec_dev_read(
            codec_dev, frame.samples, sizeof(frame.samples)) !=
        ESP_CODEC_DEV_OK) {
      ++capture_driver_failures;
      vTaskDelay(1U);
      continue;
    }
    if (atomic_load_explicit(
            &capture_consumer_started, memory_order_acquire) &&
        uxQueueMessagesWaiting(capture_queue) > 0U) {
      ++capture_overruns;
    }
    (void)xQueueOverwrite(capture_queue, &frame);
  }
}

/*
 * When the amplifier can be trusted to reproduce a sample. Written by the
 * receive path, read by the playback task; a single aligned 64-bit stamp on a
 * board where only one writer ever sets it.
 */
static volatile int64_t amplifier_settled_at_us;

static void playback_hardware_task(void *argument) {
  struct audio_frame frame;
  (void)argument;
  for (;;) {
    if (xQueueReceive(playback_queue, &frame, portMAX_DELAY) != pdTRUE) {
      continue;
    }
    const uint32_t frame_ms = (uint32_t)(
        frame.sample_count * 1000U / WAVESHARE_AUDIO_SAMPLE_RATE_HZ);
    /*
     * THE AMPLIFIER HAS TO BE CONDUCTING BEFORE THE FIRST SAMPLE, AND THIS IS
     * THE SECOND TIME THAT HAS NEEDED FIXING.
     *
     * The first fix raised the amp when audio ARRIVED rather than when the
     * first sample was written, and spent the playout prefill as settle time.
     * That was sound while the server dripped frames in real time: the prefill
     * really did take 160 ms of wall clock to accumulate. It is not sound any
     * more — a whole answer now leaves the bridge as fast as the wire takes
     * it, so the prefill threshold is crossed a few milliseconds after the
     * first frame lands and the amp gets no settle window at all. Heard as
     * "banana" arriving as "nana".
     *
     * The counters could not see it and never will: every frame was received,
     * queued and written (spkPlayed == spkWrites, nothing discarded). The
     * audio was lost in the analogue domain, after the last instrument.
     *
     * So the settle is an explicit deadline now rather than a side effect of
     * how slowly audio happens to arrive. Waiting HERE is safe and waiting in
     * the amplifier call is not: this task exists to feed DMA, while that one
     * runs on the receive path that decodes speaker PCM.
     */
    {
      const int64_t settle_us = amplifier_settled_at_us - esp_timer_get_time();
      if (settle_us > 0) {
        vTaskDelay(pdMS_TO_TICKS((uint32_t)((settle_us + 999) / 1000)));
      }
    }
    /*
     * Credit before the blocking write: DMA completion callbacks run from
     * inside esp_codec_dev_write(), so crediting afterwards fabricates an
     * underrun. The rollback keeps the ledger conserved on driver failure.
     */
    waveshare_audio_reserve_write(frame_ms);
    if (esp_codec_dev_write(
            codec_dev,
            (void *)(uintptr_t)frame.samples,
            frame.sample_count * sizeof(*frame.samples)) != ESP_CODEC_DEV_OK) {
      waveshare_audio_rollback_write(frame_ms);
      ++playback_driver_failures;
    }
  }
}

static bool axp2101_write(
    i2c_master_dev_handle_t device, uint8_t reg, uint8_t value) {
  const uint8_t frame[2] = {reg, value};
  return i2c_master_transmit(device, frame, sizeof(frame), 100) == ESP_OK;
}

static bool power_rails_up(void) {
  const i2c_device_config_t config = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = ADDR_AXP2101,
    .scl_speed_hz = 400000,
  };
  i2c_master_dev_handle_t pmic;
  bool ok;
  if (i2c_master_bus_add_device(i2c_bus, &config, &pmic) != ESP_OK) {
    ESP_LOGE(tag, "AXP2101 not reachable");
    return false;
  }
  ok = axp2101_write(pmic, 0x22, 0x06) &&
      axp2101_write(pmic, 0x27, 0x10) &&
      axp2101_write(pmic, 0x80, 0x01) &&           /* DCDCs: DC1 only */
      axp2101_write(pmic, 0x90, 0x00) &&
      axp2101_write(pmic, 0x91, 0x00) &&
      axp2101_write(pmic, 0x82, (3300 - 1500) / 100) && /* DC1 3.3V */
      axp2101_write(pmic, 0x92, (3300 - 500) / 100) &&  /* ALDO1 3.3V */
      axp2101_write(pmic, 0x90, 0x01) &&           /* ALDO1 on == MIC rail */
      axp2101_write(pmic, 0x64, 0x02) &&
      axp2101_write(pmic, 0x61, 0x02) &&
      axp2101_write(pmic, 0x62, 0x08) &&
      axp2101_write(pmic, 0x63, 0x01);
  (void)i2c_master_bus_rm_device(pmic);
  if (!ok) {
    ESP_LOGE(tag, "AXP2101 rail configuration failed");
    return false;
  }
  vTaskDelay(pdMS_TO_TICKS(20)); /* rails settle before codec probe */
  return true;
}

/*
 * DMA BUFFERS THE HARDWARE SENT WITH NOTHING IN THEM.
 *
 * Every "starvation" number this device reports is inferred from the stream
 * buffer, which sits one hop upstream of the DMA — so it says the software
 * queue was empty, not that the DAC ever wanted for audio. With a 90 ms ring
 * in front of it those are very different claims, and the whole playout
 * policy has been tuned against the weaker one.
 *
 * This is the strong one: the driver hands each finished descriptor to this
 * callback and, because auto_clear zeroes AFTER it runs, a buffer we never
 * filled arrives here still holding the zeros of its last send. A run where
 * this stays at zero is a run where the listener heard every sample the
 * hardware was asked for, whatever the software counters say.
 *
 * ISR context: no logging, no locks, one increment.
 */
static volatile uint32_t dma_underruns;
/*
 * Only while somebody is speaking. Between answers the ring is CORRECTLY
 * full of zeros — that is an idle DAC, not a starved one — and counting
 * those produced 23471 "underruns" in six turns, which is the sound of a
 * metric measuring silence rather than a fault.
 */

static volatile bool dma_watch;
/*
 * True while the software has stopped handing over audio on purpose. Separate
 * from dma_watch being false, because the difference between "an answer is
 * ending" and "no answer is happening" is worth keeping in the numbers.
 */
static volatile bool dma_draining;
/*
 * Underruns in the first descriptors after playback starts, separated from
 * the rest. The two have different causes and only one is worth chasing: an
 * answer's opening plays into a DMA ring that has been idle, so the first
 * buffers were cleared long ago and the very first write cannot reach them
 * before they are sent. Underruns AFTER that are the pipeline failing to keep
 * up, which is the real defect.
 */
static volatile uint32_t dma_underruns_opening;
/*
 * Cleared descriptors sent while the source was DRY — the normal end of every
 * answer, and not a fault.
 *
 * The DMA ring is 90 ms deep and the speaker task blocks up to 60 ms for the
 * next frame, so between answers the hardware keeps sending descriptors the
 * software has deliberately stopped filling. Those were landing in
 * dma_underruns: 6-12 of them on every short turn, on turns where every
 * single frame sent was played. A counter that moves on a perfect turn tells
 * nobody anything, so the drain is counted here and starvation stays over
 * there.
 */
static volatile uint32_t dma_sends_draining;
/*
 * MILLISECONDS OF AUDIO handed over since feeding began.
 *
 * The opening window used to be six SENDS — one ring's worth of descriptors —
 * which assumed each send was preceded by a full frame. After a barge-in that is
 * false: the discard boundary can split a read, so the replacement answer's
 * first write is a fragment, six sends elapse in 90ms regardless, and the window
 * closes while the ring is still mostly empty. The sends that follow were then
 * charged as starvation. Intermittent exactly as observed, because it depends on
 * whether the discard split a read.
 *
 * An answer is "opening" until a ring's worth of AUDIO has actually been handed
 * over. That is the real condition the window was reaching for.
 */
static volatile uint32_t dma_written_ms_since_start;
/*
 * AUDIO HANDED OVER BUT NOT YET SENT, in milliseconds. The starvation test.
 *
 * Replaces a content heuristic that called any descriptor whose first four words
 * were zero an underrun. That counted legitimate silent PCM: the decisive
 * measurement was a "starved" descriptor sent 14.983ms after a successful write
 * — one descriptor time — which cannot be an empty 90ms ring. A 20ms frame does
 * not divide into 15ms descriptors, so the tail of every write is a partly
 * filled descriptor and its opening samples are whatever was there before.
 *
 * Ownership needs no heuristic. Every write adds what it wrote; every send
 * consumes one descriptor. If the hardware sends a descriptor we never paid
 * for, it is sending one we never filled, and that is starvation whatever the
 * samples happen to contain.
 */
static volatile int32_t dma_owed_ms;
/*
 * ONE LOCK OVER THE LEDGER, because it is read-modify-written from two contexts.
 *
 * The ISR subtracts a descriptor; the playback task adds a reservation. `+=` and
 * `-=` are not atomic on Xtensa however volatile the variable is, so a callback
 * landing inside reserve_write could lose the credit entirely — which shows up
 * as an intermittent false fault, or worse, a missed one. A spinlock is the
 * right size for three integers touched for a handful of instructions, and it
 * lives in DRAM because the ISR is in IRAM and must not fault on it.
 */
static DRAM_ATTR portMUX_TYPE dma_ledger_lock = portMUX_INITIALIZER_UNLOCKED;

static bool IRAM_ATTR on_dma_sent(
    i2s_chan_handle_t handle, i2s_event_data_t *event, void *context) {
  (void)handle;
  (void)context;
  if (event == NULL || event->dma_buf == NULL) return false;

  /*
   * EVERYTHING UNDER ONE CRITICAL SECTION.
   *
   * The watch flag, the ledger, the send index and the classification are one
   * decision and must be taken together. Reading dma_watch before the lock let
   * an intentional disarm land in between, so a barge-in could still be charged
   * as starvation — and the send index could be reset by an arm between the
   * decrement and the classification that quoted it.
   */
  portENTER_CRITICAL_ISR(&dma_ledger_lock);
  if (dma_watch) {
    dma_owed_ms -= (int32_t)DMA_DESCRIPTOR_MS;
    if (dma_owed_ms < 0) {
      dma_owed_ms = 0; /* Don't accumulate debt across a gap. */
      if (dma_draining) {
        ++dma_sends_draining;
      } else if (dma_written_ms_since_start < DMA_RING_MS) {
        ++dma_underruns_opening;
      } else {
        ++dma_underruns;
      }
    }
  }
  portEXIT_CRITICAL_ISR(&dma_ledger_lock);
  return false;
}

uint32_t waveshare_audio_dma_underruns(void) {
  return dma_underruns;
}

int32_t waveshare_audio_dma_owed_ms(void) {
  return dma_owed_ms;
}




/*
 * STARVATION MEASURED ON THE WRITING TASK, not inferred from callbacks.
 *
 * The ledger in the ISR can only see a gap if the driver keeps issuing on_sent
 * while nothing is queued, and a 600ms injected starvation moved it by zero —
 * the descriptors it used to catch were the REFILL after the gap, which the
 * ownership model correctly pays for. So the gap is measured where it is
 * unambiguous: at the previous write the ring held `owed` milliseconds of audio,
 * so if more than that has elapsed before the next write, the DAC ran dry for
 * the difference. One task, one clock, no race.
 */
static volatile uint32_t dma_starved_ms;
static volatile uint32_t dma_starve_events;
/*
 * WHEN THE RING WILL BE EMPTY, as an absolute time. The conserved timeline.
 *
 * The first attempt compared the interval since the last write against the
 * ownership REMAINING after the ISR had decremented it, which double-counts what
 * the callbacks already consumed: a normal 20ms interval with 20ms credited and
 * one 15ms callback leaves owed at 5 and reports 15ms of starvation that never
 * happened. A deadline conserves instead of accumulating — every reservation
 * pushes it out by exactly the audio written, callbacks never touch it, and a
 * write is late only when it arrives after the deadline has already passed.
 */
static volatile int64_t dma_empty_at_us;
/*
 * The hardware ring may still hold audio nobody will credit again.
 *
 * An intentional cut discards the SOFTWARE buffer; the DMA ring keeps whatever
 * was already queued — up to one ring. Re-arming used to set the empty-deadline
 * to `now`, which asserts an empty ring and is false by up to 90ms, so the first
 * writes after a cut looked late and a barge-in produced spkStarveEvents on a
 * gate that must never move. Set only at a real flush, so an ordinary answer
 * end — where the ring genuinely drained — keeps the exact deadline.
 */
static volatile bool dma_stale_ring;

uint32_t waveshare_audio_starved_ms(void) {
  return dma_starved_ms;
}

uint32_t waveshare_audio_starve_events(void) {
  return dma_starve_events;
}

void waveshare_audio_reserve_write(uint32_t ms) {
  /*
   * CREDITED BEFORE THE WRITE, NOT AFTER.
   *
   * esp_codec_dev_write blocks until DMA accepts the frame, and the on_sent
   * callbacks fire DURING that block. Crediting afterwards charged every write's
   * own descriptors against a ledger that did not yet know about them: 265
   * "opening" underruns for 275 frames played, which is the accounting being
   * pathological rather than the pipeline. Reserving first means a callback that
   * fires mid-write sees the audio it is sending.
   */
  const int64_t now_us = esp_timer_get_time();
  int64_t base_us;
  portENTER_CRITICAL(&dma_ledger_lock);
  /*
   * Late only if the ring had already run out. Meaningful only while we were
   * meant to be feeding — an intentional pause disarms the watch — and only once
   * the ring has been filled for the first time.
   */
  if (dma_watch && !dma_draining && dma_empty_at_us > 0 &&
      dma_written_ms_since_start >= DMA_RING_MS && now_us > dma_empty_at_us) {
    dma_starved_ms += (uint32_t)((now_us - dma_empty_at_us) / 1000);
    ++dma_starve_events;
  }
  /* The deadline moves out by exactly the audio this write hands over. */
  base_us = now_us > dma_empty_at_us ? now_us : dma_empty_at_us;
  dma_empty_at_us = base_us + (int64_t)ms * 1000;
  dma_owed_ms += (int32_t)ms;
  if (dma_written_ms_since_start < 0xffff0000U) dma_written_ms_since_start += ms;
  portEXIT_CRITICAL(&dma_ledger_lock);
}

void waveshare_audio_rollback_write(uint32_t ms) {
  /* The write failed, so the audio never went in: take the credit back. */
  portENTER_CRITICAL(&dma_ledger_lock);
  /* Undo the reservation, deadline included: this audio never went in. */
  dma_empty_at_us -= (int64_t)ms * 1000;
  dma_owed_ms -= (int32_t)ms;
  if (dma_owed_ms < 0) dma_owed_ms = 0;
  if (dma_written_ms_since_start >= ms) dma_written_ms_since_start -= ms;
  portEXIT_CRITICAL(&dma_ledger_lock);
}

void waveshare_audio_dma_watch(bool active) {
  /* One lock over the whole transition — see on_dma_sent. */
  portENTER_CRITICAL(&dma_ledger_lock);
  if (active && !dma_watch) {
    dma_written_ms_since_start = 0U;
    dma_owed_ms = 0;
    /*
     * How much the hardware may still be holding. Zero after a normal drain;
     * one ring after an intentional flush, because that audio was never
     * un-queued and will be sent without any new credit.
     */
    dma_empty_at_us = esp_timer_get_time() +
        (dma_stale_ring ? (int64_t)DMA_RING_MS * 1000 : 0);
    dma_stale_ring = false;
  }
  if (active) dma_draining = false;
  dma_watch = active;
  portEXIT_CRITICAL(&dma_ledger_lock);
}

void waveshare_audio_note_flush(void) {
  /* The software buffer was discarded; the ring was not. See dma_stale_ring. */
  portENTER_CRITICAL(&dma_ledger_lock);
  dma_stale_ring = true;
  portEXIT_CRITICAL(&dma_ledger_lock);
}

void waveshare_audio_dma_draining(void) {
  portENTER_CRITICAL(&dma_ledger_lock);
  /*
   * Called the moment the source runs dry, BEFORE the task blocks waiting for
   * a frame that is not coming. The watch stays on so a genuine stall inside
   * the drain is still visible — it just lands in the draining bucket, where
   * it describes the end of an answer instead of a defect.
   */
  dma_draining = true;
  portEXIT_CRITICAL(&dma_ledger_lock);
}

uint32_t waveshare_audio_dma_sends_draining(void) {
  return dma_sends_draining;
}




uint32_t waveshare_audio_dma_underruns_opening(void) {
  return dma_underruns_opening;
}

bool waveshare_audio_init(void) {
  i2s_chan_handle_t tx = NULL;
  i2s_chan_handle_t rx = NULL;
  TaskHandle_t capture_task_handle = NULL;

  /*
   * One owner for I2C0: the BSP creates it (same SDA 15 / SCL 14) and the
   * codec, the PMIC and the touch controller all ride that bus. Two creators
   * of the same port is an error, and the display needs it either way.
   */
  i2c_bus = bsp_i2c_get_handle();
  if (i2c_bus == NULL) {
    ESP_LOGE(tag, "i2c bus unavailable");
    return false;
  }
  if (!power_rails_up()) {
    return false;
  }

  /*
   * DMA geometry from Espressif's standard-mode sizing formula:
   *
   *   descriptor bytes = frames * slots * bits / 8
   *                    = 240 * 1 * 16 / 8 = 480 (must be <= 4092)
   *   interrupt period = frames / sample rate = 240 / 16000 = 15 ms
   *   ring depth       = descriptors * period = 6 * 15 = 90 ms
   *
   * The 20 ms hardware-task cycle therefore needs more than 20/15
   * descriptors; six leaves four cycles of scheduling headroom. The driver's
   * receive buffer is 6 * 480 = 2880 bytes and the public seam removes a full
   * 640-byte frame at a time. Source: ESP-IDF 5.4 I2S documentation,
   * "DMA buffer info and configuration".
   * https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/i2s.html#dma-buffer-info-and-configuration
   */
  _Static_assert(
      DMA_FRAMES_PER_DESCRIPTOR * 1 * 16 / 8 <= 4092,
      "I2S descriptor exceeds the ESP32-S3 DMA limit");
  _Static_assert(
      DMA_DESCRIPTOR_COUNT * DMA_FRAMES_PER_DESCRIPTOR * 1000 /
              WAVESHARE_AUDIO_SAMPLE_RATE_HZ ==
          DMA_RING_MS,
      "documented I2S ring depth drifted");
  i2s_chan_config_t channel_config =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channel_config.dma_desc_num = DMA_DESCRIPTOR_COUNT;
  channel_config.dma_frame_num = DMA_FRAMES_PER_DESCRIPTOR;
  channel_config.auto_clear = true;
  if (i2s_new_channel(&channel_config, &tx, &rx) != ESP_OK) {
    ESP_LOGE(tag, "i2s duplex channel creation failed");
    return false;
  }
  {
    i2s_std_config_t std_config = {
      .clk_cfg = {
        .sample_rate_hz = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
        .clk_src = I2S_CLK_SRC_DEFAULT,
        .mclk_multiple = I2S_MCLK_MULTIPLE_256,
      },
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
          I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
      .gpio_cfg = {
        .mclk = PIN_I2S_MCLK,
        .bclk = PIN_I2S_BCLK,
        .ws = PIN_I2S_WS,
        .dout = PIN_I2S_DOUT,
        .din = PIN_I2S_DIN,
        .invert_flags = {0},
      },
    };
    /*
     * Registered before enable, so no descriptor completes unobserved. The
     * codec layer re-initialises these channels on open, but a registered
     * callback survives that — it lives on the channel, not the mode.
     */
    const i2s_event_callbacks_t tx_callbacks = {.on_sent = on_dma_sent};
    (void)i2s_channel_register_event_callback(tx, &tx_callbacks, NULL);
    if (i2s_channel_init_std_mode(tx, &std_config) != ESP_OK ||
        i2s_channel_init_std_mode(rx, &std_config) != ESP_OK ||
        i2s_channel_enable(tx) != ESP_OK ||
        i2s_channel_enable(rx) != ESP_OK) {
      ESP_LOGE(tag, "i2s std init failed");
      return false;
    }
  }

  {
    audio_codec_i2s_cfg_t i2s_config = {
      .port = I2S_NUM_0,
      .rx_handle = rx,
      .tx_handle = tx,
    };
    const audio_codec_data_if_t *data_interface =
        audio_codec_new_i2s_data(&i2s_config);
    audio_codec_i2c_cfg_t i2c_config = {
      .port = I2C_NUM_0,
      .addr = ADDR_ES8311_8BIT,
      .bus_handle = i2c_bus,
    };
    const audio_codec_ctrl_if_t *ctrl_interface =
        audio_codec_new_i2c_ctrl(&i2c_config);
    registers_ctrl_if = ctrl_interface;
    const audio_codec_gpio_if_t *gpio_interface = audio_codec_new_gpio();
    if (data_interface == NULL || ctrl_interface == NULL ||
        gpio_interface == NULL) {
      ESP_LOGE(tag, "codec interface creation failed");
      return false;
    }

    /* Soft reset before construction — cures "present but silent" boots. */
    {
      uint8_t reset = 0x1f;
      (void)ctrl_interface->write_reg(ctrl_interface, 0x00, 1, &reset, 1);
      vTaskDelay(pdMS_TO_TICKS(5));
    }

    es8311_codec_cfg_t codec_config = {
      .ctrl_if = ctrl_interface,
      .gpio_if = gpio_interface,
      .codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH,
      /*
       * The amplifier is driven by hand (waveshare_audio_amplifier), not
       * latched on by the codec for the life of the board.
       */
      .pa_pin = -1,
      .pa_reverted = false,
      .master_mode = false,
      .use_mclk = true,
      .digital_mic = WAVESHARE_AUDIO_DIGITAL_MIC,
      .invert_mclk = false,
      .invert_sclk = false,
      .hw_gain = {.pa_voltage = 5.0f, .codec_dac_voltage = 3.3f},
      /*
       * Kept to match Waveshare's BSP recipe. The NS4150B supply is
       * physically 3.3 V, so 5.0 V makes the codec abstraction's gain
       * arithmetic inaccurate — but correcting it is an ACOUSTIC change and
       * belongs in its own measured comparison, not folded into a structural
       * one. Retune it only against a recording, never by reasoning.
       */
      /*
       * Reg 0x44 = 0x58 (the default) puts DAC output in the ADC lane's right
       * slot as an AEC reference. That was blamed for this board's "broadband
       * garbage" capture and worked around here — but the real cause was two
       * codec instances fighting over one I2S channel pair (see below), and
       * every working port of this board leaves this at the default.
       */
      .no_dac_ref = false,
    };
    /*
     * ONE codec instance, ONE device handle, opened once.
     *
     * This used to build two es8311 instances over the same control
     * interface and two esp_codec_dev handles (IN and OUT) over the same
     * I2S data interface. Every esp_codec_dev_open() calls the data
     * interface's set_fmt, which DISABLES BOTH I2S CHANNELS, rewrites the
     * slot configuration and re-enables them — so opening the speaker tore
     * down and reconfigured the channel pair the microphone had just set up,
     * and clobbered the shared format state that this driver assumes has a
     * single owner. A capture whose slot mask got rewritten underneath it is
     * exactly the "gain-independent broadband noise" this board showed.
     */
    const audio_codec_if_t *codec = es8311_codec_new(&codec_config);
    if (codec == NULL) {
      ESP_LOGE(tag, "ES8311 construction failed");
      return false;
    }
    {
      esp_codec_dev_cfg_t device_config = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN_OUT,
        .codec_if = codec,
        .data_if = data_interface,
      };
      codec_dev = esp_codec_dev_new(&device_config);
      if (codec_dev == NULL) {
        ESP_LOGE(tag, "esp_codec_dev creation failed");
        return false;
      }
    }
  }

  {
    esp_codec_dev_sample_info_t sample_info = {
      .bits_per_sample = 16,
      .channel = 1,
      .channel_mask = 0,
      .sample_rate = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
      .mclk_multiple = 0, /* 0 -> x256, matching the I2S clock */
    };
    if (esp_codec_dev_open(codec_dev, &sample_info) != ESP_CODEC_DEV_OK) {
      ESP_LOGE(tag, "codec open failed");
      return false;
    }
    /*
     * Preserved, not endorsed: ES8311's esp_codec_dev adapter writes register
     * 0x16 ADC_SCALE here, whose reset value is already 24 dB, and clears
     * ADC_SYNC. It does not change the analogue PGA at register 0x14. The
     * earlier "30 dB clipped" result therefore measured digital saturation,
     * not an analogue-PGA comparison — so it is not evidence about the PGA at
     * all, and the comparison it appeared to settle is still open.
     */
    (void)esp_codec_dev_set_in_gain(codec_dev, 24.0f);
    /*
     * As loud as it gets without audible distortion. Measured by acoustic
     * loopback — play a 440Hz tone, capture it on this board's own
     * microphone, compare harmonics to fundamental:
     *
     *   volume 100 -> 2nd harmonic -16.8 dB   (distorting, even with the
     *                                          microphone well below clipping)
     *   volume  60 -> 2nd harmonic -34.9 dB   (clean)
     *
     * So full scale overdrives this amp, and "turn it all the way up" was
     * making the speaker worse rather than louder. 85 keeps the headroom
     * while staying loud; `itx.kit.waveshare.setVolume(n)` tunes it live.
     */
    (void)esp_codec_dev_set_out_vol(codec_dev, WAVESHARE_AUDIO_VOLUME_DEFAULT);
    speaker_volume_percent = WAVESHARE_AUDIO_VOLUME_DEFAULT;
  }
  capture_queue = xQueueCreate(1U, sizeof(struct audio_frame));
  playback_queue = xQueueCreate(1U, sizeof(struct audio_frame));
  if (capture_queue == NULL || playback_queue == NULL) {
    ESP_LOGE(tag, "audio seam queue allocation failed");
    return false;
  }
  if (xTaskCreatePinnedToCore(
          capture_hardware_task,
          "audio-hw-capture",
          4096U,
          NULL,
          19U,
          &capture_task_handle,
          1) != pdPASS ||
      xTaskCreatePinnedToCore(
          playback_hardware_task,
          "audio-hw-playback",
          4096U,
          NULL,
          20U,
          NULL,
          1) != pdPASS) {
    if (capture_task_handle != NULL) {
      vTaskDelete(capture_task_handle);
    }
    ESP_LOGE(tag, "audio hardware task creation failed");
    return false;
  }
  ESP_LOGI(tag, "ES8311 duplex audio ready at 16 kHz");
  /*
   * Bring-up probes deliberately NOT run here: probe_din reconfigures the
   * pull mode on a live DIN pad, busy-spins, and leaves the pad FLOATING —
   * discarding whatever the I2S driver installed. Call them by hand when
   * diagnosing, never on the shipping path.
   */
  return true;
}

/*
 * MEASURED DISTORTION IS THE CEILING HERE, not power or echo: a 1 kHz tone at
 * volume 100 put the 2nd harmonic at -16.8 dB, and at 60 at -34.9 dB. 92 is
 * where the harmonic is still below the noise a listener notices and the
 * device is meaningfully louder than the old 85. Above that it gets louder by
 * getting dirtier, which is not louder.
 */
enum iterate_kit_status waveshare_audio_set_volume(
    uint8_t percent, uint8_t *applied) {
  if (codec_dev == NULL) return ITERATE_KIT_UNAVAILABLE;
  if (percent > WAVESHARE_AUDIO_VOLUME_CEILING) {
    percent = WAVESHARE_AUDIO_VOLUME_CEILING;
  }
  if (esp_codec_dev_set_out_vol(codec_dev, (int)percent) !=
      ESP_CODEC_DEV_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  speaker_volume_percent = percent;
  if (applied != NULL) *applied = percent;
  return ITERATE_KIT_OK;
}

uint8_t waveshare_audio_volume(void) { return speaker_volume_percent; }

void waveshare_audio_amplifier(bool on) {
  static bool configured;
  static bool current;
  if (!configured) {
    const gpio_config_t pa_config = {
      .pin_bit_mask = 1ULL << PIN_PA,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&pa_config) != ESP_OK) return;
    configured = true;
    current = false;
    (void)gpio_set_level(PIN_PA, 0);
  }
  if (on == current) return;
  current = on;
  (void)gpio_set_level(PIN_PA, on ? 1 : 0);
  /*
   * Still no delay on the way up — blocking here would stall the task that
   * decodes speaker PCM, which is exactly what must not happen. Instead this
   * publishes the instant the amp can be trusted, and the PLAYBACK task waits
   * for it. See the wait in playback_task for why the old "the prefill settles
   * it for free" reasoning stopped being true.
   */
  if (on) {
    amplifier_settled_at_us =
        esp_timer_get_time() + (int64_t)AMPLIFIER_SETTLE_MS * 1000;
  }
}

struct iterate_kit_audio_codec waveshare_audio_codec(void) {
  return (struct iterate_kit_audio_codec){
    .ops = &codec_ops,
    .properties = &codec_properties,
    .context = NULL,
  };
}

uint32_t waveshare_audio_capture_overruns(void) {
  return capture_overruns;
}

uint32_t waveshare_audio_capture_driver_failures(void) {
  return capture_driver_failures;
}

uint32_t waveshare_audio_playback_driver_failures(void) {
  return playback_driver_failures;
}
