/*
 * Fetch and decode one image, as described in waveshare_image.h.
 *
 * The shape of this file follows from one decision: buffer the whole compressed
 * body in PSRAM, then decode from memory. Streaming the socket straight into
 * the decoder would save a few tens of KB, but it puts network latency inside
 * the decode loop, makes a truncated body indistinguishable from a corrupt one,
 * and leaves no point at which the format can be checked before a decoder is
 * handed attacker-controlled bytes. PSRAM is 8MB and the body cap is 384KB, so
 * the memory it saves is memory we are not short of.
 *
 * The decoder is TJpgDec in the ESP32-S3 mask ROM (ESP_ROM_HAS_JPEG_DECODE,
 * jd_prepare/jd_decomp at fixed addresses in esp32s3.rom.ld). Choosing it over
 * espressif/esp_jpeg or LVGL's lodepng adds no component, no flash, and no
 * managed-component download to a build directory that other work shares. The
 * price is fixed by the ROM: baseline JPEG only, and RGB888 output
 * (JD_FORMAT 0), so this file converts to RGB565 as blocks arrive rather than
 * allocating a second full-size buffer.
 *
 * Ownership: between a successful waveshare_image_fetch and
 * waveshare_image_release, this module owns exactly one PSRAM pixel buffer and
 * nothing else. Everything else — the HTTP client, the compressed body, the
 * decoder work area — is allocated inside the call and freed before it returns,
 * on every path. That is the invariant to check when editing: an early return
 * that skips a free is a leak that only shows itself after twenty images, as a
 * NO_MEMORY on a device that looks idle.
 *
 * All state here is touched from the calling task only. There is no lock; see
 * the header on serialisation.
 */
#include "waveshare_image.h"

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "rom/tjpgd.h"
/* For the panel size, which is the dimension bound. Nothing is drawn here. */
#include "waveshare_display.h"

/*
 * The ROM decoder's output format is fixed in silicon, and the header shipped
 * with ESP-IDF is what states it. convert_row reads three bytes per pixel on
 * the strength of that, so a header that ever says otherwise must stop the
 * build rather than quietly produce a picture with the colours wrong.
 */
#if JD_FORMAT != 0
#error "ROM TJpgDec is expected to emit RGB888 (JD_FORMAT 0)"
#endif

static const char tag[] = "waveshare-image";

enum {
  /*
   * The whole call: DNS, TLS handshake, redirects, headers, body, decode. This
   * is time the calling task spends doing nothing else, so it is a product
   * decision as much as a network one. 15s is long enough for a 300KB image
   * over a poor hotel Wi-Fi link and short enough that a person watching the
   * screen sees a failure rather than a hang. Raising it makes a dead server
   * look like a wedged device; lowering it makes a slow network look like a
   * broken URL.
   */
  DEADLINE_MS = 15000,
  /*
   * One socket operation: connect, one header read, one body read. A far end
   * that has stopped talking is detected in this long rather than in
   * DEADLINE_MS, which matters because the deadline is only checked between
   * reads. 4s absorbs a Wi-Fi retransmission burst; 1s would fail healthy
   * downloads on a busy channel.
   */
  STALL_MS = 4000,
  /*
   * Compressed body cap, enforced against Content-Length before allocating and
   * again while reading, because Content-Length is a claim and can be absent
   * or a lie. 384KB is far above any baseline JPEG that decodes to at most one
   * 368x448 panel (those run 20-80KB, and 384KB still covers an unoptimised
   * encoder plus a fat EXIF thumbnail and ICC profile), and low enough that
   * even a 300kbit/s link finishes inside DEADLINE_MS.
   */
  MAX_BODY_BYTES = 384 * 1024,
  /*
   * Bytes asked for per esp_http_client_read. This is the granularity at which
   * the deadline is re-checked, so smaller is tighter; 1KB costs ~400 calls for
   * a large image, which is nothing next to the TLS work already happening.
   */
  READ_CHUNK_BYTES = 1024,
  /*
   * Socket timeout for the DRAIN read: long enough to collect a segment that
   * has already arrived, far too short to wait for one that has not.
   *
   * This is the whole defence against a read that never returns. esp_http_client
   * _read loops internally until the buffer it was given is FULL, and every byte
   * that turns up resets the socket wait — so one call asking for 1024 bytes
   * against a server dribbling a byte every few seconds does not come back for
   * roughly an hour, and the deadline check above it never gets a turn. Measured:
   * such a server held the worker past 40s and disabled showImage entirely.
   *
   * So a read is never allowed to wait for bytes it has not got. Waiting happens
   * only in the one-byte progress read below, which cannot aggregate because one
   * byte is all it asks for. Worst-case overshoot past the deadline is therefore
   * READ_CHUNK_BYTES x DRAIN_MS, about two seconds, and only against a peer
   * pacing itself precisely under this bound.
   */
  DRAIN_MS = 2,
  /*
   * KNOWN LIMIT, measured rather than assumed. esp_http_client_read loops
   * internally until it has the count asked for, so a server dribbling one byte
   * just under each socket timeout keeps one read call alive far past the total
   * deadline: a 1-byte-per-3s server held the worker beyond 40s and every later
   * showImage was refused while it sat there. The CALLER is protected — the
   * deferred reply fails at IMAGE_REPLY_DEADLINE_MS in waveshare_tools.c — and
   * the worker recovers once the read returns. Shortening this bound to 1000ms
   * was tried and REVERTED: it took the device's WebSocket down inside one test,
   * whereas 4000ms passed the whole verification suite.
   */
  /*
   * Redirects followed. Image URLs redirect constantly — CDNs, storage
   * buckets, short links — so refusing them outright would fail on ordinary
   * inputs. Each hop costs a fresh TLS handshake against the deadline, which is
   * why the count is small; the deadline, not this number, is what stops a
   * redirect loop.
   */
  MAX_REDIRECTS = 3,
  /*
   * TJpgDec work area. Its documented minimum for a baseline image is about
   * 3100 bytes (stream buffer, Huffman and quantisation tables, MCU and IDCT
   * scratch); this doubles it so an image carrying all four quantisation
   * tables and 16x16 MCUs still fits. It is the only internal-RAM allocation
   * in this module and is freed before the call returns. jd_prepare reports
   * JDR_MEM1 if it is ever short, which surfaces as NO_MEMORY rather than as a
   * mis-decode.
   */
  WORK_POOL_BYTES = 6144,
  /*
   * Receive buffer for header parsing. A single header line must fit, and 512
   * (the IDF default) is uncomfortably close to the length of a signed-URL
   * Location header.
   */
  HTTP_RX_BUFFER_BYTES = 1024,
  /*
   * The request line carries the whole URL, so the transmit buffer has to hold
   * MAX_URL_BYTES plus the headers around it.
   */
  HTTP_TX_BUFFER_BYTES = 2048,
  /*
   * URL length cap, terminator included. Presigned storage URLs routinely
   * reach ~700 characters of signature query string, so the bound sits above
   * that; anything longer is far more likely to be a mistake than a URL, and
   * refusing it at the door keeps it out of the transmit buffer sizing above.
   */
  MAX_URL_BYTES = 1024,
  /* TJpgDec with JD_FORMAT 0 emits three bytes per pixel. */
  RGB888_BYTES_PER_PIXEL = 3,
  /* jd_decomp scale exponent 0 is 1:1. Anything the panel cannot show is
   * refused rather than shrunk, so the caller is never handed a picture at a
   * size it did not ask for. */
  JPEG_SCALE_NONE = 0,
};

/**
 * The one bitmap this module may be holding.
 *
 * `pixels` non-NULL is the whole definition of "occupied": it is what makes
 * fetch return BUSY and what release keys off, so there is no second flag to
 * fall out of step with the allocation.
 */
static struct {
  uint16_t *pixels;
  uint16_t width;
  uint16_t height;
} held;

/**
 * The compressed body while it is being read.
 *
 * `capacity` is what was allocated and `length` what has arrived; the gap is
 * how the byte cap is enforced without trusting the server, since reads are
 * always sized to what is left rather than to what was promised.
 */
struct download {
  uint8_t *bytes;
  size_t capacity;
  size_t length;
};

/**
 * What the two TJpgDec callbacks share, reached through JDEC::device.
 *
 * The input side walks `bytes`; the output side fills `pixels`. `deadline_ms`
 * is here so the decode is bounded by the same clock as the download — a large
 * image on a busy CPU is the one place decode time is worth checking. The two
 * flags exist because jd_decomp collapses every callback refusal into
 * JDR_INTR, and "ran out of time" and "wanted to write outside the buffer" are
 * different bugs that must not report as one status.
 */
struct jpeg_source {
  const uint8_t *bytes;
  size_t length;
  size_t offset;
  uint16_t *pixels;
  uint16_t width;
  uint16_t height;
  int64_t deadline_ms;
  bool timed_out;
  bool outside_bitmap;
};

const char *waveshare_image_status_name(enum waveshare_image_status status) {
  switch (status) {
    case WAVESHARE_IMAGE_OK: return "ok";
    case WAVESHARE_IMAGE_BAD_URL: return "bad-url";
    case WAVESHARE_IMAGE_UNREACHABLE: return "unreachable";
    case WAVESHARE_IMAGE_HTTP_ERROR: return "http-error";
    case WAVESHARE_IMAGE_TOO_LARGE: return "too-large";
    case WAVESHARE_IMAGE_UNSUPPORTED: return "unsupported";
    case WAVESHARE_IMAGE_DECODE_FAILED: return "decode-failed";
    case WAVESHARE_IMAGE_TIMEOUT: return "timeout";
    case WAVESHARE_IMAGE_NO_MEMORY: return "no-memory";
    case WAVESHARE_IMAGE_BUSY: return "busy";
    default: break;
  }
  /* Reached only if an enumerator is added without a name for it. */
  return "unknown";
}

static int64_t now_ms(void) {
  return esp_timer_get_time() / 1000;
}

static bool deadline_passed(int64_t deadline_ms) {
  return now_ms() >= deadline_ms;
}

/**
 * How long one socket operation may block: the stall bound, or less when the
 * deadline is closer than that.
 *
 * Shrinking with the remaining budget is what stops the last read of a dying
 * transfer from overshooting the deadline by a full stall period.
 */
static int socket_timeout_ms(int64_t deadline_ms) {
  const int64_t left = deadline_ms - now_ms();

  if (left <= 0) return 1;
  if (left < (int64_t)STALL_MS) return (int)left;
  return STALL_MS;
}

static bool is_https_url(const char *url) {
  return strncmp(url, "https://", sizeof("https://") - 1U) == 0;
}

static bool is_http_url(const char *url) {
  return strncmp(url, "http://", sizeof("http://") - 1U) == 0;
}

static enum waveshare_image_status check_url(const char *url) {
  size_t length;

  if (url == NULL) return WAVESHARE_IMAGE_BAD_URL;
  length = strlen(url);
  if (length == 0U || length >= (size_t)MAX_URL_BYTES) {
    ESP_LOGW(tag, "url is empty or longer than %d bytes", MAX_URL_BYTES);
    return WAVESHARE_IMAGE_BAD_URL;
  }
  /*
   * Scheme is checked here rather than left to esp_http_client so that file://
   * or a bare host is a named refusal instead of an INVALID_TRANSPORT deep in
   * the client. Only these two schemes reach the network from this module.
   */
  if (is_https_url(url) || is_http_url(url)) return WAVESHARE_IMAGE_OK;
  ESP_LOGW(tag, "url is neither http nor https");
  return WAVESHARE_IMAGE_BAD_URL;
}

/**
 * Send the request and read the response headers.
 *
 * Returns OK only on 200 with `content_length` set to the declared body size,
 * or 0 when the response is chunked or declares nothing. HTTP_ERROR means the
 * status line is not 200 and the caller may inspect the code to decide whether
 * it is a redirect worth following.
 */
static enum waveshare_image_status send_request(
    esp_http_client_handle_t client, int64_t deadline_ms,
    int64_t *content_length) {
  int64_t declared;

  if (deadline_passed(deadline_ms)) return WAVESHARE_IMAGE_TIMEOUT;
  (void)esp_http_client_set_timeout_ms(client, socket_timeout_ms(deadline_ms));
  if (esp_http_client_open(client, 0) != ESP_OK) {
    return WAVESHARE_IMAGE_UNREACHABLE;
  }
  /*
   * EAGAIN means this socket read hit STALL_MS, not that the fetch is over —
   * so keep asking while the overall deadline allows, exactly as read_body
   * does. Giving up on the first one cost more than a slow success: the status
   * code is not known until the headers arrive, so a 404 from a server that
   * took longer than STALL_MS to answer was reported as "timeout" instead of
   * "http-error", which sends the caller looking for a network fault that was
   * never there.
   */
  for (;;) {
    declared = esp_http_client_fetch_headers(client);
    if (declared != -ESP_ERR_HTTP_EAGAIN) break;
    if (deadline_passed(deadline_ms)) return WAVESHARE_IMAGE_TIMEOUT;
    (void)esp_http_client_set_timeout_ms(client, socket_timeout_ms(deadline_ms));
  }
  if (declared < 0) return WAVESHARE_IMAGE_UNREACHABLE;
  if (esp_http_client_get_status_code(client) != HttpStatus_Ok) {
    return WAVESHARE_IMAGE_HTTP_ERROR;
  }
  *content_length = declared;
  return WAVESHARE_IMAGE_OK;
}

/**
 * Point the client at the Location header of the response it is holding.
 *
 * The socket is closed first: reusing it would send the next request to the old
 * host, and a redirect that stays on the same host is the uncommon case.
 */
static bool follow_redirect(esp_http_client_handle_t client) {
  (void)esp_http_client_close(client);
  return esp_http_client_set_redirection(client) == ESP_OK;
}

static bool is_redirect(int status_code) {
  return status_code >= HttpStatus_MultipleChoices &&
         status_code < HttpStatus_BadRequest;
}

/**
 * Whether the URL the client now points at may still be fetched.
 *
 * A redirect chain is chosen by the server, so the scheme rule that applied to
 * the caller's URL has to be applied again at every hop — otherwise one
 * Location header turns a validated TLS fetch into cleartext, and the
 * certificate bundle this module attaches stops meaning anything. Only the
 * scheme is wanted, so the buffer is deliberately short and the truncating
 * snprintf inside esp_http_client_get_url does the rest; it also keeps a signed
 * URL's query string out of the log line below.
 */
static bool redirect_target_allowed(
    esp_http_client_handle_t client, bool tls_required) {
  char url[sizeof("https://") + 8U];

  if (esp_http_client_get_url(client, url, (int)sizeof url) != ESP_OK) {
    return false;
  }
  if (is_https_url(url)) return true;
  if (tls_required) {
    ESP_LOGW(tag, "refusing an https to http downgrade at %s", url);
    return false;
  }
  return is_http_url(url);
}

/** Get to a 200 response, following at most MAX_REDIRECTS hops to find one. */
static enum waveshare_image_status open_response(
    esp_http_client_handle_t client, bool tls_required, int64_t deadline_ms,
    int64_t *content_length) {
  int hop;

  for (hop = 0; hop <= MAX_REDIRECTS; ++hop) {
    const enum waveshare_image_status status =
        send_request(client, deadline_ms, content_length);
    const int code = esp_http_client_get_status_code(client);
    if (status != WAVESHARE_IMAGE_HTTP_ERROR) return status;
    if (!is_redirect(code)) {
      ESP_LOGW(tag, "http %d", code);
      return WAVESHARE_IMAGE_HTTP_ERROR;
    }
    if (hop == MAX_REDIRECTS) break;
    /* No Location header, or one esp_http_client will not parse. */
    if (!follow_redirect(client)) return WAVESHARE_IMAGE_HTTP_ERROR;
    if (!redirect_target_allowed(client, tls_required)) {
      return WAVESHARE_IMAGE_BAD_URL;
    }
  }
  ESP_LOGW(tag, "more than %d redirects", MAX_REDIRECTS);
  return WAVESHARE_IMAGE_HTTP_ERROR;
}

/**
 * Reserve room for the body, refusing anything past the cap before allocating.
 *
 * A server that declares nothing (chunked, or no Content-Length) gets the full
 * cap reserved rather than a buffer that grows: a realloc walk would hold two
 * copies at the moment it doubles, which is worse for PSRAM fragmentation than
 * one honest 384KB reservation that lives for a few seconds.
 */
static enum waveshare_image_status reserve_body(
    int64_t declared_length, struct download *download) {
  if (declared_length > (int64_t)MAX_BODY_BYTES) {
    ESP_LOGW(
        tag, "content-length %lld is past the %d byte cap",
        (long long)declared_length, MAX_BODY_BYTES);
    return WAVESHARE_IMAGE_TOO_LARGE;
  }
  download->capacity = declared_length > 0 ? (size_t)declared_length
                                           : (size_t)MAX_BODY_BYTES;
  download->bytes = heap_caps_malloc(download->capacity, MALLOC_CAP_SPIRAM);
  if (download->bytes == NULL) {
    ESP_LOGE(tag, "no psram for a %u byte body", (unsigned)download->capacity);
    return WAVESHARE_IMAGE_NO_MEMORY;
  }
  download->length = 0U;
  return WAVESHARE_IMAGE_OK;
}

/**
 * Decide what a body that stopped arriving means.
 *
 * Filling the buffer without the client agreeing the response is complete is
 * the "Content-Length lied, or there was none" case, and it is the only reason
 * this returns TOO_LARGE. A short body is reported as DECODE_FAILED because a
 * truncated JPEG is exactly what the caller has, whatever the transport thought
 * it was doing.
 */
static enum waveshare_image_status body_verdict(
    esp_http_client_handle_t client, const struct download *download) {
  if (!esp_http_client_is_complete_data_received(client)) {
    if (download->length >= download->capacity) {
      ESP_LOGW(tag, "body exceeds the %d byte cap", MAX_BODY_BYTES);
      return WAVESHARE_IMAGE_TOO_LARGE;
    }
    ESP_LOGW(tag, "body ended after %u bytes", (unsigned)download->length);
    return WAVESHARE_IMAGE_DECODE_FAILED;
  }
  if (download->length == 0U) {
    ESP_LOGW(tag, "200 with an empty body");
    return WAVESHARE_IMAGE_DECODE_FAILED;
  }
  return WAVESHARE_IMAGE_OK;
}

/**
 * Read the body into the reserved buffer.
 *
 * The deadline is re-checked before every read and the socket timeout is
 * re-derived from it, so a far end that goes quiet costs one stall period and a
 * far end that never finishes costs the deadline. What this does NOT bound is a
 * server that delivers one byte just before every socket timeout expires:
 * esp_http_client_read loops internally until it has the bytes it was asked
 * for, so such a peer can hold a single call for up to READ_CHUNK_BYTES stall
 * periods. Bounding that properly needs the blocking read interrupted from
 * another task, which is not worth a task and its stack here; the chunk is kept
 * small partly to keep that product small.
 */
static enum waveshare_image_status read_body(
    esp_http_client_handle_t client, int64_t deadline_ms,
    struct download *download) {
  while (download->length < download->capacity) {
    size_t room;
    size_t ask;
    int taken;

    if (deadline_passed(deadline_ms)) return WAVESHARE_IMAGE_TIMEOUT;

    /*
     * ONE byte, and this is the only read allowed to wait. Asking for one is
     * what makes it return as soon as anything arrives instead of holding on
     * for a full buffer — see DRAIN_MS for what that cost before.
     */
    (void)esp_http_client_set_timeout_ms(client, socket_timeout_ms(deadline_ms));
    taken = esp_http_client_read(
        client, (char *)(download->bytes + download->length), 1);
    if (taken == 0) break; /* Nothing more is coming; body_verdict says why. */
    /*
     * A read that timed out with nothing to show is not fatal on its own — a
     * stalled radio recovers — so the loop tries again and lets the deadline
     * above be the thing that gives up. The yield keeps a retry storm off the
     * back of the audio WebSocket sharing this chip.
     */
    if (taken == -ESP_ERR_HTTP_EAGAIN) {
      vTaskDelay(1);
      continue;
    }
    if (taken < 0) return WAVESHARE_IMAGE_UNREACHABLE;
    download->length += (size_t)taken;
    if (download->length >= download->capacity) break;

    /*
     * Now take whatever else is ALREADY buffered. This is where throughput
     * comes from: on a healthy fetch the segment is sitting there and this
     * collects it in one call. It must never wait, which is what DRAIN_MS
     * enforces.
     */
    room = download->capacity - download->length;
    ask = room < (size_t)READ_CHUNK_BYTES ? room : (size_t)READ_CHUNK_BYTES;
    (void)esp_http_client_set_timeout_ms(client, DRAIN_MS);
    taken = esp_http_client_read(
        client, (char *)(download->bytes + download->length), (int)ask);
    if (taken > 0) {
      download->length += (size_t)taken;
      continue;
    }
    /* Empty or timed out is ordinary here: the next progress read decides. */
    if (taken < 0 && taken != -ESP_ERR_HTTP_EAGAIN) {
      return WAVESHARE_IMAGE_UNREACHABLE;
    }
  }
  return body_verdict(client, download);
}

/** Fetch the compressed body into `download`, which the caller frees. */
static enum waveshare_image_status download_body(
    const char *url, int64_t deadline_ms, struct download *download) {
  const esp_http_client_config_t config = {
    .url = url,
    .timeout_ms = STALL_MS,
    .buffer_size = HTTP_RX_BUFFER_BYTES,
    .buffer_size_tx = HTTP_TX_BUFFER_BYTES,
    /*
     * The same certificate validation the WebSocket transport uses
     * (platforms/iterate_esp_idf/websocket_connection.c): the compiled-in
     * mbedTLS root bundle. A device that will render whatever an agent points
     * it at has no business accepting an unvalidated peer.
     */
    .crt_bundle_attach = esp_crt_bundle_attach,
    /*
     * Redirects are followed by hand in open_response, because the automatic
     * path only exists inside esp_http_client_perform, and perform cannot
     * enforce a byte cap while the body streams.
     */
    .disable_auto_redirect = true,
  };
  const bool tls_required = is_https_url(url);
  esp_http_client_handle_t client;
  enum waveshare_image_status status;
  int64_t content_length = 0;

  client = esp_http_client_init(&config);
  if (client == NULL) return WAVESHARE_IMAGE_NO_MEMORY;
  /* Says what we can decode, so a server that can serve either sends JPEG. */
  (void)esp_http_client_set_header(client, "Accept", "image/jpeg,image/*;q=0.5");
  status = open_response(client, tls_required, deadline_ms, &content_length);
  if (status == WAVESHARE_IMAGE_OK) {
    status = reserve_body(content_length, download);
  }
  if (status == WAVESHARE_IMAGE_OK) {
    status = read_body(client, deadline_ms, download);
  }
  (void)esp_http_client_close(client);
  (void)esp_http_client_cleanup(client);
  return status;
}

/**
 * Feed the decoder from the buffered body.
 *
 * TJpgDec passes a NULL destination to mean "skip these bytes", which for an
 * in-memory source is the same bookkeeping as a read. Returning fewer bytes
 * than asked for is how the end of a truncated file is reported; the decoder
 * turns that into JDR_INP.
 */
static UINT jpeg_input(JDEC *decoder, BYTE *buffer, UINT length) {
  struct jpeg_source *source = (struct jpeg_source *)decoder->device;
  const size_t remaining = source->length - source->offset;
  const size_t take = (size_t)length < remaining ? (size_t)length : remaining;

  if (buffer != NULL) {
    memcpy(buffer, source->bytes + source->offset, take);
  }
  source->offset += take;
  return (UINT)take;
}

static uint16_t to_rgb565(const uint8_t *rgb888) {
  const unsigned int red = (unsigned int)rgb888[0];
  const unsigned int green = (unsigned int)rgb888[1];
  const unsigned int blue = (unsigned int)rgb888[2];

  return (uint16_t)(
      ((red & 0xF8U) << 8) | ((green & 0xFCU) << 3) | (blue >> 3));
}

static void convert_row(
    const struct jpeg_source *source, const uint8_t *rgb888, unsigned int left,
    unsigned int row, unsigned int count) {
  uint16_t *destination =
      source->pixels + (size_t)row * (size_t)source->width + (size_t)left;
  unsigned int column;

  for (column = 0U; column < count; ++column) {
    destination[column] =
        to_rgb565(&rgb888[(size_t)column * (size_t)RGB888_BYTES_PER_PIXEL]);
  }
}

/**
 * Take one decoded block, converting ROM TJpgDec's RGB888 to the panel's
 * RGB565 on the way in.
 *
 * Converting here rather than afterwards is what keeps peak memory at one
 * RGB565 panel: a whole-image RGB888 intermediate would be 3/2 as large again
 * and would exist at the same time as the destination.
 *
 * Returning 0 aborts the decode. The rect check is not defensive decoration —
 * the destination was sized from the header the same decoder parsed, so a rect
 * outside it means the two disagree, and clamping would write into whatever
 * PSRAM follows.
 */
static UINT jpeg_output(JDEC *decoder, void *bitmap, JRECT *rect) {
  struct jpeg_source *source = (struct jpeg_source *)decoder->device;
  const uint8_t *rgb888 = (const uint8_t *)bitmap;
  const unsigned int left = (unsigned int)rect->left;
  const unsigned int top = (unsigned int)rect->top;
  const unsigned int bottom = (unsigned int)rect->bottom;
  const unsigned int width = (unsigned int)(rect->right - rect->left) + 1U;
  const size_t stride = (size_t)width * (size_t)RGB888_BYTES_PER_PIXEL;
  unsigned int row;

  if (deadline_passed(source->deadline_ms)) {
    source->timed_out = true;
    return 0U;
  }
  if (rect->right >= source->width || rect->bottom >= source->height) {
    source->outside_bitmap = true;
    return 0U;
  }
  for (row = top; row <= bottom; ++row) {
    convert_row(
        source, rgb888 + (size_t)(row - top) * stride, left, row, width);
  }
  return 1U;
}

/**
 * Translate a decoder result.
 *
 * The distinction that earns its keep is JDR_FMT2/JDR_FMT3 against JDR_FMT1:
 * a progressive or arithmetic-coded JPEG is a file we will never read and the
 * caller should stop asking, whereas damaged data may well be a retry away
 * from working.
 */
static enum waveshare_image_status from_jpeg_result(JRESULT result) {
  switch (result) {
    case JDR_OK: return WAVESHARE_IMAGE_OK;
    case JDR_MEM1:
    case JDR_MEM2: return WAVESHARE_IMAGE_NO_MEMORY;
    case JDR_FMT2:
    case JDR_FMT3: return WAVESHARE_IMAGE_UNSUPPORTED;
    default: break;
  }
  /* JDR_INP (truncated), JDR_FMT1 (damaged), JDR_PAR, JDR_INTR. */
  return WAVESHARE_IMAGE_DECODE_FAILED;
}

/**
 * Size and allocate the destination from the header the decoder just parsed.
 *
 * The panel is the bound in both senses the brief asks for: nothing larger can
 * be shown, and one panel of RGB565 (368*448*2 = 329,728 bytes) is the memory
 * budget this module is allowed to hold. Oversized images are refused rather
 * than downscaled, so the caller is never handed dimensions it did not ask for.
 */
static enum waveshare_image_status reserve_pixels(
    const JDEC *decoder, struct jpeg_source *source) {
  size_t bytes;

  if (decoder->width == 0U || decoder->height == 0U) {
    return WAVESHARE_IMAGE_DECODE_FAILED;
  }
  if (decoder->width > (UINT)WAVESHARE_DISPLAY_WIDTH ||
      decoder->height > (UINT)WAVESHARE_DISPLAY_HEIGHT) {
    ESP_LOGW(
        tag, "%ux%u is larger than the %dx%d panel", decoder->width,
        decoder->height, (int)WAVESHARE_DISPLAY_WIDTH,
        (int)WAVESHARE_DISPLAY_HEIGHT);
    return WAVESHARE_IMAGE_TOO_LARGE;
  }
  bytes = (size_t)decoder->width * (size_t)decoder->height * sizeof(uint16_t);
  source->pixels = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
  if (source->pixels == NULL) {
    ESP_LOGE(tag, "no psram for %u pixel bytes", (unsigned)bytes);
    return WAVESHARE_IMAGE_NO_MEMORY;
  }
  source->width = (uint16_t)decoder->width;
  source->height = (uint16_t)decoder->height;
  return WAVESHARE_IMAGE_OK;
}

/** Refuse anything that is not a baseline-or-progressive JPEG stream. */
static bool looks_like_jpeg(const struct download *download) {
  static const uint8_t signature[] = {0xFFU, 0xD8U, 0xFFU};

  if (download->length < sizeof signature) return false;
  return memcmp(download->bytes, signature, sizeof signature) == 0;
}

/**
 * Say what arrived instead of a JPEG.
 *
 * The first four bytes are the useful diagnostic — they name PNG, GIF, BMP and
 * WebP on sight, and an HTML error page served with a 200 is unmistakable — but
 * a body shorter than that exists (a one-byte Content-Length is legal), so the
 * length is checked against what was actually read rather than against what a
 * signature would need.
 */
static void log_not_jpeg(const struct download *download) {
  enum { SIGNATURE_LOG_BYTES = 4 };

  if (download->length < (size_t)SIGNATURE_LOG_BYTES) {
    ESP_LOGW(
        tag, "%u bytes is too short to be an image",
        (unsigned)download->length);
    return;
  }
  ESP_LOGW(
      tag, "%u bytes starting %02x %02x %02x %02x: not a jpeg",
      (unsigned)download->length, (unsigned)download->bytes[0],
      (unsigned)download->bytes[1], (unsigned)download->bytes[2],
      (unsigned)download->bytes[3]);
}

/**
 * Decode the buffered body into a fresh PSRAM bitmap.
 *
 * On any failure this frees everything it took, including a pixel buffer that
 * was allocated before the decode went wrong, so the caller's slot stays empty.
 * The work area is asked of internal RAM first because TJpgDec walks its
 * Huffman tables per bit; PSRAM works and is the fallback when the internal
 * heap is tight, at perhaps an order of magnitude on decode time. Either way it
 * must be a whole allocation rather than an offset into a larger buffer:
 * TJpgDec sub-allocates 4-byte-aligned words from the base it is given and
 * relies on that base already being aligned, which is true of heap_caps_malloc
 * and not true of an arbitrary pointer into someone else's memory.
 */
static enum waveshare_image_status decode_jpeg(
    const struct download *download, int64_t deadline_ms,
    struct jpeg_source *source) {
  JDEC decoder;
  void *pool;
  enum waveshare_image_status status;
  JRESULT result;

  pool = heap_caps_malloc(
      (size_t)WORK_POOL_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (pool == NULL) {
    pool = heap_caps_malloc((size_t)WORK_POOL_BYTES, MALLOC_CAP_SPIRAM);
  }
  if (pool == NULL) return WAVESHARE_IMAGE_NO_MEMORY;

  source->bytes = download->bytes;
  source->length = download->length;
  source->deadline_ms = deadline_ms;
  result = jd_prepare(
      &decoder, jpeg_input, pool, (UINT)WORK_POOL_BYTES, source);
  status = from_jpeg_result(result);
  if (status == WAVESHARE_IMAGE_OK) status = reserve_pixels(&decoder, source);
  if (status == WAVESHARE_IMAGE_OK) {
    status = from_jpeg_result(jd_decomp(&decoder, jpeg_output, JPEG_SCALE_NONE));
    if (source->timed_out) status = WAVESHARE_IMAGE_TIMEOUT;
    if (source->outside_bitmap) {
      /*
       * The decoder disagreed with the size it reported from the same header,
       * so the abort was not ordinary corruption. Worth a line of its own: the
       * status says decode-failed either way, and only this distinguishes a
       * broken file from a decoder we are driving wrongly.
       */
      ESP_LOGE(tag, "decoder addressed pixels outside the bitmap it sized");
    }
  }
  heap_caps_free(pool);
  if (status == WAVESHARE_IMAGE_OK) return WAVESHARE_IMAGE_OK;
  heap_caps_free(source->pixels);
  source->pixels = NULL;
  return status;
}

/**
 * Take ownership of the decoded pixels and hand the caller a view of them.
 *
 * The slot and the caller's struct are filled from one place so they cannot
 * come to disagree: what makes the module BUSY is exactly what the caller was
 * given, and release frees exactly that.
 */
static void hold(
    const struct jpeg_source *source, struct waveshare_image_bitmap *bitmap) {
  held.pixels = source->pixels;
  held.width = source->width;
  held.height = source->height;
  bitmap->pixels = held.pixels;
  bitmap->width = held.width;
  bitmap->height = held.height;
}

enum waveshare_image_status waveshare_image_fetch(
    const char *url, struct waveshare_image_bitmap *bitmap) {
  const int64_t deadline_ms = now_ms() + DEADLINE_MS;
  struct download download = {NULL, 0U, 0U};
  struct jpeg_source source;
  enum waveshare_image_status status;

  assert(bitmap != NULL);
  /* Cleared first, so a caller that ignores the status sees no pixels. */
  bitmap->pixels = NULL;
  bitmap->width = 0U;
  bitmap->height = 0U;
  memset(&source, 0, sizeof source);
  if (held.pixels != NULL) return WAVESHARE_IMAGE_BUSY;

  status = check_url(url);
  if (status == WAVESHARE_IMAGE_OK) {
    status = download_body(url, deadline_ms, &download);
  }
  if (status == WAVESHARE_IMAGE_OK && !looks_like_jpeg(&download)) {
    log_not_jpeg(&download);
    status = WAVESHARE_IMAGE_UNSUPPORTED;
  }
  if (status == WAVESHARE_IMAGE_OK) {
    status = decode_jpeg(&download, deadline_ms, &source);
  }
  /* The compressed body has no reader after the decode, on any path. */
  heap_caps_free(download.bytes);
  if (status != WAVESHARE_IMAGE_OK) {
    ESP_LOGW(tag, "fetch failed: %s", waveshare_image_status_name(status));
    return status;
  }
  hold(&source, bitmap);
  ESP_LOGI(
      tag, "decoded %ux%u from %u bytes", held.width, held.height,
      (unsigned)download.length);
  return WAVESHARE_IMAGE_OK;
}

void waveshare_image_release(void) {
  if (held.pixels == NULL) return;
  heap_caps_free(held.pixels);
  held.pixels = NULL;
  held.width = 0U;
  held.height = 0U;
}
