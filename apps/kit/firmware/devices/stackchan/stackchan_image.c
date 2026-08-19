#include "stackchan_image.h"

#include "stackchan_avatar.h"

/* For FACE_RENDER_WIDTH/HEIGHT: the staging surface's fixed geometry. */
#include "iterate/kit/avatar/face_render.h"

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "jpeg_decoder.h"

#include <string.h>

/*
 * THE WHOLE JOB RUNS OFF THE REALTIME TASKS. The app task would stall the
 * voice loop for the length of a TLS handshake, and the avatar tasks own a
 * 66 ms visual deadline; a web fetch belongs on neither. So acceptance is
 * synchronous and cheap — busy flag, staging allocation, url shape — and one
 * one-shot task does the slow part, replying to nobody: by the time it knows
 * anything the RPC has long since resolved `true`, which is why every
 * asynchronous outcome lands in a health counter and the console log instead.
 *
 * EVERY BIG BUFFER IS PSRAM AND TRANSIENT. This board has been to 4.6 KiB of
 * internal heap and lost its network for it (see stackchan_avatar.c on
 * STACKCHAN_AVATAR_SOURCE_CAPS); a picture must never spend the pool TLS,
 * Wi-Fi and DMA compete for. The one internal cost is the task's own stack,
 * and it is one-shot: allocated for the fetch, gone when the task deletes
 * itself.
 */

static const char *const tag = "stackchan-image";

enum {
  IMAGE_URL_CAPACITY = 512,
  /*
   * The download's hard cap. A 512 KiB JPEG is already far beyond what a
   * 160x120 staging surface can use; past this the fetch aborts rather than
   * letting an arbitrary url size the allocation.
   */
  IMAGE_BODY_CAPACITY = 512 * 1024,
  /*
   * The decoded-pixels ceiling. The scale picker below keeps a sane photo
   * near the staging size, but an extreme aspect ratio can defeat every
   * 1/8..1/2 scale in one dimension; 1 MiB of transient PSRAM bounds how far
   * that is indulged.
   */
  IMAGE_DECODE_CAPACITY = 1024 * 1024,
  /* tjpgd's scratchpad: 3.1 KiB minimum, given a rounder figure in PSRAM. */
  IMAGE_JPEG_WORK_BYTES = 4096,
  IMAGE_SHOW_MINIMUM_SECONDS = 1,
  IMAGE_SHOW_MAXIMUM_SECONDS = 300,
  /*
   * The one-shot task's shape. The stack carries esp_http_client plus a TLS
   * handshake, which is the same synchronous peak the transport's WebSocket
   * owner is sized for; 10 KiB is that lesson applied, transient. Priority 2
   * on core 1 puts it beside the avatar's renderer in audio's spare cycles —
   * never on the Wi-Fi core, never above a realtime owner.
   */
  IMAGE_FETCH_STACK_BYTES = 10240,
  IMAGE_FETCH_PRIORITY = 2,
  IMAGE_FETCH_CORE = 1,
  IMAGE_HTTP_TIMEOUT_MS = 15000,
  IMAGE_HTTP_READ_BYTES = 4096,
  IMAGE_HTTP_MAXIMUM_REDIRECTS = 3,
};

static struct {
  /* The single-flight latch: set at acceptance, cleared as the task dies. */
  volatile uint32_t in_flight;
  /*
   * When the picture we last published stops owning the glass, in ms since
   * boot on esp_timer's clock — the avatar keeps the authoritative copy; this
   * one exists so acceptance can refuse a write into a surface the render
   * task is still reading, without a second avatar seam.
   */
  volatile uint64_t visible_through_ms;
  volatile uint32_t fetches;
  volatile uint32_t fetch_failures;
  /* The accepted request, owned by the fetch task until in_flight clears. */
  char url[IMAGE_URL_CAPACITY];
  uint32_t show_ms;
  /* The download, allocated per fetch and freed before the task detaches. */
  uint8_t *body;
  size_t body_length;
} image;

static uint64_t now_ms(void) {
  const int64_t now = esp_timer_get_time();
  return now <= 0 ? 0U : (uint64_t)now / 1000U;
}

/*
 * Streamed download in ~4 KiB reads with the cap enforced mid-flight, and
 * redirects followed by hand: the manual open/read path is what gives the
 * cap an abort lever, and it does not follow Location on its own.
 */
static const char *fetch_body(esp_http_client_handle_t client) {
  int status = 0;
  int64_t content_length = 0;
  for (int hop = 0;; ++hop) {
    if (esp_http_client_open(client, 0) != ESP_OK) {
      return "could not reach that url";
    }
    content_length = esp_http_client_fetch_headers(client);
    if (content_length < 0) {
      return "the server dropped the connection";
    }
    status = esp_http_client_get_status_code(client);
    if (status == 301 || status == 302 || status == 303 || status == 307 ||
        status == 308) {
      if (hop >= IMAGE_HTTP_MAXIMUM_REDIRECTS) {
        return "too many redirects";
      }
      if (esp_http_client_set_redirection(client) != ESP_OK) {
        return "a redirect with nowhere to go";
      }
      (void)esp_http_client_close(client);
      continue;
    }
    break;
  }
  if (status != 200) {
    return "the server did not answer 200";
  }
  if (content_length > (int64_t)IMAGE_BODY_CAPACITY) {
    return "the image is bigger than 512 KiB";
  }
  for (;;) {
    const size_t room = (size_t)IMAGE_BODY_CAPACITY - image.body_length;
    if (room == 0U) {
      /* At the cap exactly: one probing byte separates "full" from "over". */
      char overflow;
      if (esp_http_client_read(client, &overflow, 1) > 0) {
        return "the image is bigger than 512 KiB";
      }
      break;
    }
    const size_t ask =
        room < (size_t)IMAGE_HTTP_READ_BYTES ? room : (size_t)IMAGE_HTTP_READ_BYTES;
    const int got = esp_http_client_read(
        client, (char *)image.body + image.body_length, (int)ask);
    if (got < 0) {
      return "the download broke off";
    }
    if (got == 0) {
      break;
    }
    image.body_length += (size_t)got;
  }
  if (image.body_length == 0U) {
    return "the server sent an empty body";
  }
  return NULL;
}

/*
 * Cover-scale and centre-crop the decoded frame to exactly 160x120 with
 * nearest-neighbour picks. The window is the largest region of the source
 * with the staging surface's 4:3 shape; a source narrower than that is
 * simply stretched from all of itself, which also handles pictures smaller
 * than the surface.
 */
static void stage_cover_crop(
    const uint16_t *decoded, uint32_t decoded_width, uint32_t decoded_height,
    uint16_t *staging) {
  uint32_t window_width;
  uint32_t window_height;
  if ((uint64_t)decoded_width * FACE_RENDER_HEIGHT >=
      (uint64_t)decoded_height * FACE_RENDER_WIDTH) {
    /* Wider than 4:3: full height, crop the sides. */
    window_height = decoded_height;
    window_width = (uint32_t)(((uint64_t)decoded_height * FACE_RENDER_WIDTH) /
                              FACE_RENDER_HEIGHT);
    if (window_width == 0U) window_width = 1U;
    if (window_width > decoded_width) window_width = decoded_width;
  } else {
    /* Taller than 4:3: full width, crop top and bottom. */
    window_width = decoded_width;
    window_height = (uint32_t)(((uint64_t)decoded_width * FACE_RENDER_HEIGHT) /
                               FACE_RENDER_WIDTH);
    if (window_height == 0U) window_height = 1U;
    if (window_height > decoded_height) window_height = decoded_height;
  }
  const uint32_t x0 = (decoded_width - window_width) / 2U;
  const uint32_t y0 = (decoded_height - window_height) / 2U;
  for (uint32_t dy = 0U; dy < FACE_RENDER_HEIGHT; ++dy) {
    const uint32_t sy =
        y0 + (uint32_t)(((uint64_t)dy * window_height) / FACE_RENDER_HEIGHT);
    const uint16_t *const source_row = decoded + (size_t)sy * decoded_width;
    uint16_t *const destination_row = staging + (size_t)dy * FACE_RENDER_WIDTH;
    for (uint32_t dx = 0U; dx < FACE_RENDER_WIDTH; ++dx) {
      const uint32_t sx =
          x0 + (uint32_t)(((uint64_t)dx * window_width) / FACE_RENDER_WIDTH);
      destination_row[dx] = source_row[sx];
    }
  }
}

static const char *decode_and_stage(void) {
  esp_jpeg_image_cfg_t cfg = {
    .indata = image.body,
    .indata_size = (uint32_t)image.body_length,
    .out_format = JPEG_IMAGE_FORMAT_RGB565,
    .out_scale = JPEG_IMAGE_SCALE_0,
  };
  esp_jpeg_image_output_t header = {0};
  if (esp_jpeg_get_image_info(&cfg, &header) != ESP_OK ||
      header.width == 0U || header.height == 0U) {
    return "not a baseline JPEG this board can decode";
  }
  /*
   * The largest decode scale whose output still covers the staging surface:
   * tjpgd discards the skipped pixels during decode, which is far cheaper
   * than decoding a full frame this file would immediately shrink.
   */
  uint32_t divisor = 1U;
  static const struct {
    esp_jpeg_image_scale_t scale;
    uint32_t divisor;
  } scales[] = {
    {JPEG_IMAGE_SCALE_1_8, 8U},
    {JPEG_IMAGE_SCALE_1_4, 4U},
    {JPEG_IMAGE_SCALE_1_2, 2U},
  };
  for (size_t index = 0U; index < sizeof(scales) / sizeof(scales[0]);
       ++index) {
    if (header.width / scales[index].divisor >= FACE_RENDER_WIDTH &&
        header.height / scales[index].divisor >= FACE_RENDER_HEIGHT) {
      cfg.out_scale = scales[index].scale;
      divisor = scales[index].divisor;
      break;
    }
  }
  const uint32_t decoded_width = header.width / divisor;
  const uint32_t decoded_height = header.height / divisor;
  const uint32_t decoded_bytes =
      decoded_width * decoded_height * (uint32_t)sizeof(uint16_t);
  if (decoded_bytes == 0U || decoded_bytes > (uint32_t)IMAGE_DECODE_CAPACITY) {
    return "the image's shape decodes too large for this screen";
  }
  uint16_t *const decoded = heap_caps_malloc(
      decoded_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  uint8_t *const work = heap_caps_malloc(
      IMAGE_JPEG_WORK_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  const char *failure = NULL;
  if (decoded == NULL || work == NULL) {
    failure = "no memory to decode the image";
  } else {
    cfg.outbuf = (uint8_t *)decoded;
    cfg.outbuf_size = decoded_bytes;
    /*
     * swap_color_bytes stays 0: with the ROM decoder's RGB888 output the
     * component stores low byte first, which read back as uint16_t on this
     * little-endian core is exactly the host-order RGB565 the face's own
     * renderer emits — the avatar byte-swaps once for the panel, for both.
     */
    cfg.advanced.working_buffer = work;
    cfg.advanced.working_buffer_size = IMAGE_JPEG_WORK_BYTES;
    esp_jpeg_image_output_t decoded_info = {0};
    if (esp_jpeg_decode(&cfg, &decoded_info) != ESP_OK) {
      failure = "the JPEG would not decode";
    } else {
      /*
       * Acceptance proved this allocation, and it is permanent thereafter;
       * writing it here is safe because no show deadline is active (the
       * acceptance gate refused the request otherwise, and nothing else
       * publishes one while this task holds the in-flight latch).
       */
      uint16_t *const staging = iterate_kit_stackchan_avatar_image_staging();
      if (staging == NULL) {
        failure = "no memory to stage the image";
      } else {
        stage_cover_crop(
            decoded, decoded_info.width, decoded_info.height, staging);
      }
    }
  }
  if (work != NULL) heap_caps_free(work);
  if (decoded != NULL) heap_caps_free(decoded);
  return failure;
}

static const char *fetch_and_stage(void) {
  image.body = heap_caps_malloc(
      IMAGE_BODY_CAPACITY, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (image.body == NULL) {
    return "no memory for the download";
  }
  image.body_length = 0U;
  const esp_http_client_config_t config = {
    .url = image.url,
    .timeout_ms = IMAGE_HTTP_TIMEOUT_MS,
    .buffer_size = IMAGE_HTTP_READ_BYTES,
    /* https through the same trust the WebSocket transport already carries. */
    .crt_bundle_attach = esp_crt_bundle_attach,
  };
  const char *failure;
  esp_http_client_handle_t client = esp_http_client_init(&config);
  if (client == NULL) {
    failure = "that url could not be parsed";
  } else {
    failure = fetch_body(client);
    (void)esp_http_client_cleanup(client);
  }
  if (failure == NULL) {
    failure = decode_and_stage();
  }
  heap_caps_free(image.body);
  image.body = NULL;
  return failure;
}

static void fetch_task(void *context) {
  (void)context;
  const char *const failure = fetch_and_stage();
  if (failure != NULL) {
    __atomic_fetch_add(&image.fetch_failures, 1U, __ATOMIC_RELAXED);
    ESP_LOGW(tag, "screen.show(%s) failed: %s", image.url, failure);
  } else {
    __atomic_store_n(
        &image.visible_through_ms,
        now_ms() + image.show_ms,
        __ATOMIC_RELEASE);
    iterate_kit_stackchan_avatar_show_image(image.show_ms);
    ESP_LOGI(
        tag,
        "showing %s for %u ms",
        image.url,
        (unsigned int)image.show_ms);
  }
  /* The latch opens LAST: everything above owned the request exclusively. */
  __atomic_store_n(&image.in_flight, 0U, __ATOMIC_RELEASE);
  vTaskDelete(NULL);
}

enum iterate_kit_status iterate_kit_stackchan_image_show(
    const char *url, size_t url_length, uint32_t seconds) {
  if (url == NULL || url_length == 0U || url_length >= sizeof(image.url)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if ((url_length < 7U || strncmp(url, "http://", 7U) != 0) &&
      (url_length < 8U || strncmp(url, "https://", 8U) != 0)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  uint32_t expected = 0U;
  if (!__atomic_compare_exchange_n(
          &image.in_flight,
          &expected,
          1U,
          false,
          __ATOMIC_ACQ_REL,
          __ATOMIC_ACQUIRE)) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  /*
   * An image still on the glass is a render task still reading the staging
   * surface, and this module's single-writer promise is exactly that nobody
   * writes it meanwhile. Refusing is honest; the far end can retry when the
   * show it asked for has run its course.
   */
  if (now_ms() < __atomic_load_n(&image.visible_through_ms, __ATOMIC_ACQUIRE)) {
    __atomic_store_n(&image.in_flight, 0U, __ATOMIC_RELEASE);
    return ITERATE_KIT_BACKPRESSURE;
  }
  if (iterate_kit_stackchan_avatar_image_staging() == NULL) {
    __atomic_store_n(&image.in_flight, 0U, __ATOMIC_RELEASE);
    return ITERATE_KIT_LIMIT;
  }
  memcpy(image.url, url, url_length);
  image.url[url_length] = '\0';
  if (seconds < (uint32_t)IMAGE_SHOW_MINIMUM_SECONDS) {
    seconds = (uint32_t)IMAGE_SHOW_MINIMUM_SECONDS;
  }
  if (seconds > (uint32_t)IMAGE_SHOW_MAXIMUM_SECONDS) {
    seconds = (uint32_t)IMAGE_SHOW_MAXIMUM_SECONDS;
  }
  image.show_ms = seconds * 1000U;
  __atomic_fetch_add(&image.fetches, 1U, __ATOMIC_RELAXED);
  if (xTaskCreatePinnedToCore(
          fetch_task,
          "sc-image",
          IMAGE_FETCH_STACK_BYTES,
          NULL,
          IMAGE_FETCH_PRIORITY,
          NULL,
          IMAGE_FETCH_CORE) != pdPASS) {
    __atomic_fetch_add(&image.fetch_failures, 1U, __ATOMIC_RELAXED);
    __atomic_store_n(&image.in_flight, 0U, __ATOMIC_RELEASE);
    return ITERATE_KIT_LIMIT;
  }
  return ITERATE_KIT_OK;
}

uint32_t iterate_kit_stackchan_image_fetches(void) {
  return __atomic_load_n(&image.fetches, __ATOMIC_RELAXED);
}

uint32_t iterate_kit_stackchan_image_fetch_failures(void) {
  return __atomic_load_n(&image.fetch_failures, __ATOMIC_RELAXED);
}
