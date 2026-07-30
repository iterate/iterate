#ifndef ITERATE_KIT_PLATFORMS_DIRECT_I2S_STEREO_OUTPUT_HPP
#define ITERATE_KIT_PLATFORMS_DIRECT_I2S_STEREO_OUTPUT_HPP

#include "iterate/kit/platforms/realtime_playback.hpp"
#include "iterate/kit/status.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace iterate::kit::platforms {

/**
 * Opaque identity of one physical DMA descriptor.
 *
 * A count of completed frames is insufficient for cyclic I2S: the writer must
 * refill the exact descriptor named by the oldest EOF callback. The ESP-IDF
 * adapter may encode a descriptor pointer or a checked small index here; this
 * portable layer never derives or reorders it.
 */
struct DirectI2sDescriptorToken {
  std::uintptr_t value;
};

constexpr bool operator==(
    DirectI2sDescriptorToken left,
    DirectI2sDescriptorToken right) {
  return left.value == right.value;
}

constexpr bool operator!=(
    DirectI2sDescriptorToken left,
    DirectI2sDescriptorToken right) {
  return !(left == right);
}

/**
 * Result of one synchronous backend copy.
 *
 * `bytesTransferred` is authoritative even when `status` is not OK. A
 * zero-byte BACKPRESSURE/UNAVAILABLE result preserves descriptor ownership
 * because no DMA content changed, but it is not retry permission. On ESP-IDF
 * 5.4 the completed pointer is already in the private TX queue before the ISR
 * can yield to our sole writer, so production treats zero progress as an
 * invariant failure and destructively resets. Any nonzero short result tears a
 * PCM frame across scheduling boundaries and poisons the generation.
 */
struct DirectI2sTransferResult {
  iterate_kit_status status;
  std::size_t bytesTransferred;
  DirectI2sDescriptorToken descriptor;
};

/**
 * One exact EOF observation copied out of an ISR-owned bounded queue.
 *
 * `eofAtUs` is in the device monotonic microsecond domain. The adapter must
 * capture it at the callback, not when the audio task later drains the queue;
 * otherwise scheduler delay is incorrectly erased from playback latency.
 */
struct DirectI2sBackendCompletion {
  DirectI2sDescriptorToken descriptor;
  std::uint64_t eofAtUs;
};

/**
 * Metadata returned beside a bounded completion drain.
 *
 * The backend must report current timing for the oldest still-refillable
 * descriptor even when `descriptorCount` is zero. That keeps deadline evidence
 * honest when an owner poll observes no new EOF. Queue overflow is deliberately
 * separate: once IDF drops a three-entry message-queue element, no surviving
 * batch can reconstruct the lost oldest descriptor identity.
 */
struct DirectI2sBackendCompletionBatch {
  std::size_t descriptorCount;
  bool timingValid;
  std::uint32_t oldestEofToOwnerUs;
  std::uint32_t earliestReuseLeadUs;
};

/**
 * Application metadata that follows content through its exact DMA descriptor.
 *
 * Generation zero means "metadata unavailable" for the compatibility
 * preloadMono()/writeMono() overloads. Production voice generations are
 * nonzero. Age and stale-generation classification intentionally live in the
 * realtime policy, because only that layer owns the active socket generation
 * and the millisecond-to-microsecond clock-domain proof. Content versus EOS
 * padding is an explicit DirectI2sFrameKind and must never be inferred from
 * generation zero: compatibility content also has unavailable metadata.
 */
using DirectI2sFrameMetadata =
    RealtimePlaybackFrameMetadata;
using DirectI2sFrameKind = RealtimePlaybackFrameKind;

struct DirectI2sDescriptorCompletion {
  DirectI2sDescriptorToken descriptor;
  std::uint64_t eofAtUs;
  DirectI2sFrameMetadata frame;
  DirectI2sFrameKind frameKind;
};

using DirectI2sCompletionPollResult =
    RealtimePlaybackCompletionPollResult;

enum class DirectI2sStereoOutputState : std::uint8_t {
  released = 0U,
  preloading,
  running,
  poisoned,
};

enum class DirectI2sStereoOutputFault : std::uint8_t {
  none = 0U,
  backendFailure,
  partialTransfer,
  descriptorIdentity,
  completionCapacity,
  completionQueueOverflow,
};

/**
 * Allocation-free mono-PCM-to-direct-I2S ownership adapter.
 *
 * Backend contract
 * ----------------
 *
 * The injected backend is owned by the same dedicated audio task and outlives
 * this object. Every method is synchronous and allocation-free:
 *
 * - resetForPlayback() *destructively* stops/deletes any previous channel,
 *   creates a disabled empty descriptor cycle, and clears its ISR EOF queue;
 * - preloadStereo() copies exactly one interleaved frame and returns the opaque
 *   descriptor it filled;
 * - startPlayback() enables clocks only after all descriptors are preloaded;
 * - takeCompletedDescriptors() drains ordered `{descriptor,eofAtUs}` entries
 *   into caller storage without waiting;
 * - writeStereo() nonblockingly copies into the supplied exact descriptor;
 * - takeQueueOverflows() consumes the exact ISR queue-overflow count;
 * - stopAndRelease() synchronously prevents DMA from reading old content and
 *   deletes the channel.
 *
 * The backend also declares `clearsDmaBeforeEofCallback = true`. For ESP-IDF
 * this is the compile-time-visible counterpart of configuring
 * `auto_clear_before_cb=true`: if the owner misses a refill deadline, hardware
 * emits silence instead of replaying stale speech. Clearing after the callback
 * is too late for a callback that publishes descriptor ownership to another
 * task, so the requirement is pinned at this boundary rather than left as an
 * undocumented target setting.
 *
 * ESP-IDF 5.4.2 has two source-derived constraints for the backend:
 *
 * - public preload does not expose a descriptor pointer, so preload tokens are
 *   synthetic `{hardware generation, ordinal}` identities. The first ordered
 *   callback cycle establishes pointer-to-ordinal mapping; reset invalidates
 *   all of it;
 * - the driver's private finished-buffer queue is distinct from the callback
 *   observations drained here and has `dma_desc_num - 1` entries. writeStereo
 *   must call `i2s_channel_write(..., timeout=0)` (while validating the same
 *   oldest token), or explicitly drain that private queue before direct copy.
 *   Merely memcpying callback `dma_buf` leaves IDF's queue full and produces a
 *   real overflow every fourth EOF.
 *
 * This wrapper expands one mono frame into one fixed stereo scratch buffer.
 * It does not resample, allocate, block, retain a PCM FIFO, or retry partial
 * I/O. Four descriptors are an ownership cycle, not four anonymous credits:
 * EOF identities are checked against the preload order across every wrap and
 * retained in a fixed ring until an exact full-frame write succeeds.
 * preloadSilence() initializes unused tail descriptors for finite responses
 * through the same exact-copy path; it does not create a second silence frame.
 *
 * Metadata-aware overloads preserve `{receivedAtMs,generation,sequence}` until
 * the matching EOF. lastCompletion() exposes exact EOF observations until the
 * next completion drain or reset. It deliberately does not calculate acoustic
 * latency: EOF is a hardware boundary, and the physical microphone harness is
 * still required to prove the signal became audible without a jiggle.
 */
template<
    std::size_t MonoSampleCount,
    std::size_t DescriptorCount,
    typename Backend>
class DirectI2sStereoOutput {
  static_assert(MonoSampleCount > 0U);
  static_assert(DescriptorCount >= 2U);
  static_assert(
      DescriptorCount <=
      static_cast<std::size_t>(
          std::numeric_limits<std::uint8_t>::max()) +
          1U);
  static_assert(
      MonoSampleCount <=
      std::numeric_limits<std::size_t>::max() /
          (2U * sizeof(std::int16_t)));
  static_assert(
      Backend::clearsDmaBeforeEofCallback,
      "direct I2S must clear a completed DMA buffer before "
      "publishing its EOF");

 public:
  explicit DirectI2sStereoOutput(Backend &backend)
      : backend_(backend) {}

  iterate_kit_status resetForPlayback() {
    /*
     * Recovery is destructive even from a nominally healthy running state.
     * Merely rewinding local indices would let already-queued EOF callbacks and
     * old PCM bytes cross a reconnect/underrun generation boundary.
     */
    clearLocalOwnership();
    const auto status = backend_.resetForPlayback();
    if (status != ITERATE_KIT_OK) {
      poison(DirectI2sStereoOutputFault::backendFailure);
      return status;
    }
    state_ = DirectI2sStereoOutputState::preloading;
    fault_ = DirectI2sStereoOutputFault::none;
    return ITERATE_KIT_OK;
  }

  iterate_kit_status preloadMono(
      const std::int16_t *samples,
      std::size_t sampleCount) {
    return preloadMono(
        samples,
        sampleCount,
        DirectI2sFrameMetadata{0U, 0U, 0U});
  }

  iterate_kit_status preloadMono(
      const std::int16_t *samples,
      std::size_t sampleCount,
      DirectI2sFrameMetadata metadata) {
    if (samples == nullptr ||
        sampleCount != MonoSampleCount) {
      return ITERATE_KIT_INVALID_ARGUMENT;
    }
    if (state_ != DirectI2sStereoOutputState::preloading ||
        preloadedDescriptorCount_ >= DescriptorCount) {
      return ITERATE_KIT_STATE_ERROR;
    }
    expandStereo(samples);
    return preloadPreparedStereo(
        metadata, DirectI2sFrameKind::content);
  }

  iterate_kit_status preloadSilence() {
    if (state_ != DirectI2sStereoOutputState::preloading ||
        preloadedDescriptorCount_ >= DescriptorCount) {
      return ITERATE_KIT_STATE_ERROR;
    }
    /*
     * A finite response with fewer than four content frames still needs every
     * cyclic descriptor initialized before clocks start. Zero-fill the one
     * existing scratch frame and submit it through the same exact-byte path;
     * a special backend shortcut could accidentally bypass partial-I/O checks
     * or leave an old descriptor tail audible.
     */
    stereoScratch_.fill(0);
    return preloadPreparedStereo(
        DirectI2sFrameMetadata{0U, 0U, 0U},
        DirectI2sFrameKind::paddingSilence);
  }

  iterate_kit_status start() {
    if (state_ != DirectI2sStereoOutputState::preloading ||
        preloadedDescriptorCount_ != DescriptorCount) {
      return ITERATE_KIT_STATE_ERROR;
    }
    const auto status = backend_.startPlayback();
    if (status != ITERATE_KIT_OK) {
      poison(DirectI2sStereoOutputFault::backendFailure);
      return status;
    }
    state_ = DirectI2sStereoOutputState::running;
    return ITERATE_KIT_OK;
  }

  DirectI2sCompletionPollResult pollCompletionBatch() {
    lastCompletionCount_ = 0U;
    if (state_ == DirectI2sStereoOutputState::poisoned) {
      return {
        ITERATE_KIT_STATE_ERROR,
        emptyCompletionBatch()};
    }
    if (state_ != DirectI2sStereoOutputState::running) {
      return {
        ITERATE_KIT_STATE_ERROR,
        emptyCompletionBatch()};
    }

    const auto backendBatch =
        backend_.takeCompletedDescriptors(
            backendCompletionScratch_.data(),
            backendCompletionScratch_.size());
    if (backendBatch.descriptorCount >
            DescriptorCount ||
        backendBatch.descriptorCount >
            DescriptorCount - pendingCount_) {
      poison(
          DirectI2sStereoOutputFault::
              completionCapacity);
      return {
        ITERATE_KIT_STATE_ERROR,
        emptyCompletionBatch()};
    }

    for (std::size_t index = 0U;
         index < backendBatch.descriptorCount;
         ++index) {
      const auto &completion =
          backendCompletionScratch_[index];
      const auto expectedIndex = nextExpectedEofIndex_;
      if (completion.descriptor !=
          descriptors_[expectedIndex].token) {
        /*
         * A skipped/duplicated token means ownership is unknowable. Do not
         * search ahead for a matching descriptor: that would normalize the
         * exact queue-loss fault which can overwrite still-audible DMA.
         */
        poison(
            DirectI2sStereoOutputFault::
                descriptorIdentity);
        return {
          ITERATE_KIT_STATE_ERROR,
          emptyCompletionBatch()};
      }

      pendingDescriptorIndices_[
          (pendingHead_ + pendingCount_) %
          DescriptorCount] =
          static_cast<std::uint8_t>(expectedIndex);
      ++pendingCount_;
      lastCompletions_[lastCompletionCount_] = {
        completion.descriptor,
        completion.eofAtUs,
        descriptors_[expectedIndex].metadata,
        descriptors_[expectedIndex].frameKind};
      ++lastCompletionCount_;
      nextExpectedEofIndex_ =
          (nextExpectedEofIndex_ + 1U) %
          DescriptorCount;
    }

    return {
      ITERATE_KIT_OK,
      RealtimePlaybackCompletionBatch{
        static_cast<std::uint32_t>(
            backendBatch.descriptorCount),
        static_cast<std::uint32_t>(pendingCount_),
        backendBatch.timingValid,
        backendBatch.oldestEofToOwnerUs,
        backendBatch.earliestReuseLeadUs}};
  }

  RealtimePlaybackCompletionBatch takeCompletionBatch() {
    /*
     * Compatibility for the current generic policy, whose completion method
     * predates an explicit status. New integration should consume
     * pollCompletionBatch() so fatal cleanup does not depend on a sentinel.
     */
    const auto result = pollCompletionBatch();
    return result.status == ITERATE_KIT_OK
        ? result.batch
        : faultCompletionBatch();
  }

  iterate_kit_status writeMono(
      const std::int16_t *samples,
      std::size_t sampleCount) {
    return writeMono(
        samples,
        sampleCount,
        DirectI2sFrameMetadata{0U, 0U, 0U});
  }

  iterate_kit_status writeMono(
      const std::int16_t *samples,
      std::size_t sampleCount,
      DirectI2sFrameMetadata metadata) {
    if (samples == nullptr ||
        sampleCount != MonoSampleCount) {
      return ITERATE_KIT_INVALID_ARGUMENT;
    }
    expandStereo(samples);
    return writePreparedStereo(
        metadata, DirectI2sFrameKind::content);
  }

  iterate_kit_status writeSilence() {
    /*
     * ESP-IDF's completed-pointer queue has one fewer entry than the DMA
     * descriptor cycle. At an ordered finite boundary the owner must therefore
     * continue consuming completed pointers while the last content descriptors
     * drain. Writing explicit zeroes behind that content preserves descriptor
     * ownership without inventing another PCM frame or replaying old speech.
     *
     * Reusing the one stereo scratch frame matters here: a permanent silence
     * buffer would add RAM solely for a terminal transition, while direct DMA
     * writes from a shared static zero page would weaken the single-owner
     * lifetime argument.
     */
    stereoScratch_.fill(0);
    return writePreparedStereo(
        DirectI2sFrameMetadata{},
        DirectI2sFrameKind::paddingSilence);
  }

  iterate_kit_status writeRecoverySilence() {
    /*
     * A late network frame and an ordered finite response are different facts.
     * Both require zeroes in one physical descriptor, but tagging recovery
     * silence separately lets completion accounting remain exact: EOS padding
     * is legal only after the ordered marker, while recovery silence is the
     * explicit realtime substitute for content that missed its playout slot.
     *
     * Keeping this as a named operation also prevents a future driver adapter
     * from silently treating "no input" as permission to leave ESP-IDF's
     * finished-pointer queue undrained. The same full checked copy and exact
     * descriptor ownership apply to silence as to PCM.
     */
    stereoScratch_.fill(0);
    return writePreparedStereo(
        DirectI2sFrameMetadata{},
        DirectI2sFrameKind::recoverySilence);
  }

 private:
  iterate_kit_status writePreparedStereo(
      DirectI2sFrameMetadata metadata,
      DirectI2sFrameKind frameKind) {
    if (state_ == DirectI2sStereoOutputState::poisoned) {
      return ITERATE_KIT_STATE_ERROR;
    }
    if (state_ != DirectI2sStereoOutputState::running ||
        pendingCount_ == 0U) {
      return ITERATE_KIT_BACKPRESSURE;
    }

    const auto descriptorIndex =
        static_cast<std::size_t>(
            pendingDescriptorIndices_[pendingHead_]);
    const auto descriptor =
        descriptors_[descriptorIndex].token;
    const auto result = backend_.writeStereo(
        descriptor,
        stereoScratch_.data(),
        stereoFrameBytes);
    const auto transferStatus =
        classifyTransfer(result, stereoFrameBytes);
    if (transferStatus != ITERATE_KIT_OK) {
      return transferStatus;
    }
    if (result.descriptor != descriptor) {
      poison(
          DirectI2sStereoOutputFault::
              descriptorIdentity);
      return ITERATE_KIT_STATE_ERROR;
    }
    lastSuccessfulRefillTiming_ =
        backend_.lastSuccessfulRefillTiming();

    descriptors_[descriptorIndex].metadata = metadata;
    descriptors_[descriptorIndex].frameKind = frameKind;
    pendingHead_ =
        (pendingHead_ + 1U) % DescriptorCount;
    --pendingCount_;
    return ITERATE_KIT_OK;
  }

 public:
  std::uint32_t takeQueueOverflows() {
    const auto count = backend_.takeQueueOverflows();
    if (count > 0U) {
      /*
       * IDF's queue is one element shorter than a four-descriptor cycle. Its
       * overflow callback proves the oldest exact pointer was dropped; the
       * newest three pointers cannot reconstruct safe ownership.
       */
      poison(
          DirectI2sStereoOutputFault::
              completionQueueOverflow);
    }
    return count;
  }

  iterate_kit_status stopAndRelease() {
    if (state_ == DirectI2sStereoOutputState::released) {
      return ITERATE_KIT_OK;
    }
    const auto status = backend_.stopAndRelease();
    clearLocalOwnership();
    if (status != ITERATE_KIT_OK) {
      poison(DirectI2sStereoOutputFault::backendFailure);
      return status;
    }
    state_ = DirectI2sStereoOutputState::released;
    fault_ = DirectI2sStereoOutputFault::none;
    return ITERATE_KIT_OK;
  }

  DirectI2sStereoOutputState state() const {
    return state_;
  }

  DirectI2sStereoOutputFault fault() const {
    return fault_;
  }

  std::size_t preloadedDescriptorCount() const {
    return preloadedDescriptorCount_;
  }

  std::size_t pendingRefillDescriptorCount() const {
    return pendingCount_;
  }

  std::size_t lastCompletionCount() const {
    return lastCompletionCount_;
  }

  bool lastCompletion(
      std::size_t index,
      DirectI2sDescriptorCompletion *completion) const {
    if (completion == nullptr ||
        index >= lastCompletionCount_) {
      return false;
    }
    *completion = lastCompletions_[index];
    return true;
  }

  bool lastPlaybackCompletion(
      std::size_t index,
      RealtimePlaybackDescriptorCompletion
          *completion) const {
    if (completion == nullptr ||
        index >= lastCompletionCount_) {
      return false;
    }
    const auto &direct = lastCompletions_[index];
    *completion = {
      direct.eofAtUs,
      direct.frame,
      direct.frameKind};
    return true;
  }

  RealtimePlaybackSuccessfulRefillTiming
  lastSuccessfulRefillTiming() const {
    return lastSuccessfulRefillTiming_;
  }

 private:
  static constexpr std::size_t stereoFrameBytes =
      MonoSampleCount * 2U * sizeof(std::int16_t);

  struct DescriptorState {
    DirectI2sDescriptorToken token;
    DirectI2sFrameMetadata metadata;
    DirectI2sFrameKind frameKind;
  };

  void expandStereo(const std::int16_t *mono) {
    /*
     * The hardware codec expects two interleaved slots even when content is
     * mono. Duplicate directly into the sole fixed scratch frame: a second
     * conversion buffer or resampler adds memory, copies, and latency without
     * changing information.
     */
    for (std::size_t index = 0U;
         index < MonoSampleCount;
         ++index) {
      stereoScratch_[index * 2U] = mono[index];
      stereoScratch_[index * 2U + 1U] = mono[index];
    }
  }

  iterate_kit_status classifyTransfer(
      DirectI2sTransferResult result,
      std::size_t expectedBytes) {
    if (result.status == ITERATE_KIT_OK &&
        result.bytesTransferred == expectedBytes) {
      return ITERATE_KIT_OK;
    }
    if (result.bytesTransferred != 0U) {
      poison(
          DirectI2sStereoOutputFault::
              partialTransfer);
      return ITERATE_KIT_IO_ERROR;
    }
    if (result.status == ITERATE_KIT_BACKPRESSURE ||
        result.status == ITERATE_KIT_UNAVAILABLE) {
      return result.status;
    }
    /*
     * OK with zero bytes is as contradictory as a hard backend error: neither
     * proves a complete descriptor copy, so upper layers must not advance.
     */
    poison(DirectI2sStereoOutputFault::backendFailure);
    return result.status == ITERATE_KIT_OK
        ? ITERATE_KIT_IO_ERROR
        : result.status;
  }

  iterate_kit_status preloadPreparedStereo(
      DirectI2sFrameMetadata metadata,
      DirectI2sFrameKind frameKind) {
    const auto result = backend_.preloadStereo(
        stereoScratch_.data(), stereoFrameBytes);
    const auto transferStatus =
        classifyTransfer(result, stereoFrameBytes);
    if (transferStatus != ITERATE_KIT_OK) {
      return transferStatus;
    }
    for (std::size_t index = 0U;
         index < preloadedDescriptorCount_;
         ++index) {
      if (descriptors_[index].token ==
          result.descriptor) {
        poison(
            DirectI2sStereoOutputFault::
                descriptorIdentity);
        return ITERATE_KIT_STATE_ERROR;
      }
    }
    descriptors_[preloadedDescriptorCount_] = {
      result.descriptor, metadata, frameKind};
    ++preloadedDescriptorCount_;
    return ITERATE_KIT_OK;
  }

  void clearLocalOwnership() {
    descriptors_.fill(DescriptorState{});
    pendingDescriptorIndices_.fill(0U);
    backendCompletionScratch_.fill(
        DirectI2sBackendCompletion{});
    lastCompletions_.fill(
        DirectI2sDescriptorCompletion{});
    lastSuccessfulRefillTiming_ = {};
    preloadedDescriptorCount_ = 0U;
    pendingHead_ = 0U;
    pendingCount_ = 0U;
    nextExpectedEofIndex_ = 0U;
    lastCompletionCount_ = 0U;
  }

  void poison(DirectI2sStereoOutputFault fault) {
    if (state_ != DirectI2sStereoOutputState::poisoned) {
      fault_ = fault;
    }
    /*
     * A failed batch is not a partially useful diagnostics sample. Clearing
     * its observations prevents a caller from updating current-generation
     * latency with entries that preceded a stale or out-of-order token in the
     * same drain.
     */
    lastCompletionCount_ = 0U;
    state_ = DirectI2sStereoOutputState::poisoned;
  }

  static RealtimePlaybackCompletionBatch
  emptyCompletionBatch() {
    return RealtimePlaybackCompletionBatch{
      0U, 0U, false, 0U, 0U};
  }

  static RealtimePlaybackCompletionBatch
  faultCompletionBatch() {
    /*
     * The established realtime driver API has no status field. An impossible
     * count forces its invariant checker to fail immediately rather than
     * returning an innocent empty batch and silently stalling audio.
     */
    return RealtimePlaybackCompletionBatch{
      std::numeric_limits<std::uint32_t>::max(),
      std::numeric_limits<std::uint32_t>::max(),
      false,
      0U,
      0U};
  }

  Backend &backend_;
  std::array<std::int16_t, MonoSampleCount * 2U>
      stereoScratch_{};
  std::array<DescriptorState, DescriptorCount>
      descriptors_{};
  std::array<std::uint8_t, DescriptorCount>
      pendingDescriptorIndices_{};
  std::array<DirectI2sBackendCompletion, DescriptorCount>
      backendCompletionScratch_{};
  std::array<DirectI2sDescriptorCompletion, DescriptorCount>
      lastCompletions_{};
  std::size_t preloadedDescriptorCount_ = 0U;
  std::size_t pendingHead_ = 0U;
  std::size_t pendingCount_ = 0U;
  std::size_t nextExpectedEofIndex_ = 0U;
  std::size_t lastCompletionCount_ = 0U;
  RealtimePlaybackSuccessfulRefillTiming
      lastSuccessfulRefillTiming_{};
  DirectI2sStereoOutputState state_ =
      DirectI2sStereoOutputState::released;
  DirectI2sStereoOutputFault fault_ =
      DirectI2sStereoOutputFault::none;
};

}  // namespace iterate::kit::platforms

#endif
