#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_DIRECT_I2S_BACKEND_HPP
#define ITERATE_KIT_PLATFORMS_ESP_IDF_DIRECT_I2S_BACKEND_HPP

#include "iterate/kit/platforms/direct_i2s_stereo_output.hpp"
#include "iterate/kit/status.h"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <limits>

#if defined(ESP_PLATFORM)
#include "esp_attr.h"
#define ITERATE_KIT_ESP_IDF_ISR_ATTR IRAM_ATTR
#else
#define ITERATE_KIT_ESP_IDF_ISR_ATTR
#endif

namespace iterate::kit::platforms {

/**
 * Result at the deliberately tiny ESP-IDF I/O seam.
 *
 * The real target maps this directly from i2s_channel_preload_data() or
 * i2s_channel_write(timeout=0). Host tests inject the same two facts without
 * pretending that ESP-IDF's private completed-buffer queue is an application
 * audio FIFO.
 */
struct EspIdfDirectI2sIoResult {
  iterate_kit_status status;
  std::size_t bytesTransferred;
};

using EspIdfDirectI2sSentCallback = bool (*)(
    void *context,
    void *dmaBuffer,
    std::size_t bytes,
    std::uint64_t eofAtUs);
using EspIdfDirectI2sOverflowCallback =
    bool (*)(void *context);

/**
 * Allocation-free ownership adapter around ESP-IDF's standard-mode TX API.
 *
 * `I2sOps` contains the target-only calls and callback registration;
 * `BoardOps` contains the codec and amplifier controls. Keeping those two
 * boundaries injectable is important: the host test can prove every ordering
 * and queue invariant without copying ESP-IDF internals into a fake driver,
 * while the production implementation remains ordinary direct IDF code.
 *
 * This type does not contain PCM storage. The only PCM buffers are the lane's
 * fixed slots, DirectI2sStereoOutput's one stereo expansion scratch frame, and
 * ESP-IDF's physical DMA descriptors. Callback metadata is kept separately in
 * a four-entry SPSC ring so a stalled owner cannot turn old speech into a
 * growing delayed-playback backlog.
 */
template<
    std::size_t DescriptorCount,
    std::size_t StereoFrameBytes,
    std::uint32_t FrameDurationUs,
    typename I2sOps,
    typename BoardOps>
class EspIdfDirectI2sBackend {
  static_assert(DescriptorCount >= 2U);
  static_assert(DescriptorCount <= 255U);
  static_assert(StereoFrameBytes > 0U);
  static_assert(FrameDurationUs > 0U);
#if !defined(ESP_PLATFORM)
  static_assert(
      std::atomic<std::uint32_t>::is_always_lock_free,
      "host ISR/owner metadata exchange must be lock-free");
#else
  /*
   * ESP-IDF deliberately builds application C++ with
   * -mdisable-hardware-atomics, so libstdc++ reports this type as not
   * `is_always_lock_free` even on the ESP32-S3's S32C1I-capable core. IDF
   * supplies its own `stdatomic` entry points in IRAM; with the S3 PSRAM
   * workaround enabled they dispatch internal-DRAM objects such as these
   * counters to the S32C1I implementation. Keeping std::atomic here therefore
   * uses Espressif's supported ISR-safe path. Treating the libstdc++ trait as
   * the target truth would reject that implementation at compile time.
   *
   * The image/map audit must still prove the called __atomic_* symbols remain
   * in IRAM whenever CONFIG_I2S_ISR_IRAM_SAFE is enabled. That evidence, not a
   * misleading generic-library trait, is the executable contract.
   */
#endif

 public:
  static constexpr bool clearsDmaBeforeEofCallback = true;

  EspIdfDirectI2sBackend(
      I2sOps &i2s,
      BoardOps &board)
      : i2s_(i2s), board_(board) {}

  iterate_kit_status resetForPlayback() {
    /*
     * A generation reset is a physical teardown, not an index rewind. The amp
     * goes quiet before channel deletion so an old DMA descriptor cannot leak
     * through the codec while reconnect state is being reconciled.
     *
     * Both cleanup operations are attempted. We return the first failure and
     * refuse to create another channel if either operation leaves hardware
     * state uncertain; carrying on would turn a diagnosable reset failure into
     * two channels contending for the same pins.
     */
    const auto amplifierStatus =
        board_.setAmplifierEnabled(false);
    const auto releaseStatus = i2s_.release();
    if (releaseStatus == ITERATE_KIT_OK) {
      clearAfterSuccessfulRelease();
    }
    if (amplifierStatus != ITERATE_KIT_OK) {
      return amplifierStatus;
    }
    if (releaseStatus != ITERATE_KIT_OK) {
      return releaseStatus;
    }

    advanceTokenGeneration();
    const auto createStatus = i2s_.createAndConfigure(
        this, &sentThunk, &overflowThunk);
    if (createStatus != ITERATE_KIT_OK) {
      return createStatus;
    }
    configured_ = true;

    /*
     * Codec setup happens with clocks disabled and the external amplifier
     * muted. Several ES8311 registers transiently select/reset signal paths;
     * exposing those transitions is a common source of start-of-stream pops.
     */
    const auto codecStatus = board_.configureCodec();
    if (codecStatus != ITERATE_KIT_OK) {
      if (i2s_.release() == ITERATE_KIT_OK) {
        clearAfterSuccessfulRelease();
      }
      return codecStatus;
    }
    return ITERATE_KIT_OK;
  }

  DirectI2sTransferResult preloadStereo(
      const void *stereo,
      std::size_t bytes) {
    if (!configured_ || running_ ||
        stereo == nullptr ||
        bytes != StereoFrameBytes ||
        preloadedDescriptorCount_ >= DescriptorCount) {
      return {
        ITERATE_KIT_STATE_ERROR,
        0U,
        DirectI2sDescriptorToken{0U}};
    }

    const auto ordinal = preloadedDescriptorCount_;
    const auto token = tokenForOrdinal(ordinal);
    const auto result = i2s_.preload(stereo, bytes);
    if (result.status == ITERATE_KIT_OK &&
        result.bytesTransferred == bytes) {
      ++preloadedDescriptorCount_;
    }
    return {result.status, result.bytesTransferred, token};
  }

  iterate_kit_status startPlayback() {
    if (!configured_ || running_ ||
        preloadedDescriptorCount_ != DescriptorCount) {
      return ITERATE_KIT_STATE_ERROR;
    }

    /*
     * Every DMA descriptor already contains a complete current-generation
     * frame before clocks start. The amplifier is the final action, after
     * enable succeeds, so neither uninitialized RAM nor codec startup reaches
     * the speaker.
     */
    const auto enableStatus = i2s_.enable();
    if (enableStatus != ITERATE_KIT_OK) {
      if (i2s_.release() == ITERATE_KIT_OK) {
        clearAfterSuccessfulRelease();
      }
      return enableStatus;
    }
    running_ = true;

    const auto amplifierStatus =
        board_.setAmplifierEnabled(true);
    if (amplifierStatus != ITERATE_KIT_OK) {
      (void)board_.setAmplifierEnabled(false);
      if (i2s_.release() == ITERATE_KIT_OK) {
        clearAfterSuccessfulRelease();
      }
      return amplifierStatus;
    }
    return ITERATE_KIT_OK;
  }

  DirectI2sBackendCompletionBatch
  takeCompletedDescriptors(
      DirectI2sBackendCompletion *destination,
      std::size_t capacity) {
    if ((destination == nullptr && capacity != 0U) ||
        !running_) {
      return emptyBatch();
    }

    /*
     * There are two queues involved here: our callback-metadata ring and
     * ESP-IDF's private completed-DMA-pointer queue. If the latter overflowed,
     * its oldest pointer was discarded. Callback metadata may still look
     * perfectly ordered, but the next public write can now address a different
     * descriptor. Treat an overflow observed before *or during* this drain as
     * a loss of ownership, never as a metric which can be acknowledged and
     * playback allowed to continue.
     */
    const auto overflowBefore =
        overflowTotal_.load(std::memory_order_acquire);
    if (ownershipPoisoned_ ||
        overflowBefore != overflowTaken_) {
      ownershipPoisoned_ = true;
      return ownershipFaultBatch();
    }

    std::size_t copied = 0U;
    auto consumer =
        completionConsumer_.load(std::memory_order_relaxed);
    const auto published =
        completionProducer_.load(std::memory_order_acquire);
    while (consumer != published && copied < capacity) {
      const auto &event =
          completionEvents_[consumer % DescriptorCount];
      destination[copied] = {
        event.descriptor, event.eofAtUs};

      /*
       * Timing follows the same exact descriptor ownership as the PCM copy.
       * It remains at the head until one complete write advances ownership.
       * Production IDF zero-progress is fatal (see writeStereo); retaining the
       * entry until destructive reset still preserves evidence for diagnostics
       * instead of silently claiming that descriptor was filled.
       */
      if (pendingTimingCount_ >= DescriptorCount) {
        incrementOverflow();
      } else {
        pendingTimings_[
            (pendingTimingHead_ + pendingTimingCount_) %
            DescriptorCount] = event;
        ++pendingTimingCount_;
      }
      ++copied;
      ++consumer;
    }
    completionConsumer_.store(
        consumer, std::memory_order_release);

    auto batch = currentTimingBatch();
    if (batch.descriptorCount > DescriptorCount) {
      ownershipPoisoned_ = true;
      return batch;
    }
    const auto overflowAfter =
        overflowTotal_.load(std::memory_order_acquire);
    if (overflowAfter != overflowBefore ||
        overflowAfter != overflowTaken_) {
      /*
       * The impossible count is the backend's explicit poison sentinel. The
       * portable wrapper rejects it before reading scratch entries. Keeping
       * this fail-closed signal at the backend is essential because only this
       * layer can atomically surround the private-driver ownership window.
       */
      ownershipPoisoned_ = true;
      return ownershipFaultBatch();
    }
    batch.descriptorCount = copied;
    return batch;
  }

  DirectI2sTransferResult writeStereo(
      DirectI2sDescriptorToken descriptor,
      const void *stereo,
      std::size_t bytes) {
    if (!running_ || stereo == nullptr ||
        bytes != StereoFrameBytes ||
        pendingTimingCount_ == 0U) {
      return {
        ITERATE_KIT_STATE_ERROR, 0U, descriptor};
    }
    const auto overflowBefore =
        overflowTotal_.load(std::memory_order_acquire);
    if (ownershipPoisoned_ ||
        overflowBefore != overflowTaken_) {
      ownershipPoisoned_ = true;
      return {
        ITERATE_KIT_STATE_ERROR, 0U, descriptor};
    }

    const auto &pending =
        pendingTimings_[pendingTimingHead_];
    if (pending.descriptor != descriptor) {
      return {
        ITERATE_KIT_STATE_ERROR, 0U, descriptor};
    }
    lastSuccessfulRefillTiming_ = {};
    const auto writeStartedUs =
        i2s_.monotonicMicroseconds();
    if (writeStartedUs < pending.eofAtUs) {
      /*
       * Both timestamps come from esp_timer. A regression is not a tiny
       * negative latency to clamp away: doing so would manufacture a full DMA
       * reuse window and bless a write whose deadline cannot be proven.
       */
      ownershipPoisoned_ = true;
      return {
        ITERATE_KIT_STATE_ERROR, 0U, descriptor};
    }

    /*
     * timeout=0 is a semantic requirement of I2sOps, not a tuning choice:
     * blocking inside opaque driver state would make service latency
     * unbounded. IDF calls on_sent before queueing the same pointer, but both
     * actions are inside one ISR. The notified owner cannot execute until that
     * ISR has queued the pointer and returned, and this backend has no second
     * writer holding the driver's binary semaphore. A zero-progress timeout
     * after an EOF is therefore an invariant/driver fault, not scheduling
     * backpressure. Poison immediately; a scheduled 10 ms retry was both
     * unjustified and an audible-jitter risk.
     */
    const auto result =
        i2s_.write(stereo, bytes, descriptor);
    const auto writeCompletedUs =
        i2s_.monotonicMicroseconds();
    const auto overflowAfter =
        overflowTotal_.load(std::memory_order_acquire);
    if (writeCompletedUs < writeStartedUs ||
        writeCompletedUs < pending.eofAtUs) {
      ownershipPoisoned_ = true;
      return {
        ITERATE_KIT_STATE_ERROR,
        result.bytesTransferred,
        descriptor};
    }
    if (overflowAfter != overflowBefore ||
        overflowAfter != overflowTaken_) {
      /*
       * Preserve IDF's authoritative byte count even on this fatal result.
       * Zero bytes means ownership was lost before any copy; a nonzero/full
       * count means the copy and queue loss overlapped and the wrapper must
       * classify it as an uncertain partial transfer. In neither case may the
       * pending token ledger advance.
       *
       * An overflow immediately after this snapshot is ordered after this
       * completed write and is caught by the next poll/write pre-check.
       */
      ownershipPoisoned_ = true;
      return {
        ITERATE_KIT_STATE_ERROR,
        result.bytesTransferred,
        descriptor};
    }
    if ((result.status == ITERATE_KIT_BACKPRESSURE ||
         result.status == ITERATE_KIT_UNAVAILABLE) &&
        result.bytesTransferred == 0U) {
      /*
       * Preserve the driver's precise status for the policy's incident
       * counter, but quarantine ownership before returning it. The policy
       * performs one synchronous destructive reset; if a caller instead tries
       * to reuse this descriptor, the pre-check above fails without entering
       * IDF a second time.
       */
      ownershipPoisoned_ = true;
      return {
        result.status, result.bytesTransferred, descriptor};
    }
    if (result.status == ITERATE_KIT_OK &&
        result.bytesTransferred == bytes) {
      const auto eofToRefillUs =
          writeCompletedUs - pending.eofAtUs;
      const auto writeDurationUs =
          writeCompletedUs - writeStartedUs;
      constexpr std::uint64_t reuseWindowUs =
          static_cast<std::uint64_t>(
              DescriptorCount - 1U) *
          FrameDurationUs;
      const auto reuseLeadUs =
          eofToRefillUs >= reuseWindowUs
          ? 0U
          : reuseWindowUs - eofToRefillUs;
      lastSuccessfulRefillTiming_ = {
        true,
        bounded32(eofToRefillUs),
        bounded32(writeDurationUs),
        bounded32(reuseLeadUs)};
      pendingTimingHead_ =
          (pendingTimingHead_ + 1U) % DescriptorCount;
      --pendingTimingCount_;
    }
    return {
      result.status, result.bytesTransferred, descriptor};
  }

  RealtimePlaybackSuccessfulRefillTiming
  lastSuccessfulRefillTiming() const {
    return lastSuccessfulRefillTiming_;
  }

  std::uint32_t takeQueueOverflows() {
    /*
     * This is a monotonic producer total plus an owner snapshot, rather than a
     * read-then-zero counter. An ISR arriving between those two operations
     * would otherwise be erased. Saturation is fine: the first overflow makes
     * descriptor ownership unknowable and poisons this entire generation.
     */
    const auto total =
        overflowTotal_.load(std::memory_order_acquire);
    const auto previous = overflowTaken_;
    overflowTaken_ = total;
    const auto count = total >= previous
        ? total - previous
        : std::numeric_limits<std::uint32_t>::max();
    if (count > 0U) {
      ownershipPoisoned_ = true;
    }
    return count;
  }

  iterate_kit_status stopAndRelease() {
    /*
     * MCLK remains present after i2s_channel_disable() on this target, and the
     * microphone reuses the same MCLK/BCLK/WS pins. `release()` must therefore
     * disable and delete I2S0 synchronously; merely stopping DMA is not enough
     * for the half-duplex ownership handoff.
     */
    const auto amplifierStatus =
        board_.setAmplifierEnabled(false);
    const auto releaseStatus = i2s_.release();
    if (releaseStatus == ITERATE_KIT_OK) {
      clearAfterSuccessfulRelease();
    }
    return amplifierStatus != ITERATE_KIT_OK
        ? amplifierStatus
        : releaseStatus;
  }

 private:
  struct CompletionEvent {
    DirectI2sDescriptorToken descriptor;
    std::uint64_t eofAtUs;
  };

  static bool ITERATE_KIT_ESP_IDF_ISR_ATTR sentThunk(
      void *context,
      void *dmaBuffer,
      std::size_t bytes,
      std::uint64_t eofAtUs) {
    return static_cast<EspIdfDirectI2sBackend *>(context)
        ->onSent(dmaBuffer, bytes, eofAtUs);
  }

  static bool ITERATE_KIT_ESP_IDF_ISR_ATTR overflowThunk(
      void *context) {
    auto *backend =
        static_cast<EspIdfDirectI2sBackend *>(context);
    backend->incrementOverflow();
    return backend->i2s_.notifyOwnerFromIsr();
  }

  bool ITERATE_KIT_ESP_IDF_ISR_ATTR onSent(
      void *dmaBuffer,
      std::size_t bytes,
      std::uint64_t eofAtUs) {
    const auto sequence = callbackSequence_;
    const auto ordinal = sequence % DescriptorCount;
    DirectI2sDescriptorToken token{0U};

    /*
     * Public preload_data() does not reveal descriptor pointers. The first
     * ordered callback cycle binds each real DMA pointer to its synthetic
     * preload ordinal. Every later cycle must present that same pointer at the
     * same ordinal. Publishing token zero on any discrepancy lets the portable
     * wrapper poison ownership instead of searching ahead and concealing a
     * skipped descriptor.
     */
    bool identityValid =
        dmaBuffer != nullptr && bytes == StereoFrameBytes;
    if (identityValid && sequence < DescriptorCount) {
      for (std::size_t prior = 0U;
           prior < ordinal;
           ++prior) {
        if (dmaBuffers_[prior] == dmaBuffer) {
          identityValid = false;
          break;
        }
      }
      if (identityValid) {
        dmaBuffers_[ordinal] = dmaBuffer;
      }
    } else if (identityValid) {
      identityValid = dmaBuffers_[ordinal] == dmaBuffer;
    }
    if (identityValid) {
      token = tokenForOrdinal(ordinal);
    }
    ++callbackSequence_;

    const auto producer =
        completionProducer_.load(std::memory_order_relaxed);
    const auto consumer =
        completionConsumer_.load(std::memory_order_acquire);
    if (producer - consumer >= DescriptorCount) {
      /*
       * Do not overwrite the oldest event. Losing either side is fatal, but
       * retaining the old entries produces the most useful forensic sequence
       * before takeQueueOverflows() poisons the generation.
       */
      incrementOverflow();
      return i2s_.notifyOwnerFromIsr();
    }
    completionEvents_[producer % DescriptorCount] = {
      token, eofAtUs};
    completionProducer_.store(
        producer + 1U, std::memory_order_release);
    /*
     * IDF interprets this callback result as "yield from ISR". Merely returning
     * true neither wakes the audio owner nor proves a higher-priority waiter
     * was unblocked; it creates 50 gratuitous scheduler yields per second.
     * I2sOps performs exactly one task notification and returns FreeRTOS's
     * actual higherPriorityTaskWoken fact.
     */
    return i2s_.notifyOwnerFromIsr();
  }

  void ITERATE_KIT_ESP_IDF_ISR_ATTR incrementOverflow() {
    auto current =
        overflowTotal_.load(std::memory_order_relaxed);
    while (
        current !=
            std::numeric_limits<std::uint32_t>::max() &&
        !overflowTotal_.compare_exchange_weak(
            current,
            current + 1U,
            std::memory_order_release,
            std::memory_order_relaxed)) {
    }
  }

  DirectI2sBackendCompletionBatch
  currentTimingBatch() const {
    if (pendingTimingCount_ == 0U) {
      return emptyBatch();
    }
    const auto nowUs = i2s_.monotonicMicroseconds();
    const auto oldestEofUs =
        pendingTimings_[pendingTimingHead_].eofAtUs;
    if (nowUs < oldestEofUs) {
      /*
       * ESP's monotonic timer cannot legitimately precede an ISR timestamp
       * captured from that same clock. Treating this as age zero would
       * manufacture a full refill window and authorize a DMA write from false
       * timing evidence. The impossible count makes the wrapper stop.
       */
      return ownershipFaultBatch();
    }
    const auto ageUs = nowUs - oldestEofUs;
    /*
     * The EOF callback describes a descriptor which has already completed;
     * DMA advances to the following descriptor before the owner sees it.
     * Therefore only DescriptorCount-1 frame durations remain before the
     * completed descriptor is reused. Counting the full physical cycle grants
     * one fictitious frame of refill time and permits a copy while DMA may
     * already be reading the same memory.
     */
    constexpr std::uint64_t reuseWindowUs =
        static_cast<std::uint64_t>(DescriptorCount - 1U) *
        FrameDurationUs;
    const auto leadUs =
        ageUs >= reuseWindowUs
        ? 0U
        : reuseWindowUs - ageUs;
    return {
      0U,
      true,
      bounded32(ageUs),
      bounded32(leadUs)};
  }

  static DirectI2sBackendCompletionBatch emptyBatch() {
    return {0U, false, 0U, 0U};
  }

  static DirectI2sBackendCompletionBatch
  ownershipFaultBatch() {
    return {
      DescriptorCount + 1U, false, 0U, 0U};
  }

  static std::uint32_t bounded32(
      std::uint64_t value) {
    return value >
            std::numeric_limits<std::uint32_t>::max()
        ? std::numeric_limits<std::uint32_t>::max()
        : static_cast<std::uint32_t>(value);
  }

  void advanceTokenGeneration() {
    constexpr auto maximum =
        std::numeric_limits<std::uintptr_t>::max();
    if (nextTokenBase_ == 0U ||
        nextTokenBase_ >
            maximum - (DescriptorCount - 1U)) {
      nextTokenBase_ = 1U;
    }
    tokenBase_ = nextTokenBase_;
    nextTokenBase_ =
        tokenBase_ + DescriptorCount;
  }

  DirectI2sDescriptorToken ITERATE_KIT_ESP_IDF_ISR_ATTR
  tokenForOrdinal(
      std::size_t ordinal) const {
    return DirectI2sDescriptorToken{
      tokenBase_ + ordinal};
  }

  void clearSoftwareOwnership() {
    completionConsumer_.store(
        0U, std::memory_order_relaxed);
    completionProducer_.store(
        0U, std::memory_order_relaxed);
    overflowTotal_.store(
        0U, std::memory_order_relaxed);
    overflowTaken_ = 0U;
    ownershipPoisoned_ = false;
    completionEvents_.fill(CompletionEvent{});
    pendingTimings_.fill(CompletionEvent{});
    dmaBuffers_.fill(nullptr);
    preloadedDescriptorCount_ = 0U;
    callbackSequence_ = 0U;
    pendingTimingHead_ = 0U;
    pendingTimingCount_ = 0U;
    lastSuccessfulRefillTiming_ = {};
  }

  void clearAfterSuccessfulRelease() {
    /*
     * A successful i2s_del_channel() is the only proof that IDF can no longer
     * invoke our registered callbacks. If disable/delete fails while RUNNING,
     * the ISR still owns callbackSequence_, dmaBuffers_, and the SPSC producer
     * cursor. Quarantining those bytes is intentional: resetting them from the
     * task would race a live ISR and manufacture a false-clean generation.
     * The next lifecycle attempt retries deletion against the same handle; only
     * after that succeeds may this owner-exclusive reset run.
     */
    clearSoftwareOwnership();
    configured_ = false;
    running_ = false;
  }

  I2sOps &i2s_;
  BoardOps &board_;
  std::array<CompletionEvent, DescriptorCount>
      completionEvents_{};
  std::array<CompletionEvent, DescriptorCount>
      pendingTimings_{};
  std::array<void *, DescriptorCount> dmaBuffers_{};
  std::atomic<std::uint32_t> completionProducer_{0U};
  std::atomic<std::uint32_t> completionConsumer_{0U};
  std::atomic<std::uint32_t> overflowTotal_{0U};
  std::uint32_t overflowTaken_ = 0U;
  std::uintptr_t tokenBase_ = 1U;
  std::uintptr_t nextTokenBase_ = 1U;
  std::size_t preloadedDescriptorCount_ = 0U;
  std::size_t callbackSequence_ = 0U;
  std::size_t pendingTimingHead_ = 0U;
  std::size_t pendingTimingCount_ = 0U;
  RealtimePlaybackSuccessfulRefillTiming
      lastSuccessfulRefillTiming_{};
  bool configured_ = false;
  bool running_ = false;
  bool ownershipPoisoned_ = false;
};

}  // namespace iterate::kit::platforms

#undef ITERATE_KIT_ESP_IDF_ISR_ATTR

#endif
