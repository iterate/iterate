#include "waveshare_avatar.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "iterate/kit/avatar/face_animator.h"
#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/avatar/face_doze.h"
#include "iterate/kit/avatar/face_keyframe.h"
#include "iterate/kit/avatar/face_viseme_queue.h"
#include "waveshare_audio.h"

static const char tag[] = "waveshare-face";

enum {
  SAMPLE_RATE_HZ = 16000,
  SAMPLES_PER_MS = SAMPLE_RATE_HZ / 1000,
  /*
   * The ring the playback task hands audio over in, in samples.
   *
   * A POWER OF TWO, because the cursors are free-running and masked: that is
   * what makes "how much is in here" a single subtraction with no wrap case to
   * get wrong, and no cursor that both tasks have to agree about.
   *
   * 256ms is not a latency budget, it is headroom. The consumer deliberately
   * holds audio back (see HOLD_SAMPLES_MAX), and whatever is left over is how
   * long the app task may be busy elsewhere before the producer has nowhere to
   * put a frame. At a 5ms app loop and 20ms speaker chunks, 128ms of slack is
   * about six chunks: far past any ordinary scheduling delay, and small enough
   * that 8KB of internal RAM buys it.
   */
  HEARD_SAMPLES = 4096,
  HEARD_MASK = HEARD_SAMPLES - 1,
  /*
   * The most the mouth may be held back by, in samples.
   *
   * The I2S ring is 6 descriptors of 240 frames at 16kHz — 90ms — and credit is
   * taken BEFORE a write, so the honest owed figure momentarily includes the
   * 20ms chunk being handed over. 128ms covers that with room; anything beyond
   * it is a stale ledger rather than real queued audio, and holding the mouth
   * for a stale number is the failure this cap exists to bound.
   */
  HOLD_SAMPLES_MAX = 2048,
  /*
   * How long the speaker must be quiet before the mouth is told so, in ms.
   *
   * Longer than one DMA descriptor (15ms) so an ordinary gap between chunks is
   * not mistaken for the end of a turn, and short enough that the mouth shuts
   * within a frame or two of the voice stopping.
   */
  SILENCE_AFTER_MS = 40,
  /*
   * How long held audio may sit undrained before it is released regardless of
   * what the hardware says it still owes. Three rings: far beyond any honest
   * queue, close enough that a stuck count is a hiccup rather than a dead face.
   */
  HELD_TOO_LONG_MS = 270,
  /* Silence pushed per tick once the speaker has gone quiet, in ms. */
  SILENCE_CHUNK_MS = 10,
  /* How much PCM goes into the analyzer per call. Stack, so: modest. */
  RELEASE_BATCH_SAMPLES = 128,
};

static struct {
  bool ready;
  face_animator_t animator;
  face_avatar_registry_t registry;

  /*
   * Audio the DAC has accepted, oldest first, waiting to be heard.
   *
   * A ring rather than a queue of pointers: the producer's buffer is reused the
   * moment it returns, so the samples have to be copied somewhere, and this is
   * the only place that knows how long they must wait.
   */
  int16_t heard[HEARD_SAMPLES];
  /* PRODUCER (playback task) writes; consumer reads. Free-running. */
  volatile uint32_t heard_write;
  /* CONSUMER (app task) only. Never touched by anyone else. */
  uint32_t heard_read;
  /* PRODUCER only: when audio was last handed over, and what would not fit. */
  volatile uint32_t last_write_ms;
  volatile uint32_t dropped_samples;
  /* ANY TASK raises it, consumer applies it. See note_abandoned. */
  volatile uint32_t abandon_epoch;
  /* CONSUMER only. */
  uint32_t abandon_applied;
  uint32_t last_release_ms;

  /*
   * --- The viseme lane. APP TASK ONLY, all of it. ---
   *
   * Acceptance (the speaker callback) and release (the tick) are separated by
   * two FIFO buffers, so which answer a released sample belongs to is
   * recovered by ledger: `answer_starts` records where each answer began in
   * the accepted stream, and the release counter walks past those marks in
   * the same order the audio does. An abandon resets the whole ledger — the
   * audio it described is gone, and the next answer starts the count clean.
   */
  face_viseme_queue_t viseme_queue;
  struct {
    uint32_t answer;
    uint32_t start_offset;
  } answer_starts[8];
  uint8_t answer_start_count;
  bool has_accepted_answer;
  uint32_t last_accepted_answer;
  uint32_t accepted_samples;
  uint32_t released_samples;
  bool has_playing_answer;
  uint32_t playing_answer;
  uint32_t playing_answer_start;
  bool call_active;

  /* The last pose the renderer managed to read; kept for a raced snapshot. */
  face_pose_t pose;
  uint32_t render_failures;
  /*
   * The face somebody has asked for but the renderer has not adopted yet.
   *
   * An INDEX rather than a name: a slug would be a string written by one task
   * and read by another, and this is one machine word. The epoch is what makes
   * the handoff safe without a lock — the renderer only acts when it differs
   * from the epoch it last applied, so a request that lands mid-render is
   * picked up by the next one instead of being half-seen.
   */
  volatile size_t requested_index;
  volatile uint32_t request_epoch;
  uint32_t applied_epoch;
} face;

/*
 * Milliseconds since boot, as a 32-bit count.
 *
 * 32 BITS ON PURPOSE. These stamps are written by one task and read by another,
 * and a 64-bit load on this CPU is two instructions — so a reader could catch
 * half of an old value and half of a new one. A word cannot tear. It wraps
 * after 49 days, which every comparison here survives because they are all
 * unsigned differences rather than magnitudes.
 */
static uint32_t now_ms(void) {
  return (uint32_t)(esp_timer_get_time() / 1000);
}

static bool elapsed_at_least(uint32_t since, uint32_t span_ms) {
  return (uint32_t)(now_ms() - since) >= span_ms;
}

/*
 * The clock the face's own motion runs on, in 16kHz samples.
 *
 * DELIBERATELY WALL TIME, NOT PLAYOUT. StackChan can drive this from DMA
 * descriptors because its I2S never stops; this board powers the amplifier down
 * between turns and stops writing entirely, so a playout-derived clock would
 * freeze — and a face that stops blinking looks like a device that has crashed.
 * Blinks, saccades and breathing are the only things this clock drives. The
 * mouth comes from the analyzer's envelope, which sees real audio or nothing.
 */
static uint32_t motion_clock_samples(void) {
  return (uint32_t)((uint64_t)esp_timer_get_time() * SAMPLES_PER_MS / 1000U);
}

/* --- consumer side: the app task, and nobody else -------------------------- */

/** How much audio is waiting in the ring. CONSUMER ONLY. */
static uint32_t heard_available(void) {
  const uint32_t write = __atomic_load_n(&face.heard_write, __ATOMIC_ACQUIRE);
  return write - face.heard_read;
}

/**
 * Hand everything except the newest `keep` samples to the analyzer.
 *
 * THE ONLY PLACE IN THIS FILE THAT CALLS THE ANALYZER WITH PCM, reached only
 * from `waveshare_avatar_tick`, which the header pins to the app task.
 */
static void release_keeping(uint32_t keep) {
  int16_t batch[RELEASE_BATCH_SAMPLES];
  uint32_t available = heard_available();

  if (available <= keep) return;
  face.last_release_ms = now_ms();
  while (available > keep) {
    uint32_t batched = available - keep;
    uint32_t index;
    if (batched > (uint32_t)RELEASE_BATCH_SAMPLES) {
      batched = (uint32_t)RELEASE_BATCH_SAMPLES;
    }
    for (index = 0U; index < batched; ++index) {
      batch[index] = face.heard[(face.heard_read + index) & HEARD_MASK];
    }
    face.heard_read += batched;
    face.released_samples += batched;
    face_animator_push_pcm(&face.animator, batch, (size_t)batched);
    available -= batched;
  }
}

/**
 * Apply whatever part of the mouth track playout has now reached. APP TASK,
 * from the tick, after every release.
 */
static void drain_viseme_track(void) {
  face_viseme_change_t change;

  while (face.answer_start_count > 0U &&
         face.answer_starts[0].start_offset <= face.released_samples) {
    face.has_playing_answer = true;
    face.playing_answer = face.answer_starts[0].answer;
    face.playing_answer_start = face.answer_starts[0].start_offset;
    memmove(&face.answer_starts[0], &face.answer_starts[1],
            (size_t)(face.answer_start_count - 1U) *
                sizeof(face.answer_starts[0]));
    face.answer_start_count -= 1U;
  }
  if (!face.has_playing_answer) return;
  if (face_viseme_queue_advance(
          &face.viseme_queue,
          face.playing_answer,
          face.released_samples - face.playing_answer_start,
          &change)) {
    face_animator_apply_viseme(&face.animator, change.viseme,
                               change.confidence);
  }
}

/** How much audio the hardware still has to play, in samples. */
static uint32_t still_owed_samples(void) {
  const int32_t owed_ms = waveshare_audio_dma_owed_ms();
  uint32_t owed;

  if (owed_ms <= 0) return 0U;
  owed = (uint32_t)owed_ms * (uint32_t)SAMPLES_PER_MS;
  return owed > (uint32_t)HOLD_SAMPLES_MAX ? (uint32_t)HOLD_SAMPLES_MAX : owed;
}

/**
 * Act on an abandon raised by another task, if there was one.
 *
 * Dropped, not released: nobody heard these samples, so they must not move a
 * mouth. Only this task may move the read cursor, which is the whole reason
 * `note_abandoned` raises a flag instead of emptying the ring itself.
 */
static void apply_abandon(void) {
  const uint32_t epoch = __atomic_load_n(&face.abandon_epoch, __ATOMIC_ACQUIRE);

  if (epoch == face.abandon_applied) return;
  face.abandon_applied = epoch;
  face.heard_read = __atomic_load_n(&face.heard_write, __ATOMIC_ACQUIRE);
  /* Nothing is overdue at the moment the queue becomes empty. */
  face.last_release_ms = now_ms();
}

/* --- lifecycle ------------------------------------------------------------- */

bool waveshare_avatar_init(void) {
  memset(&face, 0, sizeof(face));
  face_animator_init(&face.animator, (uint32_t)SAMPLE_RATE_HZ);
  if (!face_avatar_registry_init(&face.registry)) {
    ESP_LOGE(tag, "no compiled face to show");
    return false;
  }
  face.last_release_ms = now_ms();
  face.ready = true;
  ESP_LOGI(
      tag, "face ready: %s (%dx%d, shown at 2x)",
      face_avatar_registry_current_slug(&face.registry),
      (int)FACE_RENDER_WIDTH, (int)FACE_RENDER_HEIGHT);
  return true;
}

/* --- producer: playback task ----------------------------------------------- */

void waveshare_avatar_observe_playout(const int16_t *pcm, size_t samples) {
  uint32_t write;
  uint32_t free_space;
  uint32_t index;

  if (!face.ready || pcm == NULL || samples == 0U) return;

  write = face.heard_write;
  free_space = (uint32_t)HEARD_SAMPLES - (write - face.heard_read);
  if ((uint32_t)samples > free_space) {
    /*
     * THE NEWEST AUDIO IS WHAT GETS DROPPED, and only the app task having
     * stalled for a fifth of a second can cause it.
     *
     * Dropping the oldest instead would mean moving the read cursor, which
     * belongs to the consumer — one shared cursor is exactly the kind of
     * two-writer arrangement this file was rebuilt to remove. The counter is
     * reported by health() so a stall shows up as a number rather than as a
     * mouth that looked a bit wrong once.
     */
    face.dropped_samples += (uint32_t)samples - free_space;
    samples = (size_t)free_space;
    if (samples == 0U) return;
  }
  for (index = 0U; index < (uint32_t)samples; ++index) {
    face.heard[(write + index) & HEARD_MASK] = pcm[index];
  }
  face.last_write_ms = now_ms();
  /* Published last: the consumer must never see a cursor ahead of the data. */
  __atomic_store_n(&face.heard_write, write + (uint32_t)samples,
                   __ATOMIC_RELEASE);
}

/* --- any task -------------------------------------------------------------- */

void waveshare_avatar_note_abandoned(void) {
  if (!face.ready) return;
  (void)__atomic_fetch_add(&face.abandon_epoch, 1U, __ATOMIC_RELEASE);
}

/* --- consumer: app task ---------------------------------------------------- */

void waveshare_avatar_tick(void) {
  static const int16_t silence[SILENCE_CHUNK_MS * SAMPLES_PER_MS] = {0};

  if (!face.ready) return;
  apply_abandon();
  release_keeping(still_owed_samples());
  /*
   * AUDIO THAT HAS STOPPED DRAINING IS RELEASED ANYWAY.
   *
   * `still_owed_samples()` trusts the hardware's owed count, and that count
   * only falls while the starvation watch is armed — so a turn that ends with
   * the watch already disarmed leaves it frozen at whatever it was, and the
   * mouth would hold its last shape against a debt that will never be repaid.
   * Past this bound the samples are let go regardless: the mouth then leads the
   * speaker slightly, which is a blemish, where a frozen face reads as a
   * crashed device.
   */
  if (heard_available() > 0U && elapsed_at_least(
          face.last_release_ms, (uint32_t)HELD_TOO_LONG_MS)) {
    release_keeping(0U);
  }
  drain_viseme_track();
  if (heard_available() > 0U) return;
  /*
   * The ring is empty and the speaker has stopped. Silence is pushed rather
   * than assumed because the envelope only moves when it is given samples: with
   * nothing arriving, the last shape of the last word stays on the face.
   */
  if (face.last_write_ms == 0U) return;
  if (!elapsed_at_least(face.last_write_ms, (uint32_t)SILENCE_AFTER_MS)) return;
  face_animator_push_pcm(
      &face.animator, silence, sizeof(silence) / sizeof(silence[0]));
}

/* --- viseme lane: app task only (see header) ------------------------------- */

void waveshare_avatar_note_viseme(
    uint32_t answer, uint32_t offset_samples,
    uint8_t viseme, uint8_t confidence) {
  if (!face.ready || !face.call_active) return;
  (void)face_viseme_queue_push(
      &face.viseme_queue, answer, offset_samples, viseme, confidence);
}

void waveshare_avatar_note_accepted(uint32_t answer, size_t samples) {
  if (!face.ready || samples == 0U) return;
  if (!face.has_accepted_answer || answer != face.last_accepted_answer) {
    if (face.answer_start_count >=
        sizeof(face.answer_starts) / sizeof(face.answer_starts[0])) {
      /*
       * Eight answers queued and none released is not a real call any more;
       * dropping the OLDEST keeps the marks for audio that can still play.
       */
      memmove(&face.answer_starts[0], &face.answer_starts[1],
              (size_t)(face.answer_start_count - 1U) *
                  sizeof(face.answer_starts[0]));
      face.answer_start_count -= 1U;
    }
    face.answer_starts[face.answer_start_count].answer = answer;
    face.answer_starts[face.answer_start_count].start_offset =
        face.accepted_samples;
    face.answer_start_count += 1U;
    face.has_accepted_answer = true;
    face.last_accepted_answer = answer;
  }
  face.accepted_samples += (uint32_t)samples;
}

void waveshare_avatar_viseme_reset(void) {
  if (!face.ready) return;
  face_viseme_queue_reset(&face.viseme_queue);
  face.answer_start_count = 0U;
  face.has_accepted_answer = false;
  face.accepted_samples = 0U;
  face.released_samples = 0U;
  face.has_playing_answer = false;
  face_animator_clear_viseme(&face.animator);
}

void waveshare_avatar_set_call_active(bool active) {
  if (!face.ready || face.call_active == active) return;
  face.call_active = active;
  /*
   * THE ENVELOPE KEEPS THE MOUTH. Handing it to the external viseme track
   * for the call's duration meant the mouth moved only as fast as the
   * 10 Hz runtime-state poll delivered shapes — a handful per answer next
   * to the CoreS3's fifty envelope frames a second, and a person reads
   * that as a worse robot, not a different lane. The delay line already
   * feeds this animator the PCM the hardware actually played, which is the
   * same mouth the CoreS3 wears; the viseme queue stays wired and inert
   * unless a stream certificate turns `visemes` back on.
   */
  if (!active) waveshare_avatar_viseme_reset();
}

void waveshare_avatar_set_listening(bool listening) {
  face_stream_event_t event;

  if (!face.ready) return;
  memset(&event, 0, sizeof(event));
  event.type = listening ? FACE_STREAM_USER_SPEECH_STARTED
                         : FACE_STREAM_USER_SPEECH_STOPPED;
  face_animator_push_event(&face.animator, &event);
}

/* --- reader: LVGL task ----------------------------------------------------- */

bool waveshare_avatar_render(
    uint16_t *rgb565, size_t pixel_capacity, bool awake) {
  face_pose_t candidate;
  face_render_key_t render_key;

  if (!face.ready || rgb565 == NULL) return false;
  /* Adopt a requested face here, on the only task that may touch the registry. */
  if (face.request_epoch != face.applied_epoch) {
    const size_t wanted = face.requested_index;
    face.applied_epoch = face.request_epoch;
    if (face_avatar_registry_select(&face.registry, wanted)) {
      ESP_LOGI(tag, "face is now %s",
               face_avatar_registry_current_slug(&face.registry));
    }
  }
  candidate = face.pose;
  if (face_animator_snapshot(&face.animator, &candidate)) {
    face.pose = candidate;
  }
  /* Motion runs on wall time; see motion_clock_samples. */
  face.pose.playout_samples = motion_clock_samples();
  face_render_key_from_pose(&face.pose, &render_key);
  /*
   * ASLEEP UNTIL SOMEBODY CALLS.
   *
   * Rewriting the key rather than picking a different sprite: the shared doze
   * module holds the lids shut and selects each character's own authored
   * `sleepy` bank, so the device dozes in the face it is wearing instead of in
   * a generic one. The blink flag it sets is load-bearing — two zero eye
   * controls read as an uninitialised key, and the registry defensively opens
   * the eyes, which is exactly how "sleeping" came out awake on the other
   * boards.
   */
  if (!awake) face_doze_prepare_render_key(&render_key);
  if (!face_avatar_registry_render(
          &face.registry,
          &render_key,
          face.pose.playout_samples,
          rgb565,
          pixel_capacity)) {
    face.render_failures++;
    return false;
  }
  /*
   * The Z goes on after the face, and a failure here fails the whole frame.
   * Half a doze — shut eyes with no mark — is a face that could equally be
   * mid-blink, and showing that instead of the last coherent frame would be
   * inventing a state the device is not in.
   */
  if (!awake && !face_doze_apply_overlay(
                    rgb565, pixel_capacity, face.pose.playout_samples)) {
    face.render_failures++;
    return false;
  }
  return true;
}

uint16_t waveshare_avatar_speaker_level(void) {
  return face.pose.level;
}

/* --- faces ----------------------------------------------------------------- */

bool waveshare_avatar_request_slug(const char *slug) {
  size_t index;

  if (!face.ready || slug == NULL) return false;
  for (index = 0U; index < face_avatar_registry_count(); ++index) {
    const char *const candidate = face_avatar_registry_slug_at(index);
    if (candidate != NULL && strcmp(candidate, slug) == 0) {
      face.requested_index = index;
      face.request_epoch++;
      return true;
    }
  }
  return false;
}

void waveshare_avatar_request_next(void) {
  if (!face.ready) return;
  face.requested_index =
      (face_avatar_registry_current_index(&face.registry) + 1U) %
      face_avatar_registry_count();
  face.request_epoch++;
}

size_t waveshare_avatar_count(void) {
  return face_avatar_registry_count();
}

const char *waveshare_avatar_slug_at(size_t index) {
  const char *const slug = face_avatar_registry_slug_at(index);
  return slug == NULL ? "" : slug;
}

const char *waveshare_avatar_slug(void) {
  return face.ready ? face_avatar_registry_current_slug(&face.registry) : "";
}

/* --- what went wrong ------------------------------------------------------- */

uint32_t waveshare_avatar_render_failures(void) {
  return face.render_failures;
}

uint32_t waveshare_avatar_dropped_samples(void) {
  return face.dropped_samples;
}

uint32_t waveshare_avatar_frames_analysed(void) {
  return __atomic_load_n(&face.animator.state.frame_index, __ATOMIC_RELAXED);
}
