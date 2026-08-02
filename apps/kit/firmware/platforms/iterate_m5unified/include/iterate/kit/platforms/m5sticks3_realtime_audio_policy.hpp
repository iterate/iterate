#ifndef ITERATE_KIT_PLATFORMS_M5STICKS3_REALTIME_AUDIO_POLICY_HPP
#define ITERATE_KIT_PLATFORMS_M5STICKS3_REALTIME_AUDIO_POLICY_HPP

#include <cstddef>
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
   * Sixteen 20 ms physical DMA descriptors provide 320 ms of bounded playout
   * reserve. The first production trace measured a 90 ms provider-to-device
   * interarrival gap and proved eight descriptors sufficient for that case.
   * The next run measured 250 ms: thirteen phase-aligned slots completed,
   * exhausted the eight-descriptor cycle, and produced one exact recovery
   * silence/late-frame pair. Sixteen spans those thirteen completions with two
   * entries of margin below ESP-IDF's dma_desc_num-1 finished-pointer bound.
   * Relative to eight descriptors this costs 10,240 bytes of internal DMA RAM;
   * the same run's 68,163-byte minimum leaves roughly 57 KiB after that charge,
   * which the physical resource proof must confirm rather than assume.
   *
   * This is the hardware ownership cycle, not a software FIFO. Frame-age and
   * generation policy below still reject delayed history after an outage.
   */
  static constexpr std::size_t descriptorCount = 16U;

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
