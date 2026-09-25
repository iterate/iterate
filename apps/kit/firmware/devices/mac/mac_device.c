/*
 * mac_device.c: the Mac as a board.
 *
 * Runs the shared voice loop (components/voice) — the same program the
 * ESP boards run — with this laptop's hardware: CoreAudio
 * behind the codec (platforms/darwin), Apple's VoiceProcessingIO where the
 * HAVPE has its XMOS, the keyboard as the button, the provisioning image read
 * from a file instead of a partition. The loop's audio tasks are pumped from
 * here on one thread, the way the voice loop tests pump them; nothing in the
 * loop knows it is not on an ESP32.
 *
 *   iterate-kit-mac --config cfg.bin [--name mac] [--no-aec]
 *
 * `cfg.bin` is the ITERKIT1 image tools/make-config-image.py writes for a
 * board. Space or return presses the button; q leaves. Over the wire the
 * device is `itx.clients.<name>` like every board — scripts/voice-board.ts
 * starts its conversation and speaks to it. VoiceProcessingIO cancels what
 * this Mac plays through its own speaker, so a scripted proof that speaks
 * through that speaker runs with --no-aec; a person talking keeps it on.
 */
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "capnweb/capnweb.h"
#include "esp_timer.h"
#include "iterate/kit/audio_processor.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/darwin_audio_codec.h"
#include "iterate/kit/platforms/provisioning.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_device_profile.h"
#include "keyboard.h"

enum { TICK_MS = 5 };

static struct iterate_kit_darwin_audio_codec codec;
static struct iterate_kit_voice_view view;
static bool no_aec;
static bool press_pending;
static bool hang_up_sent;
static volatile sig_atomic_t quit_requested;
/*
 * The clip the loop last asked for (its spoken status), fed into the speaker
 * ring after the loop's own playback step, on this thread, so the ring keeps
 * its one writer. A copy: this ring can fall behind the loop's idea of when
 * the clip ended, and the loop frees its PCM by that idea.
 */
static struct {
  int16_t *pcm;
  size_t samples;
  size_t next;
  /* Silence after the clip, so the output's pull has enough queued to play its end. */
  unsigned int silence_frames;
} clip;

static void on_signal(int signal_number) {
  (void)signal_number;
  quit_requested = 1;
}

static const char *screen_name(enum iterate_kit_voice_screen screen) {
  switch (screen) {
    case ITERATE_KIT_VOICE_SCREEN_CONNECTING: return "connecting";
    case ITERATE_KIT_VOICE_SCREEN_IDLE: return "idle";
    case ITERATE_KIT_VOICE_SCREEN_LISTENING: return "listening";
    case ITERATE_KIT_VOICE_SCREEN_SPEAKING: return "speaking";
  }
  return "?";
}

/* --- the board ops the loop calls ----------------------------------------- */

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  const struct iterate_kit_darwin_audio_codec_options options = {
    .capture_enabled = true,
    .playback_enabled = true,
    .echo_cancellation_off = no_aec,
  };
  if (iterate_kit_darwin_audio_codec_open(&codec, &options) != ITERATE_KIT_OK) {
    (void)fprintf(stderr, "mac: CoreAudio refused to open\n");
    return false;
  }
  out->codec = codec.codec;
  /* VoiceProcessingIO already cancelled the echo; nothing to do per frame. */
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void present(void *context, const struct iterate_kit_voice_view *value) {
  (void)context;
  const char *before = view.status == NULL ? "" : view.status;
  const char *after = value->status == NULL ? "" : value->status;
  const bool changed = value->screen != view.screen ||
      value->call_active != view.call_active ||
      value->listening != view.listening || value->fault != view.fault ||
      value->link_ready != view.link_ready || strcmp(before, after) != 0;
  view = *value;
  if (!changed) return;
  (void)fprintf(
      stderr, "mac: %s%s%s%s — %s\n", screen_name(value->screen),
      value->call_active ? ", in a call" : "",
      value->listening ? ", listening" : "", value->fault ? ", FAULT" : "",
      after[0] != '\0' ? after
      : (value->screen == ITERATE_KIT_VOICE_SCREEN_IDLE && value->link_ready &&
         !value->call_active && !value->wants_call && !value->listening)
          ? "ready: space presses the button, q leaves"
          : "");
}

static void poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  const bool busy = view.call_active || view.wants_call;
  *out = (struct iterate_kit_voice_intent){0};
  switch (mac_keyboard_poll()) {
    case MAC_KEYBOARD_PRESS: press_pending = true; break;
    case MAC_KEYBOARD_QUIT: quit_requested = 1; break;
    case MAC_KEYBOARD_NONE: break;
  }
  if (quit_requested) {
    /* Leave the way a press ends a call, once; the main loop exits when it did. */
    if (busy && !hang_up_sent) {
      out->end_call = true;
      hang_up_sent = true;
    }
    return;
  }
  if (press_pending) {
    press_pending = false;
    if (busy) out->end_call = true;
    else out->start_call = true;
  }
}

static void play_clip(void *context, const int16_t *pcm, size_t samples) {
  (void)context;
  free(clip.pcm);
  clip.pcm = malloc(samples * sizeof(*pcm));
  if (clip.pcm == NULL) return;
  memcpy(clip.pcm, pcm, samples * sizeof(*pcm));
  clip.samples = samples;
  clip.next = 0U;
  clip.silence_frames = 4U;
}

static void feed_clip(void) {
  /* A call's answer gets the speaker: interleaved in one ring, clip and answer would garble each other. */
  if (view.call_active && clip.pcm != NULL) {
    free(clip.pcm);
    clip.pcm = NULL;
  }
  while (clip.pcm != NULL &&
         iterate_kit_darwin_audio_output_queued_bytes(&codec.output) <
             iterate_kit_darwin_audio_output_lead_bytes(&codec.output)) {
    int16_t frame[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
    if (clip.next < clip.samples) {
      const size_t count = clip.samples - clip.next < ITERATE_KIT_VOICE_FRAME_SAMPLES
                               ? clip.samples - clip.next
                               : ITERATE_KIT_VOICE_FRAME_SAMPLES;
      memcpy(frame, clip.pcm + clip.next, count * sizeof(frame[0]));
      clip.next += count;
    } else if (clip.silence_frames > 0U) {
      clip.silence_frames--;
    } else {
      free(clip.pcm);
      clip.pcm = NULL;
      /* Trailing silence is the end of a clip, not a starved answer. */
      iterate_kit_darwin_audio_output_set_expected(&codec.output, false);
      break;
    }
    if (iterate_kit_darwin_audio_output_write(&codec.output, (const uint8_t *)frame, sizeof(frame)) !=
        ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK) {
      break;
    }
  }
}

/** The button, over the wire — the same `button.press` every board lends. */
static enum capnweb_status button_press(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  press_pending = true;
  return capnweb_reply_set_boolean(reply, true);
}

static size_t modules(
    void *context, struct iterate_kit_module *out, size_t capacity) {
  (void)context;
  static const char *const path[] = {"button", "press"};
  static const struct iterate_kit_method methods[] = {{path, 2U, button_press}};
  if (capacity == 0U) return 0U;
  out[0] = (struct iterate_kit_module){.methods = methods, .method_count = 1U};
  return 1U;
}

static size_t health(void *context, char *out, size_t capacity) {
  (void)context;
  struct iterate_kit_darwin_audio_codec_metrics metrics;
  iterate_kit_darwin_audio_codec_metrics(&codec, &metrics);
  const struct iterate_kit_health_field fields[] = {
    {"macCaptureFrames", metrics.capture_frames},
    {"macCaptureDropped", metrics.capture_frames_dropped},
    {"macPlaybackStarved", metrics.playback_starved_buffers},
    {"macVoiceProcessing", metrics.voice_processing_active ? 1U : 0U},
  };
  return iterate_kit_health_append_fields(
      out, capacity, fields, sizeof(fields) / sizeof(fields[0]));
}

/* --- the process ---------------------------------------------------------- */

static int usage(FILE *to) {
  (void)fputs(
      "Usage: iterate-kit-mac --config <image> [--name <device name>] [--no-aec]\n"
      "\n"
      "Runs the Kit voice loop on this Mac as a device. <image> is the ITERKIT1\n"
      "provisioning image tools/make-config-image.py writes. Space or return\n"
      "presses the button; q leaves.\n",
      to);
  return to == stdout ? 0 : 2;
}

int main(int argc, char **argv) {
  const char *config = NULL;
  const char *name = "mac";
  for (int index = 1; index < argc; ++index) {
    const char *argument = argv[index];
    if (strcmp(argument, "--help") == 0) return usage(stdout);
    if (strcmp(argument, "--no-aec") == 0) {
      no_aec = true;
    } else if (strcmp(argument, "--config") == 0 && index + 1 < argc) {
      config = argv[++index];
    } else if (strcmp(argument, "--name") == 0 && index + 1 < argc) {
      name = argv[++index];
    } else {
      return usage(stderr);
    }
  }
  if (config == NULL) return usage(stderr);
  iterate_kit_darwin_provisioning_set_path(config);
  (void)signal(SIGINT, on_signal);
  (void)signal(SIGTERM, on_signal);
  if (mac_keyboard_open()) {
    (void)fputs("mac: space presses the button, q leaves\n", stderr);
  } else {
    (void)fputs("mac: no terminal; the button is remote-only\n", stderr);
  }

  const struct iterate_kit_board_facts facts = {
    .device_name = name,
    .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
    .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
    .capture_stack_bytes = 4096U,
  };
  const struct iterate_kit_board_ops ops = {
    .start = start,
    .present = present,
    .poll = poll,
    .modules = modules,
    .health = health,
    .play_clip = play_clip,
  };
  if (!iterate_kit_voice_loop_init(&ops, &facts, NULL)) {
    (void)fputs("mac: the voice loop refused this board (see the log)\n", stderr);
    return 1;
  }
  /* The audio tasks the loop asked for are pumped here, in the same order the
   * tests pump them: control, then capture, then playback. Two capture steps a
   * tick is eight times realtime, so a slow tick never backs the microphone up. */
  int64_t next_levels_at_us = 0;
  for (;;) {
    const int64_t now_us = esp_timer_get_time();
    /* Once a second in a call: what the microphone and speaker are doing. */
    if ((view.call_active || view.wants_call) && now_us >= next_levels_at_us) {
      (void)fprintf(
          stderr, "mac: levels mic=%u speaker=%u\n",
          (unsigned int)view.microphone_peak, (unsigned int)view.speaker_peak);
      next_levels_at_us = now_us + 1000000;
    }
    iterate_kit_darwin_audio_codec_pump(&codec, (uint64_t)now_us);
    iterate_kit_voice_loop_step();
    iterate_kit_voice_loop_capture_step();
    iterate_kit_voice_loop_capture_step();
    iterate_kit_voice_loop_playback_step();
    feed_clip();
    if (quit_requested && !view.call_active && !view.wants_call) break;
    const struct timespec tick = {.tv_sec = 0, .tv_nsec = TICK_MS * 1000000L};
    (void)nanosleep(&tick, NULL);
  }
  mac_keyboard_close();
  iterate_kit_darwin_audio_codec_close(&codec);
  (void)fputs("mac: bye\n", stderr);
  return 0;
}
