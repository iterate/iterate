#ifndef ITERATE_KIT_PLATFORMS_BOUNDED_PLAYBACK_HPP
#define ITERATE_KIT_PLATFORMS_BOUNDED_PLAYBACK_HPP

#include "iterate/kit/pcm_lane.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>

namespace iterate::kit::platforms {

struct BoundedPlaybackPumpResult {
  /*
   * frameSubmitted distinguishes useful playback progress from a healthy idle
   * poll. The device lifecycle uses it to publish "speaking" without inferring
   * progress from queue depth or a merely successful status.
   */
  iterate_kit_status status;
  bool frameSubmitted;
};

/**
 * Owner-task counters for the explicit adapter and speaker queues.
 *
 * These metrics observe buffers controlled by this adapter/M5Unified, not
 * opaque I2S/DMA latency after a frame leaves the speaker descriptor. Counters
 * saturate so a long-running fault cannot wrap to an apparently healthy value.
 * No concurrent reads are permitted; the platform snapshots them on the same
 * task that pumps playback.
 */
struct BoundedPlaybackMetrics {
  std::uint32_t framesDequeued = 0U;
  std::uint32_t framesSubmitted = 0U;
  std::uint32_t framesCompleted = 0U;
  std::uint32_t framesFlushed = 0U;
  std::uint32_t prepareFailures = 0U;
  std::uint32_t submitFailures = 0U;
  std::uint32_t invalidFrames = 0U;
  std::uint32_t stateErrors = 0U;
  std::uint32_t currentOwnedBuffers = 0U;
  std::uint32_t highWaterOwnedBuffers = 0U;
  std::uint32_t currentSpeakerQueue = 0U;
  std::uint32_t highWaterSpeakerQueue = 0U;
};

/**
 * Allocation-free bridge from the bounded PCM lane to an asynchronous
 * M5Unified-style speaker.
 *
 * M5Unified retains playRaw() pointers and has two internal per-channel
 * descriptors. Its own API requires runtime audio to rotate three buffers.
 * This adapter owns exactly those three frames, submits at most one frame per
 * pump, and never calls playRaw() while both descriptors are occupied. The
 * third frame is the single staging copy needed to release the PCM lane before
 * handing a stable pointer to hardware; it is not permission to build a
 * playback backlog.
 *
 * One application/audio task owns this object. pump() performs no allocation,
 * wait, or unbounded loop: it reconciles at most two completed descriptors,
 * copies at most one fixed-size frame, and attempts at most one submission.
 * Interrupt/flush policy lives above this adapter because only the device
 * lifecycle knows whether queued speech is still semantically current.
 *
 * Speaker must provide:
 *   config_t config() const;
 *   void config(const config_t &);
 *   bool begin();
 *   size_t isPlaying(uint8_t channel) const;
 *   bool playRaw(
 *       const int16_t *, size_t, uint32_t, bool, uint32_t, int, bool);
 */
template<std::size_t SampleCount, std::uint32_t SampleRate>
class BoundedPlayback {
  static_assert(SampleCount > 0U);
  static_assert(SampleRate > 0U);
  static_assert(
      SampleCount <=
          std::numeric_limits<std::size_t>::max() /
              sizeof(std::int16_t));

 public:
  /*
   * Two hardware-owned pointers plus one staged pointer is the minimum safe
   * rotation M5Unified documents. The constant exposes the exact
   * 3 * SampleCount * sizeof(int16_t) static RAM cost to target size reports.
   */
  static constexpr std::size_t frameBufferCount = 3U;

  template<typename Speaker>
  iterate_kit_status prepare(Speaker &speaker) {
    if (prepared_) return ITERATE_KIT_OK;
    /*
     * Configure the speaker at the wire-native rate once per hardware
     * generation. Resampling here would consume CPU and add buffering; devices
     * with a different native format should instantiate a different adapter.
     */
    auto configuration = speaker.config();
    configuration.sample_rate = SampleRate;
    speaker.config(configuration);
    if (!speaker.begin()) {
      increment(metrics_.prepareFailures);
      return ITERATE_KIT_IO_ERROR;
    }
    prepared_ = true;
    return ITERATE_KIT_OK;
  }

  template<typename Speaker>
  BoundedPlaybackPumpResult pump(
      iterate_kit_pcm_lane &lane,
      Speaker &speaker) {
    if (!prepared_) {
      return {ITERATE_KIT_UNAVAILABLE, false};
    }
    const auto reconcileStatus = reconcile(speaker);
    if (reconcileStatus != ITERATE_KIT_OK) {
      return {reconcileStatus, false};
    }

    if (staged_) {
      /*
       * playRaw() may temporarily refuse a pointer even when its public queue
       * count looked available. Retain exactly this one copied frame and retry
       * on the next bounded pump; dequeuing another would reorder speech and
       * expand hidden latency.
       */
      return submitStaged(speaker);
    }
    if (outstandingCount_ >= speakerQueueCapacity) {
      return {ITERATE_KIT_OK, false};
    }

    const void *frame = nullptr;
    std::size_t frameBytes = 0U;
    const auto acquireStatus =
        iterate_kit_pcm_lane_downlink_acquire(
            &lane, &frame, &frameBytes);
    if (acquireStatus == ITERATE_KIT_UNAVAILABLE) {
      return {ITERATE_KIT_OK, false};
    }
    if (acquireStatus != ITERATE_KIT_OK) {
      /*
       * The lane now validates its metadata-bearing storage envelope before
       * exposing PCM. Preserve that impossible local corruption as a playback
       * state incident even though no malformed frame pointer can escape the
       * inner ownership boundary.
       */
      if (acquireStatus == ITERATE_KIT_STATE_ERROR) {
        increment(metrics_.stateErrors);
      }
      return {acquireStatus, false};
    }

    if (frame == nullptr || frameBytes != expectedFrameBytes) {
      /*
       * Release malformed input so one bad producer slot cannot wedge playback,
       * but return a state error and increment diagnostics. Padding/truncating
       * PCM would conceal a protocol mismatch as audible corruption.
       */
      increment(metrics_.invalidFrames);
      const auto releaseStatus =
          iterate_kit_pcm_lane_downlink_release(&lane);
      return {
        releaseStatus == ITERATE_KIT_OK
            ? ITERATE_KIT_STATE_ERROR
            : releaseStatus,
        false,
      };
    }

    const auto freeIndex = findFreeBuffer();
    if (freeIndex >= frameBufferCount) {
      increment(metrics_.stateErrors);
      (void)iterate_kit_pcm_lane_downlink_release(&lane);
      return {ITERATE_KIT_STATE_ERROR, false};
    }
    std::memcpy(
        buffers_[freeIndex], frame, expectedFrameBytes);
    /*
     * The lane slot is borrowed only until release(), whereas M5Unified retains
     * playRaw() pointers asynchronously. This fixed copy is the ownership
     * boundary; passing the ring pointer directly would let its producer
     * overwrite samples still being played.
     */
    const auto releaseStatus =
        iterate_kit_pcm_lane_downlink_release(&lane);
    if (releaseStatus != ITERATE_KIT_OK) {
      increment(metrics_.stateErrors);
      return {releaseStatus, false};
    }

    bufferStates_[freeIndex] = BufferState::staged;
    stagedIndex_ = freeIndex;
    staged_ = true;
    nextBufferIndex_ =
        static_cast<std::uint8_t>(
            (freeIndex + 1U) % frameBufferCount);
    increment(metrics_.framesDequeued);
    updateOwnedMetrics();
    return submitStaged(speaker);
  }

  /**
   * Call only after the hardware speaker has synchronously released all
   * retained playRaw() pointers (for M5Unified, after Speaker.end()). The
   * adapter cannot prove that condition itself. Resetting earlier would label
   * live DMA pointers free and permit audible memory corruption.
   *
   * Outstanding/staged speech is deliberately counted as flushed rather than
   * carried into the next generation. On interruption, current conversation
   * state is more important than eventual playback of stale assistant audio.
   */
  void resetAfterHardwareFlush() {
    const std::uint32_t discarded =
        static_cast<std::uint32_t>(outstandingCount_) +
        (staged_ ? 1U : 0U);
    add(metrics_.framesFlushed, discarded);
    for (auto &state : bufferStates_) {
      state = BufferState::free;
    }
    outstandingHead_ = 0U;
    outstandingCount_ = 0U;
    stagedIndex_ = 0U;
    staged_ = false;
    nextBufferIndex_ = 0U;
    prepared_ = false;
    metrics_.currentOwnedBuffers = 0U;
    metrics_.currentSpeakerQueue = 0U;
  }

  BoundedPlaybackMetrics metrics() const {
    return metrics_;
  }

 private:
  static constexpr std::size_t speakerQueueCapacity = 2U;
  static constexpr std::size_t expectedFrameBytes =
      SampleCount * sizeof(std::int16_t);
  static constexpr std::uint8_t speakerChannel = 0U;

  enum class BufferState : std::uint8_t {
    free,
    staged,
    speakerOwned,
  };

  static void increment(std::uint32_t &value) {
    /*
     * Retain monotonic "at least this many" evidence after endurance runs.
     */
    if (value != std::numeric_limits<std::uint32_t>::max()) {
      ++value;
    }
  }

  static void add(std::uint32_t &value, std::uint32_t amount) {
    const auto maximum =
        std::numeric_limits<std::uint32_t>::max();
    value = amount > maximum - value ? maximum : value + amount;
  }

  void updateOwnedMetrics() {
    metrics_.currentOwnedBuffers =
        static_cast<std::uint32_t>(outstandingCount_) +
        (staged_ ? 1U : 0U);
    if (metrics_.currentOwnedBuffers >
        metrics_.highWaterOwnedBuffers) {
      metrics_.highWaterOwnedBuffers =
          metrics_.currentOwnedBuffers;
    }
    metrics_.currentSpeakerQueue = outstandingCount_;
    if (metrics_.currentSpeakerQueue >
        metrics_.highWaterSpeakerQueue) {
      metrics_.highWaterSpeakerQueue =
          metrics_.currentSpeakerQueue;
    }
  }

  template<typename Speaker>
  iterate_kit_status reconcile(Speaker &speaker) {
    const std::size_t queued =
        speaker.isPlaying(speakerChannel);
    if (queued > speakerQueueCapacity ||
        queued > outstandingCount_) {
      /*
       * M5Unified reports only a count, so FIFO completion is the required
       * mental model. A count larger than our ledger means pointer ownership is
       * unknowable; guessing would allow a live buffer to be reused.
       */
      increment(metrics_.stateErrors);
      return ITERATE_KIT_STATE_ERROR;
    }

    while (outstandingCount_ > queued) {
      /*
       * Under the speaker's per-channel FIFO contract, a falling count releases
       * the oldest outstanding pointer(s). The loop is bounded by the two
       * descriptor capacity, independent of network backlog.
       */
      const std::uint8_t completedIndex =
          outstandingOrder_[outstandingHead_];
      if (completedIndex >= frameBufferCount ||
          bufferStates_[completedIndex] !=
              BufferState::speakerOwned) {
        increment(metrics_.stateErrors);
        return ITERATE_KIT_STATE_ERROR;
      }
      bufferStates_[completedIndex] = BufferState::free;
      outstandingHead_ = static_cast<std::uint8_t>(
          (outstandingHead_ + 1U) % speakerQueueCapacity);
      --outstandingCount_;
      increment(metrics_.framesCompleted);
    }
    updateOwnedMetrics();
    return ITERATE_KIT_OK;
  }

  std::uint8_t findFreeBuffer() const {
    for (std::size_t offset = 0U;
         offset < frameBufferCount;
         ++offset) {
      const auto index = static_cast<std::uint8_t>(
          (nextBufferIndex_ + offset) % frameBufferCount);
      if (bufferStates_[index] == BufferState::free) {
        return index;
      }
    }
    return static_cast<std::uint8_t>(frameBufferCount);
  }

  template<typename Speaker>
  BoundedPlaybackPumpResult submitStaged(Speaker &speaker) {
    if (!staged_) {
      increment(metrics_.stateErrors);
      return {ITERATE_KIT_STATE_ERROR, false};
    }
    if (outstandingCount_ >= speakerQueueCapacity) {
      return {ITERATE_KIT_OK, false};
    }
    if (!speaker.playRaw(
            buffers_[stagedIndex_],
            SampleCount,
            SampleRate,
            false,
            1U,
            speakerChannel,
            false)) {
      /*
       * Preserve the one staged frame across transient refusal because the lane
       * slot was already released. This is still bounded to one frame; device
       * interruption calls resetAfterHardwareFlush() to prevent stale retries.
       */
      increment(metrics_.submitFailures);
      return {ITERATE_KIT_UNAVAILABLE, false};
    }

    const auto orderIndex = static_cast<std::uint8_t>(
        (outstandingHead_ + outstandingCount_) %
        speakerQueueCapacity);
    outstandingOrder_[orderIndex] = stagedIndex_;
    /*
     * Publish speaker ownership in our ledger only after playRaw() succeeds.
     * From this point the sample array cannot be reused until reconcile()
     * observes the hardware queue count fall.
     */
    bufferStates_[stagedIndex_] = BufferState::speakerOwned;
    ++outstandingCount_;
    staged_ = false;
    increment(metrics_.framesSubmitted);
    updateOwnedMetrics();
    return {ITERATE_KIT_OK, true};
  }

  std::int16_t buffers_[frameBufferCount][SampleCount]{};
  BufferState bufferStates_[frameBufferCount]{};
  std::uint8_t outstandingOrder_[speakerQueueCapacity]{};
  std::uint8_t outstandingHead_ = 0U;
  std::uint8_t outstandingCount_ = 0U;
  std::uint8_t stagedIndex_ = 0U;
  std::uint8_t nextBufferIndex_ = 0U;
  bool prepared_ = false;
  bool staged_ = false;
  BoundedPlaybackMetrics metrics_{};
};

}  // namespace iterate::kit::platforms

#endif
