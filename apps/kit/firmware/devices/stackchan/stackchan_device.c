/*
 * M5Stack CoreS3 "StackChan" — what makes this board this board.
 *
 * The program it runs is components/voice/src/voice_loop.c, and it is the same
 * program the other three run. What is left here is the hardware: a face on a
 * 320x240 panel, a touch screen and PMIC side button that speak the session
 * grammar, a head on two servos, a camera, and —
 * the one structural novelty — a SOFTWARE echo canceller with three
 * different frame sizes behind it.
 *
 * THE CADENCES ARE THE INTERESTING PART. The codec completes 8 ms DMA chunks,
 * esp-sr's VOIP engine is fixed at 16 ms and fails closed if told otherwise,
 * and the wire wants 20 ms. Three numbers that do not divide into each other,
 * which is why this board is the reason the shared capture step goes through
 * `aec_capture_bridge` at all. Two facts express the whole of it now —
 * `capture_chunk_samples = 128` and `processing_frame_samples = 256` — and the
 * loop owns the conversion, so the fail-closed silence rule lives in one place
 * instead of being restated here.
 *
 * The microphone runs continuously during a call; the ported canceller uses
 * the playback reference supplied by the audio path.
 *
 * The status STRINGS go to the console log rather than the screen: the face
 * owns the glass and a semantic snapshot owns the rail, so there is nowhere a
 * sentence would go. Opening the USB console reboots this board, which is why
 * `health()` exists. The face lends the glass to the shared screen capability
 * (`screen.setImage`) and gets it back on `setImage(null)`.
 */
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "iterate/kit/capabilities/arguments.h"
#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/capabilities/camera.h"
#include "iterate/kit/capabilities/face.h"
#include "iterate/kit/capabilities/screen.h"
#include "iterate/kit/capabilities/servos.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/platforms/board.h"
#include "iterate/kit/voice_device_profile.h"

#include "stackchan_audio.h"
#include "stackchan_avatar.h"
#include "stackchan_body.h"
#include "stackchan_camera.h"
#include "stackchan_processor.h"

/* The baked wake and end chimes; see tools/baked-sounds.cmake. */
#include <sounds_generated.inc>

static const char tag[] = "iterate-stackchan";

/*
 * The body MCU, when there is one. A head without its body still holds a
 * conversation, so a failed probe demotes the LEDs and servos rather than
 * bricking the voice endpoint — which is why this is a pointer and every use
 * of it is guarded.
 */
static struct iterate_kit_stackchan_body body_mcu;
static struct iterate_kit_stackchan_body *body;

/*
 * What each surface was last actually shown, so an equal snapshot is not
 * republished. Republishing forced the display path to repaint, which a person
 * sees as the face cutting to black.
 *
 * The body keeps its own copy rather than sharing the face's, because its
 * write is rate limited and a deferred write must be RETRIED — recording it as
 * shown when it never left would leave the body lit in a colour the device had
 * already moved on from.
 */
static struct iterate_kit_conversation_visual_state shown;
static bool shown_valid;
static struct iterate_kit_rgb8 body_shown[ITERATE_KIT_STACKCHAN_LED_COUNT];
static bool body_shown_valid;
static uint64_t last_body_write_ms;
static uint64_t last_present_ms;

/*
 * THE SHARED SCREEN, on the face's glass. A frame arrives at the panel's own
 * 320x240 in big-endian RGB565, which is the ILI9341's wire order, so the
 * avatar paints it straight from this PSRAM buffer (150 KiB, which internal
 * memory cannot spare) and holds it until `setImage(null)`, which `present`
 * turns back into the face.
 */
EXT_RAM_BSS_ATTR static struct iterate_kit_screen screen;
static bool screen_ready;
static bool image_lent;

static bool submit_image(void *context, enum iterate_kit_screen_format format,
                         const uint8_t *bytes, size_t length) {
  (void)context;
  (void)length;
  if (format != ITERATE_KIT_SCREEN_RGB565 ||
      !iterate_kit_stackchan_avatar_display_active()) return false;
  iterate_kit_stackchan_avatar_show_image(bytes);
  image_lent = true;
  return true;
}

static enum iterate_kit_screen_state image_state(void *context) {
  (void)context;
  if (!iterate_kit_stackchan_avatar_display_active()) return ITERATE_KIT_SCREEN_FAILED;
  return iterate_kit_stackchan_avatar_image_painted() ? ITERATE_KIT_SCREEN_SHOWN
                                                      : ITERATE_KIT_SCREEN_PENDING;
}

static void screen_start(void) {
  const struct iterate_kit_screen_driver display = {
    .width = 320, .height = 240, .formats = ITERATE_KIT_SCREEN_RGB565,
    .preferred_format = ITERATE_KIT_SCREEN_RGB565, .refresh_timeout_ms = 1000,
    .submit = submit_image, .state = image_state,
  };
  const size_t bytes = iterate_kit_screen_frame_bytes(
      display.width, display.height, ITERATE_KIT_SCREEN_RGB565);
  uint8_t *const buffer = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  screen_ready = buffer != NULL &&
      iterate_kit_screen_init(&screen, &display, buffer, bytes);
  if (!screen_ready) ESP_LOGW(tag, "no PSRAM for the screen: setImage disabled");
}

/*
 * THE HEAD GESTURES, stepped from `poll` on the app task: a gesture is a
 * short fixed itinerary of on-servo moves, and the loop's own cadence is the
 * timer — no task, no esp_timer chain, nothing to race the servo UART. Each
 * step's dwell covers the on-servo move time plus a settle so the next move
 * starts from a still head. The sequences are the v1 voice agent's, degrees
 * and speeds unchanged.
 */
struct head_step {
  int16_t yaw_degrees;
  int16_t pitch_degrees;
  uint16_t move_ms;
  uint16_t dwell_ms;
};

static const struct head_step nod_steps[] = {
  {0, 24, 260, 350}, {0, 0, 260, 350}, {0, 24, 260, 350}, {0, 0, 260, 350},
};
static const struct head_step shake_steps[] = {
  {-26, 0, 240, 400}, {26, 0, 240, 400}, {-26, 0, 240, 400}, {0, 0, 240, 400},
};

static struct {
  const struct head_step *steps; /* NULL when idle */
  size_t count;
  size_t index;
  uint64_t next_at_ms;
} gesture;

static void head_gesture_begin(const struct head_step *steps, size_t count) {
  gesture.steps = steps;
  gesture.count = count;
  gesture.index = 0U;
  gesture.next_at_ms = 0U;
}

static void head_gesture_step(uint64_t now_ms) {
  if (body == NULL || gesture.steps == NULL) return;
  if (now_ms < gesture.next_at_ms) return;
  {
    const struct head_step *step = &gesture.steps[gesture.index];
    (void)iterate_kit_stackchan_body_move_head(
        body, step->yaw_degrees, step->pitch_degrees, step->move_ms);
    gesture.next_at_ms = now_ms + step->dwell_ms;
  }
  if (++gesture.index >= gesture.count) gesture.steps = NULL;
}

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  /*
   * The avatar owns the panel, so it goes first: there is no screen to say
   * anything on until it is up, and nothing left to say it about if it fails.
   */
  if (iterate_kit_stackchan_avatar_start() != ESP_OK) return false;
  screen_start();
  if (iterate_kit_stackchan_body_start(&body_mcu) == ESP_OK) {
    body = &body_mcu;
  } else {
    ESP_LOGW(tag, "body MCU absent: LEDs and servos disabled");
  }
  if (!stackchan_audio_init()) return false;
  /*
   * The tuned VOIP engine (PSRAM state) must exist before the capture bridge
   * accepts a chunk; failing here beats an uncancelled microphone.
   */
  if (!stackchan_processor_init()) return false;
  /* The mouth animates audio the hardware actually played. */
  stackchan_audio_set_playout_observer(
      iterate_kit_stackchan_avatar_observe_playout, NULL);
  out->codec = stackchan_audio_codec();
  out->processor = stackchan_processor();
  return true;
}

/**
 * TWO SURFACES, ONE SNAPSHOT, TWO CEILINGS.
 *
 * The face's status rail and the body's LED run consume the same semantic
 * snapshot, and both publish only when it changes: republishing an equal one
 * forces the display path to repaint, which a person sees as the face cutting
 * to black.
 *
 * EVALUATED AT 20 Hz, not at the loop's rate. `overlay_equal` RENDERS the
 * twelve pixels twice to compare them, and the snapshot carries the live
 * microphone and speaker peaks — so it genuinely differs on most passes during
 * speech, and doing that comparison two hundred times a second would be work
 * nobody can see. It is the same ceiling the other screenless board's ring
 * keeps, and it replaces the dirty flag the old panel driver owned: the loop
 * pushes a whole view every pass now, so there is no setter left to mark it.
 *
 * THE BODY IS 1 Hz ON TOP OF THAT, because it is an I2C write on the bus the
 * codec and the touch controller share. A write the ceiling defers stays
 * pending — `body_shown` records what actually left, not what was intended —
 * so the run cannot be stranded showing a colour the device has moved past.
 */
static void present(
    void *context, const struct iterate_kit_voice_view *view) {
  const uint64_t now = (uint64_t)(esp_timer_get_time() / 1000);
  struct iterate_kit_conversation_visual_state visual;
  (void)context;
  /*
   * STRINGS GO TO THE LOG. The face owns the glass and the rail carries a
   * semantic snapshot; there is nowhere on this device a sentence would fit,
   * and the person who wants one is reading the console.
   */
  {
    static const char *last_status;
    if (view->status != NULL && view->status[0] != '\0' &&
        view->status != last_status) {
      last_status = view->status;
      ESP_LOGI(tag, "status: %s", view->status);
    }
  }
  if (image_lent && !screen.showing_image) {
    iterate_kit_stackchan_avatar_show_image(NULL);
    image_lent = false;
  }
  if (last_present_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now, last_present_ms) < 50U) {
    return;
  }
  last_present_ms = now;
  /* One fleet mapping, then two facts only this board has:
   * (a) the FACE opens its eyes on conversation_active, and it must open on
   *     the press, not seconds later when the GPT-Live session is live —
   *     otherwise the chime answers a sleeping face (the regression the
   *     deleted mapping's comment recorded, and review round 2 found again);
   * (b) the physical playout meter is the SPEAKER's level, not the mic's;
   *     routing it through microphone_peak painted the speaker in the mic
   *     sector and dropped the person's level while listening. */
  iterate_kit_voice_view_lights(view, &visual);
  visual.conversation_active = view->call_active || view->wants_call;
  visual.speaker_peak = iterate_kit_stackchan_avatar_speaker_status_peak();
  /*
   * The OVERLAY comparison for the face, not the lights one: "connecting" and
   * "ready" can render the same twelve pixels but different overlays.
   */
  if (!shown_valid ||
      !iterate_kit_conversation_overlay_equal(&visual, &shown)) {
    (void)iterate_kit_stackchan_avatar_request_status(&visual);
    shown = visual;
    shown_valid = true;
  }
  if (body == NULL) return;
  {
    struct iterate_kit_rgb8 pixels[ITERATE_KIT_STACKCHAN_LED_COUNT];
    uint16_t rgb565[ITERATE_KIT_STACKCHAN_LED_COUNT];
    iterate_kit_conversation_lights_render(&visual, pixels);
    if (body_shown_valid &&
        memcmp(pixels, body_shown, sizeof(pixels)) == 0) {
      return;
    }
    if (last_body_write_ms != 0U &&
        iterate_kit_voice_elapsed_ms(now, last_body_write_ms) < 1000U) {
      return; /* Deferred, not dropped: retried on the next pass. */
    }
    for (size_t index = 0U; index < ITERATE_KIT_STACKCHAN_LED_COUNT;
         ++index) {
      rgb565[index] = (uint16_t)(((pixels[index].red >> 3) << 11) |
                                 ((pixels[index].green >> 2) << 5) |
                                 (pixels[index].blue >> 3));
    }
    (void)iterate_kit_stackchan_body_write_leds(
        body, rgb565, ITERATE_KIT_STACKCHAN_LED_COUNT);
    memcpy(body_shown, pixels, sizeof(pixels));
    body_shown_valid = true;
    last_body_write_ms = now;
  }
}

/** Either physical call control supplies the same session tap. */
static void read_gestures(struct iterate_kit_board_gestures *out) {
  bool ignored_left_half;
  out->pressed |= iterate_kit_stackchan_avatar_take_side_button_tap();
  out->pressed |= iterate_kit_stackchan_avatar_take_face_tap(&ignored_left_half);
}

/** Poll StackChan-only presentation controls after the shared call grammar. */
static void poll(void *context, struct iterate_kit_voice_intent *out) {
  const uint64_t now = (uint64_t)(esp_timer_get_time() / 1000);
  (void)context;
  (void)out;
  head_gesture_step(now);
}

/* The rail remains on for the boot: the software canceller's reference
 * rides TX. Gating it would force re-adaptation on every answer; the table
 * has no amplifier GPIO and ARRIVED/QUIET only update the shared ledger. */

/*
 * WHAT THE CODEC KNOWS ABOUT THE CHUNK IT JUST HANDED OVER, which on this
 * board is both things the bridge needs and on the others is neither: a DMA
 * sequence that gaps when the hardware does, and a completion timestamp that
 * back-dates each egress frame.
 *
 * The epoch latch is CONSUMED here, so it must only be read once per accepted
 * chunk — which is exactly when the loop calls this.
 */
static void capture_meta(
    void *context, struct iterate_kit_voice_capture_meta *out) {
  (void)context;
  out->epoch_reset = stackchan_audio_take_epoch_reset();
  stackchan_audio_last_chunk_meta(
      &out->sequence, &out->captured_through_at_us);
}

static uint8_t volume(void *context) {
  (void)context;
  return stackchan_audio_volume();
}

static enum iterate_kit_status servo_move(
    void *context, int32_t yaw_degrees, int32_t pitch_degrees,
    uint16_t speed) {
  struct iterate_kit_stackchan_body *moving = context;
  if (moving == NULL) return ITERATE_KIT_UNAVAILABLE;
  return iterate_kit_stackchan_body_move_head(
      moving, (int16_t)yaw_degrees, (int16_t)pitch_degrees, speed);
}

static bool wear_face(void *context, size_t index) {
  (void)context;
  return iterate_kit_stackchan_avatar_request_sprite_set(index) == ESP_OK;
}

/*
 * `head.nod()` / `head.shake()` — the two gestures as single calls, because
 * a voice tool ends at ONE function: the model cannot conduct a four-move
 * itinerary over the wire, so the itinerary lives here and the tool just
 * names it. A gesture already in flight is replaced, newest intent wins.
 */
/*
 * `button.press()` / `touch.tap({x})` — the physical controls, injectable.
 * They set the same pending latches the finger does, so the device-side
 * handler path is ONE path and the loop's button audit records both.
 */
static const char *const button_press_path[] = {"button", "press"};
static const char *const touch_tap_path[] = {"touch", "tap"};

static enum capnweb_status button_press(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  iterate_kit_stackchan_avatar_inject_side_button();
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status touch_tap(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply) {
  struct capnweb_value object = {0};
  int64_t x = 0;
  (void)context;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "x", &x) || x < 0 || x > 4096) {
    return capnweb_reply_set_error(
        reply, "TypeError", "touch.tap needs {x} as a panel column 0..319");
  }
  iterate_kit_stackchan_avatar_inject_face_tap((uint16_t)x);
  return capnweb_reply_set_boolean(reply, true);
}

static const char *const head_nod_path[] = {"head", "nod"};
static const char *const head_shake_path[] = {"head", "shake"};

static enum capnweb_status head_gesture_call(
    struct capnweb_reply *reply,
    const struct head_step *steps,
    size_t count) {
  if (body == NULL) {
    return capnweb_reply_set_error(
        reply, "Error", "the body MCU is absent, so the head cannot move");
  }
  head_gesture_begin(steps, count);
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status head_nod(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  return head_gesture_call(
      reply, nod_steps, sizeof(nod_steps) / sizeof(nod_steps[0]));
}

static enum capnweb_status head_shake(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  return head_gesture_call(
      reply, shake_steps, sizeof(shake_steps) / sizeof(shake_steps[0]));
}

/*
 * What this board lends: a head (raw moves and the two named gestures), a
 * camera, the shared screen, and a face that can be asked for by name.
 * Conversation control, the speaker and health are the loop's.
 */
static size_t modules(
    void *context, struct iterate_kit_module *out, size_t capacity) {
  static const struct iterate_kit_method board_methods[] = {
    {button_press_path, 2U, button_press},
    {touch_tap_path, 2U, touch_tap},
    {head_nod_path, 2U, head_nod},
    {head_shake_path, 2U, head_shake},
  };
  static struct iterate_kit_servos servos;
  static struct iterate_kit_camera camera;
  static struct iterate_kit_face face;
  static const struct iterate_kit_face_driver face_driver = {
    .context = NULL,
    .slug_at = face_avatar_registry_slug_at,
    .wear = wear_face,
  };
  size_t count = 0U;
  (void)context;
  if (capacity < 5U) return 0U;
  if (body != NULL) {
    /*
     * The donor envelope, enforced before any narrowing: enclosure linkage and
     * servo-horn installation define these, not the SCS0009 catalogue.
     */
    const struct iterate_kit_servo_driver driver = {
      .context = body,
      .move = servo_move,
    };
    const struct iterate_kit_servo_limits limits = {
      .minimum_yaw_degrees = -128,
      .maximum_yaw_degrees = 128,
      .minimum_pitch_degrees = 0,
      .maximum_pitch_degrees = 90,
      .maximum_speed = 1000,
    };
    if (iterate_kit_servos_init(&servos, &driver, &limits) ==
        ITERATE_KIT_OK) {
      out[count++] = iterate_kit_servos_module(&servos);
    }
  }
  /*
   * The camera is mounted here but its SENSOR is not started here — see
   * stackchan_camera.h. Starting it before the radio took the internal DMA
   * memory Wi-Fi needs and left this board reboot-looping, so the first take()
   * brings it up and a board that cannot manage that says so.
   */
  {
    const struct iterate_kit_camera_driver driver =
        iterate_kit_stackchan_camera_driver();
    if (iterate_kit_camera_init(&camera, &driver) ==
        ITERATE_KIT_OK) {
      out[count++] = iterate_kit_camera_module(&camera);
    }
  }
  if (screen_ready) out[count++] = iterate_kit_screen_module(&screen);
  /*
   * `face.set({face})`, the ONLY face changer this board has: the side button
   * opens conversations, so a face nobody can ask for by name is a face the
   * robot never makes.
   */
  if (iterate_kit_face_init(&face, &face_driver) == ITERATE_KIT_OK) {
    out[count++] = iterate_kit_face_module(&face);
  }
  out[count++] = (struct iterate_kit_module){
    .methods = board_methods,
    .method_count = sizeof(board_methods) / sizeof(board_methods[0]),
    .context = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return count;
}

/*
 * The counters that are this board's hardware rather than the loop's state.
 * Same `,"name":value` shape as the shared table, and the same rule: a field
 * that does not fit returns 0 and the whole stats line is dropped, because a
 * truncated document is not a shorter one.
 */
static size_t health(void *context, char *out, size_t capacity) {
  struct iterate_kit_stackchan_avatar_metrics face_metrics;
  (void)context;
  iterate_kit_stackchan_avatar_metrics_snapshot(&face_metrics);
  {
    const struct iterate_kit_health_field fields[] = {
      {"codecCaptureOverruns", stackchan_audio_capture_overruns()},
      {"codecCaptureFailures", stackchan_audio_capture_driver_failures()},
      /*
       * The credit the starvation measure below is gated on. Zero here means
       * the gate CANNOT fire whatever the speaker does, so publishing it is
       * what makes the two numbers underneath falsifiable rather than
       * reassuring — that gate was silently dark on this board.
       */
      {"dmaWrittenMs", iterate_kit_i2s_codec_written_ms()},
      {"codecPlaybackFailures", stackchan_audio_playback_driver_failures()},
      {"spkPartialChunks", stackchan_audio_playback_partial_chunks()},
      /*
       * WHETHER A DIRECTION IS DEAD. After three consecutive I/O failures the
       * audio task gates that direction off permanently — and the failure
       * counters above are incremented behind the same gate, so they FREEZE at
       * the threshold. A dead microphone therefore read exactly like a healthy
       * quiet one. These two say it outright.
       */
      {"capFailed", stackchan_audio_capture_failed() ? 1U : 0U},
      {"spkFailed", stackchan_audio_playback_failed() ? 1U : 0U},
      /*
       * The AEC's own health: engine rebuilds mean the capture timeline broke;
       * clip counters catch abnormal board levels that would otherwise vanish
       * after the next metrics interval. The bridge's own census — refused
       * frames, sequence gaps, clock regressions — is the loop's now, because
       * every board runs one.
       */
      {"aecRecreates", stackchan_processor_recreates()},
      {"aecMode", stackchan_processor_mode()},
      {"aecRecreateFailures", stackchan_processor_recreate_failures()},
      {"aecReferenceClipped",
       (uint32_t)stackchan_processor_reference_clipped_samples()},
      {"aecNearHighPassClipped",
       (uint32_t)stackchan_processor_near_high_pass_clipped_samples()},
      {"aecUplinkClipped",
       (uint32_t)stackchan_processor_uplink_clipped_samples()},
      {"captureEpochResets", stackchan_audio_epoch_resets()},
      /*
       * The camera's own account of itself. The sensor is up only DURING a
       * photograph, so what matters is how many were taken, whether any
       * refused to shut down again, and what the internal heap looked like
       * while one was open.
       */
      {"camPhotographs", iterate_kit_stackchan_camera_photographs()},
      {"camShutdownFailures",
       iterate_kit_stackchan_camera_shutdown_failures()},
      {"camInternalFreeWhileUp",
       iterate_kit_stackchan_camera_internal_free_with_sensor_up()},
      {"camSensorFailures", iterate_kit_stackchan_camera_sensor_failures()},
      {"camEncodeFailures", iterate_kit_stackchan_camera_encode_failures()},
      {"camLargestJpegBytes",
       iterate_kit_stackchan_camera_largest_jpeg_bytes()},
      /*
       * THE FACE, AND THE ONE NUMBER THAT SAYS IT IS ALIVE. A mouth that has
       * stopped moving is either faceFrames standing still or the audio never
       * arriving, and nothing on the screen tells those apart.
       */
      {"faceFrames", face_metrics.analyzer_frames},
      {"faceRenderFails", face_metrics.render_failures},
      /*
       * THE BLACK SCREEN, NAMED. The sidecar switches itself off after a
       * failed or timed-out panel transfer and never switches back on;
       * without these the board looks identical to a working one from every
       * angle except the one you are looking at.
       */
      {"displayActive",
       iterate_kit_stackchan_avatar_display_active() ? 1U : 0U},
      {"displayTransfers", face_metrics.display_transfers},
      {"displayTransferFails", face_metrics.display_transfer_failures},
      {"displayTransferTimeouts", face_metrics.display_transfer_timeouts},
      {"faceDroppedFrames", face_metrics.mailbox_overwrites},
      /*
       * Two of the screen counters the other screens publish, not five: this
       * board's stats line already runs close to the loop's 2816-byte bound,
       * and one that does not fit is not sent at all.
       */
      {"screenUploadFailures", screen.upload_failures},
      {"screenImageShown", screen.showing_image ? 1U : 0U},
    };
    return iterate_kit_health_append_fields(
        out, capacity, fields, sizeof(fields) / sizeof(fields[0]));
  }
}

static const struct iterate_kit_board_ops ops = {
  .start = start,
  .present = present,
  .poll = poll,
  /* The only board that can answer this, and the reason the bridge exists. */
  .capture_meta = capture_meta,
  .modules = modules,
  .health = health,
};

static const struct iterate_kit_board board = {
  .facts = {
  .device_name = "stackchan",
  .speaker = {
    .context = NULL,
    .volume = volume, /* The shipped 60, until board.c restores the kept level. */
    .ceiling = STACKCHAN_AUDIO_VOLUME_CEILING,
  },
  /*
   * Two thirds of the 40 ms I2S DMA ring, so a late frame is absorbed by the
   * hardware cushion rather than concealed, while the remaining third still
   * bounds how long the playback step can sit before the ring empties.
   */
  .speaker_dry_wait_ms = 25,
  /*
   * FIXED BY ESP-SR, not chosen: its VOIP engine processes 16 ms frames and
   * fails closed if told otherwise. The bridge regroups 128 -> 256 -> 320.
   */
  .processing_frame_samples = STACKCHAN_PROCESSOR_FRAME_SAMPLES,
  .capture_chunk_samples = STACKCHAN_AUDIO_CHUNK_SAMPLES,
  /*
   * 8 KiB, not 4. The capture task runs esp-sr's AEC inline through the
   * bridge, which is far deeper than the other boards' capture paths: the
   * proven donor gave aec_process a dedicated 6144-byte stack ON TOP of a
   * 4096-byte I/O task, and 4096 here trips the stack canary the moment the
   * first frame is processed.
   */
  .capture_stack_bytes = 8192,
  /*
   * Codec first, like everyone but the HA Voice PE. This board's bring-up is
   * not the long pole — the camera is, and it is deliberately deferred to its
   * first take() so it cannot take the internal DMA memory Wi-Fi needs.
   */
  },
  .i2c = {.sda = -1, .scl = -1}, /* The CoreS3 BSP owns all buses in extra. */
  .audio = NULL, /* Four-slot TDM and esp-sr remain board-owned. */
  .ring = {.gpio = -1, .power_gpio = -1},
  .status_led_gpio = -1,
  .button = {.gpio = -1},
  .read_gestures = read_gestures,
  .sounds = {.wake = sound_chime_press, .wake_bytes = sizeof(sound_chime_press),
    .speech_peak = ITERATE_KIT_SPEECH_PEAK},
  .play_sound = stackchan_audio_play_sound,
  .set_volume = stackchan_audio_set_volume,
  .extra = &ops,
};

/** ESP-IDF entry point: run this board through the shared voice loop. */
void app_main(void) {
  iterate_kit_board_run(&board);
}
