#include "iterate/kit/platforms/i2s_codec.h"
#include "iterate/kit/starvation_ledger.h"
#include "iterate/kit/capabilities/health.h"
#include <stdatomic.h>
#include <string.h>
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

/** One complete 20 ms wire frame; the only queued storage in either direction. */
struct iterate_kit_i2s_codec_frame {
  int16_t samples[320];
  size_t sample_count;
};

static QueueHandle_t capture_mailbox;
static QueueHandle_t playback_mailbox;
static atomic_bool capture_consumer_started;
static uint32_t capture_overruns;
static uint32_t capture_driver_failures;
static uint32_t playback_driver_failures;
static portMUX_TYPE codec_lock = portMUX_INITIALIZER_UNLOCKED;
static struct iterate_kit_starvation_ledger ledger;
static enum iterate_kit_status (*hardware_read)(void *, int16_t *, size_t);
static enum iterate_kit_status (*hardware_write)(void *, const int16_t *, size_t);
static void *hardware_context;
static void (*before_write)(void *);
static bool (*playback_ready)(void *);
static void (*playback_observed)(void *, const int16_t *, size_t, bool);
static void (*playback_idle)(void *);

void iterate_kit_i2s_codec_set_playback_callbacks(
    bool (*ready)(void *),
    void (*observed)(void *, const int16_t *, size_t, bool),
    void (*idle)(void *)) {
  playback_ready = ready;
  playback_observed = observed;
  playback_idle = idle;
}

void iterate_kit_i2s_codec_note_failure(bool capture) {
  portENTER_CRITICAL(&codec_lock);
  if (capture) ++capture_driver_failures;
  else ++playback_driver_failures;
  portEXIT_CRITICAL(&codec_lock);
}

void iterate_kit_i2s_codec_set_before_write(void (*wait)(void *)) {
  before_write = wait;
}

static enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  struct iterate_kit_i2s_codec_frame frame;
  (void)context;
  (void)reference;
  if (capture_mailbox == NULL ||
      capacity_samples < 320) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  atomic_store_explicit(
      &capture_consumer_started, true, memory_order_release);
  if (xQueueReceive(capture_mailbox, &frame, 0) != pdTRUE) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  memcpy(capture, frame.samples, frame.sample_count * sizeof(*capture));
  *sample_count = frame.sample_count;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status codec_write(
    void *context, const int16_t *playback, size_t sample_count) {
  struct iterate_kit_i2s_codec_frame frame;
  (void)context;
  if (playback_mailbox == NULL || sample_count == 0U ||
      sample_count > 320) {
    return ITERATE_KIT_INVALID_ARGUMENT;
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
  .capture_sample_rate_hz = 16000,
  .playback_sample_rate_hz = 16000,
  .capture_channels = 1,
  .playback_channels = 1,
  .has_reference_channel = false,
  .has_output_gain_control = false,
  .output_gain_ceiling_centi_db = 0,
};

void iterate_kit_i2s_codec_phase(enum iterate_kit_voice_phase phase) {
  portENTER_CRITICAL(&codec_lock);
  iterate_kit_starvation_ledger_phase(&ledger, phase, esp_timer_get_time());
  portEXIT_CRITICAL(&codec_lock);
}

bool iterate_kit_i2s_codec_speaker_is_playing(void) {
  portENTER_CRITICAL(&codec_lock);
  const bool playing = iterate_kit_starvation_ledger_speaker_is_playing(
      &ledger, esp_timer_get_time(), 1500U);
  portEXIT_CRITICAL(&codec_lock);
  return playing;
}

/* --- local sounds ---------------------------------------------------------- */

/*
 * THE BOARD'S OWN VOICE: chimes and mode announcements, straight from flash.
 *
 * Everything else this speaker plays arrives over the stream, paced by the
 * server, seconds after the gesture that asked for it — which is exactly the
 * problem these solve: a press that answers within a frame instead of after a
 * dial. So they bypass the stream entirely and cut in at the last seam before
 * the DAC, where the playback hardware task drains them BEFORE it looks at
 * the mailbox. Preemption, not mixing, on purpose: a chime stepping on the
 * first milliseconds of an answer is acceptable and a mixer is not simpler
 * than this. The stream's frames are not lost — the depth-one mailbox holds
 * one and the portable playback task absorbs the rest as backpressure it
 * already knows how to wait out.
 *
 * Allocation-free: the PCM lives in .rodata (flash), the cursor walks it in
 * 20 ms slices, and the lock is held only to move three words — the flash
 * read itself happens outside the critical section.
 */
static const uint8_t *sound_pcm; /* NULL when idle; guarded by codec_lock */
static uint32_t sound_bytes;
static uint32_t sound_cursor;

void iterate_kit_i2s_codec_play_sound(const uint8_t *pcm, uint32_t bytes) {
  if (pcm == NULL || bytes < 2U) return;
  portENTER_CRITICAL(&codec_lock);
  sound_pcm = pcm;
  sound_bytes = bytes & ~1U; /* whole PCM16 samples only */
  sound_cursor = 0U;
  portEXIT_CRITICAL(&codec_lock);
}

void iterate_kit_i2s_codec_drop_pending_sound(void) {
  portENTER_CRITICAL(&codec_lock);
  sound_pcm = NULL;
  portEXIT_CRITICAL(&codec_lock);
}

bool iterate_kit_i2s_codec_sound_active(void) {
  portENTER_CRITICAL(&codec_lock);
  const bool active = sound_pcm != NULL;
  portEXIT_CRITICAL(&codec_lock);
  return active;
}

static void capture_hardware_task(void *argument) {
  static struct iterate_kit_i2s_codec_frame frame = {.sample_count = 320};
  (void)argument;
  for (;;) {
    const enum iterate_kit_status status = hardware_read(hardware_context, frame.samples, 320);
    if (status != ITERATE_KIT_OK) {
      if (status != ITERATE_KIT_UNAVAILABLE) {
        portENTER_CRITICAL(&codec_lock);
        ++capture_driver_failures;
        portEXIT_CRITICAL(&codec_lock);
        vTaskDelay(1U);
      }
      continue;
    }
    if (atomic_load_explicit(&capture_consumer_started, memory_order_acquire) &&
        uxQueueMessagesWaiting(capture_mailbox) > 0U) {
      portENTER_CRITICAL(&codec_lock);
      ++capture_overruns;
      portEXIT_CRITICAL(&codec_lock);
    }
    (void)xQueueOverwrite(capture_mailbox, &frame);
  }
}

static void playback_hardware_task(void *argument) {
  static struct iterate_kit_i2s_codec_frame frame;
  (void)argument;
  for (;;) {
    if (playback_ready != NULL && !playback_ready(hardware_context)) continue;
    /*
     * A local sound outranks the mailbox — see the note at `sound_pcm`. The
     * slice bounds are taken under the lock and the flash copy happens
     * outside it; if the app task replaces the sound mid-slice, this frame
     * finishes from the superseded PCM and the next one starts the new
     * sound, which is the preemption behaving as specified.
     */
    const uint8_t *sound = NULL;
    uint32_t sound_offset = 0U;
    uint32_t sound_take = 0U;
    portENTER_CRITICAL(&codec_lock);
    if (sound_pcm != NULL) {
      const uint32_t remaining = sound_bytes - sound_cursor;
      sound = sound_pcm;
      sound_offset = sound_cursor;
      sound_take = remaining < sizeof(frame.samples)
          ? remaining
          : (uint32_t)sizeof(frame.samples);
      sound_cursor += sound_take;
      if (sound_cursor >= sound_bytes) sound_pcm = NULL;
    }
    portEXIT_CRITICAL(&codec_lock);
    if (sound != NULL) {
      memcpy(frame.samples, sound + sound_offset, sound_take);
      frame.sample_count = sound_take / sizeof(frame.samples[0]);
    } else if (
        /*
         * One frame period instead of portMAX_DELAY, so a chime requested
         * while the stream is silent starts within 20 ms. An idle wake that
         * finds neither sound nor frame costs one queue peek.
         */
        xQueueReceive(playback_mailbox, &frame, pdMS_TO_TICKS(20)) !=
        pdTRUE) {
      if (playback_idle != NULL) playback_idle(hardware_context);
      continue;
    }
    if (before_write != NULL) before_write(hardware_context);
    const uint32_t frame_ms = (uint32_t)(frame.sample_count * 1000U / 16000U);
    portENTER_CRITICAL(&codec_lock);
    iterate_kit_starvation_ledger_reserve_write(&ledger, frame_ms, esp_timer_get_time());
    portEXIT_CRITICAL(&codec_lock);
    const enum iterate_kit_status status = hardware_write(
        hardware_context, frame.samples, frame.sample_count);
    if (status != ITERATE_KIT_OK) {
      portENTER_CRITICAL(&codec_lock);
      iterate_kit_starvation_ledger_rollback_write(&ledger, frame_ms);
      if (status != ITERATE_KIT_UNAVAILABLE) ++playback_driver_failures;
      portEXIT_CRITICAL(&codec_lock);
    } else if (playback_observed != NULL) {
      playback_observed(hardware_context, frame.samples, frame.sample_count, sound != NULL);
    }
  }
}

bool iterate_kit_i2s_codec_start_over(
    enum iterate_kit_status (*read)(void *, int16_t *, size_t),
    enum iterate_kit_status (*write)(void *, const int16_t *, size_t),
    void *context, uint16_t ring_ms, struct iterate_kit_audio_codec *out) {
  if (read == NULL || write == NULL || out == NULL || capture_mailbox != NULL) return false;
  hardware_read = read;
  hardware_write = write;
  hardware_context = context;
  portENTER_CRITICAL(&codec_lock);
  iterate_kit_starvation_ledger_init(&ledger, ring_ms);
  portEXIT_CRITICAL(&codec_lock);
  capture_mailbox = xQueueCreate(1U, sizeof(struct iterate_kit_i2s_codec_frame));
  playback_mailbox = xQueueCreate(1U, sizeof(struct iterate_kit_i2s_codec_frame));
  TaskHandle_t capture_task = NULL;
  if (capture_mailbox == NULL || playback_mailbox == NULL ||
      xTaskCreatePinnedToCore(capture_hardware_task, "audio-hw-capture", 4096U,
          NULL, 19U, &capture_task, 1) != pdPASS ||
      xTaskCreatePinnedToCore(playback_hardware_task, "audio-hw-playback", 4096U,
          NULL, 20U, NULL, 1) != pdPASS) {
    if (capture_task != NULL) vTaskDelete(capture_task);
    if (capture_mailbox != NULL) vQueueDelete(capture_mailbox);
    if (playback_mailbox != NULL) vQueueDelete(playback_mailbox);
    capture_mailbox = NULL;
    playback_mailbox = NULL;
    return false;
  }
  *out = (struct iterate_kit_audio_codec){&codec_ops, &codec_properties, NULL};
  return true;
}

size_t iterate_kit_i2s_codec_health(char *out, size_t capacity) {
  struct iterate_kit_starvation_ledger_metrics metrics;
  portENTER_CRITICAL(&codec_lock);
  iterate_kit_starvation_ledger_metrics(&ledger, &metrics);
  const struct iterate_kit_health_field fields[] = {
    {"codecCaptureOverruns", capture_overruns},
    {"codecCaptureFailures", capture_driver_failures},
    {"codecPlaybackFailures", playback_driver_failures},
    {"spkStarvedMs", metrics.starved_ms},
    {"spkStarveEvents", metrics.starve_events},
    {"speakerPlaying", iterate_kit_starvation_ledger_speaker_is_playing(
        &ledger, esp_timer_get_time(), 1500U) ? 1U : 0U},
  };
  portEXIT_CRITICAL(&codec_lock);
  return iterate_kit_health_append_fields(out, capacity, fields, sizeof(fields) / sizeof(fields[0]));
}
