/*
 * The SD card as a flight recorder: one directory per session, wiped when a
 * call starts, holding both PCM lanes and a line log.
 *
 * Writes happen on the tasks that already own each lane (capture drains on
 * the app loop, playback on its own task), so nothing is queued or copied a
 * second time. FatFs buffers internally and the streams are flushed on the
 * log path, which is low rate; the audio files are flushed when the call
 * ends. A missing or unwritable card disables recording rather than failing
 * a call — the recorder is diagnostics, never the product.
 */
#include "waveshare_recorder.h"

#include <dirent.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "bsp/esp-bsp.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

static const char tag[] = "waveshare-recorder";

#define RECORDING_DIR BSP_SD_MOUNT_POINT "/iterate"

enum {
  /*
   * A second of audio per lane in PSRAM. The card is usually far faster than
   * realtime; this only has to cover the occasional multi-hundred-millisecond
   * erase, and dropping recorder bytes is always better than dropping audio.
   */
  LANE_BUFFER_BYTES = 64 * 1024,
};

static struct {
  bool mounted;
  /*
   * Whether a call is being recorded, as a fact of its OWN — not inferred
   * from a FILE* that half a dozen paths may close. "Is the log handle
   * non-null" answered a different question (are the files open right now)
   * and every disagreement became a re-request from a 5 ms poll loop: the
   * card was wiped and reopened seven times a second, which is what the
   * serial log shows as "recording begins" over and over.
   */
  bool call_open;
  /* How many times a recording was opened and closed; hammering shows here. */
  uint32_t begins;
  uint32_t ends;
  FILE *mic;
  FILE *speaker;
  FILE *log;
  uint64_t call_started_ms;
  /* What we believe we wrote, independent of what the filesystem reports. */
  size_t mic_bytes;
  size_t speaker_bytes;
  size_t log_bytes;
  size_t mic_dropped;
  size_t speaker_dropped;
  StreamBufferHandle_t mic_queue;
  StreamBufferHandle_t speaker_queue;
  StreamBufferHandle_t log_queue;
} recorder;

/* Deferred to the recorder task; see the header. */
static volatile bool begin_requested;
static volatile bool end_requested;
static char pending_call_id[32];
static char pending_end_reason[64];
/* Recorder-task-served file reads; see waveshare_recorder_read. */
static volatile bool read_pending;
static volatile bool read_done;
static char read_name[32];
static size_t read_offset;
static size_t read_capacity;
static size_t read_length;
/* PSRAM: internal RAM is the TLS handshake's working set, and starving it
 * fails the connection outright with MBEDTLS_ERR_SSL_ALLOC_FAILED. */
EXT_RAM_BSS_ATTR static uint8_t read_buffer[6144];

/* A recording is read by name; a separator would let a caller walk the card. */
static bool recording_path(const char *name, char *out, size_t capacity) {
  if (name == NULL || name[0] == '\0' || strchr(name, '/') != NULL ||
      strstr(name, "..") != NULL) {
    return false;
  }
  return snprintf(out, capacity, RECORDING_DIR "/%s", name) < (int)capacity;
}

static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / 1000);
}

/*
 * FatFs only writes a file's directory entry on sync or close, so a stat of a
 * file that is still open reports the size it had when it was created —
 * zero. Anything that wants to see the live recording has to push the
 * buffered writes all the way down first.
 */
static void sync_open_files(void) {
  FILE *const files[] = {recorder.mic, recorder.speaker, recorder.log};
  size_t index;
  for (index = 0U; index < sizeof(files) / sizeof(files[0]); ++index) {
    if (files[index] == NULL) continue;
    (void)fflush(files[index]);
    (void)fsync(fileno(files[index]));
  }
}

bool waveshare_recorder_init(void) {
  const esp_err_t mounted = bsp_sdcard_mount();
  if (mounted != ESP_OK) {
    ESP_LOGW(tag, "no SD card (%s); call recording disabled",
             esp_err_to_name(mounted));
    return false;
  }
  if (mkdir(RECORDING_DIR, 0775) != 0) {
    /* Already there is the common case, and the only one worth continuing. */
    struct stat status;
    if (stat(RECORDING_DIR, &status) != 0) {
      ESP_LOGW(tag, "cannot create " RECORDING_DIR "; recording disabled");
      return false;
    }
  }
  recorder.mic_queue = xStreamBufferCreateWithCaps(
      LANE_BUFFER_BYTES, 1U, MALLOC_CAP_SPIRAM);
  recorder.speaker_queue = xStreamBufferCreateWithCaps(
      LANE_BUFFER_BYTES, 1U, MALLOC_CAP_SPIRAM);
  recorder.log_queue =
      xStreamBufferCreateWithCaps(4096, 1U, MALLOC_CAP_SPIRAM);
  if (recorder.mic_queue == NULL || recorder.speaker_queue == NULL ||
      recorder.log_queue == NULL) {
    ESP_LOGW(tag, "no PSRAM for recorder queues; recording disabled");
    return false;
  }
  recorder.mounted = true;
  ESP_LOGI(tag, "recording calls to " RECORDING_DIR);
  return true;
}

bool waveshare_recorder_available(void) {
  return recorder.mounted;
}

uint32_t waveshare_recorder_begins(void) {
  return recorder.begins;
}

uint32_t waveshare_recorder_ends(void) {
  return recorder.ends;
}

bool waveshare_recorder_recording(void) {
  /*
   * A REQUESTED recording counts as recording. Opening the files is deferred
   * to the recorder task, so reporting "not recording" until it catches up
   * made the caller — a 5ms poll loop — re-request one every pass. Each
   * request wiped the directory and reopened every file, so the card was
   * hammered continuously and the call log was truncated over and over.
   *
   * And it is the INTENT that answers, not the file handles: a card that
   * cannot be opened, or files closed by a read, must not read as "no
   * recording in progress" and start the same storm by another route.
   */
  return recorder.call_open || begin_requested;
}

void waveshare_recorder_counters(
    size_t *mic_bytes, size_t *speaker_bytes, size_t *log_bytes) {
  if (mic_bytes != NULL) *mic_bytes = recorder.mic_bytes;
  if (speaker_bytes != NULL) *speaker_bytes = recorder.speaker_bytes;
  if (log_bytes != NULL) *log_bytes = recorder.log_bytes;
}

static void close_files(void) {
  if (recorder.mic != NULL) {
    (void)fclose(recorder.mic);
    recorder.mic = NULL;
  }
  if (recorder.speaker != NULL) {
    (void)fclose(recorder.speaker);
    recorder.speaker = NULL;
  }
  if (recorder.log != NULL) {
    (void)fclose(recorder.log);
    recorder.log = NULL;
  }
}

/** Empty the directory so one call's evidence is never mixed with another's. */
static void wipe_directory(void) {
  DIR *directory = opendir(RECORDING_DIR);
  struct dirent *entry;
  if (directory == NULL) return;
  while ((entry = readdir(directory)) != NULL) {
    char path[128];
    if (snprintf(path, sizeof(path), RECORDING_DIR "/%s", entry->d_name) <
        (int)sizeof(path)) {
      (void)unlink(path);
    }
  }
  (void)closedir(directory);
}

void waveshare_recorder_begin_call(const char *call_id) {
  if (!recorder.mounted) return;
  snprintf(
      pending_call_id, sizeof(pending_call_id), "%s",
      call_id == NULL ? "?" : call_id);
  begin_requested = true;
}

void waveshare_recorder_end_call(const char *reason) {
  if (!recorder.mounted) return;
  begin_requested = false;
  snprintf(
      pending_end_reason, sizeof(pending_end_reason), "%s",
      reason == NULL ? "?" : reason);
  end_requested = true;
}

static void begin_call_now(const char *call_id) {
  if (!recorder.mounted) return;
  close_files();
  wipe_directory();
  /*
   * Set before the opens can fail. Recording is best-effort by contract — an
   * unwritable card disables it rather than failing the call — and the one
   * thing it must never do is ask to be started again on the next pass.
   */
  recorder.call_open = true;
  ++recorder.begins;
  recorder.call_started_ms = now_ms();
  recorder.mic_bytes = 0U;
  recorder.speaker_bytes = 0U;
  recorder.log_bytes = 0U;
  recorder.mic = fopen(RECORDING_DIR "/mic.pcm", "wb");
  recorder.speaker = fopen(RECORDING_DIR "/speaker.pcm", "wb");
  recorder.log = fopen(RECORDING_DIR "/call.log", "wb");
  if (recorder.mic == NULL || recorder.speaker == NULL ||
      recorder.log == NULL) {
    ESP_LOGW(tag, "could not open recording files (mic=%d spk=%d log=%d)",
             recorder.mic != NULL, recorder.speaker != NULL,
             recorder.log != NULL);
    close_files();
    return;
  }
  ESP_LOGI(tag, "recording begins for call %s", call_id == NULL ? "?" : call_id);
  (void)fprintf(
      recorder.log,
      "[       0] call %s begins; 16kHz mono s16le, mic.pcm = uplink, "
      "speaker.pcm = downlink\n",
      call_id == NULL ? "?" : call_id);
  (void)fflush(recorder.log);
}

static void end_call_now(const char *reason) {
  recorder.call_open = false;
  ++recorder.ends;
  if (recorder.log != NULL) {
    /* Written directly: the queue drain has already happened this pass. */
    (void)fprintf(recorder.log, "[%8llu] call ends: %s\n",
                  (unsigned long long)(now_ms() - recorder.call_started_ms),
                  reason == NULL ? "?" : reason);
  }
  close_files();
}

/*
 * The audio lanes only ever hand bytes to a queue — never to the filesystem.
 * A full queue drops rather than blocks: losing recorder bytes is always
 * better than stalling playback or capture.
 */
void waveshare_recorder_write_mic(const void *pcm, size_t bytes) {
  if (recorder.mic_queue == NULL || pcm == NULL || bytes == 0U) return;
  if (xStreamBufferSend(recorder.mic_queue, pcm, bytes, 0) < bytes) {
    ++recorder.mic_dropped;
  }
}

void waveshare_recorder_write_speaker(const void *pcm, size_t bytes) {
  if (recorder.speaker_queue == NULL || pcm == NULL || bytes == 0U) return;
  if (xStreamBufferSend(recorder.speaker_queue, pcm, bytes, 0) < bytes) {
    ++recorder.speaker_dropped;
  }
}

void waveshare_recorder_drain(void) {
  static uint8_t scratch[4096];
  size_t taken;
  if (recorder.mic_queue == NULL) return;
  if (begin_requested) {
    begin_requested = false;
    begin_call_now(pending_call_id);
  }
  if (read_pending && !read_done) {
    char path[128];
    read_length = 0U;
    if (recording_path(read_name, path, sizeof(path))) {
      FILE *file;
      sync_open_files();
      file = fopen(path, "rb");
      if (file != NULL) {
        if (fseek(file, (long)read_offset, SEEK_SET) == 0) {
          read_length = fread(read_buffer, 1U, read_capacity, file);
        }
        (void)fclose(file);
      }
    }
    read_done = true;
  }
  while ((taken = xStreamBufferReceive(
              recorder.mic_queue, scratch, sizeof(scratch), 0)) > 0U) {
    if (recorder.mic != NULL) {
      recorder.mic_bytes += fwrite(scratch, 1U, taken, recorder.mic);
    }
  }
  while ((taken = xStreamBufferReceive(
              recorder.speaker_queue, scratch, sizeof(scratch), 0)) > 0U) {
    if (recorder.speaker != NULL) {
      recorder.speaker_bytes += fwrite(scratch, 1U, taken, recorder.speaker);
    }
  }
  while ((taken = xStreamBufferReceive(
              recorder.log_queue, scratch, sizeof(scratch), 0)) > 0U) {
    if (recorder.log != NULL) {
      (void)fwrite(scratch, 1U, taken, recorder.log);
      (void)fflush(recorder.log);
      recorder.log_bytes = (size_t)ftell(recorder.log);
    }
  }
  if (end_requested) {
    end_requested = false;
    end_call_now(pending_end_reason);
  }
}


size_t waveshare_recorder_size(const char *name) {
  if (!recorder.mounted || name == NULL) return 0U;
  if (strcmp(name, "mic.pcm") == 0) return recorder.mic_bytes;
  if (strcmp(name, "speaker.pcm") == 0) return recorder.speaker_bytes;
  if (strcmp(name, "call.log") == 0) return recorder.log_bytes;
  return 0U;
}

size_t waveshare_recorder_read(
    const char *name, size_t offset, void *out, size_t capacity) {
  const uint64_t deadline = now_ms() + 3000U;
  size_t taken;
  if (!recorder.mounted || out == NULL || capacity == 0U || name == NULL) {
    return 0U;
  }
  /*
   * Hand the request to the recorder task rather than touching the
   * filesystem here. This runs on the task that answers every RPC and feeds
   * the speaker; a card that is slow (or wedged) would otherwise take the
   * whole device with it, which is exactly what was happening.
   */
  if (read_pending) return 0U;
  snprintf(read_name, sizeof(read_name), "%s", name);
  read_offset = offset;
  read_capacity = capacity > sizeof(read_buffer) ? sizeof(read_buffer) : capacity;
  read_length = 0U;
  read_done = false;
  read_pending = true;
  while (!read_done) {
    if (now_ms() > deadline) {
      read_pending = false;
      return 0U;
    }
    vTaskDelay(pdMS_TO_TICKS(5) > 0U ? pdMS_TO_TICKS(5) : 1U);
  }
  taken = read_length < capacity ? read_length : capacity;
  memcpy(out, read_buffer, taken);
  read_pending = false;
  return taken;
}

/*
 * Formats into the queue and returns — no filesystem call, ever, on the
 * caller's task. This matters more than it looks: the callers are transcript
 * and turn events on the APP task, which is the sole producer of speaker
 * PCM. An fsync there stalls for as long as the card's wear levelling takes
 * (FatFs bounds it at 10 s) and every one of those milliseconds is audio not
 * being decoded. vl-recorder owns the writing.
 */
void waveshare_recorder_log(const char *format, ...) {
  char line[192];
  va_list arguments;
  int prefix;
  int written;
  if (recorder.log_queue == NULL || format == NULL) return;
  prefix = snprintf(
      line, sizeof(line), "[%8llu] ",
      (unsigned long long)(now_ms() - recorder.call_started_ms));
  if (prefix < 0 || (size_t)prefix >= sizeof(line)) return;
  va_start(arguments, format);
  written =
      vsnprintf(line + prefix, sizeof(line) - (size_t)prefix, format, arguments);
  va_end(arguments);
  if (written < 0) return;
  {
    size_t length = (size_t)prefix + (size_t)written;
    if (length >= sizeof(line) - 1U) length = sizeof(line) - 2U;
    line[length++] = '\n';
    (void)xStreamBufferSend(recorder.log_queue, line, length, 0);
  }
}
