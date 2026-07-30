#include "iterate/kit/simulator/hardware.hpp"

#include <cstring>

namespace iterate::kit::simulator {

iterate_kit_status renderPng(
    void *context, const char *url, std::size_t urlLength) {
  auto &hardware = *static_cast<CommonHardware *>(context);
  /*
   * Production rendering accepts a remotely supplied URL. Requiring HTTPS in
   * the fake preserves the profile's trust-boundary expectation and catches a
   * test that accidentally bypasses normal URL validation. Downloading the URL
   * here was rejected: it would make a deterministic protocol test depend on
   * the host network while still proving nothing about the board's decoder.
   */
  if (url == nullptr ||
      urlLength < sizeof("https://") - 1U ||
      std::memcmp(url, "https://", sizeof("https://") - 1U) != 0) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  /*
   * FNV-1a is used only as a stable, allocation-free observation. Cryptographic
   * strength is unnecessary because this value is queried by a test in the
   * same trusted process; a matching hash is evidence of argument propagation,
   * not an authenticity or pixel-equivalence claim.
   */
  std::uint32_t hash = UINT32_C(2166136261);
  for (std::size_t index = 0U; index < urlLength; ++index) {
    hash ^= static_cast<std::uint8_t>(url[index]);
    hash *= UINT32_C(16777619);
  }
  hardware.renderUrlHash = hash;
  return ITERATE_KIT_OK;
}

iterate_kit_status sampleMetrics(
    void *context, iterate_kit_metrics_sample *sample) {
  if (sample == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  const auto &hardware = *static_cast<CommonHardware *>(context);
  *sample = {};

  /*
   * Uptime is the one semantically live value: it proves that the profile
   * samples on poll-driven monotonic time. The owner establishes
   * nowMilliseconds >= startedMilliseconds, so unsigned subtraction cannot
   * manufacture a near-UINT64_MAX uptime during a valid lifecycle.
   *
   * Resource values below are fixed, plausible ESP-shaped fixtures. Reading
   * host RSS or CPU here was rejected because those measurements describe the
   * simulator process, not device memory pressure, and would make serialized
   * metric tests nondeterministic. Dedicated target instrumentation supplies
   * real resource evidence.
   */
  sample->uptime_ms = static_cast<std::int64_t>(
      hardware.nowMilliseconds - hardware.startedMilliseconds);
  sample->free_heap_bytes = 312'000;
  sample->minimum_free_heap_bytes = 280'000;
  sample->free_internal_heap_bytes = 220'000;
  sample->minimum_free_internal_heap_bytes = 200'000;
  sample->free_psram_bytes = 7'500'000;
  sample->task_stack_high_water_bytes = 4'096;
  sample->cpu_permille = 73;
  return ITERATE_KIT_OK;
}

}  // namespace iterate::kit::simulator
