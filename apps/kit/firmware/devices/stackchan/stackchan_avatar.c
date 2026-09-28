#include "iterate/kit/atomic.h"
#include "stackchan_avatar.h"

#include "iterate/kit/avatar/face_animator.h"
#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/avatar/face_doze.h"
#include "iterate/kit/avatar/face_keyframe.h"
#include "iterate/kit/avatar/face_render.h"
#include "iterate/kit/avatar/face_scale.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/face_wake.h"
#include "iterate/kit/platforms/lcd_transfer.h"
#include "iterate/kit/touch_tap.h"

#include "bsp/m5stack_core_s3.h"
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
 * The first production-shaped voice turn measured only 464 bytes of unused
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
#define STACKCHAN_INPUT_STACK_BYTES 3072U
#define STACKCHAN_INPUT_PRIORITY 3U
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
#define STACKCHAN_INPUT_CORE 1
#if CONFIG_FREERTOS_NUMBER_OF_CORES != 2
#error "StackChan avatar scheduling requires the reviewed dual-core policy"
#endif
#if !CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0
#error "Re-review avatar affinity when ESP-IDF Wi-Fi leaves core 0"
#endif
_Static_assert(
    STACKCHAN_AVATAR_ANALYZER_CORE == 1,
    "visual work must stay off the StackChan Wi-Fi core");
_Static_assert(
    STACKCHAN_INPUT_CORE == STACKCHAN_AVATAR_ANALYZER_CORE &&
        STACKCHAN_INPUT_PRIORITY > STACKCHAN_AVATAR_ANALYZER_PRIORITY,
    "human input must preempt display work without moving onto Wi-Fi core");
#define STACKCHAN_AVATAR_RENDER_INTERVAL_MS 66U
#define STACKCHAN_INPUT_SAMPLE_INTERVAL_MS 20U
#define STACKCHAN_SPEAKER_STATUS_HANGOVER_US 180000U
#define STACKCHAN_AVATAR_DISPLAY_TRANSFER_TIMEOUT_MS 50U
#define STACKCHAN_AVATAR_FRAMEBUFFER_CAPS \
  (MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_8BIT)
/*
 * ESP-IDF's ESP32-S3 SPI host sends from external memory through an internal
 * bounce buffer per transfer (esp_lcd's psram_dma_direct, which this panel
 * does not ask for, is the exception). Keep this compile-time tripwire beside
 * the allocation policy: adding PSRAM either makes the requested heap
 * capability set impossible or silently restores that bounce allocation.
 */
_Static_assert(
    (STACKCHAN_AVATAR_FRAMEBUFFER_CAPS & MALLOC_CAP_SPIRAM) == 0U,
    "StackChan's SPI framebuffer must not request PSRAM");
/*
 * THE SOURCE SURFACE IS NOT A DMA BUFFER, AND KEEPING IT IN DMA MEMORY NEARLY
 * COST THIS BOARD ITS NETWORK.
 *
 * Only `scaled_strip` is ever handed to the SPI driver. The 38.4 KiB source
 * frame is touched exclusively by the CPU — rendered into, byte-swapped,
 * read by the scaler — so it has no business in the
 * one pool TLS, Wi-Fi and DMA all compete for. It sat there anyway, and the
 * measurement that finally said so was internalFree: 4,603 bytes with a
 * largest free block of 3,328, at which point mbedtls could not allocate an
 * AES context and the socket died mid-conversation ("esp-aes: Failed to
 * allocate memory"). heapFree read 5.8 MB throughout, because that is PSRAM.
 *
 * PSRAM costs this surface some read/write bandwidth, which the existing
 * maximum_render_us instrument measures at 15 Hz on a low-priority core-1
 * task. That is the right trade against a dropped call.
 */
#define STACKCHAN_AVATAR_SOURCE_CAPS (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define STACKCHAN_AVATAR_SCALE 2U
/*
 * Eight source rows make one 320x16 physical DMA strip. A naive full-screen
 * framebuffer would consume 153.6 KiB of scarce internal DMA memory; a single
 * row would instead require 120 SPI transactions per visual frame. This
 * 10 KiB strip keeps the exact 2x result while bounding memory and reducing
 * the transfer count to fifteen per frame. Audio remains higher priority and
 * the visual owner never queues a second strip.
 */
#define STACKCHAN_AVATAR_SCALE_SOURCE_ROWS_PER_TRANSFER 8U
#define STACKCHAN_AVATAR_SCALED_WIDTH \
  (FACE_RENDER_WIDTH * STACKCHAN_AVATAR_SCALE)
#define STACKCHAN_AVATAR_SCALED_HEIGHT \
  (FACE_RENDER_HEIGHT * STACKCHAN_AVATAR_SCALE)
#define STACKCHAN_AVATAR_SCALE_STRIP_HEIGHT \
  (STACKCHAN_AVATAR_SCALE_SOURCE_ROWS_PER_TRANSFER * \
   STACKCHAN_AVATAR_SCALE)
#define STACKCHAN_AVATAR_SCALE_STRIP_PIXEL_COUNT \
  (STACKCHAN_AVATAR_SCALED_WIDTH * STACKCHAN_AVATAR_SCALE_STRIP_HEIGHT)
#define STACKCHAN_AVATAR_SCALE_STRIP_BYTES \
  (STACKCHAN_AVATAR_SCALE_STRIP_PIXEL_COUNT * sizeof(uint16_t))
_Static_assert(
    BSP_LCD_H_RES == STACKCHAN_AVATAR_SCALED_WIDTH &&
        BSP_LCD_V_RES == STACKCHAN_AVATAR_SCALED_HEIGHT,
    "StackChan exact 2x output must cover the complete physical LCD");
_Static_assert(
    STACKCHAN_AVATAR_SCALED_HEIGHT % STACKCHAN_AVATAR_SCALE_STRIP_HEIGHT == 0U,
    "a lent image is painted in whole strips");
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
  volatile uint32_t current_avatar_index;
  volatile uint32_t status_updates;
  volatile uint32_t status_overwrites;
  volatile uint32_t touch_samples;
  volatile uint32_t touch_read_failures;
  volatile uint32_t touch_taps;
  volatile uint32_t face_button_samples;
  volatile uint32_t face_button_read_failures;
  volatile uint32_t face_button_boot_events_discarded;
  volatile uint32_t face_button_short_clicks;
  volatile uint32_t face_button_long_or_ambiguous_events;
  volatile uint32_t last_input_sample_interval_us;
  volatile uint32_t maximum_input_sample_interval_us;
};

struct stackchan_avatar_owner {
  face_animator_t animator;
  face_pose_t latest_pose;
  face_avatar_registry_t registry;

  esp_lcd_panel_handle_t panel;
  esp_lcd_panel_io_handle_t panel_io;
  esp_lcd_touch_handle_t touch;
  struct iterate_kit_touch_tap touch_tap;
  uint16_t *framebuffer;
  uint16_t *scaled_strip;

  StaticSemaphore_t display_transfer_control;
  struct iterate_kit_lcd_transfer display_transfer;

  StaticQueue_t mailbox_control;
  uint8_t mailbox_storage[sizeof(struct stackchan_avatar_frame)];
  QueueHandle_t mailbox;
  struct stackchan_avatar_frame isr_staging;

  StaticQueue_t status_mailbox_control;
  uint8_t status_mailbox_storage[
      sizeof(struct iterate_kit_conversation_visual_state)];
  QueueHandle_t status_mailbox;
  struct iterate_kit_conversation_visual_state latest_status;

  StaticTask_t analyzer_task_control;
  StackType_t analyzer_stack[STACKCHAN_AVATAR_ANALYZER_STACK_BYTES]
      __attribute__((aligned(16)));
  TaskHandle_t analyzer_task;

  /*
   * The PMIC call button gets its own low-cost input task. Keeping that poller
   * out of the fifteen-transfer display loop means SPI congestion may lower
   * animation detail but cannot stretch a nominal 20 ms human-input sample
   * into an arbitrary display-frame delay.
   */
  StaticTask_t input_task_control;
  StackType_t input_stack[STACKCHAN_INPUT_STACK_BYTES]
      __attribute__((aligned(16)));
  TaskHandle_t input_task;

  struct stackchan_avatar_atomic_metrics metrics;
  /*
   * Zero means no request; otherwise this is catalogue index + 1. An atomic
   * latest-only slot is intentional. Avatar changes are state, not commands,
   * so replaying every intermediate choice would waste display bandwidth and
   * could make an RPC burst visible as delayed UI work beside realtime audio.
   */
  volatile uint32_t pending_avatar_index_plus_one;
  volatile uint32_t pending_side_button_taps;
  /*
   * Completed face taps, with the half of the panel the LAST one pressed.
   * Two taps between device polls collapse onto the newest zone, which for
   * a 20 ms sampler and a human finger is a distinction without a case.
   */
  volatile uint32_t pending_face_taps;
  volatile uint32_t last_face_tap_left;
  volatile uint32_t last_touch_x;
  /*
   * THE GLASS ON LOAN (iterate_kit_stackchan_avatar_show_image). `image` is
   * the lent 320x240 frame, NULL while the face owns the glass; each loan or
   * return bumps `image_requested`, and the render task copies it to
   * `image_painted` once that state is on the panel.
   */
  const uint8_t *volatile image;
  volatile uint32_t image_requested;
  volatile uint32_t image_painted;
  bool face_button_baseline_established;
  volatile uint64_t speaker_status_active_through_us;
  volatile uint32_t started;
  volatile uint32_t ready;
  volatile uint32_t display_active;
};

/*
 * Every object touched by the I2S callback is forced into internal DRAM. Only
 * the bounded 10 KiB scale strip is internal for DMA's sake — ESP32-S3 SPI
 * cannot transfer from PSRAM, and keeping the strip here prevents the driver
 * from doing a hidden bounce-buffer allocation on every LCD transfer. The
 * 38.4 KiB source surface lives in PSRAM; see the note on
 * STACKCHAN_AVATAR_SOURCE_CAPS for the socket it cost while it did not.
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

static bool draw_region_and_wait(
    uint32_t x,
    uint32_t y,
    uint32_t width,
    uint32_t height,
    const uint16_t *pixels) {
  if (__atomic_load_n(&owner.display_active, __ATOMIC_ACQUIRE) == 0U) {
    return false;
  }
  if (pixels == NULL) return false;

  /*
   * The SPI panel API deliberately returns after queueing DMA. Reusing the
   * only framebuffer before its completion callback would produce torn faces
   * and, under unlucky timing, let the renderer mutate memory while GDMA is
   * reading it. One buffer plus a bounded completion wait is cheaper and much
   * easier to reason about than a display FIFO. The low-priority visual task
   * is the only waiter, so this can never stall audio or a WebSocket owner.
   */
  const uint64_t started_at_us = now_us_wide();
  const enum iterate_kit_lcd_transfer_result result =
      iterate_kit_lcd_transfer_draw_and_wait(
          &owner.display_transfer, owner.panel, (int32_t)x, (int32_t)y,
          (int32_t)width, (int32_t)height, pixels,
          pdMS_TO_TICKS(STACKCHAN_AVATAR_DISPLAY_TRANSFER_TIMEOUT_MS));
  if (result == ITERATE_KIT_LCD_TRANSFER_DRAW_FAILED) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &owner.metrics.display_transfer_failures);
    __atomic_store_n(&owner.display_active, 0U, __ATOMIC_RELEASE);
    return false;
  }
  if (result == ITERATE_KIT_LCD_TRANSFER_TIMED_OUT) {
    /*
     * After a timeout the DMA ownership of the buffer is unknowable. Never
     * reuse it and never retry into a possible in-flight transfer. Disabling
     * the visual sidecar is the bounded failure policy; audio remains live and
     * diagnostics retain the exact incident.
     */
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &owner.metrics.display_transfer_timeouts);
    __atomic_store_n(&owner.display_active, 0U, __ATOMIC_RELEASE);
    return false;
  }

  const uint32_t transfer_us = saturating_elapsed_us(
      now_us_wide(), started_at_us);
  iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.display_transfers);
  __atomic_store_n(
      &owner.metrics.last_display_transfer_us,
      transfer_us,
      __ATOMIC_RELAXED);
  iterate_kit_atomic_update_max_relaxed_u32(
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

/* Analyzer task only (prepare_avatar_frame), so no lock. */
static bool face_dozing_now(void) {
  static struct iterate_kit_face_wake wake;
  return !iterate_kit_face_awake(
      &wake,
      owner.latest_status.conversation_active,
      now_us_wide() / 1000U);
}

static bool prepare_avatar_frame(
    face_render_key_t *render_key,
    uint64_t *render_cpu_us) {
  if (render_key == NULL || render_cpu_us == NULL) return false;
  const uint64_t started_at_us = now_us_wide();

  /*
   * Analysis and rendering now share one low-priority task, so snapshotting
   * cannot race. Retain the bounded API anyway: it proves that any future
   * second writer fails one frame closed instead of spinning on core 0.
   */
  face_pose_t candidate = owner.latest_pose;
  if (face_animator_snapshot(&owner.animator, &candidate)) {
    owner.latest_pose = candidate;
  } else {
    iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.snapshot_races);
  }

  /*
   * The performance clock follows every physical DMA descriptor, including
   * observations deliberately skipped by the analyzer. This prevents idle
   * motion from slowing down under display/network load and makes animation
   * independent of WebSocket packet boundaries.
   */
  owner.latest_pose.playout_samples = __atomic_load_n(
      &owner.metrics.physical_playout_sample_clock, __ATOMIC_RELAXED);
  face_render_key_from_pose(&owner.latest_pose, render_key);
  const bool dozing = face_dozing_now();
  if (dozing) face_doze_prepare_render_key(render_key);
  if (!face_avatar_registry_render(
          &owner.registry,
          render_key,
          owner.latest_pose.playout_samples,
          owner.framebuffer,
          FACE_RENDER_PIXEL_COUNT)) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.render_failures);
    return false;
  }
  if (dozing && !face_doze_apply_overlay(
                     owner.framebuffer,
                     FACE_RENDER_PIXEL_COUNT,
                     owner.latest_pose.playout_samples)) {
    /*
     * The doze sprite is part of the user-visible lifecycle contract.
     * Failing closed here prevents a plausible awake-looking frame from
     * replacing the last coherent display when buffer geometry and
     * renderer assumptions diverge.
     */
    iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.render_failures);
    return false;
  }
  swap_rgb565_bytes_for_panel();
  *render_cpu_us = saturating_elapsed_us(now_us_wide(), started_at_us);
  return true;
}

static bool transfer_avatar_frame(
    const face_render_key_t *render_key,
    uint64_t render_cpu_us) {
  if (render_key == NULL) return false;
  for (uint32_t source_y = 0U; source_y < FACE_RENDER_HEIGHT;
       source_y += STACKCHAN_AVATAR_SCALE_SOURCE_ROWS_PER_TRANSFER) {
    const uint32_t remaining_rows = FACE_RENDER_HEIGHT - source_y;
    const uint32_t source_rows =
        remaining_rows < STACKCHAN_AVATAR_SCALE_SOURCE_ROWS_PER_TRANSFER
        ? remaining_rows
        : STACKCHAN_AVATAR_SCALE_SOURCE_ROWS_PER_TRANSFER;
    const uint64_t scale_started_at_us = now_us_wide();
    if (!face_scale_rgb565_2x_rows(
            owner.framebuffer + source_y * FACE_RENDER_WIDTH,
            FACE_RENDER_WIDTH,
            source_rows,
            owner.scaled_strip,
            STACKCHAN_AVATAR_SCALE_STRIP_PIXEL_COUNT)) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.render_failures);
      return false;
    }
    render_cpu_us += saturating_elapsed_us(
        now_us_wide(), scale_started_at_us);

    if (!draw_region_and_wait(
            0U,
            source_y * STACKCHAN_AVATAR_SCALE,
            STACKCHAN_AVATAR_SCALED_WIDTH,
            source_rows * STACKCHAN_AVATAR_SCALE,
            owner.scaled_strip)) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.render_failures);
      return false;
    }
  }
  const uint32_t render_us = render_cpu_us > UINT32_MAX
      ? UINT32_MAX
      : (uint32_t)render_cpu_us;
  __atomic_store_n(
      &owner.metrics.last_render_us, render_us, __ATOMIC_RELAXED);
  iterate_kit_atomic_update_max_relaxed_u32(&owner.metrics.maximum_render_us, render_us);
  if (render_key->controls.mouth_open != 0U) {
    /*
     * Count only a mouth-open frame whose LCD transfer completed. Analyzer
     * state alone cannot prove the talking pose reached the panel, while a
     * pre-transfer increment would turn a timed-out DMA into false evidence.
     */
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &owner.metrics.mouth_open_rendered_frames);
  }
  iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.rendered_frames);
  return true;
}

/*
 * A lent image is already big-endian RGB565 at the panel's own size, which is
 * the ILI9341's wire order, so each band is a straight copy into the DMA strip:
 * no scaling and no byte swap. It is painted once; the panel holds it after.
 */
static bool paint_image(const uint8_t *image) {
  const size_t band_bytes = (size_t)STACKCHAN_AVATAR_SCALED_WIDTH *
      STACKCHAN_AVATAR_SCALE_STRIP_HEIGHT * sizeof(uint16_t);
  for (uint32_t y = 0U; y < STACKCHAN_AVATAR_SCALED_HEIGHT;
       y += STACKCHAN_AVATAR_SCALE_STRIP_HEIGHT) {
    memcpy(owner.scaled_strip,
           image + (size_t)y * STACKCHAN_AVATAR_SCALED_WIDTH * sizeof(uint16_t),
           band_bytes);
    if (!draw_region_and_wait(
            0U, y, STACKCHAN_AVATAR_SCALED_WIDTH,
            STACKCHAN_AVATAR_SCALE_STRIP_HEIGHT, owner.scaled_strip)) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.render_failures);
      return false;
    }
  }
  return true;
}

static bool render_avatar(void) {
  /* The request before the pointer: a pointer newer than the request only
   * costs one more paint, never a paint marked done that was not. */
  const uint32_t requested =
      __atomic_load_n(&owner.image_requested, __ATOMIC_ACQUIRE);
  const uint8_t *const image =
      __atomic_load_n(&owner.image, __ATOMIC_ACQUIRE);
  if (image != NULL) {
    if (__atomic_load_n(&owner.image_painted, __ATOMIC_RELAXED) == requested) {
      return true; /* On the glass already; the lender may reuse its buffer. */
    }
    if (!paint_image(image)) return false;
  } else {
    face_render_key_t render_key;
    uint64_t render_cpu_us = 0U;
    if (!prepare_avatar_frame(&render_key, &render_cpu_us) ||
        !transfer_avatar_frame(&render_key, render_cpu_us)) {
      return false;
    }
  }
  __atomic_store_n(&owner.image_painted, requested, __ATOMIC_RELEASE);
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
      iterate_kit_atomic_saturating_add_relaxed_u32(
          &owner.metrics.analyzer_sequence_gaps, distance - 1U);
    }
  }
  *previous_sequence = frame->sequence;
  face_animator_push_pcm(
      &owner.animator,
      frame->samples,
      STACKCHAN_AVATAR_PLAYOUT_FRAME_SAMPLES);
  uint32_t frame_peak = 0U;
  for (size_t sample_index = 0U;
       sample_index < STACKCHAN_AVATAR_PLAYOUT_FRAME_SAMPLES;
       ++sample_index) {
    const int32_t sample = frame->samples[sample_index];
    const uint32_t magnitude = sample < 0
        ? (uint32_t)(-sample)
        : (uint32_t)sample;
    if (magnitude > frame_peak) frame_peak = magnitude;
  }
  if (frame_peak >= 256U) {
    /*
     * Natural speech crosses zero and stream frames can have tiny discontinuities where they join.
     * Letting each such valley flip AI->MIC made the rail look like VAD was
     * oscillating even when I2S was playing one coherent reply. This bounded
     * 180 ms physical-playout hangover is only presentation state: it neither
     * changes microphone publication nor suppresses stream lifecycle events.
     */
    __atomic_store_n(
        &owner.speaker_status_active_through_us,
        frame->completed_at_us + STACKCHAN_SPEAKER_STATUS_HANGOVER_US,
        __ATOMIC_RELEASE);
  }
  iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.analyzer_frames);

  const uint64_t finished_at_us = now_us_wide();
  const uint32_t handoff_delay_us = saturating_elapsed_us(
      started_at_us, frame->completed_at_us);
  const uint32_t analyzer_us = saturating_elapsed_us(
      finished_at_us, started_at_us);
  __atomic_store_n(
      &owner.metrics.last_handoff_delay_us,
      handoff_delay_us,
      __ATOMIC_RELAXED);
  iterate_kit_atomic_update_max_relaxed_u32(
      &owner.metrics.maximum_handoff_delay_us, handoff_delay_us);
  __atomic_store_n(
      &owner.metrics.last_analyzer_us, analyzer_us, __ATOMIC_RELAXED);
  iterate_kit_atomic_update_max_relaxed_u32(&owner.metrics.maximum_analyzer_us, analyzer_us);
}

static bool select_avatar_index(size_t requested_index) {
  /*
   * Only the analyzer task owns mutable registry/player state. Remote
   * capability requests and the dedicated whole-screen input task converge
   * through one atomic latest-state slot, so neither path needs a lock around
   * rendering or can wait behind LCD DMA.
   */
  if (!face_avatar_registry_select(&owner.registry, requested_index)) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.render_failures);
    __atomic_store_n(&owner.display_active, 0U, __ATOMIC_RELEASE);
    ESP_LOGE(
        TAG,
        "validated avatar index %u could not be selected",
        (unsigned)requested_index);
    return false;
  }
  __atomic_store_n(
      &owner.metrics.current_avatar_index,
      (uint32_t)requested_index,
      __ATOMIC_RELEASE);
  return true;
}

static void sample_physical_controls(uint64_t now_ms) {
  esp_lcd_touch_point_data_t touch_point;
  uint8_t touch_point_count = 0U;
  bsp_power_button_event_t power_events =
      BSP_POWER_BUTTON_EVENT_NONE;
  esp_err_t status;

  iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.touch_samples);
  status = esp_lcd_touch_read_data(owner.touch);
  if (status == ESP_OK) {
    status = esp_lcd_touch_get_data(
        owner.touch, &touch_point, &touch_point_count, 1U);
  }
  if (status != ESP_OK) {
    /*
     * A failed I2C read is not a release. Omitting the sample preserves the
     * last coherent level; feeding false into the edge detector would turn a
     * transient bus fault into an unintended tap.
     */
    iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.touch_read_failures);
  } else {
    /*
     * The finger's place is only reported while it is DOWN, so the half a
     * completed tap chose has to be remembered from the press: by the
     * release sample that completes the tap, the controller has nothing
     * left to say about where it was.
     */
    if (touch_point_count != 0U) {
      __atomic_store_n(
          &owner.last_touch_x, (uint32_t)touch_point.x, __ATOMIC_RELAXED);
    }
    if (iterate_kit_touch_tap_update(
            &owner.touch_tap, touch_point_count != 0U, now_ms)) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.touch_taps);
      __atomic_store_n(
          &owner.last_face_tap_left,
          __atomic_load_n(&owner.last_touch_x, __ATOMIC_RELAXED) <
                  (uint32_t)(BSP_LCD_H_RES / 2U)
              ? 1U
              : 0U,
          __ATOMIC_RELEASE);
      iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.pending_face_taps);
    }
  }

  iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.face_button_samples);
  status = bsp_power_button_take_events(&power_events);
  if (status != ESP_OK) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &owner.metrics.face_button_read_failures);
  } else if (!owner.face_button_baseline_established) {
    /*
     * The AXP2101 latch survives an ESP reset and therefore can still contain
     * the click used to enter download mode or an event sampled by the prior
     * firmware. Accepting that history would start a call several seconds
     * after an unattended flash. The first successful sample establishes a
     * temporal baseline and is always discarded; subsequent samples are the
     * only events this firmware instance is entitled to publish.
     */
    owner.face_button_baseline_established = true;
    if (power_events != BSP_POWER_BUTTON_EVENT_NONE) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(
          &owner.metrics.face_button_boot_events_discarded);
      ESP_LOGI(
          TAG,
          "discarded pre-boot PMIC face-button event bits: %u",
          (unsigned)power_events);
    }
  } else if (power_events == BSP_POWER_BUTTON_EVENT_SHORT_PRESS) {
    /*
     * The side button is the CALL control now — wake a session, end a
     * session — consumed by the device's poll through the session grammar.
     * Face changes moved to the far end's set_face tool; the button that
     * used to cycle sprites opens conversations instead.
     */
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &owner.metrics.face_button_short_clicks);
    iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.pending_side_button_taps);
  } else if (power_events != BSP_POWER_BUTTON_EVENT_NONE) {
    /*
     * AXP2101 owns the long-hold hard-power policy. Recording the event but
     * taking no application action prevents a power-off gesture from also
     * changing face immediately before the rail disappears.
     */
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &owner.metrics.face_button_long_or_ambiguous_events);
  }
}

static void input_task_main(void *context) {
  (void)context;
  uint64_t previous_sample_at_us = 0U;

  for (;;) {
    const uint64_t sampled_at_us = now_us_wide();
    if (previous_sample_at_us != 0U) {
      const uint32_t interval_us = saturating_elapsed_us(
          sampled_at_us, previous_sample_at_us);
      __atomic_store_n(
          &owner.metrics.last_input_sample_interval_us,
          interval_us,
          __ATOMIC_RELAXED);
      iterate_kit_atomic_update_max_relaxed_u32(
          &owner.metrics.maximum_input_sample_interval_us, interval_us);
    }
    previous_sample_at_us = sampled_at_us;
    sample_physical_controls(sampled_at_us / 1000U);

    /*
     * Delay from "now", not from an old periodic phase. If I2C ever runs long,
     * replaying missed samples immediately cannot recover an electrical edge;
     * it only creates a catch-up loop beside audio. The measured interval above
     * makes every such slip visible in metrics.
     */
    TickType_t delay_ticks = pdMS_TO_TICKS(
        STACKCHAN_INPUT_SAMPLE_INTERVAL_MS);
    if (delay_ticks == 0U) delay_ticks = 1U;
    vTaskDelay(delay_ticks);
  }
}

static void analyzer_task_main(void *context) {
  (void)context;
  struct stackchan_avatar_frame frame;
  struct iterate_kit_conversation_visual_state status_update;
  uint32_t previous_sequence = 0U;
  bool rendering_enabled = true;
  uint64_t next_render_at_us =
      now_us_wide() + STACKCHAN_AVATAR_RENDER_INTERVAL_MS * 1000U;

  for (;;) {
    const uint64_t before_wait_us = now_us_wide();
    const uint64_t next_deadline_us = rendering_enabled
        ? next_render_at_us
        : before_wait_us + STACKCHAN_AVATAR_RENDER_INTERVAL_MS * 1000U;
    uint64_t remaining_us = next_deadline_us > before_wait_us
        ? next_deadline_us - before_wait_us
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

    if (xQueueReceive(
            owner.status_mailbox, &status_update, 0U) == pdPASS) {
      owner.latest_status = status_update;
      if (rendering_enabled) {
        /* Current lifecycle truth should not wait behind the old 15 Hz phase. */
        next_render_at_us = 0U;
      }
    }

    const uint32_t requested_index_plus_one = __atomic_exchange_n(
        &owner.pending_avatar_index_plus_one, 0U, __ATOMIC_ACQ_REL);
    if (rendering_enabled && requested_index_plus_one != 0U) {
      const size_t requested_index =
          (size_t)(requested_index_plus_one - 1U);
      /*
       * The request path already validated this immutable catalogue index. A
       * failure now means internal registry corruption, so disable rendering
       * rather than acknowledging further phantom visual changes.
       */
      if (!select_avatar_index(requested_index)) {
        rendering_enabled = false;
      } else {
        next_render_at_us = 0U;
      }
    }

    if (rendering_enabled && now_us_wide() >= next_render_at_us) {
      if (!render_avatar()) {
        /*
         * Rendering has no recovery path that is safer than audio. Disable
         * further panel work after one failure. The independent low-rate input
         * owner remains alive: an LCD DMA fault must not also destroy the
         * physical call button. Audio and both WebSocket owners remain wholly
         * independent.
         */
        rendering_enabled = false;
        __atomic_store_n(&owner.display_active, 0U, __ATOMIC_RELEASE);
        ESP_LOGE(TAG, "avatar rendering disabled after terminal failure");
        continue;
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
  __atomic_store_n(
      &owner.metrics.current_avatar_index,
      (uint32_t)face_avatar_registry_current_index(&owner.registry),
      __ATOMIC_RELAXED);

  owner.mailbox = xQueueCreateStatic(
      1U,
      sizeof(struct stackchan_avatar_frame),
      owner.mailbox_storage,
      &owner.mailbox_control);
  if (owner.mailbox == NULL) {
    return ESP_ERR_NO_MEM;
  }
  owner.status_mailbox = xQueueCreateStatic(
      1U,
      sizeof(struct iterate_kit_conversation_visual_state),
      owner.status_mailbox_storage,
      &owner.status_mailbox_control);
  if (owner.status_mailbox == NULL) {
    return ESP_ERR_NO_MEM;
  }

  /*
   * This target needs a talking head, not a general widget toolkit. LVGL's
   * generic CoreS3 startup consumed a task, a touch driver, approximately
   * 12.8 KiB even after tuning its DMA strip, and enough linked code/state to
   * leave only 3.6 KiB of minimum internal heap during a real voice turn. The
   * direct panel path has one source surface, one bounded DMA strip, and no
   * display queue above ESP-IDF's own DMA transaction. The 160x120 portable
   * face is expanded with exact nearest-neighbour pixels to fill 320x240; the
   * strip makes that four-times wire bandwidth explicit without paying for a
   * 153.6 KiB full-screen buffer. Audio deadlines still own priority, and the
   * resource/transfer metrics make this visual tradeoff falsifiable on-device.
   *
   * ESP-IDF's heap has no SPIRAM|DMA memory on the ESP32-S3, so asking for it
   * returns NULL, while asking only for SPIRAM makes the SPI driver allocate
   * and copy through an internal bounce buffer on every transfer. The internal allocation below is deliberately permanent: it
   * makes startup fail honestly if the memory budget is unavailable and keeps
   * steady-state rendering allocation-free. It also removes PSRAM/cache
   * contention from the display transfer that runs beside the AEC owner.
   */
  if (!iterate_kit_lcd_transfer_init(
          &owner.display_transfer, &owner.display_transfer_control)) {
    return ESP_ERR_NO_MEM;
  }
  owner.framebuffer = heap_caps_aligned_alloc(
      64U,
      FACE_RENDER_FRAME_BYTES,
      STACKCHAN_AVATAR_SOURCE_CAPS);
  if (owner.framebuffer == NULL) {
    return ESP_ERR_NO_MEM;
  }
  owner.scaled_strip = heap_caps_aligned_alloc(
      64U,
      STACKCHAN_AVATAR_SCALE_STRIP_BYTES,
      STACKCHAN_AVATAR_FRAMEBUFFER_CAPS);
  if (owner.scaled_strip == NULL) {
    return ESP_ERR_NO_MEM;
  }

  const bsp_display_config_t display_configuration = {
      .max_transfer_sz = STACKCHAN_AVATAR_SCALE_STRIP_BYTES,
  };
  esp_err_t status = bsp_display_brightness_init();
  if (status == ESP_OK) {
    status = bsp_display_new(
        &display_configuration, &owner.panel, &owner.panel_io);
  }
  if (status == ESP_OK) {
    const esp_lcd_panel_io_callbacks_t callbacks = {
        .on_color_trans_done = iterate_kit_lcd_transfer_complete,
    };
    status = esp_lcd_panel_io_register_event_callbacks(
        owner.panel_io, &callbacks, &owner.display_transfer);
  }
  if (status == ESP_OK) {
    status = esp_lcd_panel_disp_on_off(owner.panel, true);
  }
  if (status == ESP_OK) {
    status = bsp_display_backlight_on();
  }
  if (status == ESP_OK) {
    status = bsp_touch_new(NULL, &owner.touch);
  }
  if (status != ESP_OK) {
    return status;
  }
  /* Unknown-at-start suppresses a finger held during boot until release. */
  iterate_kit_touch_tap_init(&owner.touch_tap, true);
  __atomic_store_n(&owner.display_active, 1U, __ATOMIC_RELEASE);

  /* The first exact-2x render covers every GRAM pixel; no border clear exists. */
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
  owner.input_task = xTaskCreateStaticPinnedToCore(
      input_task_main,
      "stackchan-input",
      sizeof(owner.input_stack),
      NULL,
      STACKCHAN_INPUT_PRIORITY,
      owner.input_stack,
      &owner.input_task_control,
      STACKCHAN_INPUT_CORE);
  if (owner.input_task == NULL) {
    return ESP_ERR_NO_MEM;
  }

  __atomic_store_n(&owner.ready, 1U, __ATOMIC_RELEASE);
  ESP_LOGI(
      TAG,
      "ready: avatar=%s count=%u source=%u + scale_strip=%u bytes "
      "internal DMA; display=direct exact-2x 320x240@15Hz; "
      "handoff=latest-only 1x128 samples; visual=core1 priority2; "
      "input=whole-screen-call+PMIC-face@50Hz core1 priority3; "
      "PMIC-long=hardware-power-off; lower-key=hardware-reset",
      face_avatar_registry_current_slug(&owner.registry),
      (unsigned)face_avatar_registry_count(),
      (unsigned)FACE_RENDER_FRAME_BYTES,
      (unsigned)STACKCHAN_AVATAR_SCALE_STRIP_BYTES);
  return ESP_OK;
}


esp_err_t iterate_kit_stackchan_avatar_request_sprite_set(size_t index) {
  if (index >= face_avatar_registry_count()) {
    return ESP_ERR_INVALID_ARG;
  }
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U ||
      __atomic_load_n(&owner.display_active, __ATOMIC_ACQUIRE) == 0U) {
    return ESP_ERR_INVALID_STATE;
  }
  __atomic_store_n(
      &owner.pending_avatar_index_plus_one,
      (uint32_t)index + 1U,
      __ATOMIC_RELEASE);
  return ESP_OK;
}

esp_err_t iterate_kit_stackchan_avatar_request_status(
    const struct iterate_kit_conversation_visual_state *status) {
  if (status == NULL) return ESP_ERR_INVALID_ARG;
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U ||
      __atomic_load_n(&owner.display_active, __ATOMIC_ACQUIRE) == 0U ||
      owner.status_mailbox == NULL) {
    return ESP_ERR_INVALID_STATE;
  }

  if (uxQueueMessagesWaiting(owner.status_mailbox) != 0U) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.status_overwrites);
  }
  if (xQueueOverwrite(owner.status_mailbox, status) != pdPASS) {
    return ESP_FAIL;
  }
  iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.metrics.status_updates);
  return ESP_OK;
}

/* CAS-decrement one pending count so a quick pair cannot collapse. */
static bool take_pending(volatile uint32_t *pending) {
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U) {
    return false;
  }
  uint32_t current = __atomic_load_n(pending, __ATOMIC_ACQUIRE);
  while (current != 0U) {
    if (__atomic_compare_exchange_n(
            pending,
            &current,
            current - 1U,
            false,
            __ATOMIC_ACQ_REL,
            __ATOMIC_ACQUIRE)) {
      return true;
    }
  }
  return false;
}

bool iterate_kit_stackchan_avatar_take_face_tap(bool *left_half) {
  if (!take_pending(&owner.pending_face_taps)) return false;
  *left_half =
      __atomic_load_n(&owner.last_face_tap_left, __ATOMIC_ACQUIRE) != 0U;
  return true;
}

bool iterate_kit_stackchan_avatar_take_side_button_tap(void) {
  return take_pending(&owner.pending_side_button_taps);
}

/* The INJECTED gestures land in the same pending latches the physical
 * sampler fills, so everything downstream — the session grammar, the menu,
 * the audit — cannot tell a capability from a finger. That is the point. */
void iterate_kit_stackchan_avatar_inject_side_button(void) {
  iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.pending_side_button_taps);
}

void iterate_kit_stackchan_avatar_inject_face_tap(uint16_t x) {
  __atomic_store_n(&owner.last_touch_x, (uint32_t)x, __ATOMIC_RELAXED);
  __atomic_store_n(
      &owner.last_face_tap_left,
      (uint32_t)x < (uint32_t)(BSP_LCD_H_RES / 2U) ? 1U : 0U,
      __ATOMIC_RELEASE);
  iterate_kit_atomic_saturating_increment_relaxed_u32(&owner.pending_face_taps);
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
  snapshot->framebuffer_bytes =
      (owner.framebuffer == NULL ? 0U : FACE_RENDER_FRAME_BYTES) +
      (owner.scaled_strip == NULL ? 0U : STACKCHAN_AVATAR_SCALE_STRIP_BYTES);

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
  COPY_ATOMIC_METRIC(current_avatar_index);
  COPY_ATOMIC_METRIC(status_updates);
  COPY_ATOMIC_METRIC(status_overwrites);
  COPY_ATOMIC_METRIC(touch_samples);
  COPY_ATOMIC_METRIC(touch_read_failures);
  COPY_ATOMIC_METRIC(touch_taps);
  COPY_ATOMIC_METRIC(face_button_samples);
  COPY_ATOMIC_METRIC(face_button_read_failures);
  COPY_ATOMIC_METRIC(face_button_boot_events_discarded);
  COPY_ATOMIC_METRIC(face_button_short_clicks);
  COPY_ATOMIC_METRIC(face_button_long_or_ambiguous_events);
  COPY_ATOMIC_METRIC(last_input_sample_interval_us);
  COPY_ATOMIC_METRIC(maximum_input_sample_interval_us);
#undef COPY_ATOMIC_METRIC

  snapshot->analyzer_stack_minimum_free_bytes =
      owner.analyzer_task == NULL
      ? 0U
      : (uint32_t)uxTaskGetStackHighWaterMark(owner.analyzer_task) *
          sizeof(StackType_t);
  snapshot->input_stack_minimum_free_bytes =
      owner.input_task == NULL
      ? 0U
      : (uint32_t)uxTaskGetStackHighWaterMark(owner.input_task) *
          sizeof(StackType_t);
}

uint32_t iterate_kit_stackchan_avatar_speaker_status_peak(void) {
  if (__atomic_load_n(&owner.ready, __ATOMIC_ACQUIRE) == 0U) return 0U;
  return now_us_wide() < __atomic_load_n(
             &owner.speaker_status_active_through_us, __ATOMIC_ACQUIRE)
      ? 256U
      : 0U;
}

bool iterate_kit_stackchan_avatar_display_active(void) {
  return __atomic_load_n(&owner.display_active, __ATOMIC_ACQUIRE) != 0U;
}

void iterate_kit_stackchan_avatar_show_image(const uint8_t *pixels) {
  __atomic_store_n(&owner.image, pixels, __ATOMIC_RELEASE);
  (void)__atomic_add_fetch(&owner.image_requested, 1U, __ATOMIC_RELEASE);
}

bool iterate_kit_stackchan_avatar_image_painted(void) {
  return __atomic_load_n(&owner.image_painted, __ATOMIC_ACQUIRE) ==
      __atomic_load_n(&owner.image_requested, __ATOMIC_ACQUIRE);
}
