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

iterate_kit_status changeColour(
    void *context, iterate_kit_screen_colour colour) {
  if (colour != ITERATE_KIT_SCREEN_RED &&
      colour != ITERATE_KIT_SCREEN_GREEN) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  auto &hardware = *static_cast<CommonHardware *>(context);
  hardware.screenColour = colour;
  return ITERATE_KIT_OK;
}

iterate_kit_status sampleMetrics(
    void *context, iterate_kit_metrics_sample *sample) {
  if (sample == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  auto &hardware = *static_cast<CommonHardware *>(context);
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

  /*
   * This is a wire-contract fixture, not invented physical evidence. Plausible
   * fixed values let the host simulator exercise the real bounded C
   * serializer and callback path; only the M5StickS3 target's ESP-IDF sampler
   * is allowed to make acceptance claims about actual heap, DMA, or timing.
   */
  sample->has_playback_detail = true;
  auto &detail = sample->playback_detail;
  detail.schema_version = 5U;
  detail.sequence = ++hardware.metricsSequence;
  detail.produced_at_ms = sample->uptime_ms;
  detail.downlink_accepted = 12U;
  detail.playback.submitted = 11U;
  detail.playback.completed = 10U;
  detail.playback.receive_to_dma_start_samples = 10U;
  detail.playback.maximum_receive_to_dma_start_ms = 82U;
  detail.playback.downlink_interarrival_samples = 11U;
  detail.playback.maximum_downlink_interarrival_ms = 22U;
  detail.playback.successful_refill_timing_samples = 9U;
  detail.playback.last_eof_to_successful_refill_us = 1'100U;
  detail.playback.maximum_eof_to_successful_refill_us = 1'200U;
  detail.playback.last_write_call_duration_us = 100U;
  detail.playback.maximum_write_call_duration_us = 120U;
  detail.playback.last_reuse_lead_at_successful_refill_us = 18'700U;
  detail.playback.minimum_reuse_lead_at_successful_refill_us = 18'600U;
  detail.runtime.audio_owner_stack_headroom_bytes = 4'000U;
  detail.runtime.main_stack_headroom_bytes = 4'096U;
  detail.runtime.control_network_stack_headroom_bytes = 3'800U;
  detail.runtime.pcm_network_stack_headroom_bytes = 3'600U;
  detail.runtime.free_internal_heap_bytes = 220'000U;
  detail.runtime.minimum_free_internal_heap_bytes = 200'000U;
  detail.runtime.free_dma_heap_bytes = 96'000U;
  detail.runtime.minimum_free_dma_heap_bytes = 90'000U;
  detail.runtime.largest_free_internal_heap_block_bytes = 96'000U;
  detail.runtime.largest_free_dma_block_bytes = 48'000U;
  detail.runtime.cpu_permille = 73;
  detail.runtime.pcm_receive_calls = 71U;
  detail.runtime.pcm_receive_chunks = 61U;
  detail.runtime.control_network_max_work_cycles = 31'000U;
  detail.runtime.pcm_network_max_work_cycles = 29'000U;

  /*
   * StackChan mounts this second detailed view while M5Stick does not. The
   * common simulator sampler populates both because the profile, rather than
   * the fake hardware, owns capability discovery. These fixed values exercise
   * the exact bounded Cap'n Web shape; they are deliberately not presented as
   * a model of ESP-SR suppression or physical microphone energy.
   */
  sample->has_aec_detail = true;
  auto &aec = sample->aec_detail;
  aec.schema_version = 2U;
  aec.sequence = detail.sequence;
  aec.window_started_at_ms = sample->uptime_ms;
  aec.produced_at_ms = sample->uptime_ms;
  aec.sample_stride = 8U;
  aec.sampled_samples = 2'000U;
  aec.near_peak = 12'000U;
  aec.reference_peak = 10'000U;
  aec.clean_peak = 1'500U;
  aec.near_mean_absolute = 2'400U;
  aec.reference_mean_absolute = 2'000U;
  aec.clean_mean_absolute = 300U;
  aec.lifetime_frames_processed = 31U;
  aec.lifetime_recreates = 1U;
  aec.lifetime_recreate_failures = 0U;
  aec.last_linear_us = 1'100U;
  aec.maximum_linear_us = 1'300U;
  aec.last_nlp_us = 240U;
  aec.maximum_nlp_us = 280U;
  aec.last_capture_to_uplink_us = 3'100U;
  aec.maximum_capture_to_uplink_us = 3'500U;
  aec.lifetime_capture_reserve_dropped_chunks = 0U;
  aec.lifetime_capture_bridge_errors = 0U;
  aec.lifetime_signal_measurement_failures = 0U;
  /*
   * These are serializer fixtures, not simulated acoustics. Non-zero progress
   * plus zero incident counters prove that the shared synchronous-playback
   * block crosses the real C capability boundary; only physical boards may
   * use the corresponding values as AEC acceptance evidence.
   */
  aec.playback_health.lifetime_content_samples = 96'000U;
  aec.playback_health.lifetime_resets = 0U;
  aec.playback_health.lifetime_frames_discarded_by_reset = 0U;
  aec.playback_health.lifetime_write_failures = 0U;
  aec.playback_health.lifetime_queue_overflows = 0U;
  aec.playback_health.lifetime_policy_errors = 0U;
  aec.playback_health.lifetime_reset_failures = 0U;
  aec.playback_health.lifetime_observation_failures = 0U;
  aec.playback_health.last_write_us = 8'000U;
  aec.playback_health.maximum_write_us = 9'000U;
  aec.playback_health.last_receive_to_render_ms = 20U;
  aec.playback_health.maximum_receive_to_render_ms = 30U;
  /*
   * The stdio simulator has no ESP WebSocket or Wi-Fi layers, but it still
   * implements the same one-shot schema so host code can prove capability and
   * parsing semantics. All incident counters remain honestly zero; these
   * values are never cited as evidence about physical network reliability.
   */
  sample->has_control_diagnostics = true;
  sample->control_diagnostics.schema_version = 4U;
  sample->control_diagnostics.produced_at_ms = sample->uptime_ms;
  /*
   * The host simulator has neither an ESP station nor a PCM WebSocket. Publish
   * explicit disconnected/zero lifecycle facts while leaving RSSI absent;
   * inventing a plausible signal value would let a host-only run masquerade as
   * physical radio evidence.
   */
  sample->control_diagnostics.network.wifi_connected = false;
  return ITERATE_KIT_OK;
}

}  // namespace iterate::kit::simulator
