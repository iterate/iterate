/*
 * M5Stack CoreS3 "StackChan" — what makes this board this board.
 *
 * The program it runs is components/voice/src/voice_loop.c, and it is the same
 * program the other three run. What is left here is the hardware: a face on a
 * 320x240 panel with a status rail, a touch screen that is the only control,
 * a head on two servos, a camera, and — the one structural novelty — a
 * SOFTWARE echo canceller with three different frame sizes behind it.
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
 * Turn taking is the PROVIDER'S, on the strength of that canceller: the
 * microphone rides the open call and server VAD segments turns. A recorded
 * divergence from decision A2, and the right one — push-to-talk's rationale is
 * the echo story on boards WITHOUT cancellation, and gating this microphone
 * would defeat the ported AEC's entire purpose.
 *
 * The status STRINGS go to the console log rather than the screen: the face
 * owns the glass and a semantic snapshot owns the rail, so there is nowhere a
 * sentence would go. Opening the USB console reboots this board, which is why
 * `health()` and `screen.take()` exist.
 */
#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "iterate/kit/capabilities/arguments.h"
#include "iterate/kit/capabilities/camera.h"
#include "iterate/kit/capabilities/servos.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/devices/stackchan.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_device_profile.h"

#include "stackchan_audio.h"
#include "stackchan_avatar.h"
#include "stackchan_body.h"
#include "stackchan_camera.h"
#include "stackchan_processor.h"

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

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  /*
   * The avatar owns the panel, so it goes first: there is no screen to say
   * anything on until it is up, and nothing left to say it about if it fails.
   */
  if (iterate_kit_stackchan_avatar_start() != ESP_OK) return false;
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

/*
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
  if (last_present_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now, last_present_ms) < 50U) {
    return;
  }
  last_present_ms = now;
  visual = (struct iterate_kit_conversation_visual_state){
    .network = view->link_ready ? ITERATE_KIT_NETWORK_CONNECTED
                                : ITERATE_KIT_NETWORK_CONNECTING,
    .reach = iterate_kit_reach_from(
        view->api_ready, view->stream_ready, view->call_active),
    .has_wifi_rssi = false,
    .wifi_rssi_dbm = 0,
    .conversation_active = view->call_active,
    .media_ready = view->link_ready,
    .media_failed = view->fault,
    .microphone_listening = view->listening,
    .microphone_peak = view->microphone_peak,
    /* The one hardware-owned "is it speaking" fact both surfaces share. */
    .speaker_peak = iterate_kit_stackchan_avatar_speaker_status_peak(),
    .restart_armed = false,
  };
  /*
   * The OVERLAY comparison for the face, not the lights one: the screen also
   * carries a word, and "connecting" and "ready" can render the same twelve
   * pixels.
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

static void poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  /*
   * ONE CONTROL, AND IT IS THE WHOLE SCREEN. A coherent tap anywhere toggles
   * whether a call is wanted; the loop resolves the toggle against the intent
   * it holds, because this board cannot say start and end apart.
   */
  out->toggle_call = iterate_kit_stackchan_avatar_take_call_touch_tap();
}

static void phase(void *context, enum iterate_kit_voice_phase phase_value) {
  (void)context;
  switch (phase_value) {
    case ITERATE_KIT_VOICE_PHASE_ARRIVED:
    case ITERATE_KIT_VOICE_PHASE_QUIET:
      /*
       * NO AMPLIFIER TO GATE. The speaker rail stays up for the life of the
       * boot: the software canceller's reference is taken from the running TX
       * stream, so cutting the rail between answers would take the reference
       * with it and the filter would re-adapt at the start of every answer.
       */
      break;
    case ITERATE_KIT_VOICE_PHASE_FEEDING:
      stackchan_audio_watch(true);
      break;
    case ITERATE_KIT_VOICE_PHASE_WAITING:
      stackchan_audio_watch(false);
      break;
    case ITERATE_KIT_VOICE_PHASE_DRAINING:
      stackchan_audio_draining();
      stackchan_audio_watch(false);
      break;
    case ITERATE_KIT_VOICE_PHASE_FLUSHED:
      /* Disarm before declaring: the other order records the device's own
       * intentional cut as listener-visible starvation. */
      stackchan_audio_watch(false);
      stackchan_audio_note_flush();
      break;
  }
}

/*
 * WHAT THE CODEC KNOWS ABOUT THE CHUNK IT JUST HANDED OVER, which on this
 * board is all three things the bridge needs and on the others is none of
 * them: a DMA sequence that gaps when the hardware does, a completion
 * timestamp that back-dates each egress frame, and whether the far end was
 * audible while this chunk was recorded.
 *
 * The epoch latch is CONSUMED here, so it must only be read once per accepted
 * chunk — which is exactly when the loop calls this.
 */
static void capture_meta(
    void *context, struct iterate_kit_voice_capture_meta *out) {
  (void)context;
  out->epoch_reset = stackchan_audio_take_epoch_reset();
  stackchan_audio_last_chunk_meta(
      &out->sequence, &out->captured_through_at_us,
      &out->playback_content_active);
}

static enum iterate_kit_status set_volume(
    void *context, uint8_t percent, uint8_t *applied) {
  (void)context;
  return stackchan_audio_set_volume(percent, applied);
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

/*
 * The screen's own copy of the frame, because the loan outlives the dispatch.
 *
 * The image module borrows these bytes into a reply serialised after the
 * dispatch returns, so this cannot be the avatar's live surface — the render
 * task would be writing the next face into it mid-send. PSRAM for the same
 * reason the source surface is there: 38.4 KiB of internal DMA memory is the
 * pool TLS and Wi-Fi compete for, and losing that argument drops calls.
 *
 * Allocated on first use and kept. A screenshot is rare, but a board asked for
 * one twice must not fail the second time because the heap moved in between.
 */
static uint16_t *screen_pixels;

static enum iterate_kit_status capture_screen(
    void *context, struct iterate_kit_photo *photo) {
  uint16_t width = 0U;
  uint16_t height = 0U;
  (void)context;
  if (screen_pixels == NULL) {
    screen_pixels = heap_caps_malloc(
        (size_t)FACE_RENDER_PIXEL_COUNT * sizeof(*screen_pixels),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (screen_pixels == NULL) return ITERATE_KIT_LIMIT;
  }
  if (iterate_kit_stackchan_avatar_capture(
          screen_pixels,
          (size_t)FACE_RENDER_PIXEL_COUNT,
          &width,
          &height) != ESP_OK) {
    /*
     * The avatar is not running, or a render held the surface for two whole
     * visual ticks. Both are worth retrying and neither is this module's to
     * fix, so it says "busy" rather than inventing a frame.
     */
    return ITERATE_KIT_BACKPRESSURE;
  }
  photo->bytes = (const uint8_t *)screen_pixels;
  photo->length = (size_t)FACE_RENDER_PIXEL_COUNT * sizeof(*screen_pixels);
  photo->width = width;
  photo->height = height;
  /*
   * Not a MIME type anyone will decode by name: these are raw host-order
   * RGB565 pixels, and the caller wraps them in a PNG. Saying so beats
   * "application/octet-stream", which would be true and useless.
   */
  photo->content_type = "image/x-rgb565";
  photo->release_context = NULL;
  photo->release = NULL;
  return ITERATE_KIT_OK;
}

/*
 * `screen.fill({colour})` — the separator of last resort for a dark panel.
 *
 * Every counter this board publishes can read healthy while the glass stays
 * dark: `screen.take()` proves the source surface holds a face, and
 * `displayTransfers` proves bands are pushed and acknowledged. Both are true
 * and the screen still shows nothing, so what remains is either the content
 * arriving wrong or the panel showing nothing at all — indistinguishable from
 * inside, and one glance from outside.
 */
static const char *const screen_fill_path[] = {"screen", "fill"};

static enum capnweb_status screen_fill(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value object = {0};
  int64_t colour = 0;
  (void)context;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "colour", &colour) ||
      colour < 0 || colour > 0xffff) {
    return capnweb_reply_set_error(
        reply, "TypeError", "screen.fill needs {colour} as RGB565 0..65535");
  }
  if (iterate_kit_stackchan_avatar_fill((uint16_t)colour) != ESP_OK) {
    return capnweb_reply_set_error(
        reply, "Error", "the display refused the fill");
  }
  return capnweb_reply_set_boolean(reply, true);
}

/*
 * The four this board has that no other does: a head, a camera, its own
 * screen as an image source, and the fill. Conversation control, the speaker
 * and health are the loop's, and push-to-talk is not mounted at all because
 * this board's turns are the provider's.
 */
static size_t modules(
    void *context, struct iterate_kit_module *out, size_t capacity) {
  static const struct iterate_kit_method screen_fill_methods[] = {
    {screen_fill_path, 2U, screen_fill},
  };
  static struct iterate_kit_servos servos;
  static struct iterate_kit_camera camera;
  static struct iterate_kit_camera screen;
  size_t count = 0U;
  (void)context;
  if (capacity < 4U) return 0U;
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
    if (iterate_kit_camera_init(&camera, &driver, "camera") ==
        ITERATE_KIT_OK) {
      out[count++] = iterate_kit_camera_module(&camera);
    }
  }
  /*
   * THE SCREEN, ASKABLE, for the same reason health() is.
   *
   * "The StackChan's screen is black the whole time but the LEDs are green"
   * was reported three times and could not be answered from here: every
   * instrument this board publishes about its display measures the PIPE — is
   * the panel active, how many transfers, how many failed — and all of them
   * read healthy while a face drawn in the background colour would too. The
   * pixels themselves were the one thing nobody could ask for.
   *
   * Same protocol as the camera, and deliberately the same code: hold one
   * frame, drain it in chunks that fit a control message.
   */
  {
    const struct iterate_kit_camera_driver driver = {
      .context = NULL,
      .capture = capture_screen,
    };
    if (iterate_kit_camera_init(&screen, &driver, "screen") ==
        ITERATE_KIT_OK) {
      out[count++] = iterate_kit_camera_module(&screen);
    }
  }
  out[count++] = (struct iterate_kit_module){
    .methods = screen_fill_methods,
    .method_count = sizeof(screen_fill_methods) / sizeof(screen_fill_methods[0]),
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
  struct field {
    const char *name;
    uint32_t value;
  };
  struct iterate_kit_stackchan_avatar_metrics face_metrics;
  size_t used = 0U;
  size_t index;
  (void)context;
  iterate_kit_stackchan_avatar_metrics_snapshot(&face_metrics);
  {
    const struct field fields[] = {
      {"codecCaptureOverruns", stackchan_audio_capture_overruns()},
      {"codecCaptureFailures", stackchan_audio_capture_driver_failures()},
      /*
       * The credit the starvation measure below is gated on. Zero here means
       * the gate CANNOT fire whatever the speaker does, so publishing it is
       * what makes the two numbers underneath falsifiable rather than
       * reassuring — that gate was silently dark on this board.
       */
      {"dmaWrittenMs", stackchan_audio_written_ms()},
      /* The task-side starvation measure: ms the ring was empty, how often. */
      {"spkStarvedMs", stackchan_audio_starved_ms()},
      {"spkStarveEvents", stackchan_audio_starve_events()},
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
    };
    for (index = 0U; index < sizeof(fields) / sizeof(fields[0]); index++) {
      const int written = snprintf(
          out + used,
          capacity - used,
          ",\"%s\":%u",
          fields[index].name,
          (unsigned int)fields[index].value);
      if (written <= 0 || (size_t)written >= capacity - used) return 0U;
      used += (size_t)written;
    }
  }
  return used;
}

static const struct iterate_kit_board_ops ops = {
  .start = start,
  .present = present,
  .poll = poll,
  .phase = phase,
  /* The only board that can answer this, and the reason the bridge exists. */
  .capture_meta = capture_meta,
  /* Full duplex behind its own canceller: no fence, nothing to wait for. */
  .capture_fence = NULL,
  .playout_fenced_out = NULL,
  /*
   * The mouth is fed by the AUDIO DRIVER, not from here: the observer is
   * installed in `start` so the analyser sees samples the hardware accepted,
   * on the task that accepted them. `observe_playout` would be the same tap
   * one hop later.
   */
  .observe_playout = NULL,
  .observe_answer = NULL,
  .modules = modules,
  .health = health,
};

static const struct iterate_kit_board_facts facts = {
  .stream_path = "/agents/voice/stackchan",
  .client_path = "/clients/stackchan",
  .conversation_id = "scdev",
  .greeting = "Hi, I am your Iterate device. What can I do for you?",
  .instructions =
      "StackChan: a small desk robot with a face, a moving head and a camera. "
      "Touching its screen starts and ends the call, and its microphone stays "
      "OPEN throughout — it cancels its own speaker, so it can be interrupted. "
      "conversation.start() and conversation.end() begin and end a call. "
      "health() returns this device's full diagnostics, the same document it "
      "pushes as dev-stats — start there when it seems unwell. "
      "speaker.setVolume({percent}) sets how loud it plays, 0-100, clamped to "
      "a ceiling this board has a measured reason for; speaker.volume() reads "
      "it back. Both answer {percent,ceiling}. "
      "servos.move({yawDegrees,pitchDegrees,speed}) turns its head: yaw -128 "
      "to 128, pitch 0 to 90, speed up to 1000. Returning to 0,0 is looking "
      "straight ahead. "
      "camera.take() photographs what it can see and returns "
      "{width,height,contentType,bytes,chunkSize,chunks}; "
      "camera.readChunk({index}) then returns each piece in order, because one "
      "image is larger than a single message. The first take() powers the "
      "sensor up, so it is the slow one. "
      "screen.take() and screen.readChunk({index}) do the same for what is on "
      "the panel right now, and screen.fill({colour}) paints it a flat RGB565 "
      "colour — the only way to tell a dark panel from a dark face. "
      "Audio and lifecycle events share this stream connection.",
  /*
   * WHAT THE MODEL IS TOLD IT CAN DO. `children` stays empty because this is a
   * flattened dispatch target — sub-paths are routes the device interprets,
   * not members the host can enumerate — so the method list has to be in the
   * prose or it is nowhere. A capability nothing advertises is one nothing
   * calls: a back-office agent asked for this device's metrics once went
   * hunting through telemetry streams because nothing told it health() existed.
   */
  .peer_description =
      "{\"instructions\":\"StackChan voice robot. "
      "conversation.start() / conversation.end() begin and end a call. "
      "servos.move({yawDegrees,pitchDegrees,speed}) turns its head; yaw "
      "-128..128, pitch 0..90, speed up to 1000. "
      "speaker.setVolume({percent}) sets how loud it plays, 0-100; it clamps "
      "to a ceiling this board has a measured reason for and answers with "
      "{percent,ceiling}, which speaker.volume() also returns. "
      "health() returns the same diagnostics document the device pushes as "
      "dev-stats, including whether its audio directions are alive. "
      "camera.take() photographs what it can see and returns "
      "{width,height,contentType,bytes,chunkSize,chunks}; then "
      "camera.readChunk({index}) returns each piece in order — the image is "
      "delivered in pieces because one is larger than a single message, and it "
      "is held until the next take(). The sensor is powered up by the first "
      "take(), so that call is the slow one and it is the call that reports a "
      "unit whose camera cannot start. screen.take() / screen.readChunk() do "
      "the same for the panel's current contents, and screen.fill({colour}) "
      "paints it flat.\",\"children\":{}}",
  .talk_hint = "speak whenever you like",
  .call_hint = "connection lost — touch the screen to call",
  .speaker = {
    .context = NULL,
    .set_volume = set_volume,
    .volume = volume,
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
  .turns = ITERATE_KIT_VOICE_TURNS_SERVER_VAD,
  /*
   * Codec first, like everyone but the HA Voice PE. This board's bring-up is
   * not the long pole — the camera is, and it is deliberately deferred to its
   * first take() so it cannot take the internal DMA memory Wi-Fi needs.
   */
  .radio_before_codec = false,
};

void iterate_kit_stackchan_run(void) {
  iterate_kit_voice_loop_run(&ops, &facts, NULL);
}
