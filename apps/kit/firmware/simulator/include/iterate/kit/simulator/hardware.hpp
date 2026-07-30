#ifndef ITERATE_KIT_SIMULATOR_HARDWARE_HPP
#define ITERATE_KIT_SIMULATOR_HARDWARE_HPP

#include "iterate/kit/capabilities/metrics.h"
#include "iterate/kit/status.h"

#include <cstddef>
#include <cstdint>

namespace iterate::kit::simulator {

/*
 * This is deliberately a capability-boundary fake, not an ESP32 emulator.
 * Simulator processes exercise the real portable profile, Cap'n Web dispatch,
 * caller-owned storage, and poll/close lifecycle while replacing board drivers
 * with deterministic observations. That makes failures reproducible on a
 * developer machine and proves that an RPC reached the intended driver
 * boundary. It cannot prove display decoding, DMA/ISR ownership, FreeRTOS
 * scheduling, audio timing, or the target's actual heap and CPU behaviour;
 * those claims require the ESP-IDF host fault rigs or a physical device.
 *
 * One runner thread owns this state. Keeping that ownership explicit is
 * important: adding atomics here would make the fake look concurrency-safe
 * without exercising the real cross-task protocol.
 */
struct CommonHardware {
  /*
   * Device profiles consume monotonic milliseconds. The runner advances
   * `nowMilliseconds` before every poll so subscription scheduling uses the
   * same contract as firmware, but host scheduling jitter is not presented as
   * a model of ESP task latency.
   */
  std::uint64_t startedMilliseconds = 0U;
  std::uint64_t nowMilliseconds = 0U;

  /*
   * Retaining an arbitrary URL would either allocate or impose another large
   * fake buffer. A deterministic fingerprint is enough for an end-to-end test
   * to distinguish "the driver was called with this URL" from a no-op. It is
   * not a collision-resistant receipt and says nothing about PNG download or
   * rendering correctness.
   */
  std::uint32_t renderUrlHash = 0U;
};

/*
 * These adapters match the production driver interfaces so the generic
 * capability implementation remains under test. Both are synchronous,
 * allocation-free from the simulator's perspective, and may only be called by
 * the runner thread that owns CommonHardware.
 */
iterate_kit_status renderPng(
    void *context, const char *url, std::size_t urlLength);
iterate_kit_status sampleMetrics(
    void *context, iterate_kit_metrics_sample *sample);

}  // namespace iterate::kit::simulator

#endif
