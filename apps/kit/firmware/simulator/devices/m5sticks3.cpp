#include "iterate/kit/devices/m5sticks3.h"
#include "iterate/kit/simulator/hardware.hpp"
#include "iterate/kit/simulator/runner.hpp"

#include <cstddef>
#include <cstdint>

namespace {

/*
 * This process is a deterministic control-plane model around the production
 * M5StickS3 profile. It exercises Cap'n Web dispatch, push-to-talk event
 * ordering, audio-controller ownership/backpressure, metrics, poll, and close.
 * It deliberately does not synthesize sound or imitate I2S/DMA, FreeRTOS task
 * priorities, WebSocket buffering, AEC, or audible latency. Those realtime
 * properties need deterministic fault models plus physical-device evidence;
 * inventing them here would turn a protocol simulator into a misleading board
 * emulator.
 *
 * The stdio runner is the sole owner of Simulation and invokes every callback
 * synchronously. Plain fields therefore document the host harness's ownership,
 * not a license to omit atomics/queues at a real ISR or task boundary.
 */
constexpr std::size_t subscriptionCapacity = 2U;

/*
 * 512 URL bytes plus a terminator exercises bounded caller scratch. Eight
 * event slots can retain a short burst while the real profile limits work per
 * poll, and two metric slots permit independent-subscription scenarios. These
 * are explicit harness limits whose exhaustion remains observable, not magic
 * production defaults for every board.
 */
constexpr std::size_t screenUrlCapacity = 513U;
constexpr std::size_t eventCapacity = 8U;
constexpr std::size_t eventNotificationCapacity = 8U;

struct Simulation {
  iterate::kit::simulator::CommonHardware common;

  /* All buffers and profile state are embedded so the production allocation-
   * free lifetime contract remains intact in the host process. */
  char screenUrlScratch[screenUrlCapacity]{};
  char diagnosticsExpression
      [ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY]{};
  iterate_kit_metrics_subscription subscriptions[subscriptionCapacity]{};
  iterate_kit_device_event eventStorage[eventCapacity]{};
  iterate_kit_device_event_notification
      eventNotifications[eventNotificationCapacity]{};
  iterate_kit_m5sticks3 m5sticks3{};
  iterate_kit_device profile{};

  /*
   * The fake egress accepts at most one PCM frame and withholds completion
   * until an explicit test RPC. This models the crucial ownership interval
   * after local acceptance: submitting a second frame must produce bounded,
   * visible backpressure rather than overwrite or queue stale speech.
   */
  iterate_kit_audio_send_complete_fn pendingSend = nullptr;
  void *pendingSendContext = nullptr;

  /*
   * Counts expose causal effects at hardware/transport boundaries. They are
   * more useful than booleans because duplicate starts, stops, flushes, or
   * interruption events are lifecycle defects that a final-state check hides.
   */
  std::uint64_t captureStartCount = 0U;
  std::uint64_t captureStopCount = 0U;
  std::uint64_t playbackStopCount = 0U;
  std::uint64_t playbackFlushCount = 0U;
  std::uint64_t interruptionCount = 0U;
  std::uint64_t captureStartedEventCount = 0U;
  std::uint64_t captureEndedEventCount = 0U;

  /*
   * A test can close the profile before stdin closes to prove idempotent outer
   * cleanup and post-close rejection. The flag belongs to the simulator
   * wrapper; the real profile still owns its internal lifecycle.
   */
  bool profileClosed = false;
};

/*
 * Driver callbacks count requests without introducing fake device state
 * machines. The production audio controller decides whether an edge should
 * start/stop capture or abort playback; these observations prove that policy
 * reached the correct boundary. Hardware success is unconditional here so a
 * failure cannot be misattributed to an invented board model.
 */
iterate_kit_status startCapture(void *context) {
  ++static_cast<Simulation *>(context)->captureStartCount;
  return ITERATE_KIT_OK;
}

iterate_kit_status stopCapture(void *context) {
  ++static_cast<Simulation *>(context)->captureStopCount;
  return ITERATE_KIT_OK;
}

iterate_kit_status stopPlayback(void *context) {
  ++static_cast<Simulation *>(context)->playbackStopCount;
  return ITERATE_KIT_OK;
}

iterate_kit_status flushPlayback(void *context) {
  ++static_cast<Simulation *>(context)->playbackFlushCount;
  return ITERATE_KIT_OK;
}

iterate_kit_status sendEvent(
    void *context, iterate_kit_audio_event event) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * Non-PCM events are counted separately because interruption and capture
   * lifecycle have distinct remote meaning. Collapsing them into one "sent"
   * counter would miss a profile that emitted the wrong event at the right
   * time.
   */
  switch (event) {
    case ITERATE_KIT_AUDIO_INTERRUPTION:
      ++simulation.interruptionCount;
      break;
    case ITERATE_KIT_AUDIO_CAPTURE_STARTED:
      ++simulation.captureStartedEventCount;
      break;
    case ITERATE_KIT_AUDIO_CAPTURE_ENDED:
      ++simulation.captureEndedEventCount;
      break;
  }
  return ITERATE_KIT_OK;
}

iterate_kit_status sendPcm(
    void *context,
    const std::int16_t *,
    std::size_t,
    std::uint32_t,
    iterate_kit_audio_send_complete_fn complete,
    void *completeContext) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * Samples and rate are intentionally not interpreted: this scenario is about
   * asynchronous ownership and drop accounting, not signal fidelity. A second
   * outstanding completion is a local state error, never an invitation to
   * append an unbounded queue that could replay stale microphone audio later.
   */
  if (simulation.pendingSend != nullptr) {
    return ITERATE_KIT_STATE_ERROR;
  }
  simulation.pendingSend = complete;
  simulation.pendingSendContext = completeContext;
  return ITERATE_KIT_OK;
}

iterate_kit_status pollCapture(
    void *,
    iterate_kit_audio_capture_submit_fn,
    void *) {
  /*
   * Capture is injected explicitly through __test.submitCapture. Generating a
   * frame on every host poll would tie audio rate to the runner's 10 ms select
   * cadence and create a false realtime model. The ESP platform and PCM fault
   * harness prove continuous push-to-talk capture separately.
   */
  return ITERATE_KIT_OK;
}

bool pathEquals(
    const capnweb_call *call,
    const char *first,
    const char *second) {
  /*
   * Hidden probes share the Cap'n Web path machinery so tests cross the real
   * C peer. They are namespaced away from product capabilities and are never
   * part of a physical device manifest.
   */
  const char *path[] = {first, second};
  return capnweb_call_path_equals(call, path, 2U);
}

capnweb_status replyWithStatus(
    capnweb_reply *reply, iterate_kit_status status) {
  return capnweb_reply_set_int64(
      reply, static_cast<std::int64_t>(status));
}

capnweb_status dispatch(
    void *context,
    const capnweb_call *call,
    capnweb_reply *reply) {
  /*
   * A 320-sample frame represents 20 ms at 16 kHz, a realistic control-test
   * geometry without pretending to contain microphone signal. Static lifetime
   * keeps the borrowed samples valid until the deliberately delayed completion.
   */
  static const std::int16_t frame[320]{};
  auto &simulation = *static_cast<Simulation *>(context);

  /*
   * This interposer adds only host test stimuli/observations. All public paths
   * fall through to the production profile, so a green e2e cannot result from
   * a TypeScript or C++ reimplementation of device policy.
   */
  if (pathEquals(call, "__test", "renderUrlHash")) {
    return capnweb_reply_set_int64(
        reply,
        static_cast<std::int64_t>(simulation.common.renderUrlHash));
  }
  if (pathEquals(call, "__test", "audioMode")) {
    return capnweb_reply_set_int64(
        reply,
        static_cast<std::int64_t>(
            simulation.profile.manifest->audio_mode));
  }
  if (pathEquals(call, "__test", "notePlaybackStarted")) {
    return replyWithStatus(
        reply,
        iterate_kit_m5sticks3_note_playback_started(
            &simulation.m5sticks3));
  }
  if (pathEquals(call, "__test", "pressButton")) {
    /*
     * Publish a PHYSICAL edge rather than call startCapture directly. That
     * forces the same bounded event queue, interruption policy, and audio
     * controller transition used by the board button.
     */
    return replyWithStatus(
        reply,
        iterate_kit_m5sticks3_publish_push_to_talk(
            &simulation.m5sticks3,
            true,
            ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL));
  }
  if (pathEquals(call, "__test", "releaseButton")) {
    return replyWithStatus(
        reply,
        iterate_kit_m5sticks3_publish_push_to_talk(
            &simulation.m5sticks3,
            false,
            ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL));
  }
  if (pathEquals(call, "__test", "submitCapture")) {
    /*
     * Explicit injection lets a test hold push-to-talk for arbitrary logical
     * time and decide exactly when frames arrive. This avoids coupling PCM
     * production to host scheduler jitter.
     */
    return replyWithStatus(
        reply,
        iterate_kit_m5sticks3_submit_capture(
            &simulation.m5sticks3,
            frame,
            sizeof(frame) / sizeof(frame[0]),
            16'000U));
  }
  if (pathEquals(call, "__test", "completeCapture")) {
    /*
     * Local send acceptance is not completion. Separating the two lets tests
     * prove that an in-flight frame remains owned, a second submission drops
     * visibly, and ownership is returned only when egress reports a result.
     */
    if (simulation.pendingSend == nullptr) {
      return replyWithStatus(reply, ITERATE_KIT_STATE_ERROR);
    }
    const auto complete = simulation.pendingSend;
    void *const completeContext = simulation.pendingSendContext;
    simulation.pendingSend = nullptr;
    simulation.pendingSendContext = nullptr;
    complete(completeContext, ITERATE_KIT_OK);
    return replyWithStatus(reply, ITERATE_KIT_OK);
  }
  if (pathEquals(call, "__test", "captureFramesDropped")) {
    const iterate_kit_audio_metrics *const metrics =
        iterate_kit_m5sticks3_audio_metrics(
            &simulation.m5sticks3);
    if (metrics == nullptr) {
      return replyWithStatus(reply, ITERATE_KIT_STATE_ERROR);
    }
    return capnweb_reply_set_int64(
        reply,
        static_cast<std::int64_t>(metrics->capture_frames_dropped));
  }
  if (pathEquals(call, "__test", "captureStartCount")) {
    return capnweb_reply_set_int64(reply, simulation.captureStartCount);
  }
  if (pathEquals(call, "__test", "captureStopCount")) {
    return capnweb_reply_set_int64(reply, simulation.captureStopCount);
  }
  if (pathEquals(call, "__test", "playbackStopCount")) {
    return capnweb_reply_set_int64(reply, simulation.playbackStopCount);
  }
  if (pathEquals(call, "__test", "playbackFlushCount")) {
    return capnweb_reply_set_int64(reply, simulation.playbackFlushCount);
  }
  if (pathEquals(call, "__test", "interruptionCount")) {
    return capnweb_reply_set_int64(reply, simulation.interruptionCount);
  }
  if (pathEquals(call, "__test", "closeProfile")) {
    /*
     * Closing while capture or a send is active exposes cleanup races that a
     * normal EOF-after-idle path cannot. Reject a second direct close so tests
     * cannot normalize an invalid lifecycle as harmless.
     */
    if (simulation.profileClosed) {
      return replyWithStatus(reply, ITERATE_KIT_STATE_ERROR);
    }
    const iterate_kit_poll_result result =
        simulation.profile.close(simulation.profile.context);
    simulation.profileClosed = true;
    return replyWithStatus(
        reply,
        result.status == ITERATE_KIT_POLL_OK
            ? ITERATE_KIT_OK
            : ITERATE_KIT_IO_ERROR);
  }
  /* Product RPCs always use the profile dispatcher; __test never shadows them. */
  return simulation.profile.capability.dispatch(
      simulation.profile.capability.context, call, reply);
}

iterate_kit_poll_result poll(void *context, std::uint64_t nowMilliseconds) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * Keep fake telemetry and profile scheduling in one monotonic time domain.
   * Once explicitly closed, polling becomes a benign outer-runner no-op rather
   * than re-entering released profile state.
   */
  simulation.common.nowMilliseconds = nowMilliseconds;
  if (simulation.profileClosed) {
    return {ITERATE_KIT_POLL_OK, CAPNWEB_OK};
  }
  return simulation.profile.poll(
      simulation.profile.context, nowMilliseconds);
}

iterate_kit_poll_result close(void *context) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * The transport owns completion of an accepted PCM frame. EOF must therefore
   * return that ownership with a classified I/O failure before profile storage
   * disappears; silently forgetting the callback would look like permanent
   * backpressure to the audio controller. No samples are retried on shutdown,
   * because delayed speech is worse than an observable dropped frame.
   */
  if (simulation.pendingSend != nullptr) {
    const auto complete = simulation.pendingSend;
    void *const completeContext = simulation.pendingSendContext;
    simulation.pendingSend = nullptr;
    simulation.pendingSendContext = nullptr;
    complete(completeContext, ITERATE_KIT_IO_ERROR);
  }
  if (simulation.profileClosed) {
    /* A prior __test.closeProfile already performed real cleanup. The runner's
     * mandatory final close must not invoke it a second time. */
    return {ITERATE_KIT_POLL_OK, CAPNWEB_OK};
  }
  simulation.profileClosed = true;
  return simulation.profile.close(simulation.profile.context);
}

capnweb_status initialize(
    void *context,
    capnweb_session *session,
    iterate_kit_device *device) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * Establish uptime before metrics can be subscribed. Every pointer installed
   * below refers into Simulation, whose lifetime encloses the complete runner;
   * the profile and simulator therefore need no allocator or hidden ownership.
   */
  simulation.common.startedMilliseconds =
      iterate::kit::simulator::monotonicMilliseconds();
  simulation.common.nowMilliseconds =
      simulation.common.startedMilliseconds;
  const iterate_kit_m5sticks3_options options{
    {&simulation.common,
     iterate::kit::simulator::renderPng,
     iterate::kit::simulator::changeColour},
    simulation.screenUrlScratch,
    sizeof(simulation.screenUrlScratch),
    {
      session,
      {&simulation.common, iterate::kit::simulator::sampleMetrics},
      simulation.subscriptions,
      subscriptionCapacity,
      /*
       * Accelerated sampling keeps host e2e tests short. This is not the
       * product's eventual one-second metrics period or an ESP CPU budget.
       */
      25U,
      simulation.diagnosticsExpression,
      sizeof(simulation.diagnosticsExpression),
      nullptr,
    },
    {
      ITERATE_KIT_AUDIO_PUSH_TO_TALK,
      {
        &simulation,
        startCapture,
        stopCapture,
        stopPlayback,
        flushPlayback,
      },
      {
        &simulation,
        sendEvent,
        sendPcm,
      },
      {
        &simulation,
        pollCapture,
      },
    },
    simulation.eventStorage,
    eventCapacity,
    {
      session,
      simulation.eventNotifications,
      eventNotificationCapacity,
      nullptr,
    },
    {nullptr, nullptr},
    /*
     * Match the production target's reviewed eight-message control burst even
     * though the host stdio transport itself has no small mailbox.
     */
    2U,
  };
  const capnweb_status status =
      iterate_kit_m5sticks3_init(&simulation.m5sticks3, &options);
  if (status != CAPNWEB_OK) return status;
  simulation.profile =
      iterate_kit_m5sticks3_device(&simulation.m5sticks3);
  /*
   * Wrap only dispatch to add __test. Poll and close preserve the real device
   * context, while the wrapper coordinates the deliberately early-close and
   * pending-send cases owned by the simulator.
   */
  *device = {
    simulation.profile.manifest,
    {dispatch, &simulation, nullptr},
    &simulation,
    poll,
    close,
  };
  return CAPNWEB_OK;
}

}  // namespace

int main() {
  /*
   * One aggregate keeps all borrowed contexts and fixed storage alive. Its host
   * stack footprint is a harness implementation detail; target RAM is reported
   * by compile-time profile accounting and on-device metrics.
   */
  Simulation simulation{};
  return iterate::kit::simulator::run({
    "M5StickS3",
    &simulation,
    initialize,
  });
}
