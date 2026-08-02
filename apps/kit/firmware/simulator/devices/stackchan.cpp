#include "iterate/kit/devices/stackchan.h"
#include "iterate/kit/simulator/hardware.hpp"
#include "iterate/kit/simulator/runner.hpp"

#include <cstddef>
#include <cstdint>

namespace {

/*
 * This executable composes the production StackChan profile with observation
 * drivers. RPC parsing, capability routing, borrowed-buffer lifetimes, camera
 * release, metrics subscriptions, polling, and close are therefore real; PWM,
 * LEDs, camera capture, display networking/decoding, task scheduling, and
 * electrical timing are not. Keeping that boundary narrow is more useful than
 * a feature-rich mock whose behaviour could drift from the portable C code.
 *
 * The stdio runner is the sole owner of Simulation. Driver callbacks execute
 * synchronously on that thread, so plain fields are correct here and must not
 * be copied as a concurrency pattern into an ESP platform driver.
 */
constexpr std::size_t subscriptionCapacity = 2U;

/*
 * 512 URL bytes plus the terminator exercises caller-provided screen scratch
 * without allocating. Two subscriptions allow lifecycle/independence tests but
 * are harness scenario limits, not universal production sizing guidance.
 * Exhaustion is expected to surface through the real capability module.
 */
constexpr std::size_t screenUrlCapacity = 513U;

/*
 * The camera fixture is only a bounded JPEG-shaped payload with explicit
 * ownership. It proves bytes and release semantics traverse Cap'n Web; it is
 * deliberately not decoded, so success cannot be cited as sensor, JPEG codec,
 * image-quality, or large-photo throughput evidence.
 */
constexpr std::uint8_t sampleJpeg[] = {
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J',  'F',  'I',  'F', 0x00,
  0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
};

struct Simulation {
  iterate::kit::simulator::CommonHardware common;

  /*
   * Last-command registers let the TypeScript peer ask what reached each driver
   * boundary. Modeling servo travel or LED persistence was rejected because a
   * guessed physics model would add false confidence; real hardware tests must
   * establish range, speed, power, and visual behaviour.
   */
  std::int32_t servoYawDegrees = 0;
  std::int32_t servoPitchDegrees = 0;
  std::uint16_t servoSpeed = 0U;
  std::uint8_t ledIndex = 0U;
  std::uint8_t ledRed = 0U;
  std::uint8_t ledGreen = 0U;
  std::uint8_t ledBlue = 0U;

  /*
   * A returned photo remains borrowed until the camera release callback runs.
   * Counting releases catches leaks and double-release bugs that a plain byte
   * fixture would hide.
   */
  std::uint32_t photoReleaseCount = 0U;

  /* All following storage is caller-owned for the full profile lifetime,
   * matching the allocation-free device contract. */
  char screenUrlScratch[screenUrlCapacity]{};
  char diagnosticsExpression
      [ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY]{};
  iterate_kit_metrics_subscription subscriptions[subscriptionCapacity]{};
  iterate_kit_stackchan stackchan{};
  iterate_kit_device profile{};
};

iterate_kit_status requestPlaybackInterruption(
    void *context, std::uint32_t *token) {
  if (context == nullptr || token == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  /*
   * The host has no DMA descriptors to retire, so acknowledgement can be
   * immediate. Still using the asynchronous token seam is important: it keeps
   * the production capability lifecycle under test instead of bypassing it
   * with a simulator-only synchronous method.
   */
  *token = 1U;
  return ITERATE_KIT_OK;
}

iterate_kit_status pollPlaybackInterruption(
    void *context, std::uint32_t token) {
  if (context == nullptr || token != 1U) return ITERATE_KIT_INVALID_ARGUMENT;
  return ITERATE_KIT_OK;
}

iterate_kit_status moveServos(
    void *context,
    std::int32_t yawDegrees,
    std::int32_t pitchDegrees,
    std::uint16_t speed) {
  /*
   * Record the command at the simulator-call boundary rather than interpolate
   * motion. This proves argument conversion and dispatch exactly; it does not
   * prove that a physical servo can reach the requested pose.
   */
  auto &simulation = *static_cast<Simulation *>(context);
  simulation.servoYawDegrees = yawDegrees;
  simulation.servoPitchDegrees = pitchDegrees;
  simulation.servoSpeed = speed;
  return ITERATE_KIT_OK;
}

iterate_kit_status setLed(
    void *context,
    std::uint8_t index,
    std::uint8_t red,
    std::uint8_t green,
    std::uint8_t blue) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * Preserve index and colour independently so the test can distinguish a
   * single-pixel command from fill(). No LED count or electrical behaviour is
   * inferred; range validation belongs to the real capability/board contract.
   */
  simulation.ledIndex = index;
  simulation.ledRed = red;
  simulation.ledGreen = green;
  simulation.ledBlue = blue;
  return ITERATE_KIT_OK;
}

iterate_kit_status fillLeds(
    void *context,
    std::uint8_t red,
    std::uint8_t green,
    std::uint8_t blue) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * The current assertions care that RGB values reach the shared LED driver.
   * Per-pixel framebuffer emulation would duplicate capability policy and is
   * left to a future visual simulator if it gains a concrete requirement.
   */
  simulation.ledRed = red;
  simulation.ledGreen = green;
  simulation.ledBlue = blue;
  return ITERATE_KIT_OK;
}

void releasePhoto(void *context) {
  /*
   * Release is observable because camera buffers are scarce on-device. A
   * protocol path that returns correct bytes but never returns the frame to the
   * camera would eventually wedge capture under real memory pressure.
   */
  ++static_cast<Simulation *>(context)->photoReleaseCount;
}

iterate_kit_status takePhoto(
    void *context, iterate_kit_photo *photo) {
  if (photo == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  /*
   * The static payload eliminates allocation and nondeterminism while retaining
   * the real borrowed-buffer contract: the capability layer, not this driver,
   * decides when serialization is complete and calls releasePhoto exactly once.
   */
  *photo = {
    sampleJpeg,
    sizeof(sampleJpeg),
    releasePhoto,
    context,
  };
  return ITERATE_KIT_OK;
}

bool pathEquals(
    const capnweb_call *call,
    const char *first,
    const char *second) {
  /*
   * Host-only probes live below __test so they cannot collide with the public
   * device tree. They inspect effects after calls have crossed the real Cap'n
   * Web/profile boundary; a fake API that directly mutated state would bypass
   * the behaviour this simulator exists to test.
   */
  const char *path[] = {first, second};
  return capnweb_call_path_equals(call, path, 2U);
}

capnweb_status dispatch(
    void *context,
    const capnweb_call *call,
    capnweb_reply *reply) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * Interpose only read-only test observations, then delegate every product
   * capability to the profile's actual dispatcher. The hidden namespace is a
   * harness surface and must never be mounted by physical-device firmware.
   */
  if (pathEquals(call, "__test", "renderUrlHash")) {
    return capnweb_reply_set_int64(
        reply,
        static_cast<std::int64_t>(simulation.common.renderUrlHash));
  }
  if (pathEquals(call, "__test", "servoYawDegrees")) {
    return capnweb_reply_set_int64(reply, simulation.servoYawDegrees);
  }
  if (pathEquals(call, "__test", "servoPitchDegrees")) {
    return capnweb_reply_set_int64(reply, simulation.servoPitchDegrees);
  }
  if (pathEquals(call, "__test", "servoSpeed")) {
    return capnweb_reply_set_int64(reply, simulation.servoSpeed);
  }
  if (pathEquals(call, "__test", "ledIndex")) {
    return capnweb_reply_set_int64(reply, simulation.ledIndex);
  }
  if (pathEquals(call, "__test", "photoReleaseCount")) {
    return capnweb_reply_set_int64(reply, simulation.photoReleaseCount);
  }
  return simulation.profile.capability.dispatch(
      simulation.profile.capability.context, call, reply);
}

iterate_kit_poll_result poll(void *context, std::uint64_t nowMilliseconds) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * Use the runner clock for both fake telemetry and profile scheduling. This
   * preserves one coherent time domain without claiming the host wake cadence
   * matches an ESP task.
   */
  simulation.common.nowMilliseconds = nowMilliseconds;
  return simulation.profile.poll(
      simulation.profile.context, nowMilliseconds);
}

iterate_kit_poll_result close(void *context) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * The simulator adds no second lifecycle: profile close remains the source of
   * truth for releasing subscriptions/capabilities, so host e2e exercises the
   * same cleanup path as a transport disconnect.
   */
  return simulation.profile.close(simulation.profile.context);
}

capnweb_status initialize(
    void *context,
    capnweb_session *session,
    iterate_kit_device *device) {
  auto &simulation = *static_cast<Simulation *>(context);
  /*
   * Establish the uptime origin before exposing metrics. All options below
   * borrow Simulation storage, which is why main keeps the aggregate alive for
   * the entire runner call.
   */
  simulation.common.startedMilliseconds =
      iterate::kit::simulator::monotonicMilliseconds();
  simulation.common.nowMilliseconds =
      simulation.common.startedMilliseconds;

  /*
   * The 256 KiB camera ceiling models a useful board-class contract, while the
   * fixture itself stays tiny. Consequently this simulator proves enforcement
   * and ownership at the profile boundary, not that every transport can carry a
   * maximum-size photo under memory pressure. The 25 ms metrics interval is
   * accelerated for fast host e2e feedback; it is not the product's eventual
   * one-second cadence or an ESP CPU-budget recommendation.
   */
  const iterate_kit_stackchan_options options{
    {&simulation.common,
     iterate::kit::simulator::renderPng,
     iterate::kit::simulator::changeColour},
    simulation.screenUrlScratch,
    sizeof(simulation.screenUrlScratch),
    {&simulation, moveServos},
    {&simulation, setLed, fillLeds},
    {&simulation, takePhoto},
    256U * 1024U,
    {
      &simulation,
      requestPlaybackInterruption,
      pollPlaybackInterruption,
      50U,
    },
    {
      session,
      {&simulation.common, iterate::kit::simulator::sampleMetrics},
      simulation.subscriptions,
      subscriptionCapacity,
      25U,
      false,
      true,
      false,
      false,
      simulation.diagnosticsExpression,
      sizeof(simulation.diagnosticsExpression),
      nullptr,
    },
  };
  const capnweb_status status =
      iterate_kit_stackchan_init(&simulation.stackchan, &options);
  if (status != CAPNWEB_OK) return status;
  simulation.profile = iterate_kit_stackchan_device(&simulation.stackchan);
  /*
   * Wrap the real root capability only to add the private observation branch.
   * Poll and close still target the same profile context, preserving its
   * single-owner lifecycle and avoiding a parallel fake implementation.
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
   * One aggregate owns every borrowed buffer and driver context. Stack
   * lifetime is convenient on a host and makes cleanup deterministic; its size
   * is not reported as an ESP task-stack requirement.
   */
  Simulation simulation{};
  return iterate::kit::simulator::run({
    "StackChan",
    &simulation,
    initialize,
  });
}
