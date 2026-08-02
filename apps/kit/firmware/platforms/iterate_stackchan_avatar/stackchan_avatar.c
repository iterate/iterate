#include "iterate/kit/platforms/stackchan_avatar.h"

#include "iterate/kit/avatar/face_animator.h"
#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/avatar/face_keyframe.h"
#include "iterate/kit/avatar/face_render.h"

#include "bsp/display.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include <limits.h>
#include <string.h>

/*
 * This platform component is a deliberately lossy sidecar to the speaker.
 * Its only source is PCM which the I2S driver reports as physically complete.
 * The one-slot handoff is the architectural guarantee: animation may become
 * less detailed under load, but it can neither build stale work nor turn a
 * pretty face into an audio deadline miss.
 */

#define STACKCHAN_AVATAR_SAMPLE_RATE_HZ 16000U
#define STACKCHAN_AVATAR_PLAYOUT_FRAME_SAMPLES 128U
/*
 * The first production-shaped Grok turn measured only 464 bytes of unused
 * stack while this task was rendering and submitting a real frame. That is a
 * valid measurement, not permission to run at the cliff: ESP-IDF display/SPI
 * internals can take a slightly deeper call path on an error or timeout. One
 * additional KiB restores roughly 1.5 KiB of expected headroom while the
 * direct-panel design still saves tens of KiB versus the rejected LVGL task
 * and buffers. Heap pressure is therefore not traded for latent stack
 * corruption, which would be especially hard to distinguish from a network
 * or audio dropout.
 */
#define STACKCHAN_AVATAR_ANALYZER_STACK_BYTES 4096U
#define STACKCHAN_AVATAR_ANALYZER_PRIORITY 2U
/*
 * ESP-IDF pins the Wi-Fi task to core 0 for this target. A first real-device
 * integration mistakenly put the renderer there too; otherwise healthy LAN
 * checks then showed intermittent 5-10% loss while the face was active. Put
 * visuals on core 1 instead, matching the proven prior StackChan renderer.
 * Core 1 is also where the audio I/O and AEC owners run, but their priorities
 * are 23 and 20 versus this task's 2. The scheduler therefore lets the face
 * consume only audio's spare cycles, while neither audio nor Wi-Fi waits for
 * software rendering. This affinity split is a deadline policy, not a tuning
 * preference; tests/source audits should keep it from drifting back.
 */
#define STACKCHAN_AVATAR_ANALYZER_CORE 1
#if CONFIG_FREERTOS_NUMBER_OF_CORES != 2
#error "StackChan avatar scheduling requires the reviewed dual-core policy"
#endif
#if !CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0
#error "Re-review avatar affinity when ESP-IDF Wi-Fi leaves core 0"
#endif
_Static_assert(
    STACKCHAN_AVATAR_ANALYZER_CORE == 1,
    "visual work must stay off the StackChan Wi-Fi core");
#define STACKCHAN_AVATAR_RENDER_INTERVAL_MS 66U
#define STACKCHAN_AVATAR_DISPLAY_TRANSFER_TIMEOUT_MS 50U
#define STACKCHAN_AVATAR_FRAMEBUFFER_CAPS \
  (MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_8BIT)
/*
 * ESP-IDF 5.4's ESP32-S3 SPI host explicitly cannot access external memory.
 * Keep this compile-time tripwire beside the allocation policy: adding PSRAM
 * either makes the requested heap capability set impossible or silently
 * restores the driver's per-transfer internal bounce allocation.
 */
_Static_assert(
    (STACKCHAN_AVATAR_FRAMEBUFFER_CAPS & MALLOC_CAP_SPIRAM) == 0U,
    "StackChan's SPI framebuffer must not request PSRAM");
#define STACKCHAN_AVATAR_DISPLAY_X \
  ((BSP_LCD_H_RES - FACE_RENDER_WIDTH) / 2U)
#define STACKCHAN_AVATAR_DISPLAY_Y \
  ((BSP_LCD_V_RES - FACE_RENDER_HEIGHT) / 2U)

static const char *const TAG = "iterate-stackchan-avatar";

struct stackchan_avatar_frame {
  uint32_t sequence;
  uint64_t completed_at_us;
  int16_t samples[STACKCHAN_AVATAR_PLAYOUT_FRAME_SAMPLES];
};

struct stackchan_avatar_atomic_metrics {
  volatile uint32_t playout_observations;
  volatile uint32_t malformed_observations;
  volatile uint32_t mailbox_overwrites;
  volatile uint32_t mailbox_failures;
  volatile uint32_t analyzer_frames;
  volatile uint32_t analyzer_sequence_gaps;
  volatile uint32_t mouth_open_rendered_frames;
  volatile uint32_t snapshot_races;
  volatile uint32_t rendered_frames;
  volatile uint32_t render_failures;
  volatile uint32_t display_transfers;
  volatile uint32_t display_transfer_failures;
  volatile uint32_t display_transfer_timeouts;
  volatile uint32_t last_handoff_delay_us;
  volatile uint32_t maximum_handoff_delay_us;
  volatile uint32_t last_analyzer_us;
  volatile uint32_t maximum_analyzer_us;
  volatile uint32_t last_render_us;
  volatile uint32_t maximum_render_us;
  volatile uint32_t last_display_transfer_us;
  volatile uint32_t maximum_display_transfer_us;
  volatile uint32_t physical_playout_sample_clock;
};

struct stackchan_avatar_owner {
  face_animator_t animator;
  face_animator_state_t latest_pose;
  face_avatar_registry_t registry;

  esp_lcd_panel_handle_t panel;
  esp_lcd_panel_io_handle_t panel_io;
  uint16_t *framebuffer;

  StaticSemaphore_t display_transfer_control;
  SemaphoreHandle_t display_transfer_complete;

  StaticQueue_t mailbox_control;
  uint8_t mailbox_storage[sizeof(struct stackchan_avatar_frame)];
  QueueHandle_t mailbox;
  struct stackchan_avatar_frame isr_staging;

  StaticTask_t analyzer_task_control;
  StackType_t analyzer_stack[STACKCHAN_AVATAR_ANALYZER_STACK_BYTES]
      __attribute__((aligned(16)));
  TaskHandle_t analyzer_task;

  struct stackchan_avatar_atomic_metrics metrics;
  volatile uint32_t started;
  volatile uint32_t ready;
  volatile uint32_t display_active;
};

/*
 * Every object touched by the I2S callback is forced into internal DRAM. The
 * framebuffer is also internal because ESP32-S3 SPI cannot DMA directly from
 * PSRAM; keeping it here prevents the driver from doing hidden bounce-buffer
 * allocations on every LCD transfer. The tradeoff is an explicit 38.4 KiB
 * startup cost which the resource proof must measure and gate.
 */
static DRAM_ATTR struct stackchan_avatar_owner owner
    __attribute__((aligned(16)));

static uint32_t saturating_elapsed_us(
    uint64_t finished_at_us, uint64_t started_at_us) {
  if (finished_at_us <= started_at_us) {
    return 0U;
  }
  const uint64_t elapsed = finished_at_us - started_at_us;
  return elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed;
}

static uint64_t now_us_wide(void) {
  const int64_t now = esp_timer_get_time();
  return now <= 0 ? 0U : (uint64_t)now;
}

static void atomic_saturating_increment(volatile uint32_t *value) {
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             current + 1U,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static void atomic_saturating_add(
    volatile uint32_t *value, uint32_t amount) {
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX) {
    const uint32_t next = amount > UINT32_MAX - current
        ? UINT32_MAX
        : current + amount;
    if (__atomic_compare_exchange_n(
            value,
            &current,
            next,
            false,
            __ATOMIC_RELAXED,
            __ATOMIC_RELAXED)) {
      return;
    }
  }
}

static void atomic_note_maximum(
    volatile uint32_t *maximum, uint32_t candidate) {
  uint32_t current = __atomic_load_n(maximum, __ATOMIC_RELAXED);
  while (candidate > current &&
         !__atomic_compare_exchange_n(
             maximum,
             &current,
             candidate,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

/*
 * There is exactly one I2S-ISR writer for these counters. A compare/exchange
 * loop would add an unbounded retry shape to the callback for no ownership
 * benefit; low-rate diagnostics performs atomic loads only.
 */
static void IRAM_ATTR isr_saturating_increment(
    volatile uint32_t *value) {
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

static bool IRAM_ATTR display_transfer_finished(
    esp_lcd_panel_io_handle_t panel_io,
    esp_lcd_panel_io_event_data_t *event_data,
    void *context) {
  (void)panel_io;
  (void)event_data;
  (void)context;
  BaseType_t higher_priority_task_woken = pdFALSE;
  xSemaphoreGiveFromISR(
      owner.display_transfer_complete, &higher_priority_task_woken);
  return higher_priority_task_woken == pdTRUE;
}

static bool draw_region_and_wait(
    uint32_t x,
    uint32_t y,
    uint32_t width,
    uint32_t height) {
  if (__atomic_load_n(&owner.display_active, __ATOMIC_ACQUIRE) == 0U) {
    return false;
  }

  /*
   * The SPI panel API deliberately returns after queueing DMA. Reusing the
   * only framebuffer before its completion callback would produce torn faces
   * and, under unlucky timing, let the renderer mutate memory while GDMA is
   * reading it. One buffer plus a bounded completion wait is cheaper and much
   * easier to reason about than a display FIFO. The low-priority visual task
   * is the only waiter, so this can never stall audio or a WebSocket owner.
   */
  (void)xSemaphoreTake(owner.display_transfer_complete, 0U);
  const uint64_t started_at_us = now_us_wide();
  const esp_err_t status = esp_lcd_panel_draw_bitmap(
      owner.panel,
      (int)x,
      (int)y,
      (int)(x + width),
      (int)(y + height),
      owner.framebuffer);
  if (status != ESP_OK) {
    atomic_saturating_increment(
        &owner.metrics.display_transfer_failures);
    __atomic_store_n(&owner.display_active, 0U, __ATOMIC_RELEASE);
    return false;
  }
  if (xSemaphoreTake(
          owner.display_transfer_complete,
          pdMS_TO_TICKS(STACKCHAN_AVATAR_DISPLAY_TRANSFER_TIMEOUT_MS)) !=
      pdPASS) {
    /*
     * After a timeout the DMA ownership of the buffer is unknowable. Never
     * reuse it and never retry into a possible in-flight transfer. Disabling
     * the visual sidecar is the bounded failure policy; audio remains live and
     * diagnostics retain the exact incident.
     */
    atomic_saturating_increment(
        &owner.metrics.display_transfer_timeouts);
    __atomic_store_n(&owner.display_active, 0U, __ATOMIC_RELEASE);
    return false;
  }

  const uint32_t transfer_us = saturating_elapsed_us(
      now_us_wide(), started_at_us);
  atomic_saturating_increment(&owner.metrics.display_transfers);
  __atomic_store_n(
      &owner.metrics.last_display_transfer_us,
      transfer_us,
      __ATOMIC_RELAXED);
  atomic_note_maximum(
      &owner.metrics.maximum_display_transfer_us, transfer_us);
  return true;
}

static void swap_rgb565_bytes_for_panel(void) {
  /*
   * The portable renderer emits ordinary host-order RGB565 so its exact pixel
   * hashes agree on ESP, WASM, and host tests. CoreS3's ILI9341 wire contract
   * is big-endian. Keeping this byte swap at the hardware boundary prevents a
   * panel quirk from infecting the reusable avatar core. The framebuffer is
   * wholly regenerated before each call, so an in-place transform needs no
   * second 38.4 KiB allocation.
   */
  for (size_t index = 0U; index < FACE_RENDER_PIXEL_COUNT; ++index) {
    const uint16_t pixel = owner.framebuffer[index];
    owner.framebuffer[index] =
        (uint16_t)((pixel << 8U) | (pixel >> 8U));
  }
}

static bool render_avatar(void) {
  const uint64_t started_at_us = now_us_wide();

  /*
   * Analysis and rendering now share one low-priority task, so snapshotting
   * cannot race. Retain the bounded API anyway: it proves that any future
   * second writer fails one frame closed instead of spinning on core 0.
   */
  face_animator_state_t candidate = owner.latest_pose;
  if (face_animator_snapshot(&owner.animator, &candidate)) {
    owner.latest_pose = candidate;
  } else {
    atomic_saturating_increment(&owner.metrics.snapshot_races);
  }

  /*
   * The performance clock follows every physical DMA descriptor, including
   * observations deliberately skipped by the analyzer. This prevents idle
   * motion from slowing down under display/network load and makes animation
   * independent of WebSocket packet boundaries.
   */
  owner.latest_pose.playout_samples = __atomic_load_n(
      &owner.metrics.physical_playout_sample_clock, __ATOMIC_RELAXED);
  face_render_key_t render_key;
  face_render_key_from_pose(&owner.latest_pose, &render_key);
  if (!face_avatar_registry_render(
          &owner.registry,
          &render_key,
          owner.latest_pose.playout_samples,
          owner.framebuffer,
          FACE_RENDER_PIXEL_COUNT)) {
    atomic_saturating_increment(&owner.metrics.render_failures);
    return false;
  }
  swap_rgb565_bytes_for_panel();

  const uint32_t render_us = saturating_elapsed_us(
      now_us_wide(), started_at_us);
  __atomic_store_n(
      &owner.metrics.last_render_us, render_us, __ATOMIC_RELAXED);
  atomic_note_maximum(&owner.metrics.maximum_render_us, render_us);
  if (!draw_region_and_wait(
          STACKCHAN_AVATAR_DISPLAY_X,
          STACKCHAN_AVATAR_DISPLAY_Y,
          FACE_RENDER_WIDTH,
          FACE_RENDER_HEIGHT)) {
    atomic_saturating_increment(&owner.metrics.render_failures);
    return false;
  }
  if (render_key.controls.mouth_open != 0U) {
    /*
     * Count only a mouth-open frame whose LCD transfer completed. Analyzer
     * state alone cannot prove the talking pose reached the panel, while a
     * pre-transfer increment would turn a timed-out DMA into false evidence.
     */
    atomic_saturating_increment(
        &owner.metrics.mouth_open_rendered_frames);
  }
  atomic_saturating_increment(&owner.metrics.rendered_frames);
  return true;
}

static void analyze_frame(
    const struct stackchan_avatar_frame *frame,
    uint32_t *previous_sequence) {
  const uint64_t started_at_us = now_us_wide();
  if (*previous_sequence != 0U) {
    const uint32_t distance = frame->sequence - *previous_sequence;
    if (distance > 1U) {
      /*
       * Sequence arithmetic intentionally wraps. Skipped observations are
       * counted, never replayed: replaying them would make the mouth tell an
       * old story after the speaker has already moved on.
       */
      atomic_saturating_add(
          &owner.metrics.analyzer_sequence_gaps, distance - 1U);
    }
  }
  *previous_sequence = frame->sequence;
  face_animator_push_pcm(
      &owner.animator,
      frame->samples,
      STACKCHAN_AVATAR_PLAYOUT_FRAME_SAMPLES);
  atomic_saturating_increment(&owner.metrics.analyzer_frames);

  const uint64_t finished_at_us = now_us_wide();
  const uint32_t handoff_delay_us = saturating_elapsed_us(
      started_at_us, frame->completed_at_us);
  const uint32_t analyzer_us = saturating_elapsed_us(
      finished_at_us, started_at_us);
  __atomic_store_n(
      &owner.metrics.last_handoff_delay_us,
      handoff_delay_us,
      __ATOMIC_RELAXED);
  atomic_note_maximum(
      &owner.metrics.maximum_handoff_delay_us, handoff_delay_us);
  __atomic_store_n(
      &owner.metrics.last_analyzer_us, analyzer_us, __ATOMIC_RELAXED);
  atomic_note_maximum(&owner.metrics.maximum_analyzer_us, analyzer_us);
}

static void analyzer_task_main(void *context) {
  (void)context;
  struct stackchan_avatar_frame frame;
  uint32_t previous_sequence = 0U;
  uint64_t next_render_at_us =
      now_us_wide() + STACKCHAN_AVATAR_RENDER_INTERVAL_MS * 1000U;

  for (;;) {
    const uint64_t before_wait_us = now_us_wide();
    uint64_t remaining_us = next_render_at_us > before_wait_us
        ? next_render_at_us - before_wait_us
        : 0U;
    uint64_t wait_ms = (remaining_us + 999U) / 1000U;
    if (wait_ms > STACKCHAN_AVATAR_RENDER_INTERVAL_MS) {
      wait_ms = STACKCHAN_AVATAR_RENDER_INTERVAL_MS;
    }

    const BaseType_t received = xQueueReceive(
        owner.mailbox, &frame, pdMS_TO_TICKS((uint32_t)wait_ms));
    if (received == pdPASS) {
      analyze_frame(&frame, &previous_sequence);
    }

    const uint64_t now_us = now_us_wide();
    if (now_us >= next_render_at_us) {
      if (!render_avatar()) {
        /*
         * Rendering has no recovery path that is safer than audio. Once the
         * panel/buffer contract fails, suspend this sidecar instead of burning
         * CPU in a retry loop or retaining stale PCM observations forever.
         */
        vTaskSuspend(NULL);
      }
      /*
       * Never catch up missed visual ticks. A current face after a busy
       * interval is useful; replaying old frames is the same accumulating
       * delay bug the audio architecture is designed to prevent.
       */
      next_render_at_us =
          now_us_wide() + STACKCHAN_AVATAR_RENDER_INTERVAL_MS * 1000U;
    }
  }
}

esp_err_t iterate_kit_stackchan_avatar_start(void) {
  uint32_t expected = 0U;
  if (!__atomic_compare_exchange_n(
          &owner.started,
          &expected,
          1U,
          false,
          __ATOMIC_ACQ_REL,
          __ATOMIC_ACQUIRE)) {
    return ESP_ERR_INVALID_STATE;
  }

  if (!face_animator_init_with_config(
          &owner.animator,
          STACKCHAN_AVATAR_SAMPLE_RATE_HZ,
          &FACE_ENVELOPE_DEFAULT_CONFIG) ||
      !face_animator_snapshot(&owner.animator, &owner.latest_pose) ||
      !face_avatar_registry_init(&owner.registry)) {
    return ESP_ERR_INVALID_STATE;
  }

  owner.mailbox = xQueueCreateStatic(
      1U,
      sizeof(struct stackchan_avatar_frame),
      owner.mailbox_storage,
      &owner.mailbox_control);
  if (owner.mailbox == NULL) {
    return ESP_ERR_NO_MEM;
  }

  /*
   * This target needs a talking head, not a general widget toolkit. LVGL's
   * generic CoreS3 startup consumed a task, a touch driver, approximately
   * 12.8 KiB even after tuning its DMA strip, and enough linked code/state to
   * leave only 3.6 KiB of minimum internal heap during a real Grok turn. The
   * direct panel path has one explicit DMA buffer and no display queue above
   * ESP-IDF's own DMA transaction. It renders at native 160x120 in the centre
   * rather than spending four times the memory bandwidth on cosmetic 2x
   * scaling. Audio deadlines, not screen coverage, set this policy.
   *
   * ESP32-S3 PSRAM is not SPI-DMA-capable in ESP-IDF 5.4. Asking the heap for
   * SPIRAM|DMA therefore returns NULL, while asking only for SPIRAM makes the
   * SPI driver allocate and copy through an internal bounce buffer on every
   * transfer. The internal allocation below is deliberately permanent: it
   * makes startup fail honestly if the memory budget is unavailable and keeps
   * steady-state rendering allocation-free. It also removes PSRAM/cache
   * contention from the display transfer that runs beside the AEC owner.
   */
  owner.display_transfer_complete = xSemaphoreCreateBinaryStatic(
      &owner.display_transfer_control);
  if (owner.display_transfer_complete == NULL) {
    return ESP_ERR_NO_MEM;
  }
  owner.framebuffer = heap_caps_aligned_alloc(
      64U,
      FACE_RENDER_FRAME_BYTES,
      STACKCHAN_AVATAR_FRAMEBUFFER_CAPS);
  if (owner.framebuffer == NULL) {
    return ESP_ERR_NO_MEM;
  }

  const bsp_display_config_t display_configuration = {
      .max_transfer_sz = FACE_RENDER_FRAME_BYTES,
  };
  esp_err_t status = bsp_display_brightness_init();
  if (status == ESP_OK) {
    status = bsp_display_new(
        &display_configuration, &owner.panel, &owner.panel_io);
  }
  if (status == ESP_OK) {
    const esp_lcd_panel_io_callbacks_t callbacks = {
        .on_color_trans_done = display_transfer_finished,
    };
    status = esp_lcd_panel_io_register_event_callbacks(
        owner.panel_io, &callbacks, NULL);
  }
  if (status == ESP_OK) {
    status = esp_lcd_panel_disp_on_off(owner.panel, true);
  }
  if (status == ESP_OK) {
    status = bsp_display_backlight_on();
  }
  if (status != ESP_OK) {
    return status;
  }
  __atomic_store_n(&owner.display_active, 1U, __ATOMIC_RELEASE);

  /*
   * The controller does not promise cleared GRAM after reset. Reuse the one
   * all-zero avatar-sized surface across four non-overlapping quadrants so
   * startup leaves deterministic black borders without allocating a full
   * 320x240 buffer. Each transfer is completed before the surface is reused.
   */
  memset(owner.framebuffer, 0, FACE_RENDER_FRAME_BYTES);
  for (uint32_t y = 0U; y < BSP_LCD_V_RES;
       y += FACE_RENDER_HEIGHT) {
    for (uint32_t x = 0U; x < BSP_LCD_H_RES;
         x += FACE_RENDER_WIDTH) {
      if (!draw_region_and_wait(
              x, y, FACE_RENDER_WIDTH, FACE_RENDER_HEIGHT)) {
        return ESP_ERR_TIMEOUT;
      }
    }
  }
  if (!render_avatar()) {
    return ESP_FAIL;
  }

  owner.analyzer_task = xTaskCreateStaticPinnedToCore(
      analyzer_task_main,
      "stackchan-avatar",
      sizeof(owner.analyzer_stack),
      NULL,
      STACKCHAN_AVATAR_ANALYZER_PRIORITY,
      owner.analyzer_stack,
      &owner.analyzer_task_control,
      STACKCHAN_AVATAR_ANALYZER_CORE);
  if (owner.analyzer_task == NULL) {
    return ESP_ERR_NO_MEM;
  }

  __atomic_store_n(&owner.ready, 1U, __ATOMIC_RELEASE);
  ESP_LOGI(
      TAG,
      "ready: avatar=%s count=%u framebuffer=%u bytes internal DMA; "
      "display=direct 160x120@15Hz centered; "
      "handoff=latest-only 1x128 samples; visual=core1 priority2",
      face_avatar_registry_current_slug(&owner.registry),
      (unsigned)face_avatar_registry_count(),
      (unsigned)FACE_RENDER_FRAME_BYTES);
  return ESP_OK;
}

bool IRAM_ATTR iterate_kit_stackchan_avatar_observe_playout(
    uint32_t sequence,
    uint64_t completed_at_us,
    const int16_t *samples,
    size_t sample_count,
    void *context) {
  (void)context;
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U ||
      owner.mailbox == NULL || samples == NULL ||
      sample_count != STACKCHAN_AVATAR_PLAYOUT_FRAME_SAMPLES) {
    isr_saturating_increment(&owner.metrics.malformed_observations);
    return false;
  }

  owner.isr_staging.sequence = sequence;
  owner.isr_staging.completed_at_us = completed_at_us;
  for (size_t index = 0U; index < sample_count; ++index) {
    owner.isr_staging.samples[index] = samples[index];
  }

  if (uxQueueMessagesWaitingFromISR(owner.mailbox) != 0U) {
    isr_saturating_increment(&owner.metrics.mailbox_overwrites);
  }
  BaseType_t higher_priority_task_woken = pdFALSE;
  if (xQueueOverwriteFromISR(
          owner.mailbox,
          &owner.isr_staging,
          &higher_priority_task_woken) != pdPASS) {
    isr_saturating_increment(&owner.metrics.mailbox_failures);
    return false;
  }

  isr_saturating_increment(&owner.metrics.playout_observations);
  __atomic_store_n(
      &owner.metrics.physical_playout_sample_clock,
      sequence * STACKCHAN_AVATAR_PLAYOUT_FRAME_SAMPLES,
      __ATOMIC_RELAXED);
  return higher_priority_task_woken == pdTRUE;
}

void iterate_kit_stackchan_avatar_metrics_snapshot(
    struct iterate_kit_stackchan_avatar_metrics *snapshot) {
  if (snapshot == NULL) {
    return;
  }
  memset(snapshot, 0, sizeof(*snapshot));
  snapshot->ready = __atomic_load_n(
      &owner.ready, __ATOMIC_ACQUIRE) != 0U;
  snapshot->static_bytes = sizeof(owner);
  snapshot->framebuffer_bytes = owner.framebuffer == NULL
      ? 0U
      : FACE_RENDER_FRAME_BYTES;

#define COPY_ATOMIC_METRIC(name) \
  snapshot->name = __atomic_load_n( \
      &owner.metrics.name, __ATOMIC_RELAXED)
  COPY_ATOMIC_METRIC(playout_observations);
  COPY_ATOMIC_METRIC(malformed_observations);
  COPY_ATOMIC_METRIC(mailbox_overwrites);
  COPY_ATOMIC_METRIC(mailbox_failures);
  COPY_ATOMIC_METRIC(analyzer_frames);
  COPY_ATOMIC_METRIC(analyzer_sequence_gaps);
  COPY_ATOMIC_METRIC(mouth_open_rendered_frames);
  COPY_ATOMIC_METRIC(snapshot_races);
  COPY_ATOMIC_METRIC(rendered_frames);
  COPY_ATOMIC_METRIC(render_failures);
  COPY_ATOMIC_METRIC(display_transfers);
  COPY_ATOMIC_METRIC(display_transfer_failures);
  COPY_ATOMIC_METRIC(display_transfer_timeouts);
  COPY_ATOMIC_METRIC(last_handoff_delay_us);
  COPY_ATOMIC_METRIC(maximum_handoff_delay_us);
  COPY_ATOMIC_METRIC(last_analyzer_us);
  COPY_ATOMIC_METRIC(maximum_analyzer_us);
  COPY_ATOMIC_METRIC(last_render_us);
  COPY_ATOMIC_METRIC(maximum_render_us);
  COPY_ATOMIC_METRIC(last_display_transfer_us);
  COPY_ATOMIC_METRIC(maximum_display_transfer_us);
  COPY_ATOMIC_METRIC(physical_playout_sample_clock);
#undef COPY_ATOMIC_METRIC

  snapshot->analyzer_stack_minimum_free_bytes =
      owner.analyzer_task == NULL
      ? 0U
      : (uint32_t)uxTaskGetStackHighWaterMark(owner.analyzer_task) *
          sizeof(StackType_t);
  const size_t avatar_index =
      face_avatar_registry_current_index(&owner.registry);
  snapshot->current_avatar_index = avatar_index > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)avatar_index;
}
