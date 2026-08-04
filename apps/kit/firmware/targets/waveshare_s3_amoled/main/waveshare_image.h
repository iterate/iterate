#ifndef ITERATE_KIT_WAVESHARE_IMAGE_H
#define ITERATE_KIT_WAVESHARE_IMAGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * One picture off the network, decoded into pixels the panel can take.
 *
 * The device shows things an agent chose: a photograph, a chart, a frame from
 * somewhere else. Getting one onto the screen is two separable problems —
 * getting the bytes and drawing them — and only the first is dangerous. A
 * remote URL is attacker-controlled input on a device with 8MB of PSRAM, a
 * single application task, and an audio path that must not stall. So this
 * module is fetch and decode ONLY: no display, no LVGL, no RPC. It hands back
 * a buffer and the caller decides what to do with it.
 *
 * What it guarantees:
 *
 *  - Bounded time. Every call returns, whatever the far end does. Nothing here
 *    waits indefinitely on a socket, and the decode is checked against the
 *    same deadline as the download.
 *  - Bounded bytes. A body past the cap is refused, and so are decoded
 *    dimensions larger than the panel. Both bounds are named constants in
 *    waveshare_image.c with the reasoning for their values.
 *  - Bounded memory. The download buffer and the pixels are PSRAM; the only
 *    internal-RAM allocation this module makes is the decoder's few-KB work
 *    area, freed before the call returns. On every failure path the module owns
 *    nothing.
 *
 * The cost NOT on this module's books is the TLS session esp_http_client opens
 * underneath it. mbedTLS takes its record buffers from the internal heap in
 * this build (MBEDTLS_SSL_IN_CONTENT_LEN 16384 plus OUT 4096, and
 * MBEDTLS_EXTERNAL_MEM_ALLOC off), so an https fetch wants roughly 20KB of
 * internal RAM for as long as it runs — on top of the session the WebSocket
 * transport is already holding. That is a configured capacity read off
 * sdkconfig, not a measurement. A device whose internal heap is already thin
 * will fail here as UNREACHABLE, out of the TLS handshake, rather than as
 * NO_MEMORY.
 *
 * What it does NOT guarantee:
 *
 *  - Thread safety. There is one slot and no lock. THE CALLER SERIALISES:
 *    call fetch, use the bitmap, call release, from one task. Two tasks
 *    fetching at once will corrupt the slot, and BUSY will not save them.
 *  - Promptness. fetch() blocks for as long as its deadline allows, which is
 *    seconds. It is for a task that can afford to stop — not the audio path,
 *    and not an LVGL callback.
 *  - Every format. JPEG only; see waveshare_image_fetch.
 */

/**
 * A decoded image ready to hand to the display. Pixels live in PSRAM.
 *
 * The pixels are owned by this module, not by the caller: valid from a
 * successful fetch until waveshare_image_release, and dangling after it. A
 * caller that hands the pointer to something with its own lifetime (an LVGL
 * image descriptor, say) must drop that reference before releasing.
 *
 * RGB565 here means one uint16_t per pixel in native byte order, red in the
 * top 5 bits. That is what LV_COLOR_FORMAT_RGB565 expects, so it can be
 * pointed at directly; a panel that wants the bytes the other way round is
 * asking for a transform at draw time, which is the caller's business.
 */
struct waveshare_image_bitmap {
  const uint16_t *pixels; /* RGB565, row-major, width*height entries */
  uint16_t width;
  uint16_t height;
};

/**
 * Why a fetch failed. Every failure is nameable; none are swallowed.
 *
 * The distinctions are the ones a person debugging the device needs: whether
 * to fix the URL, the network, the server, or the image. BAD_URL and
 * UNSUPPORTED will never succeed on retry; UNREACHABLE and TIMEOUT might.
 */
enum waveshare_image_status {
  WAVESHARE_IMAGE_OK = 0,
  WAVESHARE_IMAGE_BAD_URL,       /* not http/https, too long, empty */
  WAVESHARE_IMAGE_UNREACHABLE,   /* DNS/TCP/TLS failure */
  WAVESHARE_IMAGE_HTTP_ERROR,    /* non-200 */
  WAVESHARE_IMAGE_TOO_LARGE,     /* body or dimensions past the bound */
  WAVESHARE_IMAGE_UNSUPPORTED,   /* not a format we decode */
  WAVESHARE_IMAGE_DECODE_FAILED, /* truncated or corrupt */
  WAVESHARE_IMAGE_TIMEOUT,       /* wall-clock bound hit */
  WAVESHARE_IMAGE_NO_MEMORY,
  WAVESHARE_IMAGE_BUSY, /* one already held; release it first */
};

/**
 * Human-readable status, for logs and RPC errors.
 *
 * Short lowercase words, stable across builds, safe to put in a message an
 * agent reads back: the caller should not have to keep its own table, and two
 * tables would drift.
 */
const char *waveshare_image_status_name(enum waveshare_image_status status);

/**
 * Fetch and decode into `bitmap`. Blocking, but bounded in bytes AND time.
 * Single slot: returns BUSY if a bitmap is already held.
 *
 * `bitmap` must not be NULL and is cleared before anything else, so a caller
 * that ignores the status still sees no pixels rather than a stale pointer.
 *
 * Baseline JPEG is the only format decoded, because it is the only decoder
 * already on the chip — the ESP32-S3 mask ROM carries TJpgDec — and because it
 * is also the smallest download for a photograph. Anything else, PNG
 * included, is refused as UNSUPPORTED off its magic bytes rather than being
 * fed to a decoder that would call it corrupt. Progressive JPEG is refused the
 * same way, one step later, when the decoder reports the standard it cannot
 * read.
 *
 * http and https URLs are fetched and nothing else. Redirects are followed, a
 * few hops at most, because CDNs and storage buckets make them ordinary — but
 * an https URL that redirects to http is refused as BAD_URL rather than
 * followed, since the certificate check this module performs would otherwise
 * come undone at a hop the caller never saw.
 *
 * Blocking is on the caller's task for up to the deadline in
 * waveshare_image.c. Nothing else on the device is serviced during that time,
 * which is why the intended caller is a between-turns action rather than
 * anything on the audio or WebSocket path.
 */
enum waveshare_image_status waveshare_image_fetch(
    const char *url, struct waveshare_image_bitmap *bitmap);

/**
 * Release the held bitmap. Safe to call when nothing is held.
 *
 * This is the only way the slot reopens: a failed fetch already leaves the
 * module holding nothing, so the pairing to get right is one successful fetch
 * to one release. Skipping it costs one panel of PSRAM and makes every later
 * fetch return BUSY, which is the loud failure it should be — the alternative,
 * silently evicting a bitmap the display may still be reading from, would show
 * up as a torn screen much later.
 */
void waveshare_image_release(void);

#ifdef __cplusplus
}
#endif

#endif
