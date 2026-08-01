#ifndef ITERATE_KIT_PLATFORMS_M5STICKS3_REALTIME_AUDIO_POLICY_HPP
#define ITERATE_KIT_PLATFORMS_M5STICKS3_REALTIME_AUDIO_POLICY_HPP

#include <cstdint>

namespace iterate::kit::platforms {

/**
 * Production latency policy for the M5StickS3 direct-I2S path.
 *
 * These values live in a hardware-free header so the host fault rig tests the
 * exact target policy rather than a lookalike copied into a fixture. They are
 * time bounds, not queue capacities: the target keeps a separate fixed 640 ms
 * downlink loss reserve, while this policy decides when buffered speech is too
 * old to remain part of a realtime conversation.
 */
struct M5StickS3RealtimeAudioPolicy {
  /*
   * The initial 200 ms bound was below a measured 257 ms receive-to-DMA
   * startup excursion even though every WebSocket frame arrived in order and
   * adjacent arrivals stayed within 40 ms. It therefore created clipping
   * rather than preventing backlog. Four hundred milliseconds preserves 143
   * ms of scheduling margin around that observation while remaining 240 ms
   * below the target's 640 ms application-ring reserve. Crossing this bound
   * still resets the whole suspect epoch: recovery resumes from current audio
   * instead of replaying a delayed conversation after a real outage.
   */
  static constexpr std::uint32_t maximumFrameAgeMs = 400U;
  static constexpr std::uint32_t partialPrebufferTimeoutMs = 200U;
  static constexpr std::uint32_t minimumRefillLeadUs = 2'000U;
};

}  // namespace iterate::kit::platforms

#endif
