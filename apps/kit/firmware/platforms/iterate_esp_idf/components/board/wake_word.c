#include "iterate/kit/platforms/wake_word.h"
#include <string.h>

bool iterate_kit_wake_word_buffer_feed(
    struct iterate_kit_wake_word_buffer *buffer,
    const int16_t *samples, size_t count,
    bool (*consume)(void *context, int16_t *samples), void *context) {
  if (buffer == NULL || buffer->samples == NULL || buffer->capacity == 0U ||
      buffer->capacity > SIZE_MAX / sizeof(int16_t) ||
      buffer->used >= buffer->capacity || consume == NULL ||
      (count != 0U && samples == NULL)) return false;
  while (count != 0U) {
    const size_t room = buffer->capacity - buffer->used;
    const size_t take = count < room ? count : room;
    memcpy(buffer->samples + buffer->used, samples, take * sizeof(*samples));
    buffer->used += take;
    samples += take;
    count -= take;
    if (buffer->used == buffer->capacity) {
      buffer->used = 0U;
      if (!consume(context, buffer->samples)) break;
    }
  }
  return true;
}

#ifdef CONFIG_ITERATE_KIT_WAKE_WORD
#if !defined(CONFIG_MODEL_IN_FLASH) || !defined(CONFIG_SR_WN_WN9_JARVIS_TTS)
#error "board_wake_word requires flash model storage and CONFIG_SR_WN_WN9_JARVIS_TTS"
#endif
#include <stdatomic.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wn_models.h"
#include "model_path.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/platforms/i2s_codec.h"

/** A bounded capture copy with the history generation it belongs to. */
struct iterate_kit_wake_word_frame {
  int16_t samples[320];
  size_t count;
  uint32_t generation;
  int64_t captured_us;
};

static const char iterate_kit_wake_word_tag[] = "wake_word";
static QueueHandle_t iterate_kit_wake_word_queue;
static const esp_wn_iface_t *iterate_kit_wake_word_iface;
static model_iface_data_t *iterate_kit_wake_word_model;
static srmodel_list_t *iterate_kit_wake_word_models;
static struct iterate_kit_wake_word_buffer iterate_kit_wake_word_buffer;
static atomic_bool iterate_kit_wake_word_enabled_flag;
static portMUX_TYPE iterate_kit_wake_word_lock = portMUX_INITIALIZER_UNLOCKED;
/* The lock owns cross-task history/counters; only the worker touches WakeNet. */
static uint32_t iterate_kit_wake_word_generation;
static bool iterate_kit_wake_word_pending;
static uint32_t iterate_kit_wake_word_detections;
static uint32_t iterate_kit_wake_word_frames;
static uint32_t iterate_kit_wake_word_max_us;
static uint32_t iterate_kit_wake_word_overruns;

/** Local chimes are not included in the codec's answer-only speaker window.
 * Hold for 100 ms after the last local slice, covering the 60 ms TX ring.
 * The lock owns the hold timestamp shared by capture, worker and app tasks.
 */
static bool iterate_kit_wake_word_speaker_playing(void) {
  const bool sound = iterate_kit_i2s_codec_sound_active();
  const int64_t now = esp_timer_get_time();
  static int64_t sound_until_us;
  portENTER_CRITICAL(&iterate_kit_wake_word_lock);
  if (sound) sound_until_us = now + 100000;
  const bool holding = now < sound_until_us;
  portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
  return holding || iterate_kit_i2s_codec_speaker_is_playing();
}

bool iterate_kit_wake_word_enabled(void) {
  return atomic_load_explicit(&iterate_kit_wake_word_enabled_flag, memory_order_acquire);
}

void iterate_kit_wake_word_set_enabled(bool enabled) {
  if (iterate_kit_wake_word_queue == NULL) return;
  portENTER_CRITICAL(&iterate_kit_wake_word_lock);
  if (iterate_kit_wake_word_enabled() != enabled) {
    ++iterate_kit_wake_word_generation;
    iterate_kit_wake_word_pending = false;
    atomic_store_explicit(&iterate_kit_wake_word_enabled_flag, enabled, memory_order_release);
  }
  portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
}

void iterate_kit_wake_word_feed(const int16_t *samples, size_t count) {
  const bool playing = iterate_kit_wake_word_speaker_playing();
  struct iterate_kit_wake_word_frame frame;
  portENTER_CRITICAL(&iterate_kit_wake_word_lock);
  if (playing || samples == NULL || count == 0U || count > 320U) {
    ++iterate_kit_wake_word_generation;
    iterate_kit_wake_word_pending = false;
    portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
    return;
  }
  frame.generation = iterate_kit_wake_word_generation;
  const bool enabled = iterate_kit_wake_word_enabled();
  portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
  if (!enabled) return;
  memcpy(frame.samples, samples, count * sizeof(*samples));
  frame.count = count;
  frame.captured_us = esp_timer_get_time();
  if (xQueueSend(iterate_kit_wake_word_queue, &frame, 0) != pdTRUE) {
    portENTER_CRITICAL(&iterate_kit_wake_word_lock);
    ++iterate_kit_wake_word_overruns;
    ++iterate_kit_wake_word_generation;
    iterate_kit_wake_word_pending = false;
    portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
  }
}

/** Check the generation before AND after inference; a concurrent call start
 * or speaker edge must never publish a tap from obsolete model history.
 */
static bool iterate_kit_wake_word_detect(void *context, int16_t *samples) {
  const uint32_t generation = *(const uint32_t *)context;
  const bool playing = iterate_kit_wake_word_speaker_playing();
  portENTER_CRITICAL(&iterate_kit_wake_word_lock);
  const bool allowed = !playing && iterate_kit_wake_word_enabled() &&
      generation == iterate_kit_wake_word_generation && !iterate_kit_wake_word_pending;
  portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
  if (!allowed) return false;
  const int64_t started = esp_timer_get_time();
  const wakenet_state_t detected = iterate_kit_wake_word_iface->detect(iterate_kit_wake_word_model, samples);
  const uint32_t elapsed = (uint32_t)(esp_timer_get_time() - started);
  const bool speaker = iterate_kit_wake_word_speaker_playing();
  portENTER_CRITICAL(&iterate_kit_wake_word_lock);
  ++iterate_kit_wake_word_frames;
  if (elapsed > iterate_kit_wake_word_max_us) iterate_kit_wake_word_max_us = elapsed;
  const bool current = !speaker && iterate_kit_wake_word_enabled() &&
      generation == iterate_kit_wake_word_generation;
  if (current && detected > 0) iterate_kit_wake_word_pending = true;
  portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
  return current && detected <= 0;
}

/** Own model history off priority-19 capture. Queue gaps and pause transitions
 * clean both WakeNet state and the partial chunk before accepting new PCM.
 */
static void iterate_kit_wake_word_task(void *context) {
  (void)context;
  uint32_t previous_generation = UINT32_MAX;
  struct iterate_kit_wake_word_frame frame;
  for (;;) {
    if (xQueueReceive(iterate_kit_wake_word_queue, &frame, portMAX_DELAY) != pdTRUE) continue;
    portENTER_CRITICAL(&iterate_kit_wake_word_lock);
    const uint32_t generation = iterate_kit_wake_word_generation;
    portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
    if (generation != previous_generation) {
      iterate_kit_wake_word_buffer.used = 0U;
      iterate_kit_wake_word_iface->clean(iterate_kit_wake_word_model);
      previous_generation = generation;
    }
    if (frame.generation != generation || !iterate_kit_wake_word_enabled()) continue;
    if (esp_timer_get_time() - frame.captured_us > 80000) {
      portENTER_CRITICAL(&iterate_kit_wake_word_lock);
      ++iterate_kit_wake_word_overruns;
      ++iterate_kit_wake_word_generation;
      iterate_kit_wake_word_pending = false;
      portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
      continue;
    }
    (void)iterate_kit_wake_word_buffer_feed(&iterate_kit_wake_word_buffer,
        frame.samples, frame.count, iterate_kit_wake_word_detect, &frame.generation);
  }
}

bool iterate_kit_wake_word_start(const char *wake_word) {
  if (wake_word == NULL || strcmp(wake_word, "jarvis") != 0 ||
      iterate_kit_wake_word_queue != NULL) return false;
  const char *name = "wn9_jarvis_tts";
  iterate_kit_wake_word_models = esp_srmodel_init("model");
  if (iterate_kit_wake_word_models == NULL) goto failed;
  bool found = false;
  for (int i = 0; i < iterate_kit_wake_word_models->num; ++i) {
    if (strcmp(iterate_kit_wake_word_models->model_name[i], name) == 0) found = true;
  }
  if (!found) goto failed;
  iterate_kit_wake_word_iface = esp_wn_handle_from_name(name);
  if (iterate_kit_wake_word_iface == NULL) goto failed;
  iterate_kit_wake_word_model = iterate_kit_wake_word_iface->create(name, DET_MODE_90);
  if (iterate_kit_wake_word_model == NULL) goto failed;
  const int chunk = iterate_kit_wake_word_iface->get_samp_chunksize(iterate_kit_wake_word_model);
  if (chunk <= 0 || chunk > 16000 ||
      iterate_kit_wake_word_iface->get_samp_rate(iterate_kit_wake_word_model) != 16000 ||
      iterate_kit_wake_word_iface->get_channel_num(iterate_kit_wake_word_model) != 1) goto failed;
  iterate_kit_wake_word_buffer.capacity = (size_t)chunk;
  iterate_kit_wake_word_buffer.samples = calloc((size_t)chunk, sizeof(int16_t));
  if (iterate_kit_wake_word_buffer.samples == NULL) goto failed;
  iterate_kit_wake_word_queue = xQueueCreate(3U, sizeof(struct iterate_kit_wake_word_frame));
  if (iterate_kit_wake_word_queue == NULL ||
      xTaskCreatePinnedToCore(iterate_kit_wake_word_task, "wake_word", 8192U,
          NULL, 5U, NULL, 1) != pdPASS) goto failed;
  ESP_LOGI(iterate_kit_wake_word_tag,
      "%s: chunk=%d (%d us), priority=5 core=1; measure wakeWordMaxUs/wakeWordOverruns",
      name, chunk, chunk * 1000 / 16);
  return true;
failed:
  ESP_LOGE(iterate_kit_wake_word_tag, "Jarvis initialization failed: check model partition and heap");
  if (iterate_kit_wake_word_queue != NULL) vQueueDelete(iterate_kit_wake_word_queue);
  iterate_kit_wake_word_queue = NULL;
  free(iterate_kit_wake_word_buffer.samples);
  iterate_kit_wake_word_buffer = (struct iterate_kit_wake_word_buffer){0};
  if (iterate_kit_wake_word_model != NULL) iterate_kit_wake_word_iface->destroy(iterate_kit_wake_word_model);
  iterate_kit_wake_word_model = NULL;
  if (iterate_kit_wake_word_models != NULL) esp_srmodel_deinit(iterate_kit_wake_word_models);
  iterate_kit_wake_word_models = NULL;
  return false;
}

bool iterate_kit_wake_word_take_detection(void) {
  const bool playing = iterate_kit_wake_word_speaker_playing();
  portENTER_CRITICAL(&iterate_kit_wake_word_lock);
  const bool detected = iterate_kit_wake_word_pending && !playing && iterate_kit_wake_word_enabled();
  iterate_kit_wake_word_pending = false;
  if (detected) {
    ++iterate_kit_wake_word_detections;
    ++iterate_kit_wake_word_generation;
  }
  portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
  return detected;
}

size_t iterate_kit_wake_word_health(char *out, size_t capacity) {
  portENTER_CRITICAL(&iterate_kit_wake_word_lock);
  const struct iterate_kit_health_field fields[] = {
    {"wakeWordDetections", iterate_kit_wake_word_detections},
    {"wakeWordFrames", iterate_kit_wake_word_frames},
    {"wakeWordModel", iterate_kit_wake_word_model != NULL ? 1U : 0U},
    {"wakeWordChunkSamples", iterate_kit_wake_word_buffer.capacity},
    {"wakeWordMaxUs", iterate_kit_wake_word_max_us},
    {"wakeWordOverruns", iterate_kit_wake_word_overruns},
  };
  portEXIT_CRITICAL(&iterate_kit_wake_word_lock);
  return iterate_kit_health_append_fields(out, capacity, fields, sizeof(fields) / sizeof(fields[0]));
}
#endif
