#ifndef ITERATE_KIT_PLATFORMS_REALTIME_PLAYBACK_HPP
#define ITERATE_KIT_PLATFORMS_REALTIME_PLAYBACK_HPP

#include "iterate/kit/pcm_lane.h"

#include <cstddef>
#include <cstdint>
#include <limits>

namespace iterate::kit::platforms {

enum class RealtimePlaybackState : std::uint8_t {
  stopped = 0U,
  buffering,
  playing,
  failed,
};

struct RealtimePlaybackPumpResult {
  iterate_kit_status status;
  /*
   * These are edge observations, not state aliases. The application can emit a
   * lifecycle event once without inferring it from a queue depth that may stay
   * non-zero for minutes.
   */
  bool frameSubmitted;
  bool playbackStarted;
};

/**
 * Timing captured around one exact full descriptor refill.
 *
 * The backend timestamps after the synchronous driver copy returns. Measuring
 * only callback-to-owner wakeup omits stereo expansion and the actual I2S
 * write—the two operations which decide whether hardware received the next
 * frame in time. `reuseLeadAtSuccessfulRefillUs` is the physical lead still
 * available at that completed-copy boundary, not the earlier poll estimate.
 */
struct RealtimePlaybackSuccessfulRefillTiming {
  bool valid;
  std::uint32_t eofToSuccessfulRefillUs;
  std::uint32_t writeCallDurationUs;
  std::uint32_t reuseLeadAtSuccessfulRefillUs;
};

/**
 * One owner-task snapshot of exact refillable DMA-descriptor ownership.
 *
 * `refillableDescriptorCount` is not an anonymous FIFO credit. The driver must
 * retain the ordered identities supplied by its DMA EOF callbacks, and each
 * subsequent writeMono() must fill the oldest exact descriptor from this
 * snapshot. ESP-IDF's finished-buffer queue provides that ordering, while the
 * host driver deliberately models descriptor 0/1/2/3 so a count-only fake
 * cannot conceal an identity bug.
 *
 * `earliestReuseLeadUs` is the conservative time until DMA can next select the
 * oldest refillable descriptor. A task can wake before all descriptors have
 * completed and still be too late to copy one frame safely. That is why policy
 * cannot derive continuity from the count alone.
 */
struct RealtimePlaybackCompletionBatch {
  std::uint32_t newlyCompletedDescriptorCount;
  std::uint32_t pendingRefillDescriptorCount;
  bool timingValid;
  /*
   * Age of the oldest EOF still represented by this ownership snapshot.
   * Calling this the "latest" age hid scheduler starvation whenever several
   * callbacks were drained together: the newest EOF is precisely the one with
   * the smallest delay. Continuity is constrained by the oldest descriptor.
   */
  std::uint32_t oldestEofToOwnerUs;
  std::uint32_t earliestReuseLeadUs;
};

/**
 * Metadata carried through the exact descriptor that owns one content frame.
 *
 * `receivedAtMs` and descriptor EOF timestamps share the device monotonic
 * domain. `generation` prevents a delayed ISR observation from making an old
 * socket generation look current. `sequence` makes duplicate/skipped
 * descriptor observations diagnosable without retaining a second PCM FIFO.
 */
struct RealtimePlaybackFrameMetadata {
  std::uint64_t receivedAtMs;
  std::uint32_t generation;
  std::uint32_t sequence;
};

enum class RealtimePlaybackFrameKind : std::uint8_t {
  content = 0U,
  paddingSilence,
  recoverySilence,
};

struct RealtimePlaybackDescriptorCompletion {
  std::uint64_t eofAtUs;
  RealtimePlaybackFrameMetadata frame;
  RealtimePlaybackFrameKind frameKind;
};

struct RealtimePlaybackCompletionPollResult {
  iterate_kit_status status;
  RealtimePlaybackCompletionBatch batch;
};

/**
 * Exact owner-task accounting around application PCM and direct I2S DMA.
 *
 * "DMA completed" means ESP-IDF reported descriptor EOF. It is not an acoustic
 * measurement and must never be labelled "audible"; the external microphone
 * harness closes that final physical gap. Every field is mutated by one audio
 * owner. A platform that snapshots from another task must provide its own
 * synchronization rather than reading this object concurrently.
 */
struct RealtimePlaybackMetrics {
  std::uint32_t framesDequeued = 0U;
  std::uint32_t dmaFramesSubmitted = 0U;
  std::uint32_t dmaFramesCompleted = 0U;
  std::uint32_t generationFramesFlushed = 0U;
  std::uint32_t freshnessFramesDropped = 0U;
  std::uint32_t partialPrebufferFramesDropped = 0U;
  std::uint32_t underrunFramesFlushed = 0U;
  std::uint32_t underrunIncidents = 0U;
  std::uint32_t underrunSilenceFramesSubmitted = 0U;
  std::uint32_t underrunSilenceFramesCompleted = 0U;
  std::uint32_t underrunSilenceFramesRetired = 0U;
  std::uint32_t underrunLateFramesDropped = 0U;
  std::uint32_t dmaDeadlineMissIncidents = 0U;
  std::uint32_t freshnessIncidents = 0U;
  std::uint32_t partialPrebufferIncidents = 0U;
  std::uint32_t endOfStreamMarkersConsumed = 0U;
  std::uint32_t endOfStreamResponses = 0U;
  std::uint32_t endOfStreamSilenceDescriptors = 0U;
  std::uint32_t endOfStreamPaddingDescriptorsCompleted = 0U;
  std::uint32_t driverQueueOverflowIncidents = 0U;
  std::uint32_t driverFailures = 0U;
  std::uint32_t driverStopFailures = 0U;
  std::uint32_t fatalFramesFlushed = 0U;
  std::uint32_t writeBackpressureIncidents = 0U;
  std::uint32_t writeBackpressureDestructiveResets = 0U;
  std::uint32_t writeBackpressureFramesDropped = 0U;
  std::uint32_t invalidFrames = 0U;
  std::uint32_t stateErrors = 0U;
  std::uint32_t ownerClockRegressions = 0U;
  std::uint32_t currentContentFrames = 0U;
  std::uint32_t highWaterContentFrames = 0U;
  std::uint32_t lastReceiveToDmaMs = 0U;
  std::uint32_t maximumReceiveToDmaMs = 0U;
  std::uint32_t receiveToDmaStartSamples = 0U;
  std::uint32_t lastReceiveToDmaStartMs = 0U;
  std::uint32_t maximumReceiveToDmaStartMs = 0U;
  std::uint32_t completionTimingSamples = 0U;
  std::uint32_t lastEofToOwnerUs = 0U;
  std::uint32_t maximumEofToOwnerUs = 0U;
  std::uint32_t lastEarliestReuseLeadUs = 0U;
  std::uint32_t minimumEarliestReuseLeadUs = 0U;
  std::uint32_t successfulRefillTimingSamples = 0U;
  std::uint32_t lastEofToSuccessfulRefillUs = 0U;
  std::uint32_t maximumEofToSuccessfulRefillUs = 0U;
  std::uint32_t lastWriteCallDurationUs = 0U;
  std::uint32_t maximumWriteCallDurationUs = 0U;
  std::uint32_t lastReuseLeadAtSuccessfulRefillUs = 0U;
  std::uint32_t minimumReuseLeadAtSuccessfulRefillUs = 0U;
  RealtimePlaybackState state = RealtimePlaybackState::stopped;
};

/**
 * Allocation-free policy joining timestamped PCM frames to direct cyclic DMA.
 *
 * This layer deliberately knows nothing about ESP pins, codecs, tasks, or
 * stereo expansion. Its driver contract is synchronous copy ownership:
 *
 *   - resetForPlayback() leaves clocks/amplifier off and every descriptor
 *     writable from the beginning;
 *   - preloadMono() copies one complete frame plus its metadata while stopped;
 *   - preloadSilence() initializes an otherwise-unused descriptor behind a
 *     short finite response without manufacturing a content frame;
 *   - start() enables only after every descriptor contains current content;
 *   - pollCompletionBatch() explicitly reports success/failure while
 *     transferring ordered completed-descriptor ownership and its deadline;
 *   - lastPlaybackCompletion() projects each newly completed descriptor's
 *     content/padding kind and content metadata;
 *   - writeMono() copies content+metadata into the oldest exact descriptor;
 *   - stopAndRelease() synchronously prevents DMA from reading old content;
 *   - takeQueueOverflows() consumes driver-notification overflow incidents.
 *
 * One dedicated audio task owns every call. pump() never allocates or waits,
 * and processes at most DmaFrameCount lane frames, so a network burst cannot
 * monopolize the realtime core. The lane remains the only software audio FIFO.
 *
 * Four 20 ms descriptors intentionally spend 80 ms of DMA RAM/initial latency
 * to absorb ordinary scheduler and Wi-Fi jitter. Starting with fewer leaves
 * cyclic descriptors stale; adding a second private FIFO would turn outage
 * history into delayed speech. MaximumFrameAgeMs independently bounds semantic
 * latency even if a larger outer ring is configured for burst absorption.
 */
template<
    std::size_t SampleCount,
    std::uint32_t SampleRate,
    std::size_t DmaFrameCount,
    std::uint32_t MaximumFrameAgeMs,
    std::uint32_t PartialPrebufferTimeoutMs,
    std::uint32_t MinimumRefillLeadUs>
class RealtimePlayback {
  static_assert(SampleCount > 0U);
  static_assert(SampleRate > 0U);
  static_assert(DmaFrameCount >= 2U);
  static_assert(MaximumFrameAgeMs > 0U);
  static_assert(PartialPrebufferTimeoutMs > 0U);
  static_assert(MinimumRefillLeadUs > 0U);
  static_assert(
      MinimumRefillLeadUs <
      (static_cast<std::uint64_t>(SampleCount) * 1'000'000ULL) /
          SampleRate);

 public:
  template<typename Driver>
  iterate_kit_status begin(Driver &driver) {
    if (metrics_.state != RealtimePlaybackState::stopped) {
      increment(metrics_.stateErrors);
      return ITERATE_KIT_STATE_ERROR;
    }
    const auto status = driver.resetForPlayback();
    if (status != ITERATE_KIT_OK) {
      return failDriverAndStop(driver, status);
    }
    enterBuffering();
    return ITERATE_KIT_OK;
  }

  template<typename Driver>
  RealtimePlaybackPumpResult pump(
      iterate_kit_pcm_lane &lane,
      Driver &driver,
      std::uint64_t nowMs) {
    if (metrics_.state == RealtimePlaybackState::stopped) {
      return {ITERATE_KIT_UNAVAILABLE, false, false};
    }
    if (metrics_.state == RealtimePlaybackState::failed) {
      /*
       * A failed write may have left the single lane slot borrowed while fatal
       * cleanup made DMA quiet. Release it exactly once before rejecting later
       * pumps so failure cannot permanently wedge the producer-side ring.
      */
      std::uint32_t dropped = 0U;
      (void)releaseBorrowedFrame(&lane, &dropped);
      add(metrics_.fatalFramesFlushed, dropped);
      return {ITERATE_KIT_STATE_ERROR, false, false};
    }
    if (nowMs < lastOwnerNowMs_) {
      /*
       * ESP monotonic time should not regress. Normalize policy time to avoid
       * underflowing age arithmetic, but retain the incident so a broken clock
       * cannot silently weaken freshness guarantees.
       */
      increment(metrics_.ownerClockRegressions);
      nowMs = lastOwnerNowMs_;
    }
    lastOwnerNowMs_ = nowMs;

    if (metrics_.state == RealtimePlaybackState::playing) {
      const auto playingResult =
          pumpPlaying(lane, driver, nowMs);
      if (metrics_.state == RealtimePlaybackState::failed) {
        std::uint32_t dropped = 0U;
        (void)releaseBorrowedFrame(&lane, &dropped);
        add(metrics_.fatalFramesFlushed, dropped);
      }
      if (playingResult.status != ITERATE_KIT_OK ||
          metrics_.state != RealtimePlaybackState::playing) {
        return playingResult;
      }
      return playingResult;
    }
    return pumpBuffering(lane, driver, nowMs);
  }

  /**
   * Synchronous socket-generation barrier executed by the audio owner.
   *
   * Completion is the permission for the network producer to admit the first
   * frame of `generation`: hardware is stopped, EOFs are reconciled, all
   * remaining DMA/lane content is classified, and a newly-created/rewound
   * descriptor set is ready but disabled. Publishing acceptance before this
   * method returns recreates the first-frame loss observed on the Stick.
   */
  template<typename Driver>
  iterate_kit_status flushGeneration(
      iterate_kit_pcm_lane &lane,
      Driver &driver,
      std::uint32_t generation) {
    if (generation == 0U ||
        metrics_.state == RealtimePlaybackState::failed) {
      return ITERATE_KIT_INVALID_ARGUMENT;
    }
    if (metrics_.state == RealtimePlaybackState::stopped) {
      return ITERATE_KIT_UNAVAILABLE;
    }
    std::uint32_t borrowedFrames = 0U;
    const auto borrowedStatus =
        releaseBorrowedFrame(&lane, &borrowedFrames);
    if (borrowedStatus != ITERATE_KIT_OK) {
      return failStateAndStop(driver, borrowedStatus);
    }
    /*
     * This classification is committed as soon as ownership leaves the ring.
     * Completion polling and hardware stop can still fail below; postponing
     * the counters until the happy-path return made that frame disappear from
     * every diagnostic on exactly those exceptional paths.
     */
    add(metrics_.generationFramesFlushed, borrowedFrames);
    add(
        metrics_.writeBackpressureFramesDropped,
        borrowedFrames);
    if (metrics_.state == RealtimePlaybackState::playing) {
      bool ignoredDeadlineMiss = false;
      const auto reconcileStatus =
          reconcileCompletions(
              driver, false, &ignoredDeadlineMiss);
      if (reconcileStatus != ITERATE_KIT_OK) {
        return reconcileStatus;
      }
    } else {
      /*
       * The first socket generation arrives while descriptors are preloaded
       * but DMA is disabled. There cannot be an EOF to reconcile, and the ESP
       * backend intentionally rejects completion polling while stopped.
       */
      refillCredits_ = 0U;
    }
    const std::uint32_t hardwareFrames =
        metrics_.currentContentFrames;
    const auto stopStatus = driver.stopAndRelease();
    if (stopStatus != ITERATE_KIT_OK) {
      increment(metrics_.driverFailures);
      increment(metrics_.driverStopFailures);
      clearFailedOwnership();
      return stopStatus;
    }
    retireOutstandingRecoverySilenceFrames();
    /*
     * stopAndRelease() is the destructive ownership transition. From this
     * point the old descriptor content cannot be recovered, so classify it
     * before touching the independently-owned lane. A corrupt lane must not
     * turn known generation loss into an unrelated fatal-loss total.
     */
    add(
        metrics_.generationFramesFlushed,
        hardwareFrames);
    metrics_.currentContentFrames = 0U;
    nextExpectedCompletionSequence_ =
        nextSubmissionSequence_;
    refillCredits_ = 0U;

    std::uint32_t laneFrames = 0U;
    const auto discardStatus =
        iterate_kit_pcm_lane_discard_downlink(
            &lane, &laneFrames);
    if (discardStatus != ITERATE_KIT_OK) {
      failState();
      return discardStatus;
    }
    add(metrics_.generationFramesFlushed, laneFrames);

    const auto resetStatus = driver.resetForPlayback();
    if (resetStatus != ITERATE_KIT_OK) {
      return failDriverAndStop(driver, resetStatus);
    }
    acceptedGeneration_ = generation;
    nextSubmissionSequence_ = 0U;
    nextExpectedCompletionSequence_ = 0U;
    enterBuffering();
    return ITERATE_KIT_OK;
  }

  template<typename Driver>
  iterate_kit_status stop(
      iterate_kit_pcm_lane &lane,
      Driver &driver) {
    if (metrics_.state == RealtimePlaybackState::stopped) {
      return ITERATE_KIT_OK;
    }
    const auto stopStatus = driver.stopAndRelease();
    if (stopStatus != ITERATE_KIT_OK) {
      std::uint32_t borrowedFrames = 0U;
      const auto borrowedStatus =
          releaseBorrowedFrame(&lane, &borrowedFrames);
      add(
          metrics_.generationFramesFlushed,
          borrowedFrames);
      add(
          metrics_.writeBackpressureFramesDropped,
          borrowedFrames);
      if (borrowedStatus != ITERATE_KIT_OK) {
        /*
         * Preserve the borrow token for failed-state cleanup. The hardware
         * stop remains the primary returned failure, while stateErrors records
         * that the independent ring cleanup also violated its contract.
         */
        increment(metrics_.stateErrors);
      }
      increment(metrics_.driverFailures);
      increment(metrics_.driverStopFailures);
      clearFailedOwnership();
      return stopStatus;
    }
    retireOutstandingRecoverySilenceFrames();
    /*
     * Each successful cleanup operation irreversibly transfers ownership.
     * Commit its counters immediately so a later ring failure cannot erase
     * already-known losses.
     */
    add(
        metrics_.generationFramesFlushed,
        metrics_.currentContentFrames);
    metrics_.currentContentFrames = 0U;
    nextExpectedCompletionSequence_ =
        nextSubmissionSequence_;
    refillCredits_ = 0U;
    std::uint32_t borrowedFrames = 0U;
    const auto borrowedStatus =
        releaseBorrowedFrame(&lane, &borrowedFrames);
    if (borrowedStatus != ITERATE_KIT_OK) {
      failState();
      return borrowedStatus;
    }
    add(metrics_.generationFramesFlushed, borrowedFrames);
    add(
        metrics_.writeBackpressureFramesDropped,
        borrowedFrames);
    std::uint32_t discarded = 0U;
    const auto discardStatus =
        iterate_kit_pcm_lane_discard_downlink(
            &lane, &discarded);
    if (discardStatus != ITERATE_KIT_OK) {
      failState();
      return discardStatus;
    }
    add(metrics_.generationFramesFlushed, discarded);
    partialPrebufferStartedAtMs_ = 0U;
    partialPrebufferStarted_ = false;
    preloadedDescriptorCount_ = 0U;
    drainingEndOfStream_ = false;
    recoveryDropDebt_ = 0U;
    underrunActive_ = false;
    metrics_.state = RealtimePlaybackState::stopped;
    return ITERATE_KIT_OK;
  }

  std::uint32_t acceptedGeneration() const {
    return acceptedGeneration_;
  }

  RealtimePlaybackMetrics metrics() const {
    return metrics_;
  }

 private:
  static constexpr std::size_t expectedFrameBytes =
      SampleCount * sizeof(std::int16_t);
  static constexpr std::uint64_t frameDurationUs =
      (static_cast<std::uint64_t>(SampleCount) *
       1'000'000ULL) /
      SampleRate;

  static void increment(std::uint32_t &value) {
    if (value != std::numeric_limits<std::uint32_t>::max()) {
      ++value;
    }
  }

  static void add(
      std::uint32_t &value,
      std::uint32_t amount) {
    const auto maximum =
        std::numeric_limits<std::uint32_t>::max();
    value = amount > maximum - value
        ? maximum
        : value + amount;
  }

  static std::uint32_t boundedMetric(
      std::uint64_t value) {
    return value >
            std::numeric_limits<std::uint32_t>::max()
        ? std::numeric_limits<std::uint32_t>::max()
        : static_cast<std::uint32_t>(value);
  }

  void retireOutstandingRecoverySilenceFrames() {
    /*
     * A synchronous driver stop can deliberately retire a recovery descriptor
     * before its EOF callback. The important finite-stream case is a recovery
     * slot queued behind the last real content frame: waiting for that silence
     * to complete would add an artificial tail, while forgetting it makes
     * submitted/completed diagnostics look like an unexplained callback loss.
     *
     * Policy already owns an exact scalar count of those descriptor kinds, so
     * teardown can classify them without asking the platform to allocate or
     * return a vector of descriptor identities. The adjacent stop reason
     * (clean EOS, generation fence, freshness reset, or fatal counter) explains
     * why retirement occurred; strict acceptance still requires every recovery
     * and destructive-reset counter to remain zero.
     */
    add(
        metrics_.underrunSilenceFramesRetired,
        outstandingRecoverySilenceFrames_);
    outstandingRecoverySilenceFrames_ = 0U;
  }

  void enterBuffering() {
    refillCredits_ = 0U;
    preloadedDescriptorCount_ = 0U;
    partialPrebufferStartedAtMs_ = 0U;
    partialPrebufferStarted_ = false;
    drainingEndOfStream_ = false;
    recoveryDropDebt_ = 0U;
    underrunActive_ = false;
    metrics_.state = RealtimePlaybackState::buffering;
  }

  void noteSubmitted(std::uint64_t ageMs) {
    increment(metrics_.framesDequeued);
    increment(metrics_.dmaFramesSubmitted);
    increment(metrics_.currentContentFrames);
    if (metrics_.currentContentFrames >
        metrics_.highWaterContentFrames) {
      metrics_.highWaterContentFrames =
          metrics_.currentContentFrames;
    }
    metrics_.lastReceiveToDmaMs = boundedMetric(ageMs);
    if (metrics_.lastReceiveToDmaMs >
        metrics_.maximumReceiveToDmaMs) {
      metrics_.maximumReceiveToDmaMs =
          metrics_.lastReceiveToDmaMs;
    }
    increment(nextSubmissionSequence_);
  }

  bool noteSuccessfulRefill(
      RealtimePlaybackSuccessfulRefillTiming timing) {
    if (!timing.valid) {
      return false;
    }
    const bool first =
        metrics_.successfulRefillTimingSamples == 0U;
    increment(metrics_.successfulRefillTimingSamples);
    metrics_.lastEofToSuccessfulRefillUs =
        timing.eofToSuccessfulRefillUs;
    if (timing.eofToSuccessfulRefillUs >
        metrics_.maximumEofToSuccessfulRefillUs) {
      metrics_.maximumEofToSuccessfulRefillUs =
          timing.eofToSuccessfulRefillUs;
    }
    metrics_.lastWriteCallDurationUs =
        timing.writeCallDurationUs;
    if (timing.writeCallDurationUs >
        metrics_.maximumWriteCallDurationUs) {
      metrics_.maximumWriteCallDurationUs =
          timing.writeCallDurationUs;
    }
    metrics_.lastReuseLeadAtSuccessfulRefillUs =
        timing.reuseLeadAtSuccessfulRefillUs;
    if (first ||
        timing.reuseLeadAtSuccessfulRefillUs <
            metrics_.
                minimumReuseLeadAtSuccessfulRefillUs) {
      metrics_.minimumReuseLeadAtSuccessfulRefillUs =
          timing.reuseLeadAtSuccessfulRefillUs;
    }
    return true;
  }

  RealtimePlaybackFrameMetadata frameMetadata(
      std::uint64_t receivedAtMs) const {
    return {
      receivedAtMs,
      acceptedGeneration_,
      nextSubmissionSequence_};
  }

  bool frameAge(
      std::uint64_t receivedAtMs,
      std::uint64_t nowMs,
      std::uint64_t *ageMs) {
    if (receivedAtMs > nowMs) {
      /*
       * A future producer timestamp is not fresh audio. It means the network
       * and audio owners disagree about their monotonic domain, so accepting it
       * as age zero would silently bypass the only semantic-latency bound.
       */
      increment(metrics_.ownerClockRegressions);
      *ageMs = 0U;
      return false;
    }
    *ageMs = nowMs - receivedAtMs;
    return true;
  }

  bool recordIncreasingCompletionEof(
      std::uint64_t eofAtUs) {
    /*
     * A descriptor sequence alone is not sufficient proof that the backend
     * handed policy a fresh hardware completion. A duplicated queue record can
     * carry the right metadata while referring to an EOF we already consumed.
     * ESP's monotonic timer gives every real EOF a strictly later timestamp,
     * so reject zero, duplicate, and regressing timestamps before granting a
     * refill credit. Failing closed here prevents policy from overwriting a
     * descriptor that DMA may still own.
     */
    if (eofAtUs == 0U ||
        (completionEofObserved_ &&
         eofAtUs <= lastCompletionEofAtUs_)) {
      increment(metrics_.ownerClockRegressions);
      return false;
    }
    lastCompletionEofAtUs_ = eofAtUs;
    completionEofObserved_ = true;
    return true;
  }

  template<typename Driver>
  RealtimePlaybackPumpResult pumpBuffering(
      iterate_kit_pcm_lane &lane,
      Driver &driver,
      std::uint64_t nowMs) {
    bool submitted = false;
    for (std::size_t work = 0U;
         work < DmaFrameCount &&
         preloadedDescriptorCount_ < DmaFrameCount;
         ++work) {
      const void *frame = nullptr;
      std::size_t frameBytes = 0U;
      std::uint64_t receivedAtMs = 0U;
      const auto acquireStatus =
          iterate_kit_pcm_lane_downlink_acquire_at(
              &lane,
              &frame,
              &frameBytes,
              &receivedAtMs);
      if (acquireStatus == ITERATE_KIT_UNAVAILABLE) {
        break;
      }
      if (acquireStatus != ITERATE_KIT_OK) {
        return {
          failStateAndStop(driver, acquireStatus),
          submitted,
          false};
      }
      rememberBorrowedFrame(
          frame, frameBytes, receivedAtMs);
      if (frame == nullptr && frameBytes == 0U) {
        const auto releaseStatus =
            releaseBorrowedFrame(&lane, nullptr);
        if (releaseStatus != ITERATE_KIT_OK) {
          return {
            failStateAndStop(driver, releaseStatus),
            submitted,
            false};
        }
        increment(metrics_.endOfStreamMarkersConsumed);
        if (metrics_.currentContentFrames == 0U) {
          /*
           * A response with no PCM has nothing to clock. Count the ordered
           * boundary and remain ready; starting four silent descriptors would
           * waste CPU and turn "no speech" into a fake playback interval.
           */
          increment(metrics_.endOfStreamResponses);
          enterBuffering();
          return {ITERATE_KIT_OK, submitted, false};
        }
        /*
         * Cyclic DMA cannot start with uninitialized descriptors. Silence is
         * safe only after all response content and is not counted as content:
         * the final content EOF remains the exact clean-stop condition.
         */
        while (preloadedDescriptorCount_ < DmaFrameCount) {
          const auto silenceStatus =
              driver.preloadSilence();
          if (silenceStatus != ITERATE_KIT_OK) {
            return {
              failDriverAndStop(driver, silenceStatus),
              submitted,
              false};
          }
          ++preloadedDescriptorCount_;
          increment(metrics_.endOfStreamSilenceDescriptors);
        }
        const auto startStatus = driver.start();
        if (startStatus != ITERATE_KIT_OK) {
          return {
            failDriverAndStop(driver, startStatus),
            submitted,
            false};
        }
        partialPrebufferStartedAtMs_ = 0U;
        partialPrebufferStarted_ = false;
        drainingEndOfStream_ = true;
        metrics_.state = RealtimePlaybackState::playing;
        return {ITERATE_KIT_OK, submitted, true};
      }
      if (frame == nullptr ||
          frameBytes != expectedFrameBytes) {
        increment(metrics_.invalidFrames);
        const auto releaseStatus =
            releaseBorrowedFrame(&lane, nullptr);
        if (releaseStatus != ITERATE_KIT_OK) {
          return {
            failStateAndStop(driver, releaseStatus),
            submitted,
            false};
        }
        return {
          failStateAndStop(
              driver, ITERATE_KIT_STATE_ERROR),
          submitted,
          false};
      }
      borrowedFrameCountableContent_ = true;
      std::uint64_t ageMs = 0U;
      const bool timestampValid =
          frameAge(receivedAtMs, nowMs, &ageMs);
      if (!timestampValid || ageMs > MaximumFrameAgeMs) {
        std::uint32_t releasedFrames = 0U;
        const auto releaseStatus =
            releaseBorrowedFrame(
                &lane, &releasedFrames);
        if (releaseStatus != ITERATE_KIT_OK) {
          return {
            failStateAndStop(driver, releaseStatus),
            submitted,
            false};
        }
        const auto freshnessStatus =
            resetForFreshness(
                lane, driver, releasedFrames);
        return {freshnessStatus, submitted, false};
      }
      const auto preloadStatus =
          driver.preloadMono(
              static_cast<const std::int16_t *>(frame),
              SampleCount,
              frameMetadata(receivedAtMs));
      if (preloadStatus != ITERATE_KIT_OK) {
        std::uint32_t releasedFrames = 0U;
        const auto releaseStatus =
            releaseBorrowedFrame(
                &lane, &releasedFrames);
        if (releaseStatus != ITERATE_KIT_OK) {
          /*
           * Both independent operations failed. Preserve the driver failure
           * and return the release error whose retained token still requires
           * failed-state cleanup.
           */
          increment(metrics_.driverFailures);
          return {
            failStateAndStop(driver, releaseStatus),
            submitted,
            false};
        }
        /*
         * No descriptor owns this frame, and successful release moved the lane
         * past it. Commit that one known loss before driver teardown; hardware
         * cleanup can account only descriptors that were actually submitted.
         */
        add(
            metrics_.fatalFramesFlushed,
            releasedFrames);
        return {
          failDriverAndStop(driver, preloadStatus),
          submitted,
          false};
      }
      /*
       * The driver copy is the submission boundary. Record it before releasing
       * the lane alias so a subsequent release failure cannot hide bytes that
       * are already owned by DMA.
       */
      noteSubmitted(ageMs);
      ++preloadedDescriptorCount_;
      submitted = true;
      borrowedFrameSubmitted_ = true;
      const auto releaseStatus =
          releaseBorrowedFrame(&lane, nullptr);
      if (releaseStatus != ITERATE_KIT_OK) {
        return {
          failStateAndStop(driver, releaseStatus),
          submitted,
          false};
      }
      if (!partialPrebufferStarted_) {
        /*
         * Store owner time rather than a possibly-zero socket timestamp. This
         * timeout bounds descriptor retention, while freshness separately
         * bounds receive-to-DMA age.
         */
        partialPrebufferStartedAtMs_ = nowMs;
        partialPrebufferStarted_ = true;
      }
    }

    if (preloadedDescriptorCount_ == DmaFrameCount) {
      const auto startStatus = driver.start();
      if (startStatus != ITERATE_KIT_OK) {
        return {
          failDriverAndStop(driver, startStatus),
          submitted,
          false};
      }
      partialPrebufferStartedAtMs_ = 0U;
      partialPrebufferStarted_ = false;
      metrics_.state = RealtimePlaybackState::playing;
      return {ITERATE_KIT_OK, submitted, true};
    }
    if (partialPrebufferStarted_ &&
        nowMs - partialPrebufferStartedAtMs_ >=
            PartialPrebufferTimeoutMs) {
      const auto partialStatus =
          resetPartialPrebuffer(driver);
      return {partialStatus, submitted, false};
    }
    return {ITERATE_KIT_OK, submitted, false};
  }

  template<typename Driver>
  RealtimePlaybackPumpResult pumpPlaying(
      iterate_kit_pcm_lane &lane,
      Driver &driver,
      std::uint64_t nowMs) {
    const auto overflowCount = driver.takeQueueOverflows();
    if (overflowCount > 0U) {
      add(
          metrics_.driverQueueOverflowIncidents,
          overflowCount);
      const auto status =
          resetAfterUnderrun(lane, driver);
      return {status, false, false};
    }
    bool deadlineMissed = false;
    const auto reconcileStatus =
        reconcileCompletions(
            driver, !drainingEndOfStream_, &deadlineMissed);
    if (reconcileStatus != ITERATE_KIT_OK) {
      return {reconcileStatus, false, false};
    }
    const auto overflowAfterPoll =
        driver.takeQueueOverflows();
    if (overflowAfterPoll > 0U) {
      /*
       * An ISR can preempt between the first overflow check and completion
       * polling. Writing after that event would let ESP-IDF's private queue
       * choose a different descriptor than our oldest-token ledger. A second
       * fail-closed check is required before touching any PCM; the backend
       * additionally poisons its poll snapshot so the final ISR-sized race is
       * not delegated to this policy layer.
       */
      add(
          metrics_.driverQueueOverflowIncidents,
          overflowAfterPoll);
      const auto status =
          resetAfterUnderrun(lane, driver);
      return {status, false, false};
    }
    if (drainingEndOfStream_ &&
        metrics_.currentContentFrames == 0U) {
      const auto status = finishEndOfStream(driver);
      return {status, false, false};
    }
    if (deadlineMissed) {
      /*
       * The owner still has an exact descriptor token, but too little physical
       * reuse lead remains to complete even a silence copy safely. This is the
       * boundary where teardown is warranted: writing anything would make the
       * metrics claim continuity after DMA may already have selected the old
       * descriptor.
       */
      const auto status =
          resetAfterUnderrun(lane, driver);
      return {status, false, false};
    }
    if (refillCredits_ >= DmaFrameCount) {
      /*
       * Once a whole descriptor cycle has completed, hardware has already
       * wrapped to the first unrefilled descriptor. Even a fake backend with
       * an unbounded finished-pointer queue must not let policy reinterpret
       * those four credits as a harmless FIFO burst: the acoustic deadline
       * was lost before this owner wake. Real ESP-IDF normally reports its
       * smaller (DmaFrameCount - 1) queue overflowing first, but retaining this
       * portable invariant keeps the host rig honest about cyclic DMA.
       */
      increment(metrics_.dmaDeadlineMissIncidents);
      const auto status =
          resetAfterUnderrun(lane, driver);
      return {status, false, false};
    }

    std::size_t work = 0U;
    const auto recoveryDropStatus =
        discardLateRecoveryFrames(
            lane, driver, &work);
    if (recoveryDropStatus != ITERATE_KIT_OK) {
      return {recoveryDropStatus, false, false};
    }
    if (drainingEndOfStream_) {
      const auto drainStatus =
          refillEndOfStreamSilence(lane, driver);
      return {drainStatus, false, false};
    }
    if (recoveryDropDebt_ > 0U) {
      /*
       * A producer can publish immediately after the bounded discard helper
       * observed an empty lane. Do not let that race turn the ordered late head
       * into current speech: while debt remains, every newly visible head still
       * belongs to a playout slot already replaced by silence. A later producer
       * notification will perform the explicit discard.
       *
       * Do not immediately fill every descriptor which happened to complete
       * while that late head was absent. Those descriptors still have measured
       * reuse lead and are the hardware jitter reserve. Write one more silence
       * only when retaining all pending pointers would fill ESP-IDF's
       * DmaFrameCount-1 completed-pointer queue; this keeps ownership bounded
       * without converting a short phase offset into several extra lost slots.
       */
      if (refillCredits_ >= DmaFrameCount - 1U) {
        const auto silenceStatus =
            refillRecoverySilence(lane, driver);
        return {silenceStatus, false, false};
      }
      return {ITERATE_KIT_OK, false, false};
    }

    bool submitted = false;
    for (;
         work < DmaFrameCount && refillCredits_ > 0U;
         ++work) {
      const void *frame = nullptr;
      std::size_t frameBytes = 0U;
      std::uint64_t receivedAtMs = 0U;
      const auto acquireStatus =
          iterate_kit_pcm_lane_downlink_acquire_at(
              &lane,
              &frame,
              &frameBytes,
              &receivedAtMs);
      if (acquireStatus == ITERATE_KIT_UNAVAILABLE) {
        break;
      }
      if (acquireStatus != ITERATE_KIT_OK) {
        return {
          failStateAndStop(driver, acquireStatus),
          submitted,
          false};
      }
      rememberBorrowedFrame(
          frame, frameBytes, receivedAtMs);
      if (frame == nullptr && frameBytes == 0U) {
        const auto releaseStatus =
            releaseBorrowedFrame(&lane, nullptr);
        if (releaseStatus != ITERATE_KIT_OK) {
          return {
            failStateAndStop(driver, releaseStatus),
            submitted,
            false};
        }
        /*
         * All earlier PCM has already been submitted because this marker shares
         * the lane FIFO. Stop refilling completed descriptors; auto-clear makes
         * them silent, and at most three content EOFs remain before clean stop,
         * within ESP-IDF's three-entry completion queue.
         */
        increment(metrics_.endOfStreamMarkersConsumed);
        drainingEndOfStream_ = true;
        break;
      }
      if (frame == nullptr ||
          frameBytes != expectedFrameBytes) {
        increment(metrics_.invalidFrames);
        const auto releaseStatus =
            releaseBorrowedFrame(&lane, nullptr);
        if (releaseStatus != ITERATE_KIT_OK) {
          return {
            failStateAndStop(driver, releaseStatus),
            submitted,
            false};
        }
        return {
          failStateAndStop(
              driver, ITERATE_KIT_STATE_ERROR),
          submitted,
          false};
      }
      borrowedFrameCountableContent_ = true;
      std::uint64_t ageMs = 0U;
      const bool timestampValid =
          frameAge(receivedAtMs, nowMs, &ageMs);
      if (!timestampValid || ageMs > MaximumFrameAgeMs) {
        std::uint32_t releasedFrames = 0U;
        const auto releaseStatus =
            releaseBorrowedFrame(
                &lane, &releasedFrames);
        if (releaseStatus != ITERATE_KIT_OK) {
          return {
            failStateAndStop(driver, releaseStatus),
            submitted,
            false};
        }
        const auto freshnessStatus =
            resetForFreshness(
                lane, driver, releasedFrames);
        return {freshnessStatus, submitted, false};
      }
      const auto writeStatus =
          driver.writeMono(
              static_cast<const std::int16_t *>(frame),
              SampleCount,
              frameMetadata(receivedAtMs));
      if (writeStatus == ITERATE_KIT_BACKPRESSURE ||
          writeStatus == ITERATE_KIT_UNAVAILABLE) {
        /*
         * ESP-IDF 5.4.2 invokes on_sent, publishes the same completed-buffer
         * pointer to its private TX queue, and only then returns/yields from the
         * ISR. This higher-priority owner therefore cannot observe the callback
         * before a timeout-zero write can consume that pointer. With one writer,
         * zero progress is an ownership/driver invariant failure—not a reason
         * to sleep and retry.
         *
         * Stop this suspect generation immediately. Retaining the borrowed
         * lane head for a later RTOS tick used to manufacture a 10 ms audible
         * hole at 100 Hz and made the precise failure look like benign jitter.
         * resetAfterUnderrun() releases and counts that one frame, tears down
         * the descriptor cycle, and re-enters clean bounded prebuffering.
         */
        increment(metrics_.writeBackpressureIncidents);
        increment(
            metrics_.writeBackpressureDestructiveResets);
        const auto resetStatus =
            resetAfterUnderrun(lane, driver);
        return {resetStatus, submitted, false};
      }
      if (writeStatus != ITERATE_KIT_OK) {
        std::uint32_t releasedFrames = 0U;
        const auto releaseStatus =
            releaseBorrowedFrame(
                &lane, &releasedFrames);
        /*
         * The acquired content is outside DMA and outside the bulk lane cursor
         * after release. Classify it before fatal cleanup accounts the three
         * still-cycling descriptors.
         */
        if (releaseStatus != ITERATE_KIT_OK) {
          increment(metrics_.driverFailures);
          return {
            failStateAndStop(driver, releaseStatus),
            submitted,
            false};
        }
        add(
            metrics_.fatalFramesFlushed,
            releasedFrames);
        return {
          failDriverAndStop(driver, writeStatus),
          submitted,
          false};
      }
      const auto refillTiming =
          driver.lastSuccessfulRefillTiming();
      --refillCredits_;
      noteSubmitted(ageMs);
      submitted = true;
      borrowedFrameSubmitted_ = true;
      const auto releaseStatus =
          releaseBorrowedFrame(&lane, nullptr);
      if (releaseStatus != ITERATE_KIT_OK) {
        return {
          failStateAndStop(driver, releaseStatus),
          submitted,
          false};
      }
      if (!noteSuccessfulRefill(refillTiming)) {
        /*
         * The full copy already transferred ownership to DMA, so account it
         * before stopping. Missing timing is nevertheless a state defect:
         * claiming continuity without the post-write timestamp would let the
         * acceptance SLO silently regress to the earlier owner-wakeup metric.
         */
        return {
          failStateAndStop(
              driver, ITERATE_KIT_STATE_ERROR),
          submitted,
          false};
      }
      if (refillTiming.reuseLeadAtSuccessfulRefillUs <=
          MinimumRefillLeadUs) {
        /*
         * The pre-write poll was safe, but the copy itself consumed the last
         * margin. Do not wait for another EOF to admit the already-known miss:
         * reset now so the next generation starts from four clean descriptors.
         */
        increment(metrics_.dmaDeadlineMissIncidents);
        const auto resetStatus =
            resetAfterUnderrun(lane, driver);
        return {resetStatus, submitted, false};
      }
      /*
       * A real content refill after all substituted slots have been discarded
       * closes one contiguous network-delay incident. Silence on a later empty
       * descriptor starts a new incident rather than inflating this one on every
       * 20 ms frame.
       */
      underrunActive_ = false;
    }

    if (drainingEndOfStream_ && refillCredits_ > 0U) {
      const auto drainStatus =
          refillEndOfStreamSilence(lane, driver);
      return {drainStatus, submitted, false};
    }
    if (!drainingEndOfStream_ &&
        refillCredits_ >= DmaFrameCount - 1U) {
      /*
       * EOF transfers ownership to this task, but it does not make the
       * descriptor acoustically late. With four DMA descriptors the oldest
       * completed slot has up to 60 ms before reuse. Retaining one or two
       * exact pointers lets an ordinary post-EOF network arrival refill them
       * on its producer notification. At three pending pointers the next EOF
       * would overflow ESP-IDF's private queue, so consume exactly the oldest
       * slot with classified silence and preserve the remaining reserve.
       *
       * The backend recomputes the oldest descriptor's reuse lead on every
       * poll, including polls with no new EOF. The deadline check above still
       * fails closed before any unsafe copy; this branch therefore delays a
       * decision, never a deadline.
       */
      const auto silenceStatus =
          refillRecoverySilence(lane, driver);
      return {silenceStatus, submitted, false};
    }
    return {ITERATE_KIT_OK, submitted, false};
  }

  template<typename Driver>
  iterate_kit_status discardLateRecoveryFrames(
      iterate_kit_pcm_lane &lane,
      Driver &driver,
      std::size_t *work) {
    if (work == nullptr) {
      return failStateAndStop(
          driver, ITERATE_KIT_INVALID_ARGUMENT);
    }
    /*
     * TCP preserves order. Once a physical slot has been filled with recovery
     * silence, the next content frame on this generation is therefore the
     * frame for that already-expired slot, not fresh speech. Retaining even one
     * such frame would shift every subsequent sample by 20 ms and manufacture
     * a permanent backlog after a transient network stall.
     *
     * The debt is scalar timing state, never PCM storage. At most one DMA
     * cycle is inspected per pump so a network burst cannot monopolize the
     * realtime owner. Further producer notifications continue paying down the
     * same debt without allocating, copying, or waiting.
     */
    while (recoveryDropDebt_ > 0U &&
           *work < DmaFrameCount) {
      const void *frame = nullptr;
      std::size_t frameBytes = 0U;
      std::uint64_t receivedAtMs = 0U;
      const auto acquireStatus =
          iterate_kit_pcm_lane_downlink_acquire_at(
              &lane,
              &frame,
              &frameBytes,
              &receivedAtMs);
      if (acquireStatus == ITERATE_KIT_UNAVAILABLE) {
        break;
      }
      if (acquireStatus != ITERATE_KIT_OK) {
        return failStateAndStop(
            driver, acquireStatus);
      }
      rememberBorrowedFrame(
          frame, frameBytes, receivedAtMs);
      if (frame == nullptr && frameBytes == 0U) {
        const auto releaseStatus =
            releaseBorrowedFrame(&lane, nullptr);
        if (releaseStatus != ITERATE_KIT_OK) {
          return failStateAndStop(
              driver, releaseStatus);
        }
        /*
         * EOS is an ordered boundary, not a late PCM frame. It proves that no
         * more content from this response exists to pay the remaining silence
         * debt. Consuming the marker and clearing the scalar debt lets the
         * already-submitted descriptors drain without throwing away the next
         * response on the same socket.
         */
        increment(metrics_.endOfStreamMarkersConsumed);
        recoveryDropDebt_ = 0U;
        underrunActive_ = false;
        drainingEndOfStream_ = true;
        return ITERATE_KIT_OK;
      }
      if (frame == nullptr ||
          frameBytes != expectedFrameBytes) {
        increment(metrics_.invalidFrames);
        const auto releaseStatus =
            releaseBorrowedFrame(&lane, nullptr);
        if (releaseStatus != ITERATE_KIT_OK) {
          return failStateAndStop(
              driver, releaseStatus);
        }
        return failStateAndStop(
            driver, ITERATE_KIT_STATE_ERROR);
      }
      borrowedFrameCountableContent_ = true;
      std::uint32_t releasedFrames = 0U;
      const auto releaseStatus =
          releaseBorrowedFrame(
              &lane, &releasedFrames);
      if (releaseStatus != ITERATE_KIT_OK) {
        return failStateAndStop(
            driver, releaseStatus);
      }
      if (releasedFrames != 1U) {
        return failStateAndStop(
            driver, ITERATE_KIT_STATE_ERROR);
      }
      --recoveryDropDebt_;
      increment(metrics_.underrunLateFramesDropped);
      ++(*work);
    }
    return ITERATE_KIT_OK;
  }

  template<typename Driver>
  iterate_kit_status refillRecoverySilence(
      iterate_kit_pcm_lane &lane,
      Driver &driver) {
    /*
     * Auto-clear prevents stale descriptor replay but does not consume the
     * completed-pointer entry in ESP-IDF's private queue. Explicitly writing
     * zeroes is therefore an ownership operation as well as an acoustic one:
     * it keeps the cyclic driver healthy while admitting exactly which 20 ms
     * playout slots were lost.
     *
     * Each successful silence write creates exactly one ordered drop debt.
     * This equality is the core no-backlog invariant. We never queue a late
     * frame, and we never resume content until the corresponding stale heads
     * have been discarded.
     */
    while (refillCredits_ >= DmaFrameCount - 1U) {
      if (recoveryDropDebt_ ==
              std::numeric_limits<std::uint32_t>::max() ||
          outstandingRecoverySilenceFrames_ ==
              std::numeric_limits<std::uint32_t>::max()) {
        /*
         * Saturation would destroy the one-silence/one-drop equality. It takes
         * years of continuous outage at 20 ms frames, but fail closed instead
         * of wrapping into an apparently healthy stream.
         */
        return failStateAndStop(
            driver, ITERATE_KIT_STATE_ERROR);
      }
      const auto writeStatus =
          driver.writeRecoverySilence();
      if (writeStatus == ITERATE_KIT_BACKPRESSURE ||
          writeStatus == ITERATE_KIT_UNAVAILABLE) {
        increment(metrics_.writeBackpressureIncidents);
        increment(
            metrics_.writeBackpressureDestructiveResets);
        return resetAfterUnderrun(lane, driver);
      }
      if (writeStatus != ITERATE_KIT_OK) {
        return failDriverAndStop(driver, writeStatus);
      }
      const auto refillTiming =
          driver.lastSuccessfulRefillTiming();
      --refillCredits_;
      ++recoveryDropDebt_;
      ++outstandingRecoverySilenceFrames_;
      increment(metrics_.underrunSilenceFramesSubmitted);
      if (!underrunActive_) {
        increment(metrics_.underrunIncidents);
        underrunActive_ = true;
      }
      if (!noteSuccessfulRefill(refillTiming)) {
        return failStateAndStop(
            driver, ITERATE_KIT_STATE_ERROR);
      }
      if (refillTiming.reuseLeadAtSuccessfulRefillUs <=
          MinimumRefillLeadUs) {
        increment(metrics_.dmaDeadlineMissIncidents);
        return resetAfterUnderrun(lane, driver);
      }
    }
    return ITERATE_KIT_OK;
  }

  template<typename Driver>
  iterate_kit_status refillEndOfStreamSilence(
      iterate_kit_pcm_lane &lane,
      Driver &driver) {
    /*
     * The final content EOF is not the only finite-stream obligation. ESP-IDF
     * retains each completed DMA pointer in a queue with DmaFrameCount-1
     * entries; simply declining to refill after EOS makes the fourth callback
     * drop the oldest pointer before the owner can account for the last frame.
     *
     * Consume every available pointer by placing silence *behind* remaining
     * content. This neither delays nor counts as server audio. It only keeps
     * the driver's ownership queue moving until the exact final content EOF,
     * where finishEndOfStream() stops the channel synchronously. Auto-clear
     * already guarantees silence on a missed refill, but it does not consume
     * ESP-IDF's private queue entry, which is why an explicit write is needed.
     */
    while (refillCredits_ > 0U) {
      const auto writeStatus = driver.writeSilence();
      if (writeStatus == ITERATE_KIT_BACKPRESSURE ||
          writeStatus == ITERATE_KIT_UNAVAILABLE) {
        /*
         * A completion credit with no writable driver pointer means exact
         * ownership has already diverged. Retrying on a later RTOS tick would
         * let the remaining content cross an unknown descriptor cycle, so use
         * the same bounded, observable recovery as a streaming underrun.
         */
        increment(metrics_.writeBackpressureIncidents);
        increment(
            metrics_.writeBackpressureDestructiveResets);
        return resetAfterUnderrun(lane, driver);
      }
      if (writeStatus != ITERATE_KIT_OK) {
        return failDriverAndStop(driver, writeStatus);
      }
      const auto refillTiming =
          driver.lastSuccessfulRefillTiming();
      --refillCredits_;
      increment(metrics_.endOfStreamSilenceDescriptors);
      if (!noteSuccessfulRefill(refillTiming)) {
        return failStateAndStop(
            driver, ITERATE_KIT_STATE_ERROR);
      }
      if (refillTiming.reuseLeadAtSuccessfulRefillUs <=
          MinimumRefillLeadUs) {
        increment(metrics_.dmaDeadlineMissIncidents);
        return resetAfterUnderrun(lane, driver);
      }
    }
    return ITERATE_KIT_OK;
  }

  template<typename Driver>
  iterate_kit_status finishEndOfStream(Driver &driver) {
    /*
     * This is an expected finite boundary, not underrun recovery. Stop before
     * DMA can advance into an already-cleared descriptor, then recreate a
     * disabled clean set for the next response on the same socket.
     */
    const auto stopStatus = driver.stopAndRelease();
    if (stopStatus != ITERATE_KIT_OK) {
      increment(metrics_.driverFailures);
      increment(metrics_.driverStopFailures);
      clearFailedOwnership();
      return stopStatus;
    }
    retireOutstandingRecoverySilenceFrames();
    metrics_.currentContentFrames = 0U;
    refillCredits_ = 0U;
    const auto resetStatus = driver.resetForPlayback();
    if (resetStatus != ITERATE_KIT_OK) {
      return failDriverAndStop(driver, resetStatus);
    }
    increment(metrics_.endOfStreamResponses);
    enterBuffering();
    return ITERATE_KIT_OK;
  }

  void noteDmaStart(
      const RealtimePlaybackDescriptorCompletion &completion) {
    /*
     * EOF is the first hardware timestamp that proves where this exact
     * descriptor sat in the I2S cycle. Subtracting one frame duration yields
     * DMA selection/start, unlike the older receive-to-copy metric which
     * omitted up to the whole descriptor reserve. This remains a hardware
     * metric—not an "audible" claim; the Mac microphone artifact closes the
     * codec/amplifier/speaker gap.
     */
    if (completion.eofAtUs < frameDurationUs ||
        completion.frame.receivedAtMs >
            std::numeric_limits<std::uint64_t>::max() /
                1000ULL) {
      increment(metrics_.ownerClockRegressions);
      return;
    }
    const std::uint64_t dmaStartedAtUs =
        completion.eofAtUs - frameDurationUs;
    const std::uint64_t receivedAtUs =
        completion.frame.receivedAtMs * 1000ULL;
    if (receivedAtUs > dmaStartedAtUs) {
      increment(metrics_.ownerClockRegressions);
      return;
    }
    const std::uint32_t ageMs = boundedMetric(
        (dmaStartedAtUs - receivedAtUs) / 1000ULL);
    increment(metrics_.receiveToDmaStartSamples);
    metrics_.lastReceiveToDmaStartMs = ageMs;
    if (ageMs > metrics_.maximumReceiveToDmaStartMs) {
      metrics_.maximumReceiveToDmaStartMs = ageMs;
    }
  }

  template<typename Driver>
  iterate_kit_status reconcileCompletions(
      Driver &driver,
      bool enforceContinuityDeadline,
      bool *deadlineMissed) {
    if (deadlineMissed == nullptr) {
      return failStateAndStop(
          driver, ITERATE_KIT_INVALID_ARGUMENT);
    }
    *deadlineMissed = false;
    const RealtimePlaybackCompletionPollResult poll =
        driver.pollCompletionBatch();
    if (poll.status != ITERATE_KIT_OK) {
      /*
       * A completion poll failure means descriptor identity may already be
       * lost. The old count-sentinel API could mark policy failed while cyclic
       * DMA continued forever; an explicit status lets us make hardware quiet
       * before returning the diagnostic.
       */
      return failDriverAndStop(driver, poll.status);
    }
    const auto &batch = poll.batch;
    const auto completedDescriptors =
        batch.newlyCompletedDescriptorCount;
    if (completedDescriptors >
            std::numeric_limits<std::uint32_t>::max() -
                refillCredits_) {
      return failStateAndStop(
          driver, ITERATE_KIT_STATE_ERROR);
    }

    std::uint32_t completedContent = 0U;
    std::uint32_t completedPadding = 0U;
    std::uint32_t completedRecoverySilence = 0U;
    for (std::uint32_t index = 0U;
         index < completedDescriptors;
         ++index) {
      RealtimePlaybackDescriptorCompletion completion{};
      if (!driver.lastPlaybackCompletion(
              index, &completion)) {
        return failStateAndStop(
            driver, ITERATE_KIT_STATE_ERROR);
      }
      if (completion.frameKind ==
          RealtimePlaybackFrameKind::paddingSilence) {
        /*
         * Padding can exist only behind a short finite response. Observing it
         * during ordinary streaming would mean content metadata and descriptor
         * identity have diverged.
         */
        if (!drainingEndOfStream_) {
          return failStateAndStop(
              driver, ITERATE_KIT_STATE_ERROR);
        }
        if (!recordIncreasingCompletionEof(
                completion.eofAtUs)) {
          return failStateAndStop(
              driver, ITERATE_KIT_STATE_ERROR);
        }
        increment(completedPadding);
        continue;
      }
      if (completion.frameKind ==
          RealtimePlaybackFrameKind::recoverySilence) {
        /*
         * Recovery silence owns a real cyclic descriptor but is neither
         * delivered content nor EOS padding. Its completion advances physical
         * ownership and refill credit while deliberately leaving the ordered
         * content sequence untouched.
         */
        if (!recordIncreasingCompletionEof(
                completion.eofAtUs)) {
          return failStateAndStop(
              driver, ITERATE_KIT_STATE_ERROR);
        }
        increment(completedRecoverySilence);
        continue;
      }
      if (completion.frameKind !=
              RealtimePlaybackFrameKind::content ||
          completion.frame.generation !=
              acceptedGeneration_ ||
          completion.frame.sequence !=
              nextExpectedCompletionSequence_ ||
          !recordIncreasingCompletionEof(
              completion.eofAtUs)) {
        return failStateAndStop(
            driver, ITERATE_KIT_STATE_ERROR);
      }
      increment(nextExpectedCompletionSequence_);
      increment(completedContent);
      noteDmaStart(completion);
    }
    if (completedContent >
        metrics_.currentContentFrames) {
      return failStateAndStop(
          driver, ITERATE_KIT_STATE_ERROR);
    }
    if (completedRecoverySilence >
        outstandingRecoverySilenceFrames_) {
      /*
       * Completion identity is stronger than a raw EOF count. Seeing more
       * recovery descriptors finish than policy submitted means either a
       * duplicate callback or stale descriptor metadata survived a reset.
       * Underflowing the scalar would turn that ownership defect into a huge
       * apparently-valid backlog, so stop before committing the batch.
       */
      return failStateAndStop(
          driver, ITERATE_KIT_STATE_ERROR);
    }
    add(metrics_.dmaFramesCompleted, completedContent);
    add(
        metrics_.endOfStreamPaddingDescriptorsCompleted,
        completedPadding);
    add(
        metrics_.underrunSilenceFramesCompleted,
        completedRecoverySilence);
    outstandingRecoverySilenceFrames_ -=
        completedRecoverySilence;
    metrics_.currentContentFrames -= completedContent;
    refillCredits_ += completedDescriptors;
    if (batch.pendingRefillDescriptorCount !=
        refillCredits_) {
      /*
       * The backend owns exact completed descriptor identities while policy
       * mirrors their count. Disagreement means a descriptor was duplicated,
       * forgotten, or consumed out of band; continuing could overwrite a live
       * DMA buffer, so this is a state defect rather than recoverable jitter.
       */
      return failStateAndStop(
          driver, ITERATE_KIT_STATE_ERROR);
    }
    if (refillCredits_ == 0U) {
      return ITERATE_KIT_OK;
    }
    if (!batch.timingValid) {
      /*
       * Timing remains mandatory for as long as any completed descriptor is
       * awaiting refill, not merely on the pump that first observed its EOF.
       * Otherwise a no-input pump can retain credits and forget that their
       * cyclic reuse deadline is still approaching.
       */
      return failStateAndStop(
          driver, ITERATE_KIT_STATE_ERROR);
    }

    const bool firstTimingSample =
        metrics_.completionTimingSamples == 0U;
    increment(metrics_.completionTimingSamples);
    metrics_.lastEofToOwnerUs =
        batch.oldestEofToOwnerUs;
    if (batch.oldestEofToOwnerUs >
        metrics_.maximumEofToOwnerUs) {
      metrics_.maximumEofToOwnerUs =
          batch.oldestEofToOwnerUs;
    }
    metrics_.lastEarliestReuseLeadUs =
        batch.earliestReuseLeadUs;
    if (firstTimingSample ||
        batch.earliestReuseLeadUs <
            metrics_.minimumEarliestReuseLeadUs) {
      metrics_.minimumEarliestReuseLeadUs =
          batch.earliestReuseLeadUs;
    }
    if (enforceContinuityDeadline &&
        batch.earliestReuseLeadUs <=
            MinimumRefillLeadUs) {
      /*
       * The completed descriptor still belongs to the owner, but ownership
       * without enough copy margin is not permission to claim gapless audio.
       * Stop the generation before touching queued fresh frames; the next pump
       * can rebuffer them into a wholly clean descriptor cycle.
       */
      increment(metrics_.dmaDeadlineMissIncidents);
      *deadlineMissed = true;
    }
    return ITERATE_KIT_OK;
  }

  template<typename Driver>
  iterate_kit_status resetAfterUnderrun(
      iterate_kit_pcm_lane &lane,
      Driver &driver) {
    /*
     * A bounded silence run can later discover an independent ownership
     * failure and require teardown. That is a destructive recovery mode for
     * the same contiguous outage, not a second network incident.
     */
    if (!underrunActive_) {
      increment(metrics_.underrunIncidents);
      underrunActive_ = true;
    }
    /*
     * Frames still owned by DMA are not "completed"; a reset deliberately
     * abandons them so stale descriptor contents cannot survive recovery.
     * Account for that loss separately from the incident count.
     */
    add(
        metrics_.underrunFramesFlushed,
        metrics_.currentContentFrames);
    std::uint32_t borrowedFrames = 0U;
    const auto borrowedStatus =
        releaseBorrowedFrame(&lane, &borrowedFrames);
    if (borrowedStatus != ITERATE_KIT_OK) {
      return failStateAndStop(driver, borrowedStatus);
    }
    add(
        metrics_.writeBackpressureFramesDropped,
        borrowedFrames);
    const auto stopStatus = driver.stopAndRelease();
    if (stopStatus != ITERATE_KIT_OK) {
      increment(metrics_.driverFailures);
      increment(metrics_.driverStopFailures);
      clearFailedOwnership();
      return stopStatus;
    }
    retireOutstandingRecoverySilenceFrames();
    metrics_.currentContentFrames = 0U;
    nextExpectedCompletionSequence_ =
        nextSubmissionSequence_;
    refillCredits_ = 0U;
    const auto resetStatus = driver.resetForPlayback();
    if (resetStatus != ITERATE_KIT_OK) {
      return failDriverAndStop(driver, resetStatus);
    }
    enterBuffering();
    return ITERATE_KIT_OK;
  }

  template<typename Driver>
  iterate_kit_status resetForFreshness(
      iterate_kit_pcm_lane &lane,
      Driver &driver,
      std::uint32_t alreadyReleased) {
    increment(metrics_.freshnessIncidents);
    /*
     * The triggering slot was released before this helper was entered. Its
     * loss is therefore already certain even if stopping DMA fails, and must
     * be committed before the next fallible ownership transition.
     */
    add(
        metrics_.freshnessFramesDropped,
        alreadyReleased);
    const auto stopStatus = driver.stopAndRelease();
    if (stopStatus != ITERATE_KIT_OK) {
      increment(metrics_.driverFailures);
      increment(metrics_.driverStopFailures);
      clearFailedOwnership();
      return stopStatus;
    }
    retireOutstandingRecoverySilenceFrames();
    add(
        metrics_.freshnessFramesDropped,
        metrics_.currentContentFrames);
    metrics_.currentContentFrames = 0U;
    nextExpectedCompletionSequence_ =
        nextSubmissionSequence_;
    refillCredits_ = 0U;
    std::uint32_t discarded = 0U;
    const auto discardStatus =
        iterate_kit_pcm_lane_discard_downlink(
            &lane, &discarded);
    if (discardStatus != ITERATE_KIT_OK) {
      return failStateAndStop(driver, discardStatus);
    }
    add(metrics_.freshnessFramesDropped, discarded);
    const auto resetStatus = driver.resetForPlayback();
    if (resetStatus != ITERATE_KIT_OK) {
      return failDriverAndStop(driver, resetStatus);
    }
    enterBuffering();
    return ITERATE_KIT_OK;
  }

  template<typename Driver>
  iterate_kit_status resetPartialPrebuffer(
      Driver &driver) {
    increment(metrics_.partialPrebufferIncidents);
    add(
        metrics_.partialPrebufferFramesDropped,
        metrics_.currentContentFrames);
    const auto stopStatus = driver.stopAndRelease();
    if (stopStatus != ITERATE_KIT_OK) {
      increment(metrics_.driverFailures);
      increment(metrics_.driverStopFailures);
      clearFailedOwnership();
      return stopStatus;
    }
    retireOutstandingRecoverySilenceFrames();
    metrics_.currentContentFrames = 0U;
    nextExpectedCompletionSequence_ =
        nextSubmissionSequence_;
    refillCredits_ = 0U;
    const auto resetStatus = driver.resetForPlayback();
    if (resetStatus != ITERATE_KIT_OK) {
      return failDriverAndStop(driver, resetStatus);
    }
    enterBuffering();
    return ITERATE_KIT_OK;
  }

  void rememberBorrowedFrame(
      const void *frame,
      std::size_t frameBytes,
      std::uint64_t receivedAtMs) {
    /*
     * Acquisition and release are separate fallible operations. Remember every
     * acquired lane slot immediately—not only a backpressured one—so a release
     * failure always leaves one exact token that failed-state cleanup can
     * retry. The disposition flags distinguish an unsent logical PCM loss from
     * a slot whose bytes were already copied into DMA.
     */
    borrowedFrame_ = frame;
    borrowedFrameBytes_ = frameBytes;
    borrowedReceivedAtMs_ = receivedAtMs;
    borrowedFramePending_ = true;
    borrowedFrameCountableContent_ = false;
    borrowedFrameSubmitted_ = false;
  }

  void clearBorrowedFrame() {
    borrowedFrame_ = nullptr;
    borrowedFrameBytes_ = 0U;
    borrowedReceivedAtMs_ = 0U;
    borrowedFramePending_ = false;
    borrowedFrameCountableContent_ = false;
    borrowedFrameSubmitted_ = false;
  }

  iterate_kit_status releaseBorrowedFrame(
      iterate_kit_pcm_lane *lane,
      std::uint32_t *releasedFrames) {
    if (releasedFrames != nullptr) {
      *releasedFrames = 0U;
    }
    if (!borrowedFramePending_) {
      return ITERATE_KIT_OK;
    }
    /*
     * The SPSC slot itself is the retry token. We deliberately keep no copied
     * PCM bytes and therefore must release this exact reservation on every
     * reset/failure path before any bulk discard can run.
     */
    const auto status =
        lane == nullptr
        ? ITERATE_KIT_INVALID_ARGUMENT
        : iterate_kit_pcm_lane_downlink_release(lane);
    if (status == ITERATE_KIT_OK) {
      /*
       * Only the ring's successful consumer advance ends this reservation.
       * Clearing on failure loses the sole token capable of retrying cleanup,
       * leaving read_acquired set forever and wedging the network producer.
       */
      const bool releasedUnsubmittedContent =
          borrowedFrameCountableContent_ &&
          !borrowedFrameSubmitted_;
      clearBorrowedFrame();
      if (releasedFrames != nullptr &&
          releasedUnsubmittedContent) {
        *releasedFrames = 1U;
      }
    }
    return status;
  }

  void clearFailedOwnership() {
    add(
        metrics_.fatalFramesFlushed,
        metrics_.currentContentFrames);
    metrics_.currentContentFrames = 0U;
    nextExpectedCompletionSequence_ =
        nextSubmissionSequence_;
    refillCredits_ = 0U;
    preloadedDescriptorCount_ = 0U;
    partialPrebufferStartedAtMs_ = 0U;
    partialPrebufferStarted_ = false;
    drainingEndOfStream_ = false;
    recoveryDropDebt_ = 0U;
    outstandingRecoverySilenceFrames_ = 0U;
    underrunActive_ = false;
    metrics_.state = RealtimePlaybackState::failed;
  }

  template<typename Driver>
  iterate_kit_status failDriverAndStop(
      Driver &driver,
      iterate_kit_status originalStatus) {
    increment(metrics_.driverFailures);
    const auto stopStatus = driver.stopAndRelease();
    if (stopStatus != ITERATE_KIT_OK) {
      increment(metrics_.driverStopFailures);
    } else {
      retireOutstandingRecoverySilenceFrames();
    }
    clearFailedOwnership();
    return originalStatus == ITERATE_KIT_OK
        ? ITERATE_KIT_STATE_ERROR
        : originalStatus;
  }

  template<typename Driver>
  iterate_kit_status failStateAndStop(
      Driver &driver,
      iterate_kit_status originalStatus) {
    increment(metrics_.stateErrors);
    const auto stopStatus = driver.stopAndRelease();
    if (stopStatus != ITERATE_KIT_OK) {
      increment(metrics_.driverFailures);
      increment(metrics_.driverStopFailures);
    } else {
      retireOutstandingRecoverySilenceFrames();
    }
    clearFailedOwnership();
    return originalStatus == ITERATE_KIT_OK
        ? ITERATE_KIT_STATE_ERROR
        : originalStatus;
  }

  void failDriver() {
    increment(metrics_.driverFailures);
    clearFailedOwnership();
  }

  void failState() {
    increment(metrics_.stateErrors);
    clearFailedOwnership();
  }

  RealtimePlaybackMetrics metrics_{};
  std::uint64_t lastOwnerNowMs_ = 0U;
  std::uint64_t partialPrebufferStartedAtMs_ = 0U;
  bool partialPrebufferStarted_ = false;
  bool drainingEndOfStream_ = false;
  const void *borrowedFrame_ = nullptr;
  std::size_t borrowedFrameBytes_ = 0U;
  std::uint64_t borrowedReceivedAtMs_ = 0U;
  bool borrowedFramePending_ = false;
  bool borrowedFrameCountableContent_ = false;
  bool borrowedFrameSubmitted_ = false;
  std::size_t preloadedDescriptorCount_ = 0U;
  std::uint32_t refillCredits_ = 0U;
  std::uint32_t acceptedGeneration_ = 0U;
  std::uint32_t nextSubmissionSequence_ = 0U;
  std::uint32_t nextExpectedCompletionSequence_ = 0U;
  std::uint32_t recoveryDropDebt_ = 0U;
  std::uint32_t outstandingRecoverySilenceFrames_ = 0U;
  std::uint64_t lastCompletionEofAtUs_ = 0U;
  bool completionEofObserved_ = false;
  bool underrunActive_ = false;
};

}  // namespace iterate::kit::platforms

#endif
